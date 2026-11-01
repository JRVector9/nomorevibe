"use server";

import { z } from "zod";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { listGatewayModels } from "@/lib/crawl/agent-review-gateway";
import { randomUUID } from "node:crypto";
import { submitModelOpsCommand } from "@/lib/operations/ops-runner/repository";
import { adminModelIdentitySchema, modelIdentityKey } from "@/lib/operations/admin-models-observation";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { findModelDefinition } from "@/lib/operations/admin-models-view";
import { ADMIN_MODEL_STAGES } from "@/lib/llm/admin-model-stages";
import { readModelRegistry, modelRequestName } from "@/lib/llm/model-registry";
import { saveProbeObservation } from "@/lib/operations/admin-models-probe-repository";

async function listRegisteredModel(definition: ReturnType<typeof readModelRegistry>["models"][number]): Promise<boolean | null> {
  if (!definition.baseUrl) return null;
  try {
    const response = await fetch(`${definition.baseUrl.replace(/\/+$/, "")}/models`, { cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(5000), headers: definition.provider === "abcllm" && process.env.ABCLLM_API_KEY
        ? { authorization: `Bearer ${process.env.ABCLLM_API_KEY}` } : {} });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 128 * 1024) { await reader.cancel(); return null; } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return Array.isArray(body.data) ? body.data.some((row: { id?: unknown }) => row?.id === definition.model || row?.id === modelRequestName(definition)) : null;
  } catch { return null; }
}

/** observedAt·source 는 결과를 관측 표(probe:<provider>:<model>)에 남긴 시각·출처 — 저장에 실패하면 saveError 만 있고 결과는 그대로다. */
export type ModelProbeResult = { error?: string; listed?: boolean; listMs?: number; callMs?: number; callBlocked?: string;
  observedAt?: string; source?: "manual" | "auto"; saveError?: string };
export const probeAdminModel = webWriteAction(async function probeAdminModel(input: unknown): Promise<ModelProbeResult> {
  const admin = await currentAdmin();
  if (!admin) return { error: "관리자만 연결을 확인할 수 있습니다." };
  const parsed = adminModelIdentitySchema.safeParse(input);
  if (!parsed.success) return { error: "모델 식별자가 올바르지 않습니다." };
  const identity = parsed.data, observation = await readAdminModelsObservation();
  const stage = ADMIN_MODEL_STAGES.find(row => row.id === identity.routeId);
  const definition = findModelDefinition(identity, readModelRegistry().models);
  const registered = stage && definition && definition.provider === stage.provider;
  if (!registered && (observation.error || !observation.rows.some(row => modelIdentityKey(row) === modelIdentityKey(identity))))
    return { error: "운영 DB에서 해당 단계·모델을 확인하지 못했습니다. 새로고침해주세요." };
  // Commit intent before network IO. Failure to audit must prevent the operation.
  await db.insert(operationsAudit).values(await adminAuditRow(admin.login, { action: "admin-models-probe-start", target: identity.routeId, detail: identity }));
  const started = Date.now();
  const models = !definition && identity.provider === "abcllm" ? await listGatewayModels() : null;
  const listed = definition ? await listRegisteredModel(definition) : models ? models.includes(identity.model) : null;
  const result: ModelProbeResult = { listed: listed ?? undefined, listMs: Date.now() - started,
    callBlocked: /deepseek/i.test(`${identity.provider} ${identity.model}`)
      ? "유료 DeepSeek 시험 호출은 허용되지 않습니다."
      : "짧은 시험 호출에 필요한 정식 슬롯·종료 증거 계약이 등록되지 않았습니다.",
    ...(listed === null ? { error: identity.provider === "abcllm" || identity.provider === "local-direct" ? "모델 목록을 읽지 못했습니다. 연결 설정·인증을 확인해주세요." : "이 제공자의 모델 목록 조회 실행기가 연결되지 않았습니다." } : {}) };
  await db.insert(operationsAudit).values(await adminAuditRow(admin.login, { action: "admin-models-probe-result", target: identity.routeId,
    detail: { ...identity, ...result }, ok: false, error: result.error ?? "short_call_contract_missing" }));
  // 2026-10-31 한 화면: 결과를 슬롯 키(probe:<provider>:<model>)에 남겨 새로고침 뒤에도 「N초 전 · 수동 · 결과」로 보인다. 같은 장비·모델은 한 결과를 공유한다.
  try { const saved = await saveProbeObservation(identity, result, "manual"); return { ...result, observedAt: saved.observedAt, source: "manual" }; }
  catch { return { ...result, saveError: "연결 확인 결과를 관측 표에 남기지 못했습니다. 이 결과는 새로고침하면 사라집니다." }; }
});

const admissionSchema = z.object({ to: z.enum(["open", "draining"]), fromMode: z.enum(["open", "draining"]),
  expectEpoch: z.number().int().positive().safe(), expectRevision: z.number().int().positive().safe(),
  reason: z.string().trim().min(1).max(500), confirmed: z.literal(true) }).strict().refine(value => value.to !== value.fromMode);
export type ModelOperationResult = { ok?: true; error?: string; blocked?: string[]; queued?: string };
export const changeAdminModelAdmission = webWriteAction(async function changeAdminModelAdmission(input: unknown): Promise<ModelOperationResult> {
  const admin = await currentAdmin();
  if (!admin) return { error: "관리자만 접수 상태를 바꿀 수 있습니다." };
  const parsed = admissionSchema.safeParse(input);
  if (!parsed.success) return { error: "현재 접수 상태와 변경 사유·확인을 다시 입력해주세요." };
  const { to, fromMode, expectEpoch, expectRevision, reason } = parsed.data;
  // Compatibility entry point also queues; it cannot OPEN around an unfinished recovery.
  const observed = await readAdminModelsObservation();
  if (observed.mode !== fromMode || observed.epoch !== expectEpoch || observed.revision !== expectRevision)
    return { error: "접수 상태가 바뀌었습니다. 새로고침해주세요.", blocked: ["capacity_pin_changed"] };
  try {
    const state = await submitModelOpsCommand({ id: randomUUID(), action: to === "open" ? "admission-open" : "admission-pause",
      targetId: "model-capacity", reason, confirmed: true }, admin.login);
    return { queued: state.id };
  } catch { return { error: "접수 변경이 거절됐습니다. 미완료 작업과 감사 기록을 확인해주세요.", blocked: ["ops_runner_submission_rejected"] }; }
});
