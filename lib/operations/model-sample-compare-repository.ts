// 워커(lib/jobs/registry → korean-tagline-sample)도 이 모듈을 부른다 — "server-only" 를 넣으면 워커가 뜨지 못한다(조각 4a 가 찾음).
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { modelSampleComparisons, operationsAudit } from "@/lib/db/schema";
import { aiTask, aiTaskAccepts } from "@/lib/llm/ai-tasks";
import { logger } from "@/lib/observability/logger";
import { aiConnectionModelIds, aiModelDisplayName, aiRanksReadiness } from "./admin-ai-tasks";
import { aiTaskCrossResourceIssues, listAiConnections, listAiTaskRows, prepareAiTaskServingResources, readAiTaskReadinessInput,
  saveAiTaskServingResources } from "./admin-ai-tasks-repository";
import { adminAuditRow } from "./admin-log";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";
import { pickSamples, SAMPLE_COMPARE_LIMITS, sampleCompareTask, type SampleComparison, type SampleItem, type SampleModelRef, type SampleStatus } from "./model-sample-compare";

/**
 * 표본 비교 기록(model_sample_comparisons, 0180)의 읽기·요청·진행 저장(2026-11-12 운영 콘솔 조각 3a).
 *
 * 요청(관리자 서버 동작): 검증 → 후보 모델의 그 작업 계약·장부 경로 준비(작업 배정의 순위 저장과 같은 readback + 1토큰 시험,
 * 순위는 바꾸지 않는다 — 순위가 없으면 실행 쪽은 이 모델을 부르지 않는다) → 대기 일감에서 표본 고르기(읽기만) → 한 TX(DR fence · 같은 작업의
 * 열린 비교 확인 · 계약·경로 쓰기 · 비교 줄 · 감사 한 줄). 모델 호출은 여기서 하지 않는다 — 그 작업의 배경 잡이 자기 lease 로 부른다.
 */

export const SAMPLE_COMPARE_AUDIT_ACTION = "model-sample-compare-request";
const fail = (code: string): never => { throw new Error(code); };

type Row = typeof modelSampleComparisons.$inferSelect;
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
export function sampleComparisonOf(row: Row): SampleComparison {
  return Object.freeze({ id: Number(row.id), task: row.task, status: row.status as SampleStatus, statusCode: row.statusCode,
    candidate: row.candidate, current: row.current ?? null, size: row.sampleSize, items: (row.items ?? []) as unknown as SampleItem[],
    deferrals: row.deferrals, requestedBy: row.requestedBy, requestedAt: iso(row.requestedAt)!, startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt) });
}

/** 최근 비교(작업을 주면 그 작업만) — 읽기 전용. 못 읽으면 던진다(화면이 「못 읽음」으로) */
export async function listModelSampleComparisons(task: string | null, limit = 10): Promise<SampleComparison[]> {
  const rows = await onPrimary(() => db.select().from(modelSampleComparisons)
    .where(task ? eq(modelSampleComparisons.task, task) : undefined).orderBy(desc(modelSampleComparisons.id)).limit(Math.max(1, Math.min(50, limit))));
  return rows.map(sampleComparisonOf);
}

/** 작업의 대기 일감(표본 후보) — 작업마다 그 작업의 대기 줄 읽기. 지원하는 작업만 */
async function sampleQueue(task: string): Promise<{ productId: number; name: string; text: string }[]> {
  if (task === "product-tagline-ko") {
    const { homeListSlugs, pendingKoreanTaglines, koreanTaglineSource } = await import("@/lib/domain/products/korean-taglines");
    const { displayProjectName } = await import("@/lib/domain/products/display-name");
    const queue = await pendingKoreanTaglines(400, await homeListSlugs());
    return queue.map(row => ({ productId: row.productId, name: displayProjectName(row.name, row.repoUrl), text: koreanTaglineSource(row) }));
  }
  return fail("sample_compare_task_unsupported");
}

export type SampleCompareRequest = Readonly<{ task: string; connectionId: string; model: string; size: number }>;
export type SampleCompareRequestResult = { ok: true; id: number; size: number; created: string[] } | { ok: false; issues: string[] };

export async function requestModelSampleComparison(input: SampleCompareRequest, actor: string): Promise<SampleCompareRequestResult> {
  if (!actor.trim() || actor.length > 120) return { ok: false, issues: ["관리자 이름을 읽지 못했습니다. 다시 로그인하세요."] };
  const spec = sampleCompareTask(input.task), task = aiTask(input.task);
  if (!spec || !task) return { ok: false, issues: ["표본 비교를 하는 작업이 아닙니다."] };
  if (!spec.supported) return { ok: false, issues: [`지원 안 함 — ${spec.reason}`] };
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > SAMPLE_COMPARE_LIMITS.maxSize)
    return { ok: false, issues: [`표본 수는 1~${SAMPLE_COMPARE_LIMITS.maxSize}입니다.`] };
  try {
    const [connections, ranks] = await Promise.all([listAiConnections(), listAiTaskRows()]);
    const candidate = connections.find(row => row.id === input.connectionId);
    if (!candidate) return { ok: false, issues: ["후보 모델을 찾지 못했습니다."] };
    if (!candidate.enabled) return { ok: false, issues: ["쉬는 중인 모델은 비교할 수 없습니다. 먼저 켜세요."] };
    if (!aiTaskAccepts(task, candidate)) return { ok: false, issues: [`${aiModelDisplayName(candidate)}은(는) ${task.label}에 쓸 수 없습니다(종류 또는 「쓸 수 있는 단계」 제한).`] };
    if (!aiConnectionModelIds(candidate).includes(input.model)) return { ok: false, issues: ["이 모델이 알려 준 이름이 아닙니다. 상세의 「연결 확인」을 보세요."] };
    // 지금 모델 = 그 작업 1칸의 켜진 1순위(요청 때의 값을 기록에 남긴다)
    const first = ranks.filter(row => row.task === task.id && row.slot === 1 && row.enabled).sort((a, b) => a.rank - b.rank)[0] ?? null;
    if (first && first.connectionId === candidate.id && first.model === input.model) return { ok: false, issues: ["이미 이 단계의 1순위 모델입니다. 다른 후보를 고르세요."] };
    const firstConnection = first ? connections.find(row => row.id === first.connectionId) ?? null : null;
    const current: SampleModelRef | null = first ? { connectionId: first.connectionId, model: first.model, name: firstConnection ? aiModelDisplayName(firstConnection) : first.model } : null;
    // 후보의 그 작업 계약·장부 경로 — 작업 배정의 순위 저장과 같은 준비(만들 것이 없으면 아무것도 쓰지 않는다)
    const readiness = aiRanksReadiness(task, [{ rank: 1, connection: candidate, model: input.model }], await readAiTaskReadinessInput());
    const blocking = [...readiness.flatMap(row => row.blocking), ...aiTaskCrossResourceIssues(task, readiness)];
    if (blocking.length) return { ok: false, issues: blocking };
    const resources = await prepareAiTaskServingResources(task, [{ rank: 1, row: { provider: candidate.id, model: input.model }, connection: candidate }], readiness);
    if (!resources.ok) return { ok: false, issues: resources.issues };
    const picked = pickSamples(await sampleQueue(task.id), input.size);
    if (!picked.length) return { ok: false, issues: [`${task.label}의 대기 일감이 없어 표본을 고를 수 없습니다.`] };
    const items: SampleItem[] = picked.map(row => ({ productId: row.productId, name: row.name, text: row.text, current: null, candidate: null }));
    const candidateRef: SampleModelRef = { connectionId: candidate.id, model: input.model, name: aiModelDisplayName(candidate) };
    const saved = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('model_sample_comparisons'), hashtext(${task.id}))`);
      const [open] = await tx.select({ id: modelSampleComparisons.id }).from(modelSampleComparisons)
        .where(and(eq(modelSampleComparisons.task, task.id), inArray(modelSampleComparisons.status, ["queued", "running"]))).limit(1);
      if (open) fail("sample_compare_open");
      const created = await saveAiTaskServingResources(tx, task, readiness, resources, actor);
      const [row] = await tx.insert(modelSampleComparisons).values({ task: task.id, candidate: candidateRef, current, sampleSize: items.length,
        items: items as unknown as Record<string, unknown>[], requestedBy: actor }).returning({ id: modelSampleComparisons.id });
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: SAMPLE_COMPARE_AUDIT_ACTION, target: `${task.id}#${row.id}`,
        detail: { id: Number(row.id), task: task.id, candidate: candidateRef, current, size: items.length, productIds: items.map(item => item.productId),
          created: { contracts: created.contracts, devices: created.devices, routes: created.routes, policyRevision: created.policyRevision } } }));
      return { id: Number(row.id), created: [...created.contracts, ...created.devices, ...created.routes] };
    }));
    logger.info("model_sample_compare.requested", { actor, task: task.id, id: saved.id, size: items.length });
    return { ok: true, id: saved.id, size: items.length, created: saved.created };
  } catch (error) {
    const code = error instanceof DrWriterFencedError ? "site_fenced" : error instanceof Error ? error.message : "unknown";
    if (code === "sample_compare_open") return { ok: false, issues: ["이 작업에 아직 끝나지 않은 비교가 있습니다. 끝난 뒤 다시 요청하세요."] };
    if (code === "site_fenced") return { ok: false, issues: ["이 사이트는 지금 쓰기가 막혀 있습니다(DR 전환 중)."] };
    logger.warn("model_sample_compare.request_failed", { code: /^[a-z0-9_:.-]{1,80}$/.test(code) ? code : "error" });
    return { ok: false, issues: ["요청을 저장하지 못했습니다. 새로고침해 상태를 확인하세요."] };
  }
}

// ── 배경 잡 쪽 ─────────────────────────────────────────────────────────────────────────────────────────

/** 그 작업의 열린 비교 하나를 잡는다(가장 오래된 것). 다른 워커가 쥐고 있으면 건너뛴다. 처음 잡으면 running 으로 바꾼다 */
export async function claimModelSampleComparison(task: string): Promise<SampleComparison | null> {
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return null;
    const [row] = await tx.select().from(modelSampleComparisons)
      .where(and(eq(modelSampleComparisons.task, task), inArray(modelSampleComparisons.status, ["queued", "running"])))
      .orderBy(modelSampleComparisons.id).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    if (row.status === "queued") {
      const [started] = await tx.update(modelSampleComparisons).set({ status: "running", startedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(eq(modelSampleComparisons.id, row.id)).returning();
      return sampleComparisonOf(started);
    }
    return sampleComparisonOf(row);
  }));
}

/** 묶음 하나의 결과 저장 — 열린 비교만(취소된 비교는 건드리지 않는다). 끝났으면 done·실패면 failed 와 까닭 */
export async function saveModelSampleProgress(id: number, value: { items: readonly SampleItem[]; deferrals: number; status: "running" | "done" | "failed";
  statusCode?: string | null }): Promise<boolean> {
  const finished = value.status !== "running";
  const [row] = await onPrimary(() => db.update(modelSampleComparisons).set({ items: value.items as unknown as Record<string, unknown>[], deferrals: Math.min(1000, value.deferrals),
    status: value.status, statusCode: value.statusCode?.slice(0, 120) ?? null, updatedAt: sql`clock_timestamp()`,
    ...(finished ? { finishedAt: sql`clock_timestamp()` } : {}) })
    .where(and(eq(modelSampleComparisons.id, id), inArray(modelSampleComparisons.status, ["queued", "running"]))).returning({ id: modelSampleComparisons.id }));
  return !!row;
}
