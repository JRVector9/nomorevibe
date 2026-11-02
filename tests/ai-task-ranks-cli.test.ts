import { describe, expect, it } from "vitest";
import { parseAiTaskRanksArgs } from "../scripts/ops/ai-task-ranks";

describe("작업 ↔ 모델 운영 스크립트 인자", () => {
  it("명령·hash·작업 목록을 읽는다", () => {
    expect(parseAiTaskRanksArgs(["apply", "--hash=" + "a".repeat(64), "--operator=claude"])).toMatchObject({ command: "apply", hash: "a".repeat(64), operator: "claude" });
    expect(parseAiTaskRanksArgs(["resave", "--operator=x", "--task=crawl-agent-review, second-review"]).tasks).toEqual(["crawl-agent-review", "second-review"]);
    expect(parseAiTaskRanksArgs(["status", "--json"])).toMatchObject({ command: "status", json: true, tasks: null });
  });
});
