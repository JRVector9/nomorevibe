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

/**
 * 1차 고르기가 읽는 이 입력의 가장 최근 모델 시도. live 는 지금 보내진 중일 수 있는 시도(running 이고 그 공급자의 호출 기한 + 여유 안에 시작)다 —
 * 고르기(chooseFirstReviewForCandidate)가 DB 시각으로 채운다. 없으면 보내진 중이 아니다.
 */
export type FirstReviewAttemptIdentity = { provider: string | null; model: string | null; state?: string | null; live?: boolean };
/** 이 틱에 쓸 수 없는 모델(firstReviewerKey): 미확인 점유로 꽉 찬 모델·이 틱에 쉬는 모델. claim 재확인에서는 고른 모델 말고 모두다. */
export type FirstReviewAvoid = { blocked: ReadonlySet<string> };

/**
 * 1차 심사자 고르기(순수) — 순위 대체(2026-11-01 운영자 결정). 풀은 순위 순서다: 설정 풀(배정 표가 꺼졌을 때)은 firstReview 가 1순위,
 * firstReviewAdditional 이 적은 순서대로 2·3순위다. 10-28 의 「보낸 일은 옮기지 않는다」와 후보 id 로 풀 전체에 나누던 고정 칸은 없앴다
 * (docs/operations/review-stall-backlog.md).
 * 1. 살아 있는 의도(active — 고르기가 기한 안의 reserved·dispatched 와 풀 모델의 waiting 만 넘긴다)는 그 모델에 묶는다. 둘 이상이거나 풀 밖이면 null(기다린다).
 * 2. 마지막 시도가 지금 보내진 중(live)이면 그 모델에 묶는다 — 풀에서 빠졌으면 null. 같은 후보에 살아 있는 호출을 둘 만들지 않는다.
 * 3. 아니면 이 틱에 쓸 수 있는(막히지·쉬지 않은) 가장 높은 순위. 모두 쓸 수 없으면 null — 잡이 all_ranks_unusable 로 건너뛰고 대기열은 지나간다.
 * 끝난 재시도는 모델에 묶지 않는다 — 시도 예산·재시도 시각은 모델과 무관하게 이어진다(retryReviewIdentity). candidateId 는 배정 표의 같은 순위 안 나눔에만 쓴다.
 */
export function selectFirstReviewer(pool: FirstReviewer[], candidateId: number,
  attempts: FirstReviewAttemptIdentity[] = [],
  active: { provider: string | null; model: string | null }[] = [],
  avoid: FirstReviewAvoid = { blocked: new Set() }): FirstReviewer | null {
  if (!pool.length || !Number.isSafeInteger(candidateId) || candidateId < 1) return null;
  if (active.length) {
    const identities = new Set(active.map(row => JSON.stringify([row.provider, row.model])));
    if (identities.size !== 1 || !hasFirstReviewer(pool, active[0])) return null;
    return pool.find(row => row.provider === active[0].provider && row.model === active[0].model)!;
  }
  const latest = attempts[0];
  if (latest?.live === true) return pool.find(row => row.provider === latest.provider && row.model === latest.model) ?? null;
  return pool.find(reviewer => !avoid.blocked.has(firstReviewerKey(reviewer))) ?? null;
}

/**
 * 배정 표 판 selectFirstReviewer(PR 3b-B, 순수). 규칙은 같다 — 살아 있는 의도·보내진 중인 시도는 표의 어느 행(대체 포함)이든 그 심사자에 묶고,
 * 아니면 chooseModelForItem: 가장 낮은 rank 의 쓸 수 있는 행들에서 (candidateId − 1) mod n 칸부터(같은 순위 안 나눔), 그 rank 가 모두
 * 막혔으면 다음 rank. 모두 막혔으면 null.
 */
export function selectTableFirstReviewer(rows: readonly FirstReviewTableRow[], candidateId: number,
  attempts: FirstReviewAttemptIdentity[] = [],
  active: { provider: string | null; model: string | null }[] = [],
  avoid: FirstReviewAvoid = { blocked: new Set() }): FirstReviewer | null {
  const usable = stageTableRows("ai1", rows), pool = tableFirstReviewers(usable);
  if (!pool.length || !Number.isSafeInteger(candidateId) || candidateId < 1) return null;
  if (active.length) {
    const identities = new Set(active.map(row => JSON.stringify([row.provider, row.model])));
    if (identities.size !== 1 || !hasFirstReviewer(pool, active[0])) return null;
    return pool.find(row => row.provider === active[0].provider && row.model === active[0].model)!;
  }
  const latest = attempts[0];
  if (latest?.live === true) return pool.find(row => row.provider === latest.provider && row.model === latest.model) ?? null;
  // 같은 모델 이름이 다른 공급자로 있을 수 있어 행 단위로 거른다(chooseModelForItem 의 excludeModels 는 모델 이름이다)
  const open = usable.filter(row => !avoid.blocked.has(firstReviewerKey(row)));
  const pick = chooseModelForItem(open, candidateId);
  return pick ? tableReviewer(pick) : null;
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
