import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { crawlTaglineMemberKeys, crawlTaglineGenerationHash, crawlTaglineLogicalWorkKey, crawlTaglineInputHash,
  crawlTaglineInputSchema, crawlTaglineDispatchBindingSchema, crawlTaglineDispatchBindingHash,
  crawlTaglineModelDispatchSchema, crawlTaglineGatewayTerminalEvidenceSchema, modelCapacityPolicyHash,
  type CrawlTaglineInput, type CrawlTaglineDispatchBinding, type ModelCapacityPolicy } from "@/lib/llm/capacity";

const sha = "a".repeat(64), other = "b".repeat(64);
function input(): CrawlTaglineInput {
  return { member: { candidateId: 21, repo: "owner/project", sourceHash: sha,
    candidateRowIdentityHash: sha, documentRowIdentityHash: other,
    cache: { kind: "present", rowIdentityHash: other, attempts: 7 } }, model: "tagline-model", askOrdinal: 1, parent: null };
}
function binding(value = input()): CrawlTaglineDispatchBinding {
  return { ...value, kind: "crawl_tagline_gateway", version: 1, generationHash: crawlTaglineGenerationHash(value),
    logicalWorkKey: crawlTaglineLogicalWorkKey(value), inputHash: crawlTaglineInputHash(value),
    provider: "abcllm", routeId: "crawl-tagline", wireHash: sha, servingContractHash: other,
    totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: "crawl-tagline", token: randomUUID(), requestedVersion: 2 },
    role: { role: "text", instanceId: "text-worker", bootId: randomUUID(), release: "release",
      kind: "primary", epoch: 1, batch: { mode: "legacy" } } };
}
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 1, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60000, reservationTtlMs: 60000,
  routes: [{ routeId: "crawl-tagline", provider: "abcllm", model: "tagline-model", providerBudgetId: "account", groupId: "engine" }] };
function dispatch(value = binding()) {
  return crawlTaglineModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: value.role.instanceId,
    bootId: value.role.bootId }, token: randomUUID(), epoch: 1, revision: 1, policyHash: modelCapacityPolicyHash(policy),
    binding: value, bindingHash: crawlTaglineDispatchBindingHash(value) });
}
function terminal() {
  return { version: 1, kind: "crawl_tagline_gateway_terminal", dispatch: dispatch(), finishReason: "length",
    responseHash: sha, actualUsage: null, provenance: "unknown", outcome: { ok: true, tagline: "", source: "page" } };
}

describe("fixed crawl-tagline shape and canonical phase identity", () => {
  it("keeps stable target and generation across identical evidence refetch without mutating input", () => {
    const value = input(), before = structuredClone(value), refetch = { ...value,
      member: { ...value.member, candidateRowIdentityHash: other, documentRowIdentityHash: sha } };
    expect(crawlTaglineMemberKeys(refetch.member)).toEqual(["crawl-tagline:21"]);
    expect(crawlTaglineGenerationHash(refetch)).toBe(crawlTaglineGenerationHash(value));
    expect(crawlTaglineLogicalWorkKey(refetch)).toBe(crawlTaglineLogicalWorkKey(value));
    expect(crawlTaglineInputHash(refetch)).not.toBe(crawlTaglineInputHash(value));
    expect(value).toEqual(before);
  });
  it("changes generation only for candidate/repo/evidence/model/cache and canonicalizes object keys", () => {
    const value = input(), hash = crawlTaglineGenerationHash(value);
    for (const member of [{ ...value.member, candidateId: 22 }, { ...value.member, repo: "owner/renamed" },
      { ...value.member, sourceHash: other }, { ...value.member, cache: { kind: "absent" as const } },
      { ...value.member, cache: { kind: "present" as const, rowIdentityHash: sha, attempts: 7 } },
      { ...value.member, cache: { kind: "present" as const, rowIdentityHash: other, attempts: 8 } }])
      expect(crawlTaglineGenerationHash({ ...value, member })).not.toBe(hash);
    expect(crawlTaglineGenerationHash({ ...value, model: "other-model" })).not.toBe(hash);
    const reverse = JSON.parse(JSON.stringify(value), (_key, child) => child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).reverse()) : child);
    expect(crawlTaglineInputHash(reverse)).toBe(crawlTaglineInputHash(value));
    expect(`${crawlTaglineLogicalWorkKey(value)}:${crawlTaglineInputHash(value)}`).toHaveLength(148);
  });
  it("uses separate phase keys with the same generation and exact parent in semantic input", () => {
    const first = input(), second: CrawlTaglineInput = { ...first, askOrdinal: 2,
      parent: { requestId: randomUUID(), bindingHash: sha, responseHash: other } };
    expect(crawlTaglineGenerationHash(second)).toBe(crawlTaglineGenerationHash(first));
    expect(crawlTaglineLogicalWorkKey(second)).not.toBe(crawlTaglineLogicalWorkKey(first));
    expect(crawlTaglineInputHash({ ...second, parent: { ...second.parent!, responseHash: sha } })).not.toBe(crawlTaglineInputHash(second));
  });
  it("rejects ordinal-parent contradictions and malformed cache while retaining count above eligibility", () => {
    const value = input();
    expect(crawlTaglineInputSchema.parse(value).member.cache).toEqual(value.member.cache);
    for (const changed of [{ ...value, askOrdinal: 2 }, { ...value, parent: { requestId: randomUUID(), bindingHash: sha, responseHash: other } },
      { ...value, askOrdinal: 3 }, { ...value, member: { ...value.member, cache: { kind: "absent", attempts: 0 } } },
      { ...value, member: { ...value.member, candidateId: Number.MAX_SAFE_INTEGER + 1 } }])
      expect(crawlTaglineInputSchema.safeParse(changed).success).toBe(false);
  });
  it("binds exact generation phase and input to full C with only legacy/versioned text owners", () => {
    const value = binding();
    expect(crawlTaglineDispatchBindingSchema.parse(value)).toEqual(value);
    expect(crawlTaglineDispatchBindingSchema.safeParse({ ...value, role: { ...value.role,
      batch: { mode: "versioned", host: "oracle-osaka-smoke", batchEpoch: 2 } } }).success).toBe(true);
    for (const changed of [{ ...value, generationHash: other }, { ...value, inputHash: other },
      { ...value, logicalWorkKey: `text:crawl-tagline:${other}` }, { ...value, chargedTokens: 1 },
      { ...value, role: { ...value.role, role: "translation" } }])
      expect(crawlTaglineDispatchBindingSchema.safeParse(changed).success).toBe(false);
  });
  it("rejects changed ordered binding hash and different dispatch owner", () => {
    const value = dispatch();
    expect(crawlTaglineModelDispatchSchema.safeParse({ ...value, bindingHash: other }).success).toBe(false);
    expect(crawlTaglineModelDispatchSchema.safeParse({ ...value, owner: { ...value.owner, instanceId: "other" } }).success).toBe(false);
  });
  it("persists bounded parser outcomes independently of physical finish and usage provenance", () => {
    const value = terminal();
    expect(crawlTaglineGatewayTerminalEvidenceSchema.parse(value).outcome).toEqual(value.outcome);
    expect(crawlTaglineGatewayTerminalEvidenceSchema.safeParse({ ...value, outcome: { ok: false, error: "invalid_output" } }).success).toBe(true);
    for (const outcome of [{ ok: false, error: "network" }, { ok: true, tagline: "x".repeat(201), source: "page" },
      { ok: true, tagline: "", source: "invented" }, { ok: true, tagline: "", source: "page", proof: true }])
      expect(crawlTaglineGatewayTerminalEvidenceSchema.safeParse({ ...value, outcome }).success).toBe(false);
    expect(crawlTaglineGatewayTerminalEvidenceSchema.safeParse({ ...value, provenance: "upstream_reported",
      actualUsage: { inputTokens: 8192, outputTokens: 1, totalTokens: 8193 } }).success).toBe(false);
  });
});

// Recording-transaction controls exercise API behavior, not physical PG locks or native provenance.
const recording = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn(), terminal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: recording.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: recording.replay }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ readCrawlTaglineGatewayTerminal: recording.terminal }));
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityControl, modelCapacityRequests } from "@/lib/db/schema";
import { modelCapacityReservationSchema } from "@/lib/llm/capacity";
import { requestCrawlTaglineModelSlot, lockCrawlTaglineModelCapacityDispatch, finishCrawlTaglineModelCapacityDispatch,
  reconcileCrawlTaglineGatewayTerminal, readCrawlTaglineContinuation, markModelDispatchIndeterminate } from "@/lib/llm/capacity-repository";
import { beforeEach, vi } from "vitest";
const control = () => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), cursor: 0 });
function rowFixture(value = binding()) {
  const identity = { owner: { instanceId: value.role.instanceId, bootId: value.role.bootId },
    workKey: `${value.logicalWorkKey}:${value.inputHash}`, class: "background" as const, pool: "text" as const,
    routeId: value.routeId, provider: value.provider, model: value.model };
  const handle = modelCapacityReservationSchema.parse({ requestId: randomUUID(), owner: identity.owner,
    token: randomUUID(), epoch: 1, revision: 1, policyHash: control().policyHash });
  const owned = crawlTaglineModelDispatchSchema.parse({ ...handle, binding: value, bindingHash: crawlTaglineDispatchBindingHash(value) });
  const evidence = crawlTaglineGatewayTerminalEvidenceSchema.parse({ ...terminal(), dispatch: owned });
  const row = { ...identity, ...handle, ownerInstanceId: identity.owner.instanceId, ownerBootId: identity.owner.bootId,
    logicalWorkKey: value.logicalWorkKey, logicalMemberKeys: crawlTaglineMemberKeys(value.member),
    state: "reserved", providerBudgetId: "account", groupId: "engine", dispatchedAt: new Date(), settledAt: new Date(),
    dispatchBinding: value, dispatchBindingHash: owned.bindingHash, terminalEvidence: evidence, terminalEvidenceHash: reviewHash(evidence) };
  return { value, identity, handle, owned, evidence, row };
}
import { reviewHash } from "@/lib/crawl/agent-review-contract";
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
beforeEach(() => { vi.clearAllMocks(); recording.replay.mockReturnValue(undefined); });

it("puts the stable member in the first waiting INSERT and preserves exact phase work identity", async () => {
  const value = rowFixture(), waiting = { ...value.row, state: "waiting" };
  const fixture = mockTx([[control()], [], [], [], [], [], [], [{ count: 0 }], [waiting]], [], [[waiting]]);
  vi.mocked(fixture.tx.execute).mockResolvedValue([] as never);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await requestCrawlTaglineModelSlot({ ...value.identity, requestId: value.handle.requestId }, input()))
    .toEqual({ kind: "deferred", reason: "capacity" });
  expect(fixture.writes.find(item => item.table === modelCapacityRequests)?.value).toMatchObject({ state: "waiting",
    logicalWorkKey: value.value.logicalWorkKey, logicalMemberKeys: ["crawl-tagline:21"] });
});
it("fences settled same-phase history and old unbound crawl unknown independently of owner and model", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [], [], [{ id: randomUUID() }]]);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await requestCrawlTaglineModelSlot({ ...value.identity, requestId: value.handle.requestId }, input()))
    .toEqual({ kind: "deferred", reason: "capacity" });
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const query = new PgDialect().sqlToQuery(fixture.queries.at(-1) as import("drizzle-orm").SQL);
  expect(query.sql).toContain("logical_member_keys"); expect(query.sql).toContain("'dispatched','indeterminate','settled'");
  expect(query.sql).toContain("'crawl-tagline'"); expect(query.params).toContain("crawl-tagline:21");
  expect(query.sql).not.toContain("owner_instance_id"); expect(query.sql).not.toContain('"model"');
  expect(fixture.writes).toEqual([]);
});
it("returns settled first business data across refetch without issuing a new opaque terminal", async () => {
  const first = rowFixture(), fixture = mockTx([[{ id: 1 }], [{ ...first.row, state: "settled" }]]);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  const result = await readCrawlTaglineContinuation({ ...input(), member: { ...input().member, documentRowIdentityHash: sha } });
  expect(result).toEqual({ generationHash: first.value.generationHash, first: { requestId: first.handle.requestId,
    bindingHash: first.owned.bindingHash, responseHash: sha, outcome: first.evidence.outcome }, second: null });
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result!.first.outcome)).toBe(true);
  expect(fixture.writes).toEqual([]); expect(recording.terminal).not.toHaveBeenCalled();
});

it("locks control and actual request before issuing a same-TX one-use dispatch capability", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [value.row], []], [[{ ...value.row, state: "dispatched" }]]);
  const lock = await lockCrawlTaglineModelCapacityDispatch(fixture.tx, { reservation: value.handle, identity: value.identity, input: input() });
  expect(lock).not.toBeNull(); expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
  await expect(finishCrawlTaglineModelCapacityDispatch({} as ProductTransaction, lock!, value.value)).rejects.toThrow("invalid_crawl_tagline_capacity_dispatch_lock");
  await expect(finishCrawlTaglineModelCapacityDispatch(fixture.tx, { ...lock! }, value.value)).rejects.toThrow("invalid_crawl_tagline_capacity_dispatch_lock");
  expect((await finishCrawlTaglineModelCapacityDispatch(fixture.tx, lock!, value.value)).binding).toEqual(value.value);
  await expect(finishCrawlTaglineModelCapacityDispatch(fixture.tx, lock!, value.value)).rejects.toThrow("invalid_crawl_tagline_capacity_dispatch_lock");
});
it("requires actual settled empty first parent before the second waiting INSERT", async () => {
  const first = rowFixture(), second: CrawlTaglineInput = { ...input(), askOrdinal: 2,
    parent: { requestId: first.handle.requestId, bindingHash: first.owned.bindingHash, responseHash: sha } };
  const current = rowFixture(binding(second)), waiting = { ...current.row, state: "waiting" };
  const fixture = mockTx([[control()], [{ ...first.row, state: "settled" }], [], [], [], [], [], [{ count: 0 }], [waiting]], [], [[waiting]]);
  vi.mocked(fixture.tx.execute).mockResolvedValue([] as never);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await requestCrawlTaglineModelSlot({ ...current.identity, requestId: current.handle.requestId }, second))
    .toEqual({ kind: "deferred", reason: "capacity" });
  expect(fixture.writes.find(write => write.table === modelCapacityRequests)?.value).toMatchObject({ logicalWorkKey: current.value.logicalWorkKey,
    logicalMemberKeys: ["crawl-tagline:21"] });
});
it("rejects nonempty or unknown parent and preserves all request and event rows", async () => {
  const first = rowFixture();
  const second: CrawlTaglineInput = { ...input(), askOrdinal: 2, parent: { requestId: first.handle.requestId, bindingHash: first.owned.bindingHash, responseHash: sha } };
  const current = rowFixture(binding(second));
  const nonempty = { ...first.evidence, outcome: { ok: true, tagline: "Known", source: "page" } };
  for (const row of [{ ...first.row, state: "indeterminate" }, { ...first.row, state: "settled",
    terminalEvidence: nonempty, terminalEvidenceHash: reviewHash(nonempty) }, { ...first.row, state: "settled", terminalEvidenceHash: other }]) {
    const fixture = mockTx([[control()], [row]]);
    recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
    await expect(requestCrawlTaglineModelSlot({ ...current.identity, requestId: current.handle.requestId }, second))
      .rejects.toThrow("crawl_tagline_parent_mismatch");
    expect(fixture.writes).toEqual([]);
  }
});
it("snapshots the member, parent and identity before a held control lock", async () => {
  const value = rowFixture(), caller = structuredClone(input());
  const fixture = mockTx([[value.row], []], [[{ ...value.row, state: "dispatched" }]]);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const original = fixture.tx.select.bind(fixture.tx);
  vi.spyOn(fixture.tx, "select").mockImplementationOnce((() => ({ from: () => ({ where: () => ({
    for: async () => { await held; return [control()]; },
  }) }) })) as never).mockImplementation(original);
  const pending = lockCrawlTaglineModelCapacityDispatch(fixture.tx, { reservation: value.handle, identity: value.identity, input: caller });
  caller.member.documentRowIdentityHash = sha;
  release(); const lock = await pending;
  expect(lock).not.toBeNull();
  expect((await finishCrawlTaglineModelCapacityDispatch(fixture.tx, lock!, value.value)).binding).toEqual(value.value);
});
it("settles the historical immutable native outcome and full charge without today's policy", async () => {
  const value = rowFixture(), fixture = mockTx([[{ id: 1 }], [{ ...value.row, state: "indeterminate" }]], [[{ ...value.row, state: "settled" }]]);
  recording.terminal.mockReturnValue(value.evidence);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await reconcileCrawlTaglineGatewayTerminal({} as never)).toEqual({ kind: "settled" });
  expect(fixture.writes[0].value).toMatchObject({ state: "settled", terminalEvidence: value.evidence, terminalEvidenceHash: reviewHash(value.evidence) });
  expect(fixture.writes[1].value).toMatchObject({ kind: "dispatch_settled", evidence: value.evidence });
  expect(fixture.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
});
it("makes the same opaque terminal idempotent and rejects conflicting persisted outcomes", async () => {
  const value = rowFixture(); recording.terminal.mockReturnValue(value.evidence);
  const fixture = mockTx([[{ id: 1 }], [{ ...value.row, state: "settled" }]]);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect(await reconcileCrawlTaglineGatewayTerminal({} as never)).toEqual({ kind: "already_settled" });
  expect(fixture.writes).toEqual([]);
  const bad = mockTx([[{ id: 1 }], [{ ...value.row, state: "settled", terminalEvidenceHash: other }]]);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(bad.tx));
  await expect(reconcileCrawlTaglineGatewayTerminal({} as never)).rejects.toThrow("crawl_tagline_gateway_terminal_conflict");
});
it("returns both settled phases as business data and rejects a broken stored parent", async () => {
  const first = rowFixture(), second = rowFixture(binding({ ...input(), askOrdinal: 2,
    parent: { requestId: first.handle.requestId, bindingHash: first.owned.bindingHash, responseHash: sha } }));
  const fixture = mockTx([[{ id: 1 }], [{ ...second.row, state: "settled" }, { ...first.row, state: "settled" }]]);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  expect((await readCrawlTaglineContinuation(input()))?.second).toEqual({ requestId: second.handle.requestId,
    bindingHash: second.owned.bindingHash, responseHash: sha, outcome: second.evidence.outcome });
  const bad = mockTx([[{ id: 1 }], [{ ...second.row, state: "settled" }]]);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(bad.tx));
  await expect(readCrawlTaglineContinuation(input())).rejects.toThrow("crawl_tagline_continuation_mismatch");
});
it("retains full original binding when marking a native call unknown", async () => {
  const value = rowFixture(), fixture = mockTx([[control()], [], [{ ...value.row, state: "dispatched" }]], [[{ ...value.row, state: "indeterminate" }]]);
  recording.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(fixture.tx));
  await expect(markModelDispatchIndeterminate(value.owned, "transport_unknown")).resolves.toBe(true);
});
it("rejects copied terminal and replay on every fixed entry before SQL", async () => {
  recording.terminal.mockReturnValue(null);
  await expect(reconcileCrawlTaglineGatewayTerminal({} as never)).rejects.toThrow("invalid_crawl_tagline_gateway_terminal");
  expect(recording.transaction).not.toHaveBeenCalled();
  const value = rowFixture(); recording.replay.mockReturnValue({});
  await expect(requestCrawlTaglineModelSlot({ ...value.identity, requestId: value.handle.requestId }, input())).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(lockCrawlTaglineModelCapacityDispatch({} as ProductTransaction, { reservation: value.handle, identity: value.identity, input: input() })).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(finishCrawlTaglineModelCapacityDispatch({} as ProductTransaction, {} as never, value.value)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(reconcileCrawlTaglineGatewayTerminal({} as never)).rejects.toThrow("model_capacity_replay_unsupported");
  await expect(readCrawlTaglineContinuation(input())).rejects.toThrow("model_capacity_replay_unsupported");
  expect(recording.transaction).not.toHaveBeenCalled();
});
