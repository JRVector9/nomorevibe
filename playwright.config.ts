import { defineConfig, devices } from "@playwright/test";

export const E2E_PORT = 43_127;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? "postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_test";

process.env.DATABASE_URL = E2E_DATABASE_URL;
process.env.NEXT_PUBLIC_SITE_URL = E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: [
      "npm run build",
      "cp -R public .next/standalone/public",
      "mkdir -p .next/standalone/.next",
      "cp -R .next/static .next/standalone/.next/static",
      `HOSTNAME=127.0.0.1 PORT=${E2E_PORT} node .next/standalone/server.js`,
    ].join(" && "),
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      NEXT_PUBLIC_SITE_URL: E2E_BASE_URL,
      ALLOW_PRIVATE_URLS: "1",
      LOG_LEVEL: "error",
      AUTH_SECRET: "playwright-auth-secret-with-at-least-32-characters",
      ADMIN_GITHUB_LOGINS: "playwright-admin",
      // 개발 셸의 무인증 관리자 옵션을 상속하지 않고 서명된 세션 경계를 검사한다.
      ADMIN_LOCAL_LOGIN: "0",
      CRAWL_REVIEW_READY: "true",
      ADMIN_TOKEN: "playwright-admin-token",
      CRON_SECRET: "playwright-cron-secret",
      VISITOR_HASH_SECRET: "playwright-visitor-hash-secret-32-characters",
      GITHUB_TOKEN: "",
      // 기능 E2E는 실행 명령에서 플래그를 켠다. 기존 회귀 검사는 기본 비활성 구성으로 실행한다.
      PUBLIC_USER_AUTH_ENABLED: process.env.PUBLIC_USER_AUTH_ENABLED ?? "false",
      GITHUB_STAR_ENABLED: process.env.GITHUB_STAR_ENABLED ?? "false",
      PRODUCT_FEEDBACK_ENABLED: process.env.PRODUCT_FEEDBACK_ENABLED ?? "false",
      GITHUB_FEEDBACK_DELIVERY_ENABLED: process.env.GITHUB_FEEDBACK_DELIVERY_ENABLED ?? "false",
      PUBLIC_AUTH_SECRET: "playwright-public-auth-secret-with-at-least-32-characters",
      GITHUB_INTEGRATION_SECRET: "playwright-github-integration-secret-at-least-32-characters",
      GITHUB_STAR_APP_CLIENT_ID: "Iv1.playwright-star-id",
      GITHUB_STAR_APP_CLIENT_SECRET: "playwright-star-secret",
      // 재인증 브라우저 검사는 테스트 파일의 로컬 RPC만 쓰며 실제 계정에는 접근하지 않는다.
      CONNECT_AGENT_URL: "http://127.0.0.1:43129",
      OPERATIONS_AGENT_SECRET: "playwright-operations-agent-secret-32-characters",
      // 분류 CLI를 없는 실행 파일로 돌려 e2e가 모델을 부르지 않게 한다
      CLAUDE_CLI: "claude-disabled-for-e2e",
    },
  },
});
