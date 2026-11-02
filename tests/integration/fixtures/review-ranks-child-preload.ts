/**
 * 자식 프로세스(scripts/*.ts)용 1차·2차 「작업 ↔ 모델」 순위 고정(PR C1). 시험 프로세스는 tests/integration/env.ts 가 순위를 고정하지만, spawn 한 스크립트는
 * 그 shim 을 거치지 않아 시험 DB 의 빈 순위 표를 읽는다. `node --import tsx --import ./tests/integration/fixtures/review-ranks-child-preload.ts <script>` 로
 * 올리면 NMV_TEST_REVIEW_RANKS(JSON { first: [심사자…], second: [[칸 1 의 1·2·3순위], …] })를 lib/crawl/review-task-ranks.ts 가 읽는 고정 자리
 * (globalThis.__nmvReviewRanksPin — setReviewRanksForTest 와 같은 자리)에 둔다. lib 모듈은 import 하지 않는다(스크립트의 import 순서를 바꾸지 않게).
 */
type Reviewer = { provider: string; model: string };
const raw = process.env.NMV_TEST_REVIEW_RANKS;
if (raw) {
  const value = JSON.parse(raw) as { first?: Reviewer[]; second?: Reviewer[][] };
  (globalThis as unknown as { __nmvReviewRanksPin?: unknown }).__nmvReviewRanksPin = { first: value.first ?? [], second: value.second ?? [] };
}
export {};
