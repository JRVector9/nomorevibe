import { defineConfig } from "vitest/config";
import path from "node:path";
import DurationReporter from "./tests/integration/duration-reporter";
import { DurationSequencer } from "./tests/integration/duration-sequencer";

// CI 묶음이 파일별 시간을 남길 곳(scripts/integration-durations.mjs 가 모아 durations.json 을 갱신한다)
const durationsOut = process.env.INTEGRATION_DURATIONS_OUT;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/env.ts"],
    // 공유 테스트 DB 스키마는 실행마다 한 번만 migrate 한다(파일마다 drizzle-kit 을 다시 띄우지 않는다)
    globalSetup: ["tests/integration/global-setup.ts"],
    // 모든 파일이 같은 테스트 DB를 공유하므로 병렬 실행하면 서로의 데이터를 지운다
    fileParallelism: false,
    // --shard=i/n 은 파일 개수가 아니라 기록된 파일 시간으로 나눈다
    sequence: { sequencer: DurationSequencer },
    reporters: durationsOut ? ["default", new DurationReporter(durationsOut)] : ["default"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
