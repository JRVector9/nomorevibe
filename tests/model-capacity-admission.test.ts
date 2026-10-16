import { beforeEach, expect, it, vi } from "vitest";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
const mocks = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: () => undefined }));
import { lockModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: "Exact Model", providerBudgetId: "account", groupId: "engine" }] };
const row = () => ({ id: 1, mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, cursor: 0, updatedAt: new Date() });
function transaction() {
  const query = { from: vi.fn(), where: vi.fn(), for: mocks.lock };
  query.from.mockReturnValue(query); query.where.mockReturnValue(query);
  return { select: vi.fn(() => query), update: vi.fn(), insert: vi.fn() };
}
const read = (tx: ReturnType<typeof transaction>) => lockModelCapacityCallerControl(tx as unknown as ProductTransaction);
beforeEach(() => vi.resetAllMocks());
it("reads disabled control with SHARE without allocating or changing a slot", async () => {
  mocks.lock.mockResolvedValue([row()]); const tx = transaction();
  expect(await read(tx)).toEqual({ mode: "disabled", epoch: 1, revision: 1, policyHash: null, policy: null });
  expect(mocks.lock).toHaveBeenCalledExactlyOnceWith("share");
  expect(tx.update).not.toHaveBeenCalled(); expect(tx.insert).not.toHaveBeenCalled();
});
it("returns an independent immutable policy snapshot, never a dispatch handle", async () => {
  const input = { ...row(), mode: "open", policy, policyHash: modelCapacityPolicyHash(policy) };
  mocks.lock.mockResolvedValue([input]); const result = await read(transaction());
  expect(result.policy).toEqual(policy); expect(result.policy).not.toBe(policy);
  for (const value of [result, result.policy, result.policy!.routes, result.policy!.routes[0],
    result.policy!.groupLimits, result.policy!.providerLimits, result.policy!.weights, result.policy!.poolLimits])
    expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(policy)).toBe(false);
  expect(result).not.toHaveProperty("token"); expect(result).not.toHaveProperty("supported");
});
it("preserves DB failures without treating them as expected waiting", async () => {
  const original = new Error("permission denied for model_capacity_control");
  mocks.lock.mockRejectedValue(original);
  await expect(read(transaction())).rejects.toBe(original);
});
it("rejects a missing row and malformed policy/hash rather than silently disabling", async () => {
  mocks.lock.mockResolvedValue([]);
  await expect(read(transaction())).rejects.toThrow("model_capacity_control_missing");
  mocks.lock.mockResolvedValue([{ ...row(), policy, policyHash: "a".repeat(64) }]);
  await expect(read(transaction())).rejects.toThrow("model_capacity_policy_hash_mismatch");
  mocks.lock.mockResolvedValue([{ ...row(), policy: { ...policy, supported: true } }]);
  await expect(read(transaction())).rejects.not.toBeInstanceOf(ModelCapacityDeferredError);
});
it.each([{ mode: "unknown" }, { epoch: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { mode: "open" }])(
  "rejects malformed control fields %j", async patch => {
    mocks.lock.mockResolvedValue([{ ...row(), ...patch }]);
    await expect(read(transaction())).rejects.toThrow("model_capacity_control_invalid");
  });
