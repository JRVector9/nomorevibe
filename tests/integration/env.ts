import { TEST_DATABASE_URL } from "./setup";
import postgres from "postgres";
import { afterAll, vi } from "vitest";

// Existing server metadata fixtures run without a Next request and target Korean.
vi.mock("@/lib/i18n/server", () => ({ getRequestLocale: async () => "ko" }));

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
