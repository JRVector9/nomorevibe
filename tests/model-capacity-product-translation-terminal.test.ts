import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { productTranslationMemberKeys, productTranslationLogicalWorkKey, productTranslationInputHash,
  productTranslationInputSchema, productTranslationDispatchBindingSchema, productTranslationDispatchBindingHash,
  productTranslationModelDispatchSchema, productTranslationGatewayTerminalEvidenceSchema } from "@/lib/llm/capacity";

const sha = "a".repeat(64), other = "b".repeat(64);
function input() {
  return { members: [
    { productId: 21, slug: "alpha", locale: "en" as const, field: "tagline" as const,
      sourceHash: sha, demand: { rowIdentityHash: sha, attempts: 0 } },
    { productId: 32, slug: "beta", locale: "zh-Hant" as const, field: "description" as const,
      sourceHash: other, demand: { rowIdentityHash: other, attempts: 2 } },
  ], model: "product-model" };
}
function binding() {
  const value = input();
  return { ...value, kind: "product_translation_gateway" as const, version: 1 as const,
    logicalWorkKey: productTranslationLogicalWorkKey(value.members), inputHash: productTranslationInputHash(value),
    provider: "abcllm" as const, routeId: "product-translate" as const, wireHash: sha, servingContractHash: other,
    totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: "product-translate" as const, token: randomUUID(), requestedVersion: 2 },
    role: { role: "text" as const, instanceId: "product-owner", bootId: randomUUID(), release: "release",
      kind: "primary" as const, epoch: 1, batch: { mode: "legacy" as const } } };
}
function dispatch() {
  const value = binding();
  return { requestId: randomUUID(), owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: sha,
    binding: value, bindingHash: productTranslationDispatchBindingHash(value) };
}
function terminal() {
  return { version: 1 as const, kind: "product_translation_gateway_terminal" as const, dispatch: dispatch(),
    finishReason: "length" as const, responseHash: sha, actualUsage: null, provenance: "unknown" as const };
}

describe("fixed product translation ledger shapes, never authority", () => {
  it("accepts demanded locale/field targets with legacy or actual versioned role shapes", () => {
    const value = binding();
    expect(productTranslationDispatchBindingSchema.parse(value).members).toEqual(value.members);
    expect(productTranslationDispatchBindingSchema.safeParse({ ...value, role: { ...value.role,
      role: "translation", batch: { mode: "versioned", host: "oracle-osaka-smoke", batchEpoch: 2 } } }).success).toBe(true);
    expect(productTranslationDispatchBindingSchema.safeParse({ ...value, role: { ...value.role, role: "translation" } }).success).toBe(false);
  });
  it("keeps target fences independent of changed source, generation slug, model or demand retry", () => {
    const value = input(), changed = { ...value.members[0], slug: "renamed", sourceHash: other,
      demand: { rowIdentityHash: other, attempts: 3 } };
    expect(productTranslationMemberKeys([changed, value.members[1]])).toEqual([
      "product-translate:21:en:tagline", "product-translate:32:zh-Hant:description",
    ]);
    expect(productTranslationLogicalWorkKey([changed, value.members[1]]))
      .toBe(productTranslationLogicalWorkKey(value.members));
  });
  it("sorts semantic member identity while preserving original input and binding wire order", () => {
    const value = input(), before = structuredClone(value), reverse = { ...value, members: [...value.members].reverse() };
    expect(productTranslationInputHash(value)).toBe(productTranslationInputHash(reverse));
    expect(productTranslationInputSchema.parse(reverse).members).toEqual(reverse.members);
    const owned = binding(), reordered = { ...owned, members: [...owned.members].reverse() };
    expect(productTranslationDispatchBindingHash(owned)).not.toBe(productTranslationDispatchBindingHash(reordered));
    expect(value).toEqual(before);
  });
  it("hashes every semantic member field and the model without changing logical target membership", () => {
    const value = input(), hash = productTranslationInputHash(value), member = value.members[0];
    const variants = [{ ...member, productId: 22 }, { ...member, slug: "new-generation" },
      { ...member, locale: "zh-Hans" as const }, { ...member, field: "description" as const },
      { ...member, sourceHash: other }, { ...member, demand: { ...member.demand, rowIdentityHash: other } },
      { ...member, demand: { ...member.demand, attempts: 1 } }];
    for (const changed of variants) expect(productTranslationInputHash({ ...value, members: [changed, value.members[1]] })).not.toBe(hash);
    expect(productTranslationInputHash({ ...value, model: "another-model" })).not.toBe(hash);
  });
  it("rejects duplicate targets even when source changes but allows equal source at distinct targets", () => {
    const value = input(), first = value.members[0];
    expect(productTranslationInputSchema.safeParse({ ...value, members: [first, { ...first, sourceHash: other }] }).success).toBe(false);
    expect(productTranslationInputSchema.safeParse({ ...value, members: [first, { ...value.members[1], sourceHash: sha }] }).success).toBe(true);
  });
  it("accepts one through four targets and rejects zero, five and invalid demand snapshots", () => {
    const value = input(), first = value.members[0];
    for (const size of [1, 4]) expect(productTranslationInputSchema.safeParse({ ...value,
      members: Array.from({ length: size }, (_, index) => ({ ...first, productId: index + 1 })) }).success).toBe(true);
    for (const size of [0, 5]) expect(productTranslationInputSchema.safeParse({ ...value,
      members: Array.from({ length: size }, (_, index) => ({ ...first, productId: index + 1 })) }).success).toBe(false);
    for (const changed of [{ ...first, productId: Number.MAX_SAFE_INTEGER + 1 }, { ...first, slug: "x".repeat(81) },
      { ...first, locale: "ko" }, { ...first, field: "name" }, { ...first, sourceHash: "invalid" },
      { ...first, demand: { rowIdentityHash: sha, attempts: 4 } }, { ...first, demand: { attempts: 0 } },
      { ...first, demand: { ...first.demand, suppliedReady: true } }])
      expect(productTranslationInputSchema.safeParse({ ...value, members: [changed] }).success).toBe(false);
  });
  it("rejects a different logical member set or stale demand behind the original input hash", () => {
    const value = binding();
    expect(productTranslationDispatchBindingSchema.safeParse({ ...value, logicalWorkKey: `text:product-translate:${other}` }).success).toBe(false);
    expect(productTranslationDispatchBindingSchema.safeParse({ ...value, members: [{ ...value.members[0],
      demand: { rowIdentityHash: other, attempts: 1 } }, value.members[1]] }).success).toBe(false);
  });
  it("requires full C charge, exact original owner and binding hash", () => {
    expect(productTranslationDispatchBindingSchema.safeParse({ ...binding(), chargedTokens: 1 }).success).toBe(false);
    const owned = dispatch();
    expect(productTranslationModelDispatchSchema.safeParse({ ...owned, owner: { instanceId: "foreign", bootId: randomUUID() } }).success).toBe(false);
    expect(productTranslationModelDispatchSchema.safeParse({ ...owned, binding: { ...owned.binding,
      members: [...owned.binding.members].reverse() } }).success).toBe(false);
  });
  it("accepts physical length with unknown usage while rejecting unsafe sums or usage above C", () => {
    const value = terminal();
    expect(productTranslationGatewayTerminalEvidenceSchema.parse(value).finishReason).toBe("length");
    expect(productTranslationGatewayTerminalEvidenceSchema.safeParse({ ...value,
      actualUsage: { inputTokens: 8000, outputTokens: 192, totalTokens: 8192 }, provenance: "upstream_reported" }).success).toBe(true);
    for (const usage of [{ inputTokens: 8000, outputTokens: 193, totalTokens: 8193 },
      { inputTokens: 1, outputTokens: 2, totalTokens: 4 }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: 1 }])
      expect(productTranslationGatewayTerminalEvidenceSchema.safeParse({ ...value, actualUsage: usage, provenance: "upstream_reported" }).success).toBe(false);
    expect(productTranslationGatewayTerminalEvidenceSchema.safeParse({ ...value, provenance: "upstream_reported" }).success).toBe(false);
  });
  it("rejects cross-route proof shapes and invalid nested fields without throwing from safeParse", () => {
    expect(productTranslationGatewayTerminalEvidenceSchema.safeParse({ ...terminal(), kind: "reason_translation_gateway_terminal" }).success).toBe(false);
    expect(productTranslationGatewayTerminalEvidenceSchema.safeParse({ ...terminal(), finishReason: undefined }).success).toBe(false);
    const value = terminal();
    expect(productTranslationGatewayTerminalEvidenceSchema.safeParse({ ...value, dispatch: { ...value.dispatch,
      binding: { ...value.dispatch.binding, members: [{ ...value.dispatch.binding.members[0], demand: { attempts: 0 } }] } } }).success).toBe(false);
  });
});

// Recording rows check repository sequencing only, not PostgreSQL authority or physical locks.
const repository = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn(), terminal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: repository.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: repository.replay }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ readProductTranslationGatewayTerminal: repository.terminal }));
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityControl, modelCapacityRequests } from "@/lib/db/schema";
import { modelCapacityPolicyHash, modelCapacityReservationSchema, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { requestProductTranslationModelSlot, lockProductTranslationModelCapacityDispatch,
  finishProductTranslationModelCapacityDispatch, reconcileProductTranslationGatewayTerminal,
  markModelDispatchIndeterminate } from "@/lib/llm/capacity-repository";

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 1, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60000, reservationTtlMs: 60000,
  routes: [{ routeId: "product-translate", provider: "abcllm", model: "product-model", providerBudgetId: "account", groupId: "engine" }] };
const control = () => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), cursor: 0 });
function rowFixture() {
  const value = binding();
  const identity = { owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    workKey: `${value.logicalWorkKey}:${value.inputHash}`, class: "background" as const, pool: "text" as const,
    routeId: value.routeId, provider: value.provider, model: value.model };
  const handle = modelCapacityReservationSchema.parse({ requestId: randomUUID(), owner: identity.owner,
    token: randomUUID(), epoch: 1, revision: 1, policyHash: control().policyHash });
  const row = { ...identity, ...handle, ownerInstanceId: identity.owner.instanceId, ownerBootId: identity.owner.bootId,
    logicalWorkKey: value.logicalWorkKey, logicalMemberKeys: productTranslationMemberKeys(value.members),
    state: "reserved", providerBudgetId: "account", groupId: "engine", dispatchedAt: new Date(),
    dispatchBinding: value, dispatchBindingHash: productTranslationDispatchBindingHash(value) };
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

it("puts stable sorted targets in the very first waiting INSERT before any grant", async () => {
  const value = rowFixture(), waiting = { ...value.row, state: "waiting" };
  const fixture = mockTx([[control()], [], [], [], [], [], [], [{ count: 0 }], [waiting]], [], [[waiting]]);
  vi.mocked(fixture.tx.execute).mockResolvedValue([] as never);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await requestProductTranslationModelSlot({ ...value.identity, requestId: value.handle.requestId }, value.value.members))
    .toEqual({ kind: "deferred", reason: "capacity" });
  const write = fixture.writes.find(item => item.table === modelCapacityRequests)!;
  expect(write.value).toMatchObject({ logicalWorkKey: value.value.logicalWorkKey,
    logicalMemberKeys: ["product-translate:21:en:tagline", "product-translate:32:zh-Hant:description"], state: "waiting" });
});
it("checks overlapping durable targets independently of model, owner, source and boot", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [], [], [{ id: "foreign-overlap" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await requestProductTranslationModelSlot({ ...value.identity, requestId: value.handle.requestId }, [...value.value.members].reverse()))
    .toEqual({ kind: "deferred", reason: "capacity" });
  expect(fixture.writes).toEqual([]);
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const query = new PgDialect().sqlToQuery(fixture.queries.at(-1) as import("drizzle-orm").SQL);
  expect(query.sql).toContain("logical_member_keys"); expect(query.sql).toContain("&& ARRAY[");
  expect(query.sql).toContain("'waiting','reserved','dispatched','indeterminate'");
  expect(query.sql).not.toContain("owner_instance_id"); expect(query.sql).not.toContain('"model"');
  expect(query.params).toEqual([value.handle.requestId, "product-translate:21:en:tagline", "product-translate:32:zh-Hant:description"]);
  expect(query.sql).toContain("logical_member_keys\" IS NULL");
  expect(query.sql).toContain("'product-translate'");
});
it("takes control and request UPDATE before rejecting changed durable membership", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [{ ...value.row, logicalMemberKeys: ["product-translate:21:en:tagline"] }]]);
  expect(await lockProductTranslationModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, members: value.value.members })).toBeNull();
  expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
  expect(fixture.writes).toEqual([]);
});
it("finishes only the same private TX capability once with the original demand snapshot", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [value.row], []], [[{ ...value.row, state: "dispatched" }]]);
  const lock = await lockProductTranslationModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, members: value.value.members });
  expect(lock).not.toBeNull();
  await expect(finishProductTranslationModelCapacityDispatch({} as ProductTransaction, lock!, value.value))
    .rejects.toThrow("invalid_product_translation_capacity_dispatch_lock");
  await expect(finishProductTranslationModelCapacityDispatch(fixture.tx, { ...lock! }, value.value))
    .rejects.toThrow("invalid_product_translation_capacity_dispatch_lock");
  expect((await finishProductTranslationModelCapacityDispatch(fixture.tx, lock!, value.value)).binding).toEqual(value.value);
  await expect(finishProductTranslationModelCapacityDispatch(fixture.tx, lock!, value.value))
    .rejects.toThrow("invalid_product_translation_capacity_dispatch_lock");
});
it("rejects nonnative terminal and genuine replay before SQL on every new entry", async () => {
  repository.terminal.mockReturnValue(null);
  await expect(reconcileProductTranslationGatewayTerminal({} as never)).rejects.toThrow("invalid_product_translation_gateway_terminal");
  expect(repository.transaction).not.toHaveBeenCalled();
  repository.replay.mockReturnValue({}); const value = rowFixture();
  await expect(requestProductTranslationModelSlot({ ...value.identity, requestId: value.handle.requestId }, value.value.members)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(lockProductTranslationModelCapacityDispatch({} as ProductTransaction, { reservation: value.handle,
    identity: value.identity, members: value.value.members })).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(finishProductTranslationModelCapacityDispatch({} as ProductTransaction, {} as never, value.value)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(reconcileProductTranslationGatewayTerminal({} as never)).rejects.toThrow("model_capacity_replay_unsupported");
  expect(repository.transaction).not.toHaveBeenCalled();
});
it("preserves original full binding when recording an unknown dispatch", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [], [{ ...value.row, state: "dispatched" }]], [[{ ...value.row, state: "indeterminate" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  const owned = productTranslationModelDispatchSchema.parse({ ...value.handle, binding: value.value, bindingHash: value.row.dispatchBindingHash });
  await expect(markModelDispatchIndeterminate(owned, "transport_unknown")).resolves.toBe(true);
});
it("settles historical opaque evidence without requiring today's open policy", async () => {
  const value = rowFixture(), evidence = { ...terminal(), dispatch: productTranslationModelDispatchSchema.parse({ ...value.handle,
    binding: value.value, bindingHash: value.row.dispatchBindingHash }) };
  repository.terminal.mockReturnValue(evidence);
  const fixture = mockTx([[{ id: 1 }], [{ ...value.row, state: "indeterminate" }]], [[{ ...value.row, state: "settled" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await reconcileProductTranslationGatewayTerminal({} as never)).toEqual({ kind: "settled" });
  expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
  expect(fixture.writes.some(item => (item.value as { kind?: string }).kind === "dispatch_settled")).toBe(true);
});
it("rejects historical terminal with a changed original target set before any write", async () => {
  const value = rowFixture(), evidence = { ...terminal(), dispatch: productTranslationModelDispatchSchema.parse({ ...value.handle,
    binding: value.value, bindingHash: value.row.dispatchBindingHash }) };
  repository.terminal.mockReturnValue(evidence);
  const fixture = mockTx([[{ id: 1 }], [{ ...value.row, state: "indeterminate", logicalMemberKeys: ["product-translate:21:en:tagline"] }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  await expect(reconcileProductTranslationGatewayTerminal({} as never)).rejects.toThrow("product_translation_gateway_terminal_binding_mismatch");
  expect(fixture.writes).toEqual([]);
});

it("snapshots caller members before the first control-lock await", async () => {
  const value = rowFixture(), callerMembers = structuredClone(value.value.members);
  const fixture = mockTx([[value.row], []], [[{ ...value.row, state: "dispatched" }]]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const originalSelect = fixture.tx.select.bind(fixture.tx);
  vi.spyOn(fixture.tx, "select").mockImplementationOnce((() => ({ from: () => ({ where: () => ({
    for: async () => { await held; return [control()]; },
  }) }) })) as never).mockImplementation(originalSelect);
  const pending = lockProductTranslationModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, members: callerMembers });
  callerMembers[0].demand.rowIdentityHash = other;
  callerMembers[0].demand.attempts = 3;
  release();
  const lock = await pending;
  expect(lock).not.toBeNull();
  expect((await finishProductTranslationModelCapacityDispatch(fixture.tx, lock!, value.value)).binding).toEqual(value.value);
});
