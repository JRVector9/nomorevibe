import { legacyFirstReviewers } from "@/lib/crawl/first-reviewers";
import { setReviewRanksForTest, type ReviewRankReviewer } from "@/lib/crawl/review-task-ranks";

/**
 * 시험용 1차·2차 「작업 ↔ 모델」 순위(PR C1). 실행 쪽은 순위만 읽는다 — 시험은 묶기가 끝난 순위(심사자 목록)를 고정한다.
 * 묶기(연결 → 계약 → 장부 이름) 자체는 tests/review-task-ranks.test.ts 가 실제 스냅숏으로 본다.
 *
 * - pinReviewRanks({ first: [1순위, 2순위…], second: [[칸 1 의 1·2·3순위], [칸 2 …]] })
 * - pinReviewRanksFromSettings(settings): 예전 설정 꼴(firstReview·firstReviewAdditional·secondReview.voters·fallbacks)을 순위로 옮긴다 —
 *   1차 = 옛 풀 차례, 2차 = 투표자 k → 칸 k 의 1순위, 옛 대체 → 칸 1 의 2·3순위(한 모델은 한 칸 — 실행 쪽도 다른 칸의 모델을 대체로 쓰지 않는다).
 * - null 이면 푼다(afterEach 에서 부른다).
 */
type Reviewer = { provider: string; model: string };
const reviewer = (value: Reviewer): ReviewRankReviewer => ({ provider: value.provider as ReviewRankReviewer["provider"], model: value.model });

export function pinReviewRanks(value: { first?: readonly Reviewer[]; second?: readonly (readonly Reviewer[])[] } | null): void {
  if (value === null) { setReviewRanksForTest(null); return; }
  setReviewRanksForTest({ first: (value.first ?? []).map(reviewer), second: (value.second ?? []).map(slot => slot.map(reviewer)) });
}

type LegacySettings = { firstReview?: Reviewer; firstReviewAdditional?: readonly Reviewer[];
  secondReview?: { voters?: readonly Reviewer[]; fallbacks?: readonly Reviewer[] } };
function ranksOf(settings: LegacySettings | null | undefined) {
  const first = settings ? legacyFirstReviewers({ firstReview: settings.firstReview as never, firstReviewAdditional: settings.firstReviewAdditional as never }) : [];
  const voters = settings?.secondReview?.voters ?? [], fallbacks = settings?.secondReview?.fallbacks ?? [];
  return { first: first.map(reviewer), second: voters.map((voter, index) => (index === 0 ? [voter, ...fallbacks].slice(0, 3) : [voter]).map(reviewer)) };
}
/** 설정 값 하나로 고정하거나, 함수를 주면 부를 때마다 그 설정을 읽는다(시험이 mocks.settings 를 바꿔 끼울 때) */
export function pinReviewRanksFromSettings(settings: LegacySettings | (() => LegacySettings | null | undefined)): void {
  setReviewRanksForTest(typeof settings === "function" ? () => ranksOf(settings()) : ranksOf(settings));
}
