import { reviewIndependenceKey, sameReviewModel } from "./review-model-identity";
import { ensureReviewTaskRanks, reviewRanksSummary, secondReviewRankSets, settingsReviewersActive, secondReviewRanks, secondReviewRanksDegraded, secondReviewSlotFallbacks,
  type ReviewRankDegraded, type SecondReviewRanks } from "./review-task-ranks";
import type { CrawlSettings } from "./settings-schema";
import { secondReviewHasWorkloadPool, secondReviewSlotRepresentatives, secondReviewWorkloadSlots } from "./second-review-workload";

/**
 * 2차 투표자·대체 목록의 한 길목. 2차의 모든 읽기(올리기·입력 검증·정리·공개 관문 SQL·보류 재심사·대체 고르기·발견 관문)가 이 함수들을 읽어,
 * 올리는 쪽과 세는 쪽이 같은 목록을 본다.
 *
 * 2026-11-02 소유자 결정(PR C1): 출처는 「작업 ↔ 모델」의 2차 AI 검수 투표자 칸 1·2·3 뿐이다(lib/crawl/review-task-ranks.ts). 칸마다 따로 1·2·3순위가 있고,
 * 그 칸의 1순위를 쓸 수 없으면(계약 없음·닫힘·연결 꺼짐·CLI 계약 없음 — 표를 만들기 전 확인) 그 칸의 2순위가, 그다음 3순위가 표를 낸다.
 * 예전 crawl_settings.secondReview.voters·fallbacks, 배정 표(ai2), 설정 기본 투표자는 읽지 않는다.
 * - 투표자 = 칸마다 지금 표를 내는 순위. 대체 = 그 밖의 순위(목록 검사용 — 대체를 고를 때는 secondReviewFallbacksFor 가 같은 칸 안에서만 고른다).
 * - 한 모델은 한 칸에만 든다(저장이 막는다 — 같은 가중치·연결로 가른 이름 포함). 옛 행·가져오기로 겹쳐도 앞 칸만 쓴다 — 한 모델이 한 항목에 두 표를 내지 않는다.
 * - 1차와 같은 모델도 별도 2차 호출로 쓸 수 있다. 2차 칸 사이의 동일 모델 중복 제외는 유지한다.
 * - 객체는 { provider, model } 두 칸뿐이다 — 2차 행 insert 가 그대로 펼친다. model 은 장부 이름(identity)이다.
 * - AI2 정책 hash(secondReviewPolicyHash)는 저장된 설정을 그대로 hash 한다 — 순위가 바뀌어도 진행 중 2차 receipt 가 hash 로 깨지지 않고,
 *   목록에서 빠진 모델은 입력 검증(secondReviewInputMatches)·정리(closeSettledSecondReviews)가 거른다.
 *
 * 격리 replay(currentReplayDb)·스냅숏 판정(withSettingsReviewers)만 예전처럼 그 설정 행(voters·fallbacks)을 읽는다 — 인증된 replay 입력이고 운영 프로세스는 이 길을 타지 않는다.
 */
export type SecondReviewVoter = CrawlSettings["secondReview"]["voters"][number];

function legacySets(settings: Pick<CrawlSettings, "secondReview">): { voters: SecondReviewVoter[]; fallbacks: SecondReviewVoter[] } {
  return { voters: settings.secondReview.voters, fallbacks: settings.secondReview.fallbacks ?? [] };
}

/** 지금 고르기의 투표자·대체와 출처. */
export function secondReviewVoterSets(settings: Pick<CrawlSettings, "secondReview">):
  { voters: SecondReviewVoter[]; fallbacks: SecondReviewVoter[]; source: "ranks" | "replay" } {
  if (settingsReviewersActive()) return { ...legacySets(settings), source: "replay" };
  return { ...(secondReviewHasWorkloadPool() ? secondReviewSlotRepresentatives() : secondReviewRankSets()), source: "ranks" };
}

/** 2차 투표자(칸마다 지금 표를 내는 순위) — 예전 `settings.secondReview.voters` 자리. */
export const secondReviewVoters = (settings: Pick<CrawlSettings, "secondReview">): SecondReviewVoter[] => secondReviewVoterSets(settings).voters;
/** 2차 대체(투표자 밖의 순위) — 예전 `settings.secondReview.fallbacks ?? []` 자리. 목록 검사용이다 — 고르기는 secondReviewFallbacksFor. */
export const secondReviewFallbacks = (settings: Pick<CrawlSettings, "secondReview">): SecondReviewVoter[] => secondReviewVoterSets(settings).fallbacks;

/**
 * 첫 표(root) 모델의 대체 차례 — 같은 투표자 칸의 다음 순위들(쓸 수 있는 것, 순위 차례). 다른 칸의 모델은 들지 않는다(대체 목록을 투표자 모두가 나눠 쓰던
 * 예전과 달리 한 모델이 한 항목에 두 표를 내지 않는다). 부르는 쪽이 이미 표를 낸 모델·투표자를 다시 뺀다(런타임 가드).
 * 격리 replay 는 예전 설정의 대체 목록 그대로다.
 */
export function secondReviewFallbacksFor(settings: Pick<CrawlSettings, "secondReview">, rootModel: string | null | undefined): SecondReviewVoter[] {
  if (settingsReviewersActive()) return legacySets(settings).fallbacks;
  if (!rootModel) return [];
  if (secondReviewHasWorkloadPool()) {
    const slot = secondReviewWorkloadSlots()[0];
    // Pool alternatives are never fallback retries for the same vote. Keep its saved legacy fallback chain.
    const primary = slot.legacy.find(candidate => candidate.binding && !candidate.unusable);
    return slot.legacy.flatMap(candidate => candidate !== primary && candidate.binding && !candidate.unusable
      && !sameReviewModel(candidate.binding.identity, rootModel)
      ? [{ provider: candidate.binding.provider, model: candidate.binding.identity }] : []);
  }
  return secondReviewSlotFallbacks(rootModel);
}

/** 2차가 지금 표를 낼 수 있는가 — 순위 없음·표 못 읽음·모든 칸을 쓸 수 없음이면 그 degraded(잡이 그대로 적는다). replay 는 늘 null. */
export function secondReviewVotersDegraded(ranks?: SecondReviewRanks): ReviewRankDegraded | null {
  if (settingsReviewersActive()) return null;
  return secondReviewRanksDegraded(ranks ?? secondReviewRanks());
}

/** 런타임 가드: 이 항목에 표를 낸·내는 중인 모델과 같은 모델(같은 가중치·연결로 가른 이름 포함)은 대체가 될 수 없다. */
export function withoutTakenModels<T extends { model: string }>(candidates: readonly T[], taken: readonly (string | null | undefined)[]): T[] {
  const keys = new Set(taken.flatMap(model => model ? [reviewIndependenceKey(model)] : []));
  return candidates.filter(candidate => !keys.has(reviewIndependenceKey(candidate.model)));
}

/**
 * 2차 틱 머리의 순위 사정: 스냅숏을 기다린 뒤 degraded(없으면 null)와 틱 요약(ai_task.ranks — 칸마다 지금 표를 내는 순위 = served).
 * 격리 replay 는 null(설정 행을 읽는다).
 */
export async function secondReviewRankTick(): Promise<{ degraded: ReviewRankDegraded | null; summary: Record<string, number> } | null> {
  if (settingsReviewersActive()) return null;
  await ensureReviewTaskRanks();
  const ranks = secondReviewRanks();
  const served = new Map<number, number>();
  for (const slot of ranks.slots) if (slot.voter && slot.resolution.execution?.mode !== 'workload_pool')
    served.set(slot.voter.rank, (served.get(slot.voter.rank) ?? 0) + 1);
  // A pool's configured eligible representative is not evidence of an actual successful consumer call.
  return { degraded: secondReviewRanksDegraded(ranks), summary: reviewRanksSummary(ranks.slots.map(slot => slot.resolution), served) };
}
