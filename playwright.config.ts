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
      ADMIN_GITHUB_LOGINS: "",
      ADMIN_TOKEN: "playwright-admin-token",
      CRON_SECRET: "playwright-cron-secret",
      VISITOR_HASH_SECRET: "playwright-visitor-hash-secret-32-characters",
      GITHUB_TOKEN: "",
      ANTHROPIC_API_KEY: "",
    },
  },
});
