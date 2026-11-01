import { modelCandidates, modelRequestName, type ModelEnvironment } from "@/lib/llm/model-registry";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { FirstReviewer } from "./agent-review";
import { sameUnderlyingModel } from "./review-model-identity";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel, type ModelCapacityDeferredReason } from "@/lib/llm/capacity-deferred";
import type { ModelAssignmentRow } from "@/lib/llm/capacity-helpers";
import { chooseModelForItem, stageTableRows } from "@/lib/llm/stage-assignments";
import { noteAssignmentOnce, stageAssignmentRows } from "@/lib/llm/stage-assignment-snapshot";
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

/** 배정 표(PR 3b-B)에서 1차 고르기가 읽는 칸. */
export type FirstReviewTableRow = Pick<ModelAssignmentRow, "assignmentId" | "stage" | "rank" | "role" | "mode" | "model" | "provider" | "vote">;
const tableReviewer = (row: Pick<FirstReviewTableRow, "provider" | "model">): FirstReviewer =>
  ({ provider: row.provider as FirstReviewer["provider"], model: row.model });

/**
 * 배정 표 행 → 1차 심사자 목록(순수). ai1 · primary · live · FirstReviewer 공급자 행을 rank → assignment_id 순으로, 같은 (공급자, 모델)은 한 번.
 * rank 1 이 분담 풀, rank ≥ 2 는 대체(selectTableFirstReviewer 가 막힌 모델을 비켜 갈 때만 고른다). 목록 전체가 「지금 1차 심사자」다 —
 * 대체 모델의 결과도 유효하고(hasFirstReviewer·firstReviewIdentitySql) route 목록에도 든다. 객체는 { provider, model } 두 칸뿐이다(binding hash).
 */
export function tableFirstReviewers(rows: readonly FirstReviewTableRow[]): FirstReviewer[] {
  const pool: FirstReviewer[] = [];
  for (const row of stageTableRows("ai1", rows))
    if (!pool.some(other => other.provider === row.provider && other.model === row.model)) pool.push(tableReviewer(row));
  return pool;
}

/**
 * 배정 표가 1차 고르기의 출처인가(PR 3b-B): 스위치가 켜졌고 쓸 수 있는 ai1 live 행이 있으며, 설정이 분담 풀 모드(`firstReviewAdditional` 이 있다, [] 도 된다)일 때
 * 그 행들, 아니면 null(예전 firstReview·firstReviewAdditional). 풀 모드를 요구하는 이유: 1차 consumer·legacy 잡(PR 3a 소유 파일)이 풀 모드에서만
 * 후보마다 chooseFirstReviewForCandidate 로 고르고 모델별로 쉰다 — 단일 모드에서는 firstReviewer(settings) 하나로 보낸다.
 * 풀 모드가 아니면 프로세스마다 한 번 `assignment_table_pool_mode_off:ai1` 을 남긴다.
 */
export function firstReviewTableRows(settings: FirstReviewSettings): readonly FirstReviewTableRow[] | null {
  const rows = stageAssignmentRows("ai1");
  if (!rows) return null;
  if (settings.firstReviewAdditional === undefined) { noteAssignmentOnce("assignment_table_pool_mode_off:ai1"); return null; }
  return rows;
}

/** The original selector remains primary; adding workers never replaces its completed decisions.
 * 배정 표가 출처면(firstReviewTableRows) 그 표의 심사자 목록이고 firstReview·firstReviewAdditional·fallback 은 보지 않는다. */
export function firstReviewers(settings: FirstReviewSettings, fallback: FirstReviewer | null = null): FirstReviewer[] {
  const table = firstReviewTableRows(settings);
  if (table) return tableFirstReviewers(table);
  return legacyFirstReviewers(settings, fallback);
}

/** 예전 설정만으로 고른 1차 풀(순수 — 배정 표 스냅숏을 보지 않는다). 배정 표 가져오기(lib/llm/assignment-import.ts)가 오늘 풀을 이것으로 읽는다. */
export function legacyFirstReviewers(settings: FirstReviewSettings, fallback: FirstReviewer | null = null): FirstReviewer[] {
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

/** 1차 고르기가 읽는 이 입력의 가장 최근 모델 시도. state 를 모르면(옛 호출자) 끝났다고 보지 않는다. */
export type FirstReviewAttemptIdentity = { provider: string | null; model: string | null; state?: string | null };
/**
 * 풀에서 빠진 모델의 시도를 지금 풀의 고정 칸으로 다시 배정해도 되는가. 끝난 시도(failed·superseded·succeeded)는 보낸 일이 남아 있지 않다 —
 * 막을 것이 없는데 null 로 두면 그 후보는 대기열에 남은 채 매 틱 조용히 건너뛰어진다(2026-11-01 AI1 정체: admitted 14 · calls 0).
 * 진행 중(running)·상태 모름·식별 불가(provider/model 없음)는 그대로 보호한다(null). 시도 예산은 모델과 무관하게 이어진다(retryReviewIdentity).
 */
const settledRemovedAttempt = (attempt: FirstReviewAttemptIdentity): boolean => typeof attempt.provider === "string"
  && typeof attempt.model === "string" && (attempt.state === "failed" || attempt.state === "superseded" || attempt.state === "succeeded");

/**
 * Pin active intents and retries before assigning untouched candidates. No state is reclaimed here.
 * Only a candidate with no intent and no attempt at all (`untouched`) may skip a blocked model,
 * rotating from its fixed slot. If every model is blocked it keeps the fixed slot and waits.
 */
export function selectFirstReviewer(pool: FirstReviewer[], candidateId: number,
  attempts: FirstReviewAttemptIdentity[] = [],
  active: { provider: string | null; model: string | null }[] = [],
  avoid: { blocked: ReadonlySet<string>; untouched: boolean } = { blocked: new Set(), untouched: false }): FirstReviewer | null {
  if (!pool.length || !Number.isSafeInteger(candidateId) || candidateId < 1) return null;
  if (active.length) {
    const identities = new Set(active.map(row => JSON.stringify([row.provider, row.model])));
    if (identities.size !== 1 || !hasFirstReviewer(pool, active[0])) return null;
    return pool.find(row => row.provider === active[0].provider && row.model === active[0].model)!;
  }
  const start = (candidateId - 1) % pool.length;
  // The latest attempt pins a retry to its model. A settled attempt of a model removed from the pool
  // takes the fixed slot (no blocked-model rotation: it is not untouched); an unsettled or unreadable one stays protected.
  if (attempts.length) return pool.find(row => row.provider === attempts[0].provider && row.model === attempts[0].model)
    ?? (settledRemovedAttempt(attempts[0]) ? pool[start] : null);
  if (avoid.untouched && attempts.length === 0) for (let offset = 0; offset < pool.length; offset++) {
    const reviewer = pool[(start + offset) % pool.length];
    if (!avoid.blocked.has(firstReviewerKey(reviewer))) return reviewer;
  }
  return pool[start];
}

/**
 * 배정 표 판 selectFirstReviewer(PR 3b-B, 순수). 고정(활성 의도·재시도)은 같다 — 표의 어느 행(대체 포함)이든 그 심사자에 묶는다.
 * 새 후보는 chooseModelForItem 의 칸: 가장 낮은 rank 의 행들에서 (candidateId − 1) mod n. 손대지 않은 후보만 막힌 모델(blocked)을 비켜 가고,
 * 그 rank 가 모두 막혔으면 다음 rank(대체)로 간다. 모두 막혔으면 고정 칸에서 기다린다.
 */
export function selectTableFirstReviewer(rows: readonly FirstReviewTableRow[], candidateId: number,
  attempts: FirstReviewAttemptIdentity[] = [],
  active: { provider: string | null; model: string | null }[] = [],
  avoid: { blocked: ReadonlySet<string>; untouched: boolean } = { blocked: new Set(), untouched: false }): FirstReviewer | null {
  const usable = stageTableRows("ai1", rows), pool = tableFirstReviewers(usable);
  if (!pool.length || !Number.isSafeInteger(candidateId) || candidateId < 1) return null;
  if (active.length) {
    const identities = new Set(active.map(row => JSON.stringify([row.provider, row.model])));
    if (identities.size !== 1 || !hasFirstReviewer(pool, active[0])) return null;
    return pool.find(row => row.provider === active[0].provider && row.model === active[0].model)!;
  }
  const fixed = chooseModelForItem(usable, candidateId);
  if (attempts.length) return pool.find(row => row.provider === attempts[0].provider && row.model === attempts[0].model)
    ?? (settledRemovedAttempt(attempts[0]) && fixed ? tableReviewer(fixed) : null);
  if (avoid.untouched && avoid.blocked.size) {
    const excludeModels = usable.filter(row => avoid.blocked.has(firstReviewerKey(row))).map(row => row.model);
    const rerouted = chooseModelForItem(usable, candidateId, { excludeModels });
    if (rerouted) return tableReviewer(rerouted);
  }
  return fixed ? tableReviewer(fixed) : null;
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
