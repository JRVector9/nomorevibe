import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reasonTranslationMemberKeys, reasonTranslationLogicalWorkKey, reasonTranslationInputHash,
  reasonTranslationDispatchBindingHash, reasonTranslationDispatchBindingSchema, reasonTranslationInputSchema,
  reasonTranslationModelDispatchSchema, reasonTranslationGatewayTerminalEvidenceSchema } from "@/lib/llm/capacity";

const sha = "a".repeat(64), other = "b".repeat(64);
function input() {
  return { members: [{ sourceHash: sha, cache: { kind: "absent" as const } },
    { sourceHash: other, cache: { kind: "present" as const, rowIdentityHash: sha, attempts: 2 } }], model: "reason-model" };
}
function binding() {
  const value = input();
  return { ...value, kind: "reason_translation_gateway" as const, version: 1 as const,
    logicalWorkKey: reasonTranslationLogicalWorkKey(value.members), inputHash: reasonTranslationInputHash(value),
    provider: "abcllm" as const, routeId: "reason-translate" as const, wireHash: sha, servingContractHash: sha,
    totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: "reason-translate" as const, token: randomUUID(), requestedVersion: 2 },
    role: { role: "text" as const, instanceId: "reason-owner", bootId: randomUUID(), release: "release",
      kind: "primary" as const, epoch: 1, batch: { mode: "legacy" as const } } };
}
function dispatch() {
  const value = binding();
  return { requestId: randomUUID(), owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: sha,
    binding: value, bindingHash: reasonTranslationDispatchBindingHash(value) };
}
function terminal() {
  return { version: 1 as const, kind: "reason_translation_gateway_terminal" as const, dispatch: dispatch(),
    finishReason: "length" as const, responseHash: sha, actualUsage: null, provenance: "unknown" as const };
}

describe("fixed reason translation ledger shapes, never authority", () => {
  it("accepts original ordered members and distinguishes legacy text from versioned translation", () => {
    const value = binding();
    expect(reasonTranslationDispatchBindingSchema.parse(value).members).toEqual(value.members);
    expect(reasonTranslationDispatchBindingSchema.safeParse({ ...value, role: { ...value.role,
      role: "translation", batch: { mode: "versioned", host: "oracle-osaka-smoke", batchEpoch: 2 } } }).success).toBe(true);
    expect(reasonTranslationDispatchBindingSchema.safeParse({ ...value, role: { ...value.role, role: "translation" } }).success).toBe(false);
  });
  it("uses sorted durable member keys but preserves original wire order", () => {
    const value = input(), reversed = { ...value, members: [...value.members].reverse() };
    expect(reasonTranslationMemberKeys(reversed.members)).toEqual([`ko:${sha}`, `ko:${other}`]);
    expect(reasonTranslationLogicalWorkKey(value.members)).toBe(reasonTranslationLogicalWorkKey(reversed.members));
    expect(reasonTranslationInputHash(value)).toBe(reasonTranslationInputHash(reversed));
    expect(reasonTranslationInputSchema.parse(reversed).members).toEqual(reversed.members);
  });
  it("binds all cache fields and leaves caller input immutable", () => {
    const value = input(), before = structuredClone(value);
    const hash = reasonTranslationInputHash(value);
    expect(hash).not.toBe(reasonTranslationInputHash({ ...value, members: [value.members[0],
      { sourceHash: other, cache: { kind: "present", rowIdentityHash: other, attempts: 2 } }] }));
    expect(hash).not.toBe(reasonTranslationInputHash({ ...value, members: [value.members[0],
      { sourceHash: other, cache: { kind: "present", rowIdentityHash: sha, attempts: 3 } }] }));
    expect(value).toEqual(before);
  });
  it("rejects duplicate members and zero or five members", () => {
    const value = input();
    expect(reasonTranslationInputSchema.safeParse({ ...value, members: [value.members[0], value.members[0]] }).success).toBe(false);
    expect(reasonTranslationInputSchema.safeParse({ ...value, members: [] }).success).toBe(false);
    expect(reasonTranslationInputSchema.safeParse({ ...value, members: Array(5).fill(value.members[0]) }).success).toBe(false);
  });
  it("rejects a logical batch for a different member set", () => {
    expect(reasonTranslationDispatchBindingSchema.safeParse({ ...binding(), logicalWorkKey: `text:reason:ko:${other}` }).success).toBe(false);
  });
  it("rejects changed cache semantics behind the original input hash", () => {
    const value = binding();
    expect(reasonTranslationDispatchBindingSchema.safeParse({ ...value, members: [{ sourceHash: sha,
      cache: { kind: "present", rowIdentityHash: sha, attempts: 1 } }, value.members[1]] }).success).toBe(false);
  });
  it("requires a full C charge and exact owner binding", () => {
    expect(reasonTranslationDispatchBindingSchema.safeParse({ ...binding(), chargedTokens: 1 }).success).toBe(false);
    expect(reasonTranslationModelDispatchSchema.safeParse({ ...dispatch(), owner: { instanceId: "other", bootId: randomUUID() } }).success).toBe(false);
  });
  it("rejects changed ordered membership under the original binding hash", () => {
    const value = dispatch();
    expect(reasonTranslationModelDispatchSchema.safeParse({ ...value, binding: { ...value.binding,
      members: [...value.binding.members].reverse() } }).success).toBe(false);
  });
  it("accepts terminal length without claiming usage and checks upstream usage exactly", () => {
    const value = terminal();
    expect(reasonTranslationGatewayTerminalEvidenceSchema.parse(value).finishReason).toBe("length");
    expect(reasonTranslationGatewayTerminalEvidenceSchema.safeParse({ ...value,
      actualUsage: { inputTokens: 8000, outputTokens: 192, totalTokens: 8192 }, provenance: "upstream_reported" }).success).toBe(true);
    expect(reasonTranslationGatewayTerminalEvidenceSchema.safeParse({ ...value,
      actualUsage: { inputTokens: 8000, outputTokens: 193, totalTokens: 8193 }, provenance: "upstream_reported" }).success).toBe(false);
    expect(reasonTranslationGatewayTerminalEvidenceSchema.safeParse({ ...value, provenance: "upstream_reported" }).success).toBe(false);
  });
  it("rejects incomplete/unknown fields and unsafe numbers without throwing from safeParse", () => {
    const value = binding();
    expect(reasonTranslationDispatchBindingSchema.safeParse({ ...value, members: [{ sourceHash: sha,
      cache: { kind: "present", rowIdentityHash: sha, attempts: Number.MAX_SAFE_INTEGER + 1 } }] }).success).toBe(false);
    expect(reasonTranslationDispatchBindingSchema.safeParse({ ...value, role: { ...value.role, suppliedReady: true } }).success).toBe(false);
    expect(reasonTranslationGatewayTerminalEvidenceSchema.safeParse({ ...terminal(), finishReason: undefined }).success).toBe(false);
    expect(reasonTranslationGatewayTerminalEvidenceSchema.safeParse({ ...terminal(), kind: "text_profile_gateway_terminal" }).success).toBe(false);
  });
});

// Mock transaction rows exercise sequencing and rejection, not actual PG authority.
const repository = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn(), terminal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: repository.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: repository.replay }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ readReasonTranslationGatewayTerminal: repository.terminal }));
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityControl, modelCapacityRequests } from "@/lib/db/schema";
import { modelCapacityPolicyHash, modelCapacityReservationSchema, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { requestReasonTranslationModelSlot, lockReasonTranslationModelCapacityDispatch,
  finishReasonTranslationModelCapacityDispatch, reconcileReasonTranslationGatewayTerminal,
  markModelDispatchIndeterminate } from "@/lib/llm/capacity-repository";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 1, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60000, reservationTtlMs: 60000,
  routes: [{ routeId: "reason-translate", provider: "abcllm", model: "reason-model", providerBudgetId: "account", groupId: "engine" }] };
const control = () => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), cursor: 0 });
function rowFixture() {
  const value = binding();
  const identity = { owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    workKey: `${value.logicalWorkKey}:${value.inputHash}`, class: "background" as const, pool: "text" as const,
    routeId: value.routeId, provider: value.provider, model: value.model };
  const handle = modelCapacityReservationSchema.parse({ requestId: randomUUID(), owner: identity.owner,
    token: randomUUID(), epoch: 1, revision: 1, policyHash: control().policyHash });
  const row = { ...identity, ...handle, ownerInstanceId: identity.owner.instanceId, ownerBootId: identity.owner.bootId,
    logicalWorkKey: value.logicalWorkKey, logicalMemberKeys: reasonTranslationMemberKeys(value.members),
    state: "reserved", providerBudgetId: "account", groupId: "engine", dispatchedAt: new Date(),
    dispatchBinding: value, dispatchBindingHash: reasonTranslationDispatchBindingHash(value) };
  return { value, identity, handle, row };
}
function mockTx(rows: unknown[][], updates: unknown[][] = [], inserted: unknown[][] = []) {
  const trace: string[] = [], writes: Array<{ table: unknown; value: unknown }> = [], queries: unknown[] = [];
  const query = (values: unknown[]) => { const chain = {
    from: (table: unknown) => { trace.push(table === modelCapacityControl ? "control" : "request"); return chain; },
    where: (predicate: unknown) => { queries.push(predicate); return chain; }, for: (mode: string) => { trace.push(mode); return chain; },
    limit: () => chain, orderBy: () => chain,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(values).then(resolve, reject),
  }; return chain; };
  const tx = { select: () => query(rows.shift() ?? []), execute: vi.fn(async () => [{ live: true }]),
    update: () => ({ set: (value: unknown) => { writes.push({ table: "update", value }); return { where: () => ({ returning: async () => updates.shift() ?? [] }) }; } }),
    insert: (table: unknown) => ({ values: (value: unknown) => { writes.push({ table, value }); const result = inserted.shift() ?? [];
      return { returning: async () => result, then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject) }; } }) };
  return { tx: tx as unknown as ProductTransaction, trace, writes, queries };
}
beforeEach(() => { vi.clearAllMocks(); repository.replay.mockReturnValue(undefined); });
it("writes canonical member metadata in the original waiting INSERT, not after grant", async () => {
  const value = rowFixture(), waiting = { ...value.row, state: "waiting" };
  const fixture = mockTx([[control()], [], [], [], [], [], [], [{ count: 0 }], [waiting]], [], [[waiting]]);
  vi.mocked(fixture.tx.execute).mockResolvedValue([] as never);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await requestReasonTranslationModelSlot({ ...value.identity, requestId: value.handle.requestId }, value.value.members)).toEqual({ kind: "deferred", reason: "capacity" });
  const write = fixture.writes.find(item => item.table === modelCapacityRequests)!;
  expect(write.value).toMatchObject({ logicalWorkKey: value.value.logicalWorkKey,
    logicalMemberKeys: [`ko:${sha}`, `ko:${other}`], state: "waiting" });
});
it("takes control/request UPDATE and refuses changed durable members before dispatch", async () => {
  const value = rowFixture();
  const fixture = mockTx([[control()], [{ ...value.row, logicalMemberKeys: [`ko:${other}`] }], []]);
  expect(await lockReasonTranslationModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, members: value.value.members })).toBeNull();
  expect(fixture.writes).toEqual([]);
  expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
});
it("finishes the same TX capability once and rejects copies/foreign TX", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [value.row], []], [[{ ...value.row, state: "dispatched" }]]);
  const lock = await lockReasonTranslationModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, members: value.value.members });
  expect(lock).not.toBeNull();
  await expect(finishReasonTranslationModelCapacityDispatch({} as ProductTransaction, lock!, value.value)).rejects.toThrow("invalid_reason_translation_capacity_dispatch_lock");
  await expect(finishReasonTranslationModelCapacityDispatch(fixture.tx, { ...lock! }, value.value)).rejects.toThrow("invalid_reason_translation_capacity_dispatch_lock");
  expect((await finishReasonTranslationModelCapacityDispatch(fixture.tx, lock!, value.value)).binding).toEqual(value.value);
  await expect(finishReasonTranslationModelCapacityDispatch(fixture.tx, lock!, value.value)).rejects.toThrow("invalid_reason_translation_capacity_dispatch_lock");
});
it("preserves reason full binding when recording unknown, without expiring dispatched work", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [], [{ ...value.row, state: "dispatched" }]], [[{ ...value.row, state: "indeterminate" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  const owned = reasonTranslationModelDispatchSchema.parse({ ...value.handle, binding: value.value, bindingHash: value.row.dispatchBindingHash });
  await expect(markModelDispatchIndeterminate(owned, "transport_unknown")).resolves.toBe(true);
});
it("rejects nonnative terminal before SQL and replay before every new entry", async () => {
  repository.terminal.mockReturnValue(null);
  await expect(reconcileReasonTranslationGatewayTerminal({ kind: "reason_translation_gateway_terminal" })).rejects.toThrow("invalid_reason_translation_gateway_terminal");
  expect(repository.transaction).not.toHaveBeenCalled();
  repository.replay.mockReturnValue({}); const value = rowFixture();
  await expect(requestReasonTranslationModelSlot({ ...value.identity, requestId: value.handle.requestId }, value.value.members)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(lockReasonTranslationModelCapacityDispatch({} as ProductTransaction, { reservation: value.handle,
    identity: value.identity, members: value.value.members })).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(finishReasonTranslationModelCapacityDispatch({} as ProductTransaction, {} as never, value.value)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(reconcileReasonTranslationGatewayTerminal({ kind: "reason_translation_gateway_terminal" })).rejects.toThrow("model_capacity_replay_unsupported");
  expect(repository.transaction).not.toHaveBeenCalled();
});

it("uses a SQL member-overlap fence independent of owner, boot, model and batch order", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [], [], [{ id: "foreign-overlap" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await requestReasonTranslationModelSlot({ ...value.identity, requestId: value.handle.requestId }, [...value.value.members].reverse()))
    .toEqual({ kind: "deferred", reason: "capacity" });
  expect(fixture.writes).toEqual([]);
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const predicate = fixture.queries.at(-1) as import("drizzle-orm").SQL;
  const query = new PgDialect().sqlToQuery(predicate);
  expect(query.sql).toContain("logical_member_keys"); expect(query.sql).toContain("&& ARRAY[");
  expect(query.sql).toContain("'waiting','reserved','dispatched','indeterminate'");
  expect(query.sql).not.toContain("owner_instance_id"); expect(query.sql).not.toContain('"model"');
  expect(query.params).toEqual([value.handle.requestId, `ko:${sha}`, `ko:${other}`]);
});
it("settles historical native evidence under control/request locks without current-policy admission", async () => {
  const value = rowFixture();
  const owned = reasonTranslationModelDispatchSchema.parse({ ...value.handle, binding: value.value, bindingHash: value.row.dispatchBindingHash });
  const evidence = { ...terminal(), dispatch: owned };
  repository.terminal.mockReturnValue(evidence);
  const fixture = mockTx([[{ id: 1 }], [{ ...value.row, state: "indeterminate" }]], [[{ ...value.row, state: "settled" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await reconcileReasonTranslationGatewayTerminal({ kind: "reason_translation_gateway_terminal" })).toEqual({ kind: "settled" });
  expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
  expect(fixture.writes.some(item => (item.value as { kind?: string }).kind === "dispatch_settled")).toBe(true);
});
it("refuses a historical terminal if persisted member metadata was changed", async () => {
  const value = rowFixture();
  const evidence = { ...terminal(), dispatch: reasonTranslationModelDispatchSchema.parse({ ...value.handle,
    binding: value.value, bindingHash: value.row.dispatchBindingHash }) };
  repository.terminal.mockReturnValue(evidence);
  const fixture = mockTx([[{ id: 1 }], [{ ...value.row, state: "indeterminate", logicalMemberKeys: [`ko:${other}`] }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  await expect(reconcileReasonTranslationGatewayTerminal({ kind: "reason_translation_gateway_terminal" }))
    .rejects.toThrow("reason_translation_gateway_terminal_binding_mismatch");
  expect(fixture.writes).toEqual([]);
});
it("binds the exact member/cache snapshot supplied before the first lock await", async () => {
  const value = rowFixture(), changed = { ...value.value, members: [{ sourceHash: sha,
    cache: { kind: "present" as const, rowIdentityHash: other, attempts: 4 } }, value.value.members[1]] };
  changed.inputHash = reasonTranslationInputHash({ members: changed.members, model: changed.model });
  const identity = { ...value.identity, workKey: `${changed.logicalWorkKey}:${changed.inputHash}` };
  const fixture = mockTx([[control()], [{ ...value.row, workKey: identity.workKey }], []], [[{ ...value.row, state: "dispatched" }]]);
  const lock = await lockReasonTranslationModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity, members: value.value.members });
  expect(lock).not.toBeNull();
  await expect(finishReasonTranslationModelCapacityDispatch(fixture.tx, lock!, changed))
    .rejects.toThrow("reason_translation_capacity_dispatch_binding_mismatch");
  expect(fixture.writes).toEqual([]);
});
