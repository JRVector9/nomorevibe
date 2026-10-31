import { describe, expect, it } from "vitest";
import {
  MODEL_CAPACITY_PREDECESSORS_MAX, compatibleModelCapacityGeneration, modelCapacityPolicyAdditive, modelCapacityPolicyHash,
  modelCapacityPolicySchema, modelCapacityPredecessorChain, parseModelCapacityPolicy, type ModelCapacityPolicy,
} from "@/lib/llm/capacity";

/** PR 3b-B — 앞 판 사슬(compatiblePredecessors): 모양·옛 단일 앞 판 읽기·세대 인증. 장부 가지치기·덧붙이기는 통합 시험(model-assignments)이 본다. */
const route = (routeId: string, groupId = "dev-a") => ({ routeId, provider: "abcllm", model: `[MLX] ${routeId}`, providerBudgetId: "mlx", groupId });
const base: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 30_000, routes: [route("a"), route("b", "dev-b")] };
const hash = (char: string) => char.repeat(64);
const entry = (revision: number, char = "a", epoch = 3) => ({ epoch, revision, policyHash: hash(char) });
const chained = (chain: unknown[]) => ({ ...base, routes: [...base.routes, route("c")], compatiblePredecessors: chain });

describe("compatiblePredecessors (PR 3b-B)", () => {
  it("parses an ascending chain of generation facts up to the cap and hashes it as part of the policy", () => {
    const value = chained([entry(10, "a"), entry(12, "b"), entry(4, "c", 4)]);
    const parsed = parseModelCapacityPolicy(value);
    expect(parsed.compatiblePredecessors).toEqual(value.compatiblePredecessors);
    expect(modelCapacityPolicyHash(parsed)).not.toBe(modelCapacityPolicyHash(parseModelCapacityPolicy({ ...value, compatiblePredecessors: [entry(10, "a")] })));
    const max = Array.from({ length: MODEL_CAPACITY_PREDECESSORS_MAX }, (_, index) => entry(index + 1, (index % 10).toString()));
    expect(modelCapacityPolicySchema.safeParse(chained(max)).success).toBe(true);
    expect(MODEL_CAPACITY_PREDECESSORS_MAX).toBe(16);
  });

  it("rejects an empty, oversized, unordered, duplicated, malformed or ambiguous chain", () => {
    const over = Array.from({ length: MODEL_CAPACITY_PREDECESSORS_MAX + 1 }, (_, index) => entry(index + 1));
    for (const chain of [[], over, [entry(5), entry(4)], [entry(5), entry(5, "b")], [entry(5, "a", 4), entry(9, "a", 3)],
      [{ ...entry(5), policyHash: "x" }], [{ ...entry(5), extra: true }], [{ epoch: 0, revision: 1, policyHash: hash("a") }]])
      expect(modelCapacityPolicySchema.safeParse(chained(chain)).success).toBe(false);
    const both = { ...chained([entry(5)]), compatiblePredecessor: { epoch: 3, revision: 5, policy: base } };
    expect(modelCapacityPolicySchema.safeParse(both).error?.issues.map(issue => issue.message)).toContain("ambiguous_capacity_predecessor");
  });

  it("reads the old single predecessor as a chain of one (its document hash) and no predecessor as an empty chain", () => {
    const legacy = parseModelCapacityPolicy({ ...base, routes: [...base.routes, route("c")], compatiblePredecessor: { epoch: 3, revision: 9, policy: base } });
    expect(modelCapacityPredecessorChain(legacy)).toEqual([{ epoch: 3, revision: 9, policyHash: modelCapacityPolicyHash(base) }]);
    expect(modelCapacityPredecessorChain(parseModelCapacityPolicy(base))).toEqual([]);
    // the parsed old form is unchanged: same keys, same hash as before this PR (no compatiblePredecessors key appears)
    expect(Object.keys(legacy)).not.toContain("compatiblePredecessors");
  });

  it("authenticates a held generation anywhere in the chain, only exactly and only for an earlier revision of the same epoch", () => {
    const policy = parseModelCapacityPolicy(chained([entry(10, "a"), entry(12, "b"), entry(13, "c")]));
    for (const generation of [entry(10, "a"), entry(12, "b"), entry(13, "c")])
      expect(compatibleModelCapacityGeneration(policy, generation, { epoch: 3, revision: 14 })).toBe(true);
    for (const generation of [entry(11, "a"), entry(12, "a"), entry(10, "a", 2), { epoch: 3, revision: 10, policyHash: null }])
      expect(compatibleModelCapacityGeneration(policy, generation, { epoch: 3, revision: 14 })).toBe(false);
    // a later writer epoch or a revision that is not after the entry proves nothing
    expect(compatibleModelCapacityGeneration(policy, entry(10, "a"), { epoch: 4, revision: 14 })).toBe(false);
    expect(compatibleModelCapacityGeneration(policy, entry(13, "c"), { epoch: 3, revision: 13 })).toBe(false);
    expect(compatibleModelCapacityGeneration(policy, entry(12, "b"), { epoch: 3, revision: 13 })).toBe(true);
  });

  it("checks additivity the same way for the old predecessor and the operator chain guard", () => {
    expect(modelCapacityPolicyAdditive(base, { ...base, routes: [...base.routes, route("c")] })).toBe(true);
    expect(modelCapacityPolicyAdditive(base, { ...base, routes: [...base.routes] })).toBe(false);                       // nothing added
    expect(modelCapacityPolicyAdditive(base, { ...base, routes: [route("b", "dev-b"), route("c")] })).toBe(false);       // a route dropped
    expect(modelCapacityPolicyAdditive(base, { ...base, routes: [route("a", "dev-c"), route("b", "dev-b"), route("c")] })).toBe(false); // moved
    expect(modelCapacityPolicyAdditive(base, { ...base, maxWaiting: 1, routes: [...base.routes, route("c")] })).toBe(false);
    // the ignored limit fields and both predecessor fields are not compared
    expect(modelCapacityPolicyAdditive(base, { ...base, globalLimit: 9, compatiblePredecessors: [entry(1)], routes: [...base.routes, route("c")] })).toBe(true);
  });
});
