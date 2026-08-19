import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // 통합 테스트는 DB가 필요하므로 별도 설정(vitest.integration.config.ts)으로 돌린다
    exclude: ["tests/integration/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
