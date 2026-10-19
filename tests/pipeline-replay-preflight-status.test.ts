import { describe, expect, it } from "vitest";
import { fixedInputPreflightStatus } from "@/lib/operations/pipeline-replay-preflight-status";

const expected = "a".repeat(64), changed = "b".repeat(64);
describe("fixed input preflight authorization", () => {
  it("blocks a changed artifact even when all model contracts are ready", () => {
    expect(fixedInputPreflightStatus(expected, changed, [])).toEqual({ artifactShaMatches: false,
      executable: false, blocked: ["replay_artifact_sha_mismatch"] });
  });
  it("preserves model blockers alongside artifact mismatch", () => {
    const modelBlocked = ["ai1_serving_contract_unavailable", "ai2_serving_contract_unavailable"];
    expect(fixedInputPreflightStatus(expected, changed, modelBlocked).blocked)
      .toEqual(["replay_artifact_sha_mismatch", ...modelBlocked]);
    expect(modelBlocked).toEqual(["ai1_serving_contract_unavailable", "ai2_serving_contract_unavailable"]);
    expect(fixedInputPreflightStatus(expected, expected, modelBlocked).executable).toBe(false);
  });
  it("allows matching artifacts only when model preflight also permits execution", () => {
    expect(fixedInputPreflightStatus(expected, expected, [])).toEqual({ artifactShaMatches: true,
      executable: true, blocked: [] });
  });
});
