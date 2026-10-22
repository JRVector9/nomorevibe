import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // 통합 테스트는 DB가 필요하므로 별도 설정(vitest.integration.config.ts)으로 돌린다
    exclude: ["tests/integration/**"],
    // 셸에 떠 있는 개발용 환경변수가 결과를 바꾸지 않게 한다
    setupFiles: ["tests/setup-env.ts"],
    // 기본값(코어 수 - 1)은 64코어 기기에서 worker 63개다. 모듈 변환을 기다리는 시간이 늘어(변환 합계 26초@16 → 477초@63)
    // 테스트 안에서 처음 읽는 화면·route 모듈이 기본 5초를 넘었다 — 40개부터 실패, 32개 이하는 통과했다. 여유를 두고 20개로 묶는다.
    // CI(4 vCPU → 3개)는 그대로다.
    maxWorkers: Math.max(1, Math.min(availableParallelism() - 1, 20)),
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
