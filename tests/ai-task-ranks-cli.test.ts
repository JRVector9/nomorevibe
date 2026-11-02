import { describe, expect, it } from "vitest";
import { parseAiTaskRanksArgs } from "../scripts/ops/ai-task-ranks";

describe("작업 ↔ 모델 운영 스크립트 인자", () => {
  it("명령·hash·작업 목록을 읽는다", () => {
    expect(parseAiTaskRanksArgs(["apply", "--hash=" + "a".repeat(64), "--operator=claude"])).toMatchObject({ command: "apply", hash: "a".repeat(64), operator: "claude" });
    expect(parseAiTaskRanksArgs(["resave", "--operator=x", "--task=crawl-agent-review, second-review"]).tasks).toEqual(["crawl-agent-review", "second-review"]);
    expect(parseAiTaskRanksArgs(["status", "--json"])).toMatchObject({ command: "status", json: true, tasks: null });
  });
});

describe("set 명령 인자", () => {
  it("--rankN=<연결>|<모델> 을 순서대로 읽고 모양이 틀리면 빈칸으로 둔다(저장 검증이 막는다)", () => {
    const args = parseAiTaskRanksArgs(["set", "--operator=x", "--task=second-review", "--slot=1", "--rank1=gpu3090|qwen3.8-flash-next", "--rank2=bad"]);
    expect(args).toMatchObject({ slot: "1", tasks: ["second-review"] });
    expect(args.ranks).toEqual([{ connection: "gpu3090", model: "qwen3.8-flash-next" }, null]);
  });
});
