import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelCapacityDispatch } from "./capacity";
import { assistWorkTaskSchema } from "@/lib/domain/llm-assist/work";

const id = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
const repo = text(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

/** 대상은 실제 도메인 행을 찾기 위한 주소다. 이 모양 자체는 호출 권한이 아니다. */
export const localModelTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assist"), purpose: z.enum(["assist_review", "intro_correction"]), workId: z.uuid(), workRevision: id,
    claimToken: z.uuid(), task: z.lazy(() => assistWorkTaskSchema), subjectId: id, backendId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/) }).strict()
    .refine(value => value.purpose !== "intro_correction" || value.task === "intro_recheck", "invalid_correction_task"),
  z.object({ kind: z.literal("audit"), purpose: z.enum(["audit", "second_opinion", "screen"]),
    itemId: id, slug: text(80) }).strict(),
  z.object({ kind: z.literal("published"), purpose: z.literal("published_filter"),
    secondReviewId: id, slug: text(80) }).strict(),
  z.object({ kind: z.literal("candidate"), purpose: z.enum(["held_qwen", "human_deepseek"]),
    attemptId: id, candidateId: id, repo }).strict(),
  z.object({ kind: z.literal("split"), purpose: z.enum(["qwen_tiebreak", "deepseek_confirm"]),
    tiebreakId: id, candidateId: id, generationKey: hash, repo }).strict(),
]);
export type LocalModelTarget = Readonly<z.infer<typeof localModelTargetSchema>>;

export function localModelLogicalKey(value: LocalModelTarget): string {
  const target = localModelTargetSchema.parse(value);
  if (target.kind === "assist") return `direct:assist:${target.subjectId}:${target.task}`;
  const key = target.kind === "audit" ? target.itemId : target.kind === "published" ? target.secondReviewId
    : target.candidateId;
  return `direct:${target.kind}:${key}:${target.purpose}`;
}

export function localModelRoute(value: LocalModelTarget): string {
  const target = localModelTargetSchema.parse(value);
  return target.kind === "assist" ? `local-assist-${target.task}-${target.backendId}` : `local-${target.purpose.replaceAll("_", "-")}`;
}

/**
 * 대상(purpose)이 정하는 잡 이름 — binding.job 은 그 호출을 띄운 잡 lease 다(dispatchLocalModelCapacity 가 실제 lease 와 같은지, proveLocalModelDomain 이
 * lease 이름이 이 값인지 잰다). 2026-10-31(PR 3a-C) 합성 잡을 단계마다 자기 잡으로 나눠 purpose 하나에 잡 하나다:
 * audit → audit-qwen, second_opinion·published_filter → audit-second-opinion, qwen_tiebreak → split-tiebreak, deepseek_confirm → split-confirm,
 * held_qwen → held-qwen-retry, human_deepseek → human-deepseek-review, screen → audit-screen-review. DB CHECK 는 migration 0155 가 같은 표를 OR 가지로 더한다.
 */
export function localModelJob(value: LocalModelTarget): string {
  const target = localModelTargetSchema.parse(value);
  if (target.kind === "assist") return ["decision_audit", "semantic_exception"].includes(target.task) ? "product-llm-assist-audit-review" : "product-llm-assist-review";
  switch (target.purpose) {
    case "screen": return "audit-screen-review";
    case "audit": return "audit-qwen";
    case "second_opinion": case "published_filter": return "audit-second-opinion";
    case "qwen_tiebreak": return "split-tiebreak";
    case "deepseek_confirm": return "split-confirm";
    case "held_qwen": return "held-qwen-retry";
    default: return "human-deepseek-review";
  }
}

/**
 * 3a-C 전의 합성 잡 이름(audit·second_opinion·published_filter → product-audit, qwen_tiebreak → second-review, held_qwen·deepseek_confirm·human_deepseek →
 * human-deepseek-review). 그 잡이 띄워 둔 행(dispatched·indeterminate·settled)을 새 코드가 읽을 때만 받는다 — 새 dispatch 는 실제 잡 lease 와
 * localModelJob 이 같아야 하므로(local-model-domain.ts) 이 이름으로는 만들어지지 않는다. SQL CHECK 의 0124 가지가 같은 표다.
 */
export function legacyLocalModelJob(value: LocalModelTarget): string {
  const target = localModelTargetSchema.parse(value);
  if (target.kind === "assist" || target.purpose === "screen") return localModelJob(target);
  if (target.purpose === "audit" || target.purpose === "second_opinion" || target.purpose === "published_filter") return "product-audit";
  return target.purpose === "qwen_tiebreak" ? "second-review" : "human-deepseek-review";
}

/** Fresh render provenance; archived crawl metadata remains revision-bound separately. */
export const localModelScreenProofSchema = z.object({
  requestedUrl: z.url().refine(value => /^https?:\/\//.test(value)),
  requestedAt: z.iso.datetime(), receivedAt: z.iso.datetime(), screenshotHash: hash,
}).strict();
export type LocalModelScreenProof = Readonly<z.infer<typeof localModelScreenProofSchema>>;

export function freshLocalModelScreenProof(proof: LocalModelScreenProof | undefined, url: string | null, now = Date.now()): boolean {
  if (!proof || proof.requestedUrl !== url) return false;
  const started = Date.parse(proof.requestedAt), received = Date.parse(proof.receivedAt);
  return Number.isFinite(started) && Number.isFinite(received) && started <= received && received <= now
    && now - received <= 60_000 && now - started <= 120_000;
}

export const localModelBindingSchema = z.object({
  kind: z.literal("local_model_direct"), version: z.literal(1), target: localModelTargetSchema,
  logicalWorkKey: text(160), routeId: text(120), provider: z.literal("local-direct"), model: text(200),
  backendId: text(120), physicalGroup: text(120), deploymentRevision: text(200),
  inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: text(160),
  wireHash: hash, servingContractHash: hash, totalTokenBound: id, chargedTokens: id,
  job: z.object({ name: text(120), token: z.uuid(), requestedVersion: z.number().int().nonnegative().safe() }).strict(),
}).strict().refine(value => value.logicalWorkKey === localModelLogicalKey(value.target)
  && value.routeId === localModelRoute(value.target) && [localModelJob(value.target), legacyLocalModelJob(value.target)].includes(value.job.name)
  && value.totalTokenBound === value.chargedTokens
  && (value.target.kind !== "assist" || value.target.backendId === value.backendId), "invalid_local_model_binding");
export type LocalModelBinding = Readonly<z.infer<typeof localModelBindingSchema>>;

export const localModelDispatchSchema = z.object({
  requestId: z.uuid(), owner: z.object({ instanceId: text(120), bootId: z.uuid() }).strict(), token: z.uuid(),
  epoch: id, revision: id, policyHash: hash, binding: localModelBindingSchema, bindingHash: hash,
}).strict().refine(value => value.bindingHash === localModelBindingHash(value.binding), "invalid_local_model_binding_hash");
export type LocalModelDispatch = ModelCapacityDispatch & Readonly<z.infer<typeof localModelDispatchSchema>>;

export function localModelBindingHash(value: LocalModelBinding): string {
  return createHash("sha256").update(JSON.stringify(localModelBindingSchema.parse(value))).digest("hex");
}

export const localModelTerminalEvidenceSchema = z.object({
  kind: z.literal("local_model_terminal"), version: z.literal(1), dispatch: localModelDispatchSchema,
  responseHash: hash, finishReason: z.enum(["stop", "length", "tool_calls", "function_call", "content_filter"]),
  actualUsage: z.object({ inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe() }).strict().nullable(),
  provenance: z.enum(["upstream_reported", "unknown"]),
}).strict().refine(value => value.actualUsage === null ? value.provenance === "unknown"
  : value.provenance === "upstream_reported" && Number.isSafeInteger(value.actualUsage.inputTokens + value.actualUsage.outputTokens)
    && value.actualUsage.inputTokens + value.actualUsage.outputTokens === value.actualUsage.totalTokens
    && value.actualUsage.totalTokens <= value.dispatch.binding.totalTokenBound, "invalid_local_model_usage");
export type LocalModelTerminalEvidence = Readonly<z.infer<typeof localModelTerminalEvidenceSchema>>;
