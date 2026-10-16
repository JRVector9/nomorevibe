import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  textProfileInputHash, textProfileDispatchBindingHash, textProfileDispatchBindingSchema,
  textProfileModelDispatchSchema, textProfileGatewayTerminalEvidenceSchema,
} from "@/lib/llm/capacity";

const sha = "a".repeat(64);
function binding() {
  const input = { productId: 12, slug: "profile-unit", evidenceHash: sha,
    profile: { kind: "absent" as const }, model: "profile-model" };
  return { kind: "text_profile_gateway" as const, version: 1 as const, ...input,
    logicalWorkKey: "text:profile:12", inputHash: textProfileInputHash(input),
    provider: "abcllm" as const, routeId: "product-search-profile" as const,
    wireHash: sha, servingContractHash: sha, totalTokenBound: 4096, chargedTokens: 4096,
    job: { name: "product-search-profile" as const, token: randomUUID(), requestedVersion: 3 },
    role: { role: "text" as const, instanceId: "text-primary", bootId: randomUUID(), release: "unit-sha",
      kind: "primary" as const, epoch: 2, batch: { mode: "legacy" as const } } };
}
function dispatch() {
  const value = binding();
  return { requestId: randomUUID(), owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: sha,
    binding: value, bindingHash: textProfileDispatchBindingHash(value) };
}
function terminal() {
  return { version: 1 as const, kind: "text_profile_gateway_terminal" as const, dispatch: dispatch(),
    finishReason: "length" as const, responseHash: sha, actualUsage: null, provenance: "unknown" as const };
}

describe("fixed text profile ledger shapes are validation, never authority", () => {
  it("accepts an absent profile and explicit legacy provenance without inventing a host", () => {
    expect(textProfileDispatchBindingSchema.parse(binding()).role.batch).toEqual({ mode: "legacy" });
    expect(textProfileGatewayTerminalEvidenceSchema.parse(terminal()).finishReason).toBe("length");
  });
  it("hashes exact profile generations independently of object insertion order", () => {
    const input = { productId: 12, slug: "profile-unit", evidenceHash: sha,
      profile: { kind: "present" as const, rowIdentityHash: sha, sourceRevision: 1, attempts: 2 }, model: "profile-model" };
    expect(textProfileInputHash(input)).toBe(textProfileInputHash({ model: input.model, profile: input.profile,
      evidenceHash: sha, slug: input.slug, productId: 12 }));
    expect(textProfileInputHash(input)).not.toBe(textProfileInputHash({ ...input,
      profile: { ...input.profile, rowIdentityHash: "b".repeat(64) } }));
  });
  it("rejects a logical key for another product", () => {
    expect(textProfileDispatchBindingSchema.safeParse({ ...binding(), logicalWorkKey: "text:profile:13" }).success).toBe(false);
  });
  it("rejects a changed profile/source behind the original input hash", () => {
    expect(textProfileDispatchBindingSchema.safeParse({ ...binding(), evidenceHash: "b".repeat(64) }).success).toBe(false);
  });
  it("requires full C charge", () => {
    expect(textProfileDispatchBindingSchema.safeParse({ ...binding(), chargedTokens: 1 }).success).toBe(false);
  });
  it("requires actual dispatch owner to equal the bound text role owner", () => {
    expect(textProfileModelDispatchSchema.safeParse({ ...dispatch(), owner: { instanceId: "other", bootId: randomUUID() } }).success).toBe(false);
  });
  it("rejects a stale binding hash", () => {
    expect(textProfileModelDispatchSchema.safeParse({ ...dispatch(), bindingHash: "b".repeat(64) }).success).toBe(false);
  });
  it("accepts only consistent upstream usage at or below C", () => {
    const value = terminal();
    const actualUsage = { inputTokens: 4000, outputTokens: 96, totalTokens: 4096 };
    expect(textProfileGatewayTerminalEvidenceSchema.safeParse({ ...value, actualUsage, provenance: "upstream_reported" }).success).toBe(true);
    expect(textProfileGatewayTerminalEvidenceSchema.safeParse({ ...value, actualUsage, provenance: "unknown" }).success).toBe(false);
    expect(textProfileGatewayTerminalEvidenceSchema.safeParse({ ...value, actualUsage: { ...actualUsage, totalTokens: 4095 }, provenance: "upstream_reported" }).success).toBe(false);
    expect(textProfileGatewayTerminalEvidenceSchema.safeParse({ ...value, actualUsage: { inputTokens: 4096, outputTokens: 1, totalTokens: 4097 }, provenance: "upstream_reported" }).success).toBe(false);
  });
  it("rejects unknown fields, unsafe integers and incomplete terminal data", () => {
    expect(textProfileDispatchBindingSchema.safeParse({ ...binding(), job: { ...binding().job, alias: true } }).success).toBe(false);
    expect(textProfileDispatchBindingSchema.safeParse({ ...binding(), productId: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    const value: Record<string, unknown> = terminal(); delete value.finishReason;
    expect(textProfileGatewayTerminalEvidenceSchema.safeParse(value).success).toBe(false);
  });
});

// These mock rows test repository sequencing; they issue no real DB authority.
const repository = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn(), terminal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: repository.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: repository.replay }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ readTextProfileGatewayTerminal: repository.terminal }));
import { vi, beforeEach } from "vitest";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityControl } from "@/lib/db/schema";
import { modelCapacityPolicyHash, modelCapacityReservationSchema, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { lockTextProfileModelCapacityDispatch, finishTextProfileModelCapacityDispatch,
  reconcileTextProfileGatewayTerminal, requestTextProfileModelSlot } from "@/lib/llm/capacity-repository";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 1, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60000, reservationTtlMs: 60000,
  routes: [{ routeId: "product-search-profile", provider: "abcllm", model: "profile-model", providerBudgetId: "account", groupId: "engine" }] };
const control = () => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), cursor: 0 });
function rowFixture() {
  const value = binding(), state = control();
  const identity = { owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    workKey: `${value.logicalWorkKey}:${value.inputHash}`, class: "background" as const, pool: "text" as const,
    routeId: value.routeId, provider: value.provider, model: value.model };
  const handle = modelCapacityReservationSchema.parse({ requestId: randomUUID(), owner: identity.owner,
    token: randomUUID(), epoch: 1, revision: 1, policyHash: state.policyHash });
  const row = { ...identity, ...handle, ownerInstanceId: identity.owner.instanceId, ownerBootId: identity.owner.bootId,
    logicalWorkKey: value.logicalWorkKey, state: "reserved", providerBudgetId: "account", groupId: "engine" };
  return { value, identity, handle, row };
}
function mockTx(rows: unknown[][], updates: unknown[][] = []) {
  const trace: string[] = [], events: unknown[] = [];
  const query = (values: unknown[]) => { const chain = {
    from: (table: unknown) => { trace.push(table === modelCapacityControl ? "control" : "request"); return chain; },
    where: () => chain, for: (mode: string) => { trace.push(mode); return chain; }, limit: () => chain, orderBy: () => chain,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(values).then(resolve, reject),
  }; return chain; };
  const tx = { select: () => query(rows.shift() ?? []), execute: vi.fn(async () => [{ live: true }]),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => updates.shift() ?? [] }) }) }),
    insert: () => ({ values: async (value: unknown) => { events.push(value); } }) };
  return { tx: tx as unknown as ProductTransaction, trace, events };
}
beforeEach(() => { vi.clearAllMocks(); repository.replay.mockReturnValue(undefined); });
it("takes control/request UPDATE prefix and finishes the original full tuple exactly once", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [value.row], []], [[{ ...value.row, state: "dispatched" }]]);
  const lock = await lockTextProfileModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, productId: 12 });
  expect(lock).not.toBeNull(); expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
  const result = await finishTextProfileModelCapacityDispatch(fixture.tx, lock!, value.value);
  expect(result.binding).toEqual(value.value); expect(fixture.events).toEqual([expect.objectContaining({ kind: "dispatch_started" })]);
  await expect(finishTextProfileModelCapacityDispatch(fixture.tx, lock!, value.value)).rejects.toThrow("invalid_text_profile_capacity_dispatch_lock");
});
it("rejects copied or foreign-TX locks before writing", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [value.row], []]);
  const lock = await lockTextProfileModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, productId: 12 });
  expect(lock).not.toBeNull();
  await expect(finishTextProfileModelCapacityDispatch({} as ProductTransaction, lock!, value.value)).rejects.toThrow("invalid_text_profile_capacity_dispatch_lock");
  await expect(finishTextProfileModelCapacityDispatch(fixture.tx, { ...lock! }, value.value)).rejects.toThrow("invalid_text_profile_capacity_dispatch_lock");
  expect(fixture.events).toEqual([]);
});
it("refuses replay before any request, lock or terminal SQL", async () => {
  repository.replay.mockReturnValue({}); const value = rowFixture();
  await expect(requestTextProfileModelSlot({ ...value.identity, requestId: value.handle.requestId }, 12)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(lockTextProfileModelCapacityDispatch({} as ProductTransaction, { reservation: value.handle,
    identity: value.identity, productId: 12 })).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(reconcileTextProfileGatewayTerminal({ kind: "text_profile_gateway_terminal" })).rejects.toThrow("model_capacity_replay_unsupported");
  expect(repository.transaction).not.toHaveBeenCalled();
});
