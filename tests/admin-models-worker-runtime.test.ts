import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("Next의 모듈 표식 없이 실제 Node/tsx 워커에서 모델 풀 범위를 로드한다", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "-e",
    "const { withAdminStagePools } = require('./lib/llm/admin-model-pools.ts'); process.stdout.write(withAdminStagePools({}, 'fixture', () => 'pool-import-ok'));"],
  { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
  expect(output).toBe("pool-import-ok");
});
