import { TEST_DATABASE_URL } from "./setup";
import postgres from "postgres";
import { afterAll, beforeEach, vi } from "vitest";

// Existing server metadata fixtures run without a Next request and target Korean.
vi.mock("@/lib/i18n/server", () => ({ getRequestLocale: async () => "ko" }));

/**
 * 1차·2차 심사자(PR C1): 실행 쪽은 「작업 ↔ 모델」 순위만 읽는다. 통합 시험 대부분은 심사 파이프라인(장부·소유·기록)을 보고, 심사자는 시험이 넣은 크롤 설정
 * (firstReview·firstReviewAdditional·secondReview.voters·fallbacks)으로 정해 왔다. 그 시험들이 같은 심사자로 돌도록, 이 프로세스가 마지막으로 읽은 설정을
 * 순위로 옮겨 고정한다(묶기가 끝난 순위 — lib/crawl/review-task-ranks.ts setReviewRanksForTest 와 같은 자리, tests/review-task-ranks-fixture.ts 와 같은 대응:
 * 1차 = 옛 풀 차례, 2차 = 투표자 k → 칸 k 의 1순위, 옛 대체 → 칸 1 의 2·3순위). lib 모듈을 여기서 import 하지 않는다(시험 파일의 vi.mock 보다 먼저 올라가지 않게) —
 * 고정 자리는 globalThis 의 같은 이름이다. 순위 표·계약 묶기 자체를 보는 시험은 그 시험 안에서 pinReviewRanks(null) 로 이 고정을 푼다(다음 시험 앞에 다시 깔린다).
 */
type LegacyReviewer = { provider: string; model: string };
type LegacyReviewSettings = { firstReview?: LegacyReviewer; firstReviewAdditional?: LegacyReviewer[];
  secondReview?: { voters?: LegacyReviewer[]; fallbacks?: LegacyReviewer[] } } | undefined;
const reviewGlobals = globalThis as unknown as { __nmvTestLastSettings?: LegacyReviewSettings; __nmvReviewRanksPin?: unknown };
const bareModel = (model: string) => model.trim().replace(/@[0-9a-f]{8}$/, "").replace(/^\[[^\]]*\]\s*/, "").replace(/^[^/\s]+\//, "").toLowerCase();
function settingsRanks(settings: LegacyReviewSettings) {
  const first: LegacyReviewer[] = [];
  if (settings?.firstReview) {
    first.push(settings.firstReview);
    for (const reviewer of settings.firstReviewAdditional ?? [])
      if (first.length < 3 && !first.some(existing => bareModel(existing.model) === bareModel(reviewer.model))) first.push(reviewer);
  }
  const voters = settings?.secondReview?.voters ?? [], fallbacks = settings?.secondReview?.fallbacks ?? [];
  return { first, second: voters.map((voter, index) => (index === 0 ? [voter, ...fallbacks] : [voter]).slice(0, 3)) };
}
vi.mock("@/lib/crawl/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crawl/settings")>();
  const remember = <T,>(value: T): T => { reviewGlobals.__nmvTestLastSettings = value as LegacyReviewSettings; return value; };
  return { ...actual,
    mergeWithDefaults: ((value: unknown) => remember(actual.mergeWithDefaults(value as never))) as typeof actual.mergeWithDefaults,
    getSettings: (async () => remember(await actual.getSettings())) as typeof actual.getSettings,
    saveSettings: (async (...args: Parameters<typeof actual.saveSettings>) => {
      const result = await actual.saveSettings(...args);
      if (result.ok) remember(result.settings);
      return result;
    }) as typeof actual.saveSettings };
});
beforeEach(() => { reviewGlobals.__nmvReviewRanksPin = () => settingsRanks(reviewGlobals.__nmvTestLastSettings); });

// lib/db는 첫 쿼리 시점에 초기화되므로, import 순서와 무관하게 여기서 지정하면 된다
process.env.DATABASE_URL = TEST_DATABASE_URL;

// 통합 테스트는 외부 fetch를 목킹하므로 SSRF 가드의 DNS 조회를 태울 이유가 없다.
// 가드 자체는 tests/ssrf.test.ts가 실제 네트워크로 검증한다.
process.env.ALLOW_PRIVATE_URLS = "1";

// 테스트 출력에 로그가 섞이지 않도록
process.env.LOG_LEVEL = "error";

/**
 * 파일이 끝나면 그 파일이 잡아 둔 잡 lease 를 푼다. 통합 테스트에는 진짜 worker 가 없으므로 파일이 끝난 뒤 남은
 * lease 는 모두 fixture 가 남긴 것이다. 남겨 두면 뒤 파일의 "다른 owner 가 살아 있으면 멈춘다" 관문
 * (native-terminal-failure-attempts·agent-review-records·text-model-capacity-admission)이 같은 묶음에서
 * 바로 뒤에 올 때만 실패한다 — 묶음 배정이 바뀔 때마다 다른 곳에서 터진다(2026-10-22 시간 기준 묶음에서 확인).
 * after 훅은 역순(stack)이라 각 파일의 자기 afterAll(원상 복구·검증)이 끝난 뒤에 돈다.
 */
afterAll(async () => {
  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`UPDATE jobs SET lease_token = NULL, locked_at = NULL WHERE lease_token IS NOT NULL OR locked_at IS NOT NULL`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});
