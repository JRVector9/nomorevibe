import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { ProductTransaction } from "@/lib/domain/products/generation";
const repository = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn(), terminal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: repository.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: repository.replay }));
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), writerSiteActive: async () => true })); // PR15c: fence는 dr-fence-paths 테스트가 본다(이 fixture의 tx 순서 불변)
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ readAi2GatewayTerminal: repository.terminal }));
import { requestAi2ItemModelSlot, lockAi2ItemModelCapacityDispatch, finishAi2ItemModelCapacityDispatch,
  markModelDispatchIndeterminate, reconcileAi2GatewayTerminal } from "@/lib/llm/capacity-repository";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, modelCapacityReservationSchema } from "@/lib/llm/capacity";
import { modelCapacityControl } from "@/lib/db/schema";
import { itemBindingHash, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { ai2DispatchBindingHash, ai2DispatchBindingSchema, ai2GatewayTerminalEvidenceSchema,
  ai2ModelDispatchSchema, type Ai2DispatchBinding } from "@/lib/llm/capacity";

const hash = "a".repeat(64), semantic = "b".repeat(64);
function binding() {
  const review: Ai2ItemBinding = { stage: "ai2", candidateId: 17, secondReviewId: 29,
    source: { kind: "first_attempt", firstAttemptId: 13 }, inputHash: hash, sourceRevisionHash: hash,
    policyHash: hash, promptVersion: "p1", rulesVersion: "r1", reviewer: { provider: "abcllm", model: "Exact Model" },
    generationKey: hash, vote: 29, fallbackForId: null };
  return { kind: "ai2_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai2:17:29", review,
    rowIdentityHash: hash, failureCount: 0, inputPolicyHash: semantic,
    item: { workKey: "ai2:29", owner: { instanceId: "ai2-consumer:m3", bootId: randomUUID() },
      token: randomUUID(), stageEpoch: 1, itemEpoch: 2, bindingHash: itemBindingHash(review) },
    routeId: "second-review" as const, provider: "abcllm" as const, model: "Exact Model", wireHash: hash,
    servingContractHash: hash, totalTokenBound: 4096, chargedTokens: 4096 };
}
function dispatch() {
  const value = binding();
  return { requestId: randomUUID(), owner: value.item.owner, token: randomUUID(), epoch: 1, revision: 1,
    policyHash: hash, binding: value, bindingHash: ai2DispatchBindingHash(value) };
}
const terminal = () => ({ version: 1 as const, kind: "ai2_gateway_terminal" as const, dispatch: dispatch(),
  finishReason: "stop" as const, responseHash: hash, actualUsage: null, provenance: "unknown" as const });

describe("fixed AI2 item dispatch and native terminal shape (not authority)", () => {
  it("snapshots complete actual item identity and keeps semantic/composite policy hashes separate", () => {
    const value = binding(), before = structuredClone(value), parsed = ai2DispatchBindingSchema.parse(value);
    value.item.owner.instanceId = "changed"; value.review.source = { kind: "first_attempt", firstAttemptId: 77 };
    expect(parsed).toEqual(before); expect(parsed.inputPolicyHash).not.toBe(parsed.review.policyHash);
    expect(ai2ModelDispatchSchema.safeParse(dispatch()).success).toBe(true);
  });
  it("accepts the actual published product identity and fallback chain vote", () => {
    const value = binding();
    value.review = { ...value.review, secondReviewId: 31, fallbackForId: 29,
      source: { kind: "published", slug: "same-slug", productId: 43 } };
    value.item = { ...value.item, workKey: "ai2:31", bindingHash: itemBindingHash(value.review) };
    expect(ai2DispatchBindingSchema.parse(value).logicalWorkKey).toBe("ai2:17:29");
  });
  it("requires the actual chain vote, item key and complete binding hash", () => {
    for (const change of [{ logicalWorkKey: "ai2:17:31" }, { logicalWorkKey: "ai2:18:29" },
      { item: { ...binding().item, workKey: "ai2:31" } },
      { item: { ...binding().item, bindingHash: semantic } }])
      expect(ai2DispatchBindingSchema.safeParse({ ...binding(), ...change }).success).toBe(false);
  });
  it("requires exact reviewer provider/model and conservative C charge", () => {
    for (const change of [{ provider: "other" }, { model: "other" }, { routeId: "other" },
      { chargedTokens: 4095 }, { totalTokenBound: 0 }, { failureCount: -1 }, { failureCount: 1.5 },
      { rowIdentityHash: "bad" }, { inputPolicyHash: "bad" }, { extra: true }])
      expect(ai2DispatchBindingSchema.safeParse({ ...binding(), ...change }).success).toBe(false);
  });
  it("rejects AI1/fetch bindings and unsafe, incomplete or extra nested identity", () => {
    const value = binding();
    for (const change of [{ review: { ...value.review, stage: "ai1" } },
      { review: { ...value.review, vote: 30 } },
      { review: { ...value.review, source: { kind: "published", slug: "same-slug" } } },
      { item: { ...value.item, stageEpoch: Number.MAX_SAFE_INTEGER + 1 } },
      { item: { ...value.item, owner: { ...value.item.owner, bootId: "bad" } } },
      { item: { ...value.item, leaseUntil: "2099-01-01" } }])
      expect(ai2DispatchBindingSchema.safeParse({ ...value, ...change }).success).toBe(false);
  });
  it("hashes a strict binding canonically and distinguishes the immutable physical claim", () => {
    const value = binding();
    const reverse = Object.fromEntries(Object.entries(value).reverse()) as Ai2DispatchBinding;
    expect(ai2DispatchBindingHash(value)).toBe(ai2DispatchBindingHash(reverse));
    expect(ai2DispatchBindingHash({ ...value, item: { ...value.item, token: randomUUID() } }))
      .not.toBe(ai2DispatchBindingHash(value));
    expect(ai2DispatchBindingHash({ ...value, inputPolicyHash: hash })).not.toBe(ai2DispatchBindingHash(value));
  });
  it("returns structured parse failure for a well-shaped but invalid nested binding", () => {
    const value = dispatch();
    expect(() => ai2ModelDispatchSchema.safeParse({ ...value,
      binding: { ...value.binding, chargedTokens: 1 } })).not.toThrow();
    expect(ai2ModelDispatchSchema.safeParse({ ...value,
      binding: { ...value.binding, chargedTokens: 1 } }).success).toBe(false);
  });
  it("rejects a mutated binding under its old hash or a different reservation owner", () => {
    const value = dispatch();
    expect(ai2ModelDispatchSchema.safeParse({ ...value, binding: { ...value.binding, failureCount: 1 } }).success).toBe(false);
    expect(ai2ModelDispatchSchema.safeParse({ ...value, owner: { ...value.owner, bootId: randomUUID() } }).success).toBe(false);
  });
  it.each(["stop", "length", "tool_calls", "function_call", "content_filter"])("accepts terminal %s without inventing known usage", finishReason => {
    expect(ai2GatewayTerminalEvidenceSchema.parse({ ...terminal(), finishReason }).actualUsage).toBeNull();
  });
  it("requires actual usage sum/provenance and never subtracts an unknown charge", () => {
    const value = terminal();
    expect(ai2GatewayTerminalEvidenceSchema.parse({ ...value, actualUsage: { inputTokens: 0, outputTokens: 3, totalTokens: 3 },
      provenance: "upstream_reported" }).actualUsage?.totalTokens).toBe(3);
    for (const change of [{ actualUsage: null, provenance: "upstream_reported" },
      { actualUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, provenance: "unknown" },
      ...[{ inputTokens: 1, outputTokens: 2, totalTokens: 4 }, { inputTokens: 4096, outputTokens: 1, totalTokens: 4097 },
        { inputTokens: -1, outputTokens: 3, totalTokens: 2 }, { inputTokens: 1, outputTokens: true, totalTokens: 2 },
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER + 1 }]
        .map(actualUsage => ({ actualUsage, provenance: "upstream_reported" }))])
      expect(ai2GatewayTerminalEvidenceSchema.safeParse({ ...value, ...change }).success).toBe(false);
  });
  it("rejects arbitrary terminal kinds, extra fields, EOF and missing identity", () => {
    for (const change of [{ finishReason: "eof" }, { kind: "ai1_gateway_terminal" }, { responseHash: "x" },
      { authority: true }, { dispatch: null }])
      expect(ai2GatewayTerminalEvidenceSchema.safeParse({ ...terminal(), ...change }).success).toBe(false);
  });
});

// Isolated repository protocol tests. These mocked rows are not actual permits or domain authority.
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "second-review", provider: "abcllm", model: "Exact Model", providerBudgetId: "account", groupId: "engine" }] };
const control = () => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), cursor: 0 });
function requestFixture() {
  const value = binding();
  const identity = { owner: value.item.owner, workKey: `${value.logicalWorkKey}:${value.item.bindingHash}`,
    class: "second" as const, pool: "reviewer" as const, routeId: "second-review", provider: "abcllm", model: value.model };
  const requestId = randomUUID(), token = randomUUID(), state = control();
  const handle = modelCapacityReservationSchema.parse({ requestId, owner: identity.owner, token,
    epoch: state.epoch, revision: state.revision, policyHash: state.policyHash });
  const row = { ...identity, requestId, token, epoch: 1, revision: 1, policyHash: state.policyHash,
    ownerInstanceId: identity.owner.instanceId, ownerBootId: identity.owner.bootId, state: "reserved",
    logicalWorkKey: value.logicalWorkKey, providerBudgetId: "account", groupId: "engine", reservedUntil: new Date(),
    dispatchBinding: null, dispatchBindingHash: null, dispatchedAt: null, terminalEvidence: null, terminalEvidenceHash: null };
  return { binding: value, identity, handle, row, target: { candidateId: 17, vote: 29 } };
}
function txFixture(selects: unknown[][], updates: unknown[][] = [], executions: unknown[][] = [[{ live: true }]]) {
  const trace: string[] = [], clauses: SQL[] = [], inserts: unknown[] = [], writes: unknown[] = [];
  const query = (rows: unknown[]) => {
    const value = { from: (table: unknown) => { trace.push(table === modelCapacityControl ? "control" : "request"); return value; },
      where: (clause: SQL) => { clauses.push(clause); return value; },
      for: (mode: string) => { trace.push(mode); return value; }, limit: () => value, orderBy: () => value,
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject) };
    return value;
  };
  const tx = { select: () => query(selects.shift() ?? []),
    execute: vi.fn(async () => executions.shift() ?? []),
    update: () => ({ set: (change: unknown) => { writes.push(change); return {
      where: () => ({ returning: async () => updates.shift() ?? [] }),
    }; } }),
    insert: () => ({ values: (value: unknown) => { inserts.push(value); return Promise.resolve(); } }) };
  return { tx: tx as unknown as ProductTransaction, trace, clauses, inserts, writes };
}
beforeEach(() => { vi.clearAllMocks(); repository.replay.mockReturnValue(undefined); });

describe("fixed AI2 repository boundary protocol without SQL execution", () => {
  it("fences old unbound second-review dispatches using the fixed route before a new request", async () => {
    const value = requestFixture(), db = txFixture([[control()], [], [], [{ requestId: randomUUID() }]]);
    repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(db.tx));
    expect(await requestAi2ItemModelSlot({ ...value.identity, requestId: value.handle.requestId }, value.target))
      .toEqual({ kind: "deferred", reason: "capacity" });
    const query = new PgDialect().sqlToQuery(db.clauses.at(-1)!);
    expect(query.sql).toContain("'second-review'"); expect(query.params).toContain("ai2:17:29");
    expect(db.inserts).toEqual([]);
  });
  it("takes control UPDATE first and returns an exact-TX one-use lock with an independent snapshot", async () => {
    const value = requestFixture(), db = txFixture([[control()], [value.row], []], [[{ ...value.row, state: "dispatched" }]]);
    const lock = await lockAi2ItemModelCapacityDispatch(db.tx, { reservation: value.handle, identity: value.identity, target: value.target });
    expect(lock).not.toBeNull(); expect(db.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
    expect(Object.isFrozen(lock!.control)).toBe(true);
    await expect(finishAi2ItemModelCapacityDispatch({} as ProductTransaction, lock!, value.binding))
      .rejects.toThrow("invalid_ai2_capacity_dispatch_lock");
    const dispatched = await finishAi2ItemModelCapacityDispatch(db.tx, lock!, value.binding);
    expect(dispatched.binding).toEqual(value.binding); expect(db.inserts).toEqual([expect.objectContaining({ kind: "dispatch_started" })]);
    await expect(finishAi2ItemModelCapacityDispatch(db.tx, lock!, value.binding)).rejects.toThrow("invalid_ai2_capacity_dispatch_lock");
  });
  it("snapshots caller identity/target before waiting and rejects a final expired reservation CAS", async () => {
    const value = requestFixture(), db = txFixture([[control()], [value.row], []]);
    const work = lockAi2ItemModelCapacityDispatch(db.tx, { reservation: value.handle, identity: value.identity, target: value.target });
    value.target.vote = 30; value.identity.model = "changed"; Reflect.set(value.handle.owner, "instanceId", "changed");
    const lock = await work;
    expect(lock).not.toBeNull();
    await expect(finishAi2ItemModelCapacityDispatch(db.tx, lock!, value.binding)).rejects.toThrow("ai2_model_reservation_lost");
    expect(db.inserts).toEqual([]);
  });
  it("preserves actual SQL errors rather than translating them to capacity waiting", async () => {
    const value = requestFixture(), original = new Error("fixed SQL failure");
    const tx = { select: () => { throw original; } } as unknown as ProductTransaction;
    await expect(lockAi2ItemModelCapacityDispatch(tx, { reservation: value.handle, identity: value.identity, target: value.target }))
      .rejects.toBe(original);
  });
  it("accepts only the exact discriminated persisted AI2 binding when recording unknown dispatch", async () => {
    const value = dispatch(), db = txFixture([[control()], [], [{ ...requestFixture().row,
      requestId: value.requestId, ownerInstanceId: value.owner.instanceId, ownerBootId: value.owner.bootId,
      token: value.token, policyHash: value.policyHash, state: "dispatched", dispatchBinding: value.binding,
      dispatchBindingHash: value.bindingHash }]], [[{ ...requestFixture().row }]]);
    repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(db.tx));
    expect(await markModelDispatchIndeterminate(value as never, "transport_unknown")).toBe(true);
    expect(db.inserts).toEqual([expect.objectContaining({ kind: "dispatch_indeterminate", reason: "transport_unknown" })]);
  });
  it("rejects a non-native/copy terminal before any DB access", async () => {
    repository.terminal.mockReturnValue(null);
    await expect(reconcileAi2GatewayTerminal(terminal() as never)).rejects.toThrow("invalid_ai2_gateway_terminal");
    expect(repository.transaction).not.toHaveBeenCalled();
  });
  it("settles historical dispatch independently of current mode/policy and keeps unknown C evidence", async () => {
    const value = terminal(), dispatched = value.dispatch;
    repository.terminal.mockReturnValue(value);
    const row = { ...requestFixture().row, requestId: dispatched.requestId, ownerInstanceId: dispatched.owner.instanceId,
      ownerBootId: dispatched.owner.bootId, token: dispatched.token, policyHash: dispatched.policyHash,
      state: "indeterminate", dispatchBinding: dispatched.binding, dispatchBindingHash: dispatched.bindingHash, dispatchedAt: new Date() };
    const db = txFixture([[{ id: 1 }], [row]], [[{ ...row, state: "settled" }]]);
    repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(db.tx));
    expect(await reconcileAi2GatewayTerminal({} as never)).toEqual({ kind: "settled" });
    expect(db.inserts).toEqual([expect.objectContaining({ kind: "dispatch_settled", evidence: value })]);
  });
});

describe("additive SQL schema metadata (not actual database conformance)", () => {
  it("declares the AI2 logical branch without removing the original AI1 shape", async () => {
    const { getTableConfig } = await import("drizzle-orm/pg-core");
    const { modelCapacityRequests } = await import("@/lib/db/schema");
    const checks = getTableConfig(modelCapacityRequests).checks;
    const logical = new PgDialect().sqlToQuery(checks.find(check => check.name === "model_capacity_requests_logical_check")!.value).sql;
    expect(logical).toContain("ai1:"); expect(logical).toContain("ai2:"); expect(logical).toContain("'second-review'");
  });
  it("declares a unique actual AI2 work-key/token/item-epoch tuple without replacing the AI1 attempt index", async () => {
    const { getTableConfig } = await import("drizzle-orm/pg-core");
    const { modelCapacityRequests } = await import("@/lib/db/schema");
    const indexes = getTableConfig(modelCapacityRequests).indexes;
    expect(indexes.some(index => index.config.name === "model_capacity_requests_ai1_attempt_idx")).toBe(true);
    const actual = indexes.find(index => index.config.name === "model_capacity_requests_ai2_claim_idx");
    expect(actual).toBeDefined(); expect(actual!.config.unique).toBe(true);
  });
});
