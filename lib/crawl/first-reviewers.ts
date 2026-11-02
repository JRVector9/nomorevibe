import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { FirstReviewer } from "./agent-review";
import { sameUnderlyingModel } from "./review-model-identity";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel, type ModelCapacityDeferredReason } from "@/lib/llm/capacity-deferred";
import { firstReviewRanks, firstReviewRanksDegraded, settingsReviewersActive, type ReviewRankDegraded, type ReviewRankResolution } from "./review-task-ranks";
import { z } from "zod";

const poolPositionSchema = z.object({ id: z.number().int().positive().safe(), reviewed: z.boolean(),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/), ceiling: z.number().int().positive().safe() });
export type FirstReviewPoolPosition = z.infer<typeof poolPositionSchema>;
export type FirstReviewCursor = { [key: string]: unknown; firstReviewPoolScan?: FirstReviewPoolPosition | null };
export function firstReviewPoolPosition(value: unknown): FirstReviewPoolPosition | null {
  const parsed = poolPositionSchema.safeParse(value);
  return parsed.success && parsed.data.id <= parsed.data.ceiling ? parsed.data : null;
}

/** 옛 설정의 1차 칸(crawl_settings.firstReview·firstReviewAdditional) — 실행 쪽은 읽지 않는다(PR C1). 가져오기·격리 replay 만 읽는다. */
export type FirstReviewSettings = { firstReview?: FirstReviewer; firstReviewAdditional?: FirstReviewer[] };

/**
 * 「지금 1차 심사자」 — 「작업 ↔ 모델」의 1차 AI 검수 1·2·3순위(2026-11-02 소유자 결정, PR C1, lib/crawl/review-task-ranks.ts). 순위 차례이고 객체는
 * { provider, model } 두 칸뿐이다(binding hash). model 은 장부 이름(identity — 같은 모델을 다른 연결에도 두면 `<모델>@<연결 8자>`)이다. 목록 전체가
 * 「지금 1차 심사자」다 — 2·3순위의 결과도 유효하고(hasFirstReviewer·firstReviewIdentitySql) route 목록에도 든다. 쓸 수 없는 순위(계약은 있는데 닫힘·CLI
 * 계약 없음)도 identity 를 알면 목록에 남고 고르기가 비켜 간다(firstReviewRankState().unusable). 예전의 firstReview·firstReviewAdditional·배정 표(ai1)·
 * 등록부 기본 후보·단일/풀 모드 구분은 없다 — 늘 순위 고르기(selectFirstReviewer)다.
 *
 * 격리 replay(currentReplayDb)·스냅숏 판정(withSettingsReviewers)만 예전처럼 그 설정 행을 읽는다 — 인증된 replay 입력(manifest 가 선언한 모델)이고 운영 프로세스는 이 길을 타지 않는다.
 * settings 인자는 그 replay 길에만 쓴다.
 */
export function firstReviewers(settings?: FirstReviewSettings): FirstReviewer[] {
  if (settingsReviewersActive()) return legacyFirstReviewers(settings ?? {});
  return firstReviewRanks().pool.map(reviewer => ({ provider: reviewer.provider, model: reviewer.model }));
}

/** 1차 순위의 지금 사정 — 고르기가 비켜 갈 쓸 수 없는 심사자(firstReviewerKey → 까닭)와, 부를 순위가 없을 때의 degraded(잡이 그대로 적는다). */
export type FirstReviewRankState = Readonly<{ pool: FirstReviewer[]; unusable: ReadonlyMap<string, string>; degraded: ReviewRankDegraded | null;
  resolution: ReviewRankResolution | null }>;
export function firstReviewRankState(settings?: FirstReviewSettings): FirstReviewRankState {
  if (settingsReviewersActive()) return Object.freeze({ pool: legacyFirstReviewers(settings ?? {}), unusable: new Map(), degraded: null, resolution: null });
  const ranks = firstReviewRanks();
  return Object.freeze({ pool: ranks.pool.map(reviewer => ({ provider: reviewer.provider, model: reviewer.model })),
    // 열쇠 꼴이 firstReviewerKey 와 같다(JSON [provider, model])
    unusable: new Map(ranks.unusable),
    degraded: firstReviewRanksDegraded(ranks), resolution: ranks.resolution });
}

/**
 * 옛 설정만으로 고른 1차 풀(순수). 실행 쪽은 읽지 않는다 — 「작업 ↔ 모델」 가져오기(lib/operations/admin-ai-task-current.ts)·배정 표 가져오기·
 * 격리 replay 만 쓴다. firstReview 가 1순위, firstReviewAdditional 이 2·3순위(같은 가중치는 한 번, 최대 3).
 */
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
 * 1차 심사자 고르기(순수) — 순위 대체(2026-11-01 운영자 결정). 풀은 순위 순서다: 「작업 ↔ 모델」의 1차 AI 검수 1·2·3순위(PR C1).
 * 10-28 의 「보낸 일은 옮기지 않는다」와 후보 id 로 풀 전체에 나누던 고정 칸은 없앴다
 * (docs/operations/review-stall-backlog.md).
 * 1. 살아 있는 의도(active — 고르기가 기한 안의 reserved·dispatched 와 풀 모델의 waiting 만 넘긴다)는 그 모델에 묶는다. 둘 이상이거나 풀 밖이면 null(기다린다).
 * 2. 마지막 시도가 지금 보내진 중(live)이면 그 모델에 묶는다 — 풀에서 빠졌으면 null. 같은 후보에 살아 있는 호출을 둘 만들지 않는다.
 * 3. 아니면 이 틱에 쓸 수 있는(막히지·쉬지 않은) 가장 높은 순위. 모두 쓸 수 없으면 null — 잡이 all_ranks_unusable 로 건너뛰고 대기열은 지나간다.
 * 끝난 재시도는 모델에 묶지 않는다 — 시도 예산·재시도 시각은 모델과 무관하게 이어진다(retryReviewIdentity). candidateId 는 모양 검사에만 쓴다.
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
