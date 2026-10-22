import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestModule } from "vitest/node";

/**
 * 파일별 실제 소요 시간(환경 준비·import·hook·테스트 합)을 JSON 으로 남긴다. CI 묶음마다 하나씩 artifact 로 올리고,
 * scripts/integration-durations.mjs 가 모아 tests/integration/durations.json 을 갱신한다.
 * INTEGRATION_DURATIONS_OUT 이 있을 때만 vitest 설정이 이 reporter 를 붙인다.
 */
export default class DurationReporter implements Reporter {
  private readonly files: Record<string, number> = {};

  constructor(private readonly out: string, private readonly root = process.cwd()) {}

  onTestModuleEnd(testModule: TestModule) {
    const diagnostic = testModule.diagnostic();
    const milliseconds = diagnostic.environmentSetupDuration + diagnostic.prepareDuration + diagnostic.collectDuration
      + diagnostic.setupDuration + diagnostic.duration;
    const file = path.relative(this.root, testModule.moduleId).split(path.sep).join("/");
    this.files[file] = Math.round(milliseconds / 100) / 10;
  }

  onTestRunEnd() {
    writeFileSync(this.out, `${JSON.stringify({ files: this.files }, null, 2)}\n`);
  }
}
