import { modelCandidates, modelRequestName, type ModelEnvironment } from "@/lib/llm/model-registry";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { FirstReviewer } from "./agent-review";
import { sameUnderlyingModel } from "./review-model-identity";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel, type ModelCapacityDeferredReason } from "@/lib/llm/capacity-deferred";
import { z } from "zod";

const poolPositionSchema = z.object({ id: z.number().int().positive().safe(), reviewed: z.boolean(),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/), ceiling: z.number().int().positive().safe() });
export type FirstReviewPoolPosition = z.infer<typeof poolPositionSchema>;
export type FirstReviewCursor = { [key: string]: unknown; firstReviewPoolScan?: FirstReviewPoolPosition | null };
export function firstReviewPoolPosition(value: unknown): FirstReviewPoolPosition | null {
  const parsed = poolPositionSchema.safeParse(value);
  return parsed.success && parsed.data.id <= parsed.data.ceiling ? parsed.data : null;
}

export type FirstReviewSettings = { firstReview?: FirstReviewer; firstReviewAdditional?: FirstReviewer[] };

/** The original selector remains primary; adding workers never replaces its completed decisions. */
export function firstReviewers(settings: FirstReviewSettings, fallback: FirstReviewer | null = null): FirstReviewer[] {
  const primary = settings.firstReview ?? fallback;
  if (!primary) return [];
  const pool = [primary];
  for (const reviewer of settings.firstReviewAdditional ?? []) {
    if (!pool.some(existing => sameUnderlyingModel(existing.model, reviewer.model)) && pool.length < 3) pool.push(reviewer);
  }
  return pool;
}

export const firstReviewerKey = (reviewer: { provider: string; model: string }): string => JSON.stringify([reviewer.provider, reviewer.model]);
export const hasFirstReviewer = (pool: FirstReviewer[], reviewer: { provider: string | null; model: string | null }): boolean =>
  pool.some(current => current.provider === reviewer.provider && current.model === reviewer.model);

export function firstReviewIdentitySql(pool: FirstReviewer[], columns: { provider: SQLWrapper; model: SQLWrapper }): SQL {
  return pool.length ? sql`(${sql.join(pool.map(reviewer => sql`(${columns.provider} = ${reviewer.provider} AND ${columns.model} = ${reviewer.model})`), sql` OR `)})` : sql`false`;
}

/**
 * Pin active intents and retries before assigning untouched candidates. No state is reclaimed here.
 * Only a candidate with no intent and no attempt at all (`untouched`) may skip a blocked model,
 * rotating from its fixed slot. If every model is blocked it keeps the fixed slot and waits.
 */
export function selectFirstReviewer(pool: FirstReviewer[], candidateId: number,
  attempts: { provider: string | null; model: string | null }[] = [],
  active: { provider: string | null; model: string | null }[] = [],
  avoid: { blocked: ReadonlySet<string>; untouched: boolean } = { blocked: new Set(), untouched: false }): FirstReviewer | null {
  if (!pool.length || !Number.isSafeInteger(candidateId) || candidateId < 1) return null;
  if (active.length) {
    const identities = new Set(active.map(row => JSON.stringify([row.provider, row.model])));
    if (identities.size !== 1 || !hasFirstReviewer(pool, active[0])) return null;
    return pool.find(row => row.provider === active[0].provider && row.model === active[0].model)!;
  }
  // The latest sent attempt pins a retry even if its model was removed from the pool.
  if (attempts.length) return pool.find(row => row.provider === attempts[0].provider && row.model === attempts[0].model) ?? null;
  const start = (candidateId - 1) % pool.length;
  if (avoid.untouched && attempts.length === 0) for (let offset = 0; offset < pool.length; offset++) {
    const reviewer = pool[(start + offset) % pool.length];
    if (!avoid.blocked.has(firstReviewerKey(reviewer))) return reviewer;
  }
  return pool[start];
}

/**
 * Only known model/route-local refusals may leave other models running.
 * `capacity` 는 이제 진짜 포화(이 요청이 줄에 섰다)만 뜻한다 — 한 후보의 fence 거절은 `work_busy` 로 따로 오고(capacityRefusalReason),
 * 호출자는 이 판정 전에 그 후보만 건너뛴다(modelCapacityDeferralIsPerWork). 2026-10-30 결정: 한 후보가 모델을 멈추지 않는다.
 * 2026-10-31(PR 3a-B): 사유 범위 표(capacity-deferred.ts)의 `model` 범위와 같다 — `withdrawn`·`reservation_lost` 는 요청 하나의 일(`work`)이라
 * 모델을 멈추지 않고 그 후보만 넘긴다.
 */
export const firstReviewDeferralIsLocal = (reason: ModelCapacityDeferredReason): boolean => modelCapacityDeferralIsPerModel(reason);

export class FirstReviewModelDeferredError extends ModelCapacityDeferredError {
  constructor(reason: ModelCapacityDeferredReason, readonly reviewer: FirstReviewer) { super(reason); }
}

/** Suggestions only. Stored primary/additional selections and retry pinning remain authoritative. */
export function firstReviewCandidates(env: ModelEnvironment = process.env): FirstReviewer[] {
  return modelCandidates("first-review", env).map(model => {
    if (!["abcllm", "claude-cli", "grok-cli", "local-direct"].includes(model.provider)) throw new Error(`first_review_candidate_provider_unsupported:${model.key}`);
    return { provider: model.provider as FirstReviewer["provider"], model: modelRequestName(model) };
  });
}
