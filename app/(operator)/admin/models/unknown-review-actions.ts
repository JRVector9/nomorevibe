"use server";

import { z } from "zod";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { closeModelCapacityUnknownReview } from "@/lib/llm/capacity-repository";
import { canRequeueUnknownRoute, requeueModelCapacityUnknowns, summarizeRequeue } from "@/lib/operations/model-capacity-requeue";
import type { RequeueSummary } from "@/lib/operations/model-capacity-requeue-text";
import { revalidatePath } from "next/cache";

export type UnknownReviewState = { ok: true; requestId: string } | { ok: false; error: string } | null;
const inputSchema = z.object({ requestId: z.uuid(), note: z.string().trim().min(1).max(400) });

/** '검토 완료': indeterminate 행을 운영자 메모와 함께 withdrawn 으로 닫는다(0151). 용량은 바뀌지 않는다 — 검토 목록에서만 빠진다. 감사 기록을 남긴다. */
export const closeUnknownReview = webWriteAction(async function closeUnknownReview(_previous: UnknownReviewState, form: FormData): Promise<UnknownReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { ok: false, error: "관리자만 검토를 닫을 수 있습니다." };
  const parsed = inputSchema.safeParse({ requestId: form.get("requestId"), note: form.get("note") });
  if (!parsed.success) return { ok: false, error: "요청 ID 또는 메모(1~400자)가 올바르지 않습니다." };
  const { requestId, note } = parsed.data;
  try {
    const result = await closeModelCapacityUnknownReview({ requestId, operator: admin.login, note });
    await db.insert(operationsAudit).values(await adminAuditRow(admin.login, { action: "model-capacity-unknown-reviewed", target: requestId,
      detail: { note, result: result.kind, ...(result.kind === "reviewed" ? { reviewedAt: result.evidence.reviewedAt } : { state: result.state }) },
      ok: result.kind === "reviewed", error: result.kind === "reviewed" ? null : `request_${result.state ?? "missing"}` }));
    if (result.kind !== "reviewed") return { ok: false, error: result.state === null ? "요청을 찾지 못했습니다." : `이미 ${result.state} 상태라 검토 대상이 아닙니다.` };
    return { ok: true, requestId };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "검토 기록에 실패했습니다." }; }
});

/** ok 면 한 번 누른 결과(N건 다시 넣음 · M건 닫음 · K건 남음과 남은 까닭)와 처리한 단계 수 */
export type RequeueUnknownState = ({ ok: true; groups: number } & RequeueSummary) | { ok: false; error: string } | null;
const scopeLabel = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:@+/-]+$/);
const requeueSchema = z.object({ routeId: z.string().trim().min(1).max(120).optional(), groupId: scopeLabel.optional(), provider: scopeLabel.optional() })
  .refine(value => [value.routeId, value.groupId, value.provider].filter(Boolean).length <= 1);

/**
 * '다시 대기열에 넣기' — 결과 미확정 행의 실제 작업 큐를 되돌리고, 다시 넣었거나 할 일이 이미 끝난 행만 운영자 검토로 닫는다.
 * 넘기는 범위는 하나다: routeId(기록 › 재실행 패널의 단계 한 줄), groupId(LLM 운영의 연결 한 줄 = 그 장비), provider(연결 행이 없는 CLI 도구 한 줄).
 * 아무것도 넘기지 않으면 모든 단계를 한 번에 처리한다(최대 500행). 지원하지 않는 단계의 행은 넣지도 닫지도 않고 까닭과 함께 남긴다.
 * 감사 기록은 늘 model-capacity-unknown-requeued 한 줄이다 — 이 동작 밖에서 requeueModelCapacityUnknowns 를 부르지 않는다.
 */
export const requeueUnknownReviews = webWriteAction(async function requeueUnknownReviews(
  _previous: RequeueUnknownState, form: FormData,
): Promise<RequeueUnknownState> {
  const admin = await currentAdmin();
  if (!admin) return { ok: false, error: "관리자만 다시 대기열에 넣을 수 있습니다." };
  const parsed = requeueSchema.safeParse({ routeId: form.get("routeId") || undefined, groupId: form.get("groupId") || undefined,
    provider: form.get("provider") || undefined });
  if (!parsed.success) return { ok: false, error: "단계·장비·도구 이름이 올바르지 않습니다." };
  const { routeId, groupId, provider } = parsed.data;
  if (routeId && !canRequeueUnknownRoute(routeId)) return { ok: false, error: "이 단계는 아직 다시 대기열에 넣기를 지원하지 않습니다." };
  try {
    const result = await requeueModelCapacityUnknowns({ routeId, groupId, provider, operator: admin.login,
      note: "운영자 다시 대기열에 넣기", limit: 500 });
    const summary = summarizeRequeue(result);
    await db.insert(operationsAudit).values(await adminAuditRow(admin.login, {
      action: "model-capacity-unknown-requeued",
      target: routeId ?? (groupId ? `device:${groupId}` : provider ? `provider:${provider}` : "all-supported-routes"),
      detail: { routeId: routeId ?? null, groupId: groupId ?? null, provider: provider ?? null, groups: result.groups, closed: result.closed,
        requeued: summary.requeued, left: summary.left, reasons: summary.reasons, leftRows: result.leftRows },
      ok: !result.groups.some(group => group.error),
      error: result.groups.some(group => group.error) ? "some_routes_failed" : null,
    }));
    revalidatePath("/admin/models");
    return { ok: true, groups: result.groups.length, ...summary };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "다시 대기열에 넣지 못했습니다." };
  }
});
