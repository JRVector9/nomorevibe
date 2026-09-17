import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/design",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4321",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 4321",
    url: "http://127.0.0.1:4321/design",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
