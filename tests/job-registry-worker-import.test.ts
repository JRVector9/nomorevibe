import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 워커(scripts/worker.ts)는 lib/jobs/registry 를 react-server 조건 없이 부른다 — 그 길에 `import "server-only"` 가 있으면 워커가 뜨지 못한다.
 * 2026-11-12 표본 비교 저장 모듈에 그 줄이 들어가 워커 import 가 던졌다(통합 전 발견).
 */
describe("워커가 부르는 모듈", () => {
  it("표본 비교 저장 모듈은 server-only 를 넣지 않는다", () => {
    for (const file of ["lib/operations/model-sample-compare-repository.ts", "lib/jobs/products/korean-tagline-sample.ts", "lib/jobs/products/korean-tagline.ts", "lib/jobs/registry.ts"])
      expect(readFileSync(file, "utf8"), file).not.toMatch(/^import "server-only";/m);
  });
});
