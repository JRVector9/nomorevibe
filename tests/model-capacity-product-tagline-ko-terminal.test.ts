import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { productTaglineKoMemberKeys, productTaglineKoLogicalWorkKey, productTaglineKoInputHash,
  productTaglineKoInputSchema, productTaglineKoDispatchBindingSchema, productTaglineKoDispatchBindingHash,
  productTaglineKoModelDispatchSchema, productTaglineKoGatewayTerminalEvidenceSchema } from "@/lib/llm/capacity";

const sha = "a".repeat(64), other = "b".repeat(64);
function input() {
  return { members: [
    { productId: 21, slug: "alpha", sourceIdentityHash: sha, sourceHash: other,
      cache: { kind: "absent" as const } },
    { productId: 32, slug: "beta", sourceIdentityHash: other, sourceHash: sha,
      cache: { kind: "present" as const, rowIdentityHash: other, attempts: 13, qualityRejections: 7 } },
  ], model: "tagline-model" };
}
function binding() {
  const value = input();
  return { ...value, kind: "product_tagline_ko_gateway" as const, version: 1 as const,
    logicalWorkKey: productTaglineKoLogicalWorkKey(value.members), inputHash: productTaglineKoInputHash(value),
    provider: "abcllm" as const, routeId: "product-tagline-ko" as const, wireHash: sha, servingContractHash: other,
    totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: "product-tagline-ko" as const, token: randomUUID(), requestedVersion: 2 },
    role: { role: "text" as const, instanceId: "tagline-owner", bootId: randomUUID(), release: "release",
      kind: "primary" as const, epoch: 1, batch: { mode: "legacy" as const } } };
}
function dispatch() {
  const value = binding();
  return { requestId: randomUUID(), owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: sha,
    binding: value, bindingHash: productTaglineKoDispatchBindingHash(value) };
}
function terminal() {
  return { version: 1 as const, kind: "product_tagline_ko_gateway_terminal" as const, dispatch: dispatch(),
    finishReason: "length" as const, responseHash: sha, actualUsage: null, provenance: "unknown" as const };
}

describe("fixed Korean tagline ledger shapes, never cache or role authority", () => {
  it("accepts absent and raw present counts above six with legacy or versioned role shapes", () => {
    const value = binding();
    expect(productTaglineKoDispatchBindingSchema.parse(value).members).toEqual(value.members);
    expect(productTaglineKoInputSchema.parse(input()).members[1].cache).toEqual({ kind: "present",
      rowIdentityHash: other, attempts: 13, qualityRejections: 7 });
    expect(productTaglineKoDispatchBindingSchema.safeParse({ ...value, role: { ...value.role,
      role: "translation", batch: { mode: "versioned", host: "oracle-osaka-smoke", batchEpoch: 2 } } }).success).toBe(true);
    expect(productTaglineKoDispatchBindingSchema.safeParse({ ...value, role: { ...value.role, role: "translation" } }).success).toBe(false);
  });
  it("keeps product target ownership independent of changed source, wire, cache or generation", () => {
    const value = input(), changed = { ...value.members[0], slug: "renamed", sourceIdentityHash: other,
      sourceHash: sha, cache: value.members[1].cache };
    expect(productTaglineKoMemberKeys([changed, value.members[1]])).toEqual(["product-tagline-ko:21", "product-tagline-ko:32"]);
    expect(productTaglineKoLogicalWorkKey([changed, value.members[1]])).toBe(productTaglineKoLogicalWorkKey(value.members));
    expect(`${productTaglineKoLogicalWorkKey(value.members)}:${productTaglineKoInputHash(value)}`).toHaveLength(153);
  });
  it("sorts semantic membership without changing original wire order or caller input", () => {
    const value = input(), before = structuredClone(value), reverse = { ...value, members: [...value.members].reverse() };
    expect(productTaglineKoInputHash(value)).toBe(productTaglineKoInputHash(reverse));
    expect(productTaglineKoInputSchema.parse(reverse).members).toEqual(reverse.members);
    const owned = binding();
    expect(productTaglineKoDispatchBindingHash(owned)).not.toBe(productTaglineKoDispatchBindingHash({ ...owned, members: [...owned.members].reverse() }));
    expect(value).toEqual(before);
  });
  it("hashes original source identity separately from wire source and every raw cache field", () => {
    const value = input(), hash = productTaglineKoInputHash(value), member = value.members[1];
    const variants = [{ ...member, productId: 33 }, { ...member, slug: "generation" }, { ...member, sourceIdentityHash: sha },
      { ...member, sourceHash: other }, { ...member, cache: { kind: "absent" } },
      { ...member, cache: { ...member.cache, rowIdentityHash: sha } }, { ...member, cache: { ...member.cache, attempts: 14 } },
      { ...member, cache: { ...member.cache, qualityRejections: 8 } }];
    for (const changed of variants) expect(productTaglineKoInputHash({ ...value, members: [value.members[0], changed] } as never)).not.toBe(hash);
    expect(productTaglineKoInputHash({ ...value, model: "another-model" })).not.toBe(hash);
  });
  it("rejects duplicate product targets even with different source and permits equal wire source at distinct products", () => {
    const value = input(), first = value.members[0];
    expect(productTaglineKoInputSchema.safeParse({ ...value, members: [first, { ...first, sourceIdentityHash: other }] }).success).toBe(false);
    expect(productTaglineKoInputSchema.safeParse({ ...value, members: [first, { ...value.members[1], sourceHash: other }] }).success).toBe(true);
  });
  it("accepts one through eight targets and rejects malformed absent or present cache snapshots", () => {
    const value = input(), first = value.members[0];
    for (const size of [1, 8]) expect(productTaglineKoInputSchema.safeParse({ ...value,
      members: Array.from({ length: size }, (_, index) => ({ ...first, productId: index + 1 })) }).success).toBe(true);
    for (const size of [0, 9]) expect(productTaglineKoInputSchema.safeParse({ ...value,
      members: Array.from({ length: size }, (_, index) => ({ ...first, productId: index + 1 })) }).success).toBe(false);
    for (const changed of [{ ...first, productId: Number.MAX_SAFE_INTEGER + 1 }, { ...first, sourceIdentityHash: "invalid" },
      { ...first, slug: "x".repeat(81) }, { ...first, cache: { kind: "absent", attempts: 0 } },
      { ...first, cache: { kind: "present", rowIdentityHash: sha, attempts: 1 } },
      { ...first, cache: { kind: "present", rowIdentityHash: sha, attempts: -1, qualityRejections: 0 } },
      { ...first, cache: { kind: "present", rowIdentityHash: sha, attempts: Number.MAX_SAFE_INTEGER + 1, qualityRejections: 0 } },
      { ...first, cache: { kind: "present", rowIdentityHash: sha, attempts: 0, qualityRejections: 0, home: true } }])
      expect(productTaglineKoInputSchema.safeParse({ ...value, members: [changed] }).success).toBe(false);
  });
  it("rejects stale original tuple or raw cache identity behind an old semantic hash", () => {
    const value = binding();
    expect(productTaglineKoDispatchBindingSchema.safeParse({ ...value, logicalWorkKey: `text:product-tagline-ko:${other}` }).success).toBe(false);
    expect(productTaglineKoDispatchBindingSchema.safeParse({ ...value, members: [{ ...value.members[0], sourceIdentityHash: other }, value.members[1]] }).success).toBe(false);
  });
  it("requires full C and exact original owner and ordered binding hash", () => {
    expect(productTaglineKoDispatchBindingSchema.safeParse({ ...binding(), chargedTokens: 1 }).success).toBe(false);
    const owned = dispatch();
    expect(productTaglineKoModelDispatchSchema.safeParse({ ...owned, owner: { instanceId: "foreign", bootId: randomUUID() } }).success).toBe(false);
    expect(productTaglineKoModelDispatchSchema.safeParse({ ...owned, binding: { ...owned.binding, members: [...owned.binding.members].reverse() } }).success).toBe(false);
  });
  it("accepts physical length with unknown usage while rejecting unsafe sums and usage above C", () => {
    const value = terminal();
    expect(productTaglineKoGatewayTerminalEvidenceSchema.parse(value).finishReason).toBe("length");
    expect(productTaglineKoGatewayTerminalEvidenceSchema.safeParse({ ...value, provenance: "upstream_reported",
      actualUsage: { inputTokens: 8000, outputTokens: 192, totalTokens: 8192 } }).success).toBe(true);
    for (const actualUsage of [{ inputTokens: 8192, outputTokens: 1, totalTokens: 8193 },
      { inputTokens: 1, outputTokens: 1, totalTokens: 1 }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }])
      expect(productTaglineKoGatewayTerminalEvidenceSchema.safeParse({ ...value, provenance: "upstream_reported", actualUsage }).success).toBe(false);
  });
  it("returns safeParse failure for nested invalid data without issuing native proof", () => {
    const value = terminal();
    expect(() => productTaglineKoGatewayTerminalEvidenceSchema.safeParse({ ...value, dispatch: { ...value.dispatch,
      binding: { ...value.dispatch.binding, members: [{ ...value.dispatch.binding.members[0], cache: null }] } } })).not.toThrow();
    expect(productTaglineKoGatewayTerminalEvidenceSchema.safeParse({ ...value, dispatch: { ...value.dispatch,
      binding: { ...value.dispatch.binding, members: [] } } }).success).toBe(false);
  });
});

// Recording rows check repository sequencing only, not PostgreSQL authority or physical locks.
const repository = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn(), terminal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: repository.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: repository.replay }));
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), writerSiteActive: async () => true })); // PR15c: fence는 dr-fence-paths 테스트가 본다(이 fixture의 tx 순서 불변)
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ readProductTaglineKoGatewayTerminal: repository.terminal }));
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityControl, modelCapacityRequests } from "@/lib/db/schema";
import { modelCapacityPolicyHash, modelCapacityReservationSchema, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { requestProductTaglineKoModelSlot, lockProductTaglineKoModelCapacityDispatch,
  finishProductTaglineKoModelCapacityDispatch, reconcileProductTaglineKoGatewayTerminal,
  markModelDispatchIndeterminate } from "@/lib/llm/capacity-repository";

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 1, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60000, reservationTtlMs: 60000,
  routes: [{ routeId: "product-tagline-ko", provider: "abcllm", model: "tagline-model", providerBudgetId: "account", groupId: "engine" }] };
const control = () => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), cursor: 0 });
function rowFixture() {
  const value = binding();
  const identity = { owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    workKey: `${value.logicalWorkKey}:${value.inputHash}`, class: "background" as const, pool: "text" as const,
    routeId: value.routeId, provider: value.provider, model: value.model };
  const handle = modelCapacityReservationSchema.parse({ requestId: randomUUID(), owner: identity.owner,
    token: randomUUID(), epoch: 1, revision: 1, policyHash: control().policyHash });
  const row = { ...identity, ...handle, ownerInstanceId: identity.owner.instanceId, ownerBootId: identity.owner.bootId,
    logicalWorkKey: value.logicalWorkKey, logicalMemberKeys: productTaglineKoMemberKeys(value.members),
    state: "reserved", providerBudgetId: "account", groupId: "engine", dispatchedAt: new Date(),
    dispatchBinding: value, dispatchBindingHash: productTaglineKoDispatchBindingHash(value) };
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
  expect(await requestProductTaglineKoModelSlot({ ...value.identity, requestId: value.handle.requestId }, value.value.members))
    .toEqual({ kind: "deferred", reason: "capacity" });
  const write = fixture.writes.find(item => item.table === modelCapacityRequests)!;
  expect(write.value).toMatchObject({ logicalWorkKey: value.value.logicalWorkKey,
    logicalMemberKeys: ["product-tagline-ko:21", "product-tagline-ko:32"], state: "waiting" });
});
it("checks overlapping durable targets independently of model, owner, source and boot", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [], [], [{ id: "foreign-overlap" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await requestProductTaglineKoModelSlot({ ...value.identity, requestId: value.handle.requestId }, [...value.value.members].reverse()))
    .toEqual({ kind: "deferred", reason: "capacity" });
  expect(fixture.writes).toEqual([]);
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const query = new PgDialect().sqlToQuery(fixture.queries.at(-1) as import("drizzle-orm").SQL);
  expect(query.sql).toContain("logical_member_keys"); expect(query.sql).toContain("&& ARRAY[");
  expect(query.sql).toContain("'waiting','reserved','dispatched','indeterminate'");
  expect(query.sql).not.toContain("owner_instance_id"); expect(query.sql).not.toContain('"model"');
  expect(query.params).toEqual([value.handle.requestId, "product-tagline-ko:21", "product-tagline-ko:32"]);
  expect(query.sql).toContain("logical_member_keys\" IS NULL");
  expect(query.sql).toContain("'product-tagline-ko'");
});
it("takes control and request UPDATE before rejecting changed durable membership", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [{ ...value.row, logicalMemberKeys: ["product-tagline-ko:21"] }]]);
  expect(await lockProductTaglineKoModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, members: value.value.members })).toBeNull();
  expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
  expect(fixture.writes).toEqual([]);
});
it("finishes only the same private TX capability once with the original cache snapshot", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [value.row], []], [[{ ...value.row, state: "dispatched" }]]);
  const lock = await lockProductTaglineKoModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, members: value.value.members });
  expect(lock).not.toBeNull();
  await expect(finishProductTaglineKoModelCapacityDispatch({} as ProductTransaction, lock!, value.value))
    .rejects.toThrow("invalid_product_tagline_ko_capacity_dispatch_lock");
  await expect(finishProductTaglineKoModelCapacityDispatch(fixture.tx, { ...lock! }, value.value))
    .rejects.toThrow("invalid_product_tagline_ko_capacity_dispatch_lock");
  expect((await finishProductTaglineKoModelCapacityDispatch(fixture.tx, lock!, value.value)).binding).toEqual(value.value);
  await expect(finishProductTaglineKoModelCapacityDispatch(fixture.tx, lock!, value.value))
    .rejects.toThrow("invalid_product_tagline_ko_capacity_dispatch_lock");
});
it("rejects nonnative terminal and genuine replay before SQL on every new entry", async () => {
  repository.terminal.mockReturnValue(null);
  await expect(reconcileProductTaglineKoGatewayTerminal({} as never)).rejects.toThrow("invalid_product_tagline_ko_gateway_terminal");
  expect(repository.transaction).not.toHaveBeenCalled();
  repository.replay.mockReturnValue({}); const value = rowFixture();
  await expect(requestProductTaglineKoModelSlot({ ...value.identity, requestId: value.handle.requestId }, value.value.members)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(lockProductTaglineKoModelCapacityDispatch({} as ProductTransaction, { reservation: value.handle,
    identity: value.identity, members: value.value.members })).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(finishProductTaglineKoModelCapacityDispatch({} as ProductTransaction, {} as never, value.value)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(reconcileProductTaglineKoGatewayTerminal({} as never)).rejects.toThrow("model_capacity_replay_unsupported");
  expect(repository.transaction).not.toHaveBeenCalled();
});
it("preserves original full binding when recording an unknown dispatch", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [], [{ ...value.row, state: "dispatched" }]], [[{ ...value.row, state: "indeterminate" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  const owned = productTaglineKoModelDispatchSchema.parse({ ...value.handle, binding: value.value, bindingHash: value.row.dispatchBindingHash });
  await expect(markModelDispatchIndeterminate(owned, "transport_unknown")).resolves.toBe(true);
});
it("settles historical opaque evidence without requiring today's open policy", async () => {
  const value = rowFixture(), evidence = { ...terminal(), dispatch: productTaglineKoModelDispatchSchema.parse({ ...value.handle,
    binding: value.value, bindingHash: value.row.dispatchBindingHash }) };
  repository.terminal.mockReturnValue(evidence);
  const fixture = mockTx([[{ id: 1 }], [{ ...value.row, state: "indeterminate" }]], [[{ ...value.row, state: "settled" }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await reconcileProductTaglineKoGatewayTerminal({} as never)).toEqual({ kind: "settled" });
  expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
  expect(fixture.writes.some(item => (item.value as { kind?: string }).kind === "dispatch_settled")).toBe(true);
});
it("rejects historical terminal with a changed original target set before any write", async () => {
  const value = rowFixture(), evidence = { ...terminal(), dispatch: productTaglineKoModelDispatchSchema.parse({ ...value.handle,
    binding: value.value, bindingHash: value.row.dispatchBindingHash }) };
  repository.terminal.mockReturnValue(evidence);
  const fixture = mockTx([[{ id: 1 }], [{ ...value.row, state: "indeterminate", logicalMemberKeys: ["product-tagline-ko:21"] }]]);
  repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  await expect(reconcileProductTaglineKoGatewayTerminal({} as never)).rejects.toThrow("product_tagline_ko_gateway_terminal_binding_mismatch");
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
  const pending = lockProductTaglineKoModelCapacityDispatch(fixture.tx, { reservation: value.handle,
    identity: value.identity, members: callerMembers });
  const cache = callerMembers[1].cache;
  if (cache.kind !== "present") throw new Error("present_cache_control_required");
  cache.rowIdentityHash = sha; cache.attempts = 14;
  release();
  const lock = await pending;
  expect(lock).not.toBeNull();
  expect((await finishProductTaglineKoModelCapacityDispatch(fixture.tx, lock!, value.value)).binding).toEqual(value.value);
});
