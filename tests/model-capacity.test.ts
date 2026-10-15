import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  modelCapacityClassCycle, modelCapacityDispatchSchema, modelCapacityOwnerSchema,
  modelCapacityPolicyHash, modelCapacityPolicySchema, modelCapacityRequestSchema,
  modelCapacityReservationSchema, parseModelCapacityPolicy,
} from "@/lib/llm/capacity";

const policy = {
  version: 1 as const, globalLimit: 4,
  providerLimits: { "account-z": 3, "account-a": 2 },
  groupLimits: { "group-z": 3, "group-a": 2 },
  poolLimits: { reviewer: 3, text: 2 },
  weights: { first: 2, second: 1, background: 3 },
  maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 15_000,
  routes: [
    { routeId: "route-z", provider: "abcllm", model: "[MLX] Model Z", providerBudgetId: "account-z", groupId: "group-z" },
    { routeId: "route-a", provider: "other", model: "Model A", providerBudgetId: "account-a", groupId: "group-a" },
  ],
};
const owner = { instanceId: "worker-a", bootId: "00000000-0000-4000-8000-000000000001" };
const request = { requestId: "00000000-0000-4000-8000-000000000002", workKey: "first:42:physical:1", owner,
  class: "first", pool: "reviewer", routeId: "route-z", provider: "abcllm", model: "[MLX] Model Z" };
const handle = { requestId: request.requestId, owner, token: "00000000-0000-4000-8000-000000000003",
  epoch: 1, revision: 2, policyHash: "a".repeat(64) };

describe("inactive model capacity contract", () => {
  it("strictly parses a complete policy without changing input or exact model spelling", () => {
    const before = structuredClone(policy), parsed = parseModelCapacityPolicy(policy);
    expect(parsed).toEqual(before);
    expect(parsed).not.toBe(policy);
    expect(parsed.routes).not.toBe(policy.routes);
    expect(policy).toEqual(before);
    expect(parsed.routes[0].model).toBe("[MLX] Model Z");
  });

  it("rejects malformed policy bounds, references, duplicates, and hidden authority", () => {
    for (const invalid of [
      { ...policy, version: 2 }, { ...policy, enabled: true }, { ...policy, globalLimit: 0 },
      { ...policy, globalLimit: 257 }, { ...policy, maxWaiting: 4097 },
      { ...policy, queueTtlMs: Number.MAX_SAFE_INTEGER + 1 }, { ...policy, reservationTtlMs: NaN },
      { ...policy, weights: { ...policy.weights, background: 0 } },
      { ...policy, poolLimits: { ...policy.poolLimits, other: 1 } },
      { ...policy, providerLimits: {} }, { ...policy, groupLimits: { missing: 2 } },
      { ...policy, routes: [] }, { ...policy, routes: [policy.routes[0], policy.routes[0]] },
      { ...policy, routes: [{ ...policy.routes[0], groupId: "missing" }] },
      { ...policy, routes: [{ ...policy.routes[0], model: " Model Z" }] },
    ]) expect(modelCapacityPolicySchema.safeParse(invalid).success, String(invalid)).toBe(false);
  });

  it("requires complete bounded request identity and reviewer pools for first/second", () => {
    expect(modelCapacityRequestSchema.parse(request)).toEqual(request);
    expect(modelCapacityRequestSchema.parse({ ...request, class: "background", pool: "text" }).pool).toBe("text");
    for (const invalid of [
      { ...request, routeId: undefined }, { ...request, class: "first", pool: "text" },
      { ...request, class: "second", pool: "text" }, { ...request, groupId: "caller-group" },
      { ...request, workKey: "x".repeat(161) }, { ...request, model: "x".repeat(201) },
      { ...request, owner: { ...owner, bootId: "not-a-uuid" } }, { ...request, provider: "abcllm\n" },
    ]) expect(modelCapacityRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates both branded handle shapes without treating their JSON as DB authority", () => {
    expect(modelCapacityReservationSchema.parse(handle)).toEqual(handle);
    expect(modelCapacityDispatchSchema.parse(handle)).toEqual(handle);
    expect(modelCapacityOwnerSchema.parse(owner)).not.toBe(owner);
    for (const invalid of [{ ...handle, epoch: 0 }, { ...handle, revision: Infinity },
      { ...handle, token: "not-a-token" }, { ...handle, policyHash: "A".repeat(64) },
      { ...handle, owner: { ...owner, role: "reviewer" } }, { ...handle, dispatched: true }]) {
      expect(modelCapacityReservationSchema.safeParse(invalid).success).toBe(false);
      expect(modelCapacityDispatchSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("hashes the complete canonical policy as SHA256", () => {
    const canonical = '{"globalLimit":4,"groupLimits":{"group-a":2,"group-z":3},"maxWaiting":20,"poolLimits":{"reviewer":3,"text":2},"providerLimits":{"account-a":2,"account-z":3},"queueTtlMs":60000,"reservationTtlMs":15000,"routes":[{"groupId":"group-a","model":"Model A","provider":"other","providerBudgetId":"account-a","routeId":"route-a"},{"groupId":"group-z","model":"[MLX] Model Z","provider":"abcllm","providerBudgetId":"account-z","routeId":"route-z"}],"version":1,"weights":{"background":3,"first":2,"second":1}}';
    expect(modelCapacityPolicyHash(policy)).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("ignores only map/property/route ordering when hashing", () => {
    const reordered = { ...policy, providerLimits: { "account-a": 2, "account-z": 3 },
      groupLimits: { "group-a": 2, "group-z": 3 }, routes: policy.routes.toReversed()
        .map(route => Object.fromEntries(Object.entries(route).reverse())) };
    const hash = modelCapacityPolicyHash(policy);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(modelCapacityPolicyHash(parseModelCapacityPolicy(reordered))).toBe(hash);
  });

  it("includes policy decisions and exact route/model identity in the hash", () => {
    const hash = modelCapacityPolicyHash(policy);
    for (const changed of [{ ...policy, globalLimit: 3 }, { ...policy, reservationTtlMs: 16_000 },
      { ...policy, weights: { ...policy.weights, background: 2 } },
      { ...policy, routes: [{ ...policy.routes[0], model: "Model Z" }, policy.routes[1]] },
      { ...policy, routes: [{ ...policy.routes[0], providerBudgetId: "account-a" }, policy.routes[1]] }]) {
      expect(modelCapacityPolicyHash(changed)).not.toBe(hash);
    }
  });

  it("expands the fixed weighted class cycle and returns an independent array", () => {
    const before = structuredClone(policy), cycle = modelCapacityClassCycle(policy);
    expect(cycle).toEqual(["first", "first", "second", "background", "background", "background"]);
    cycle.pop();
    expect(modelCapacityClassCycle(policy)).toHaveLength(6);
    expect(policy).toEqual(before);
  });
});
