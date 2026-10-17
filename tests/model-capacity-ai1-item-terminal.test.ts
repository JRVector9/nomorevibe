import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { itemBindingHash, type Ai1ItemBinding } from "@/lib/jobs/items/types";
import { ai1ItemDispatchBindingHash, ai1ItemDispatchBindingSchema, ai1ItemModelDispatchSchema,
  ai1ItemGatewayTerminalEvidenceSchema, ai1DispatchBindingSchema, ai2DispatchBindingSchema,
  type Ai1ItemDispatchBinding } from "@/lib/llm/capacity";

import type { SQL } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { ProductTransaction } from "@/lib/domain/products/generation";
const repository = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn(), terminal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: repository.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: repository.replay }));
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), writerSiteActive: async () => true })); // PR15c: fence는 dr-fence-paths 테스트가 본다(이 fixture의 tx 순서 불변)
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ readAi1ItemGatewayTerminal: repository.terminal }));
import { lockAi1ModelCapacityDispatch, finishAi1ModelCapacityDispatch, finishAi1ItemModelCapacityDispatch,
  markModelDispatchIndeterminate, reconcileAi1ItemGatewayTerminal } from "@/lib/llm/capacity-repository";
import { modelCapacityControl, modelCapacityRequests } from "@/lib/db/schema";
import { modelCapacityPolicyHash, modelCapacityReservationSchema, type ModelCapacityPolicy } from "@/lib/llm/capacity";

const hash = "a".repeat(64), other = "b".repeat(64);
function binding() {
  const review: Ai1ItemBinding = { stage: "ai1", candidateId: 17, inputHash: hash, sourceRevisionHash: hash,
    policyHash: other, promptVersion: "p1", rulesVersion: "r1", reviewer: { provider: "abcllm", model: "Exact Model" } };
  return { kind: "ai1_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:17", attemptId: 29, review,
    item: { workKey: "ai1:17", owner: { instanceId: "ai1-consumer:m3", bootId: randomUUID() },
      token: randomUUID(), stageEpoch: 1, itemEpoch: 2, bindingHash: itemBindingHash(review) },
    routeId: "crawl-agent-review" as const, provider: "abcllm" as const, model: "Exact Model", wireHash: hash,
    servingContractHash: hash, totalTokenBound: 4096, chargedTokens: 4096 };
}
function dispatch() {
  const value = binding();
  return ai1ItemModelDispatchSchema.parse({ requestId: randomUUID(), owner: value.item.owner, token: randomUUID(), epoch: 1, revision: 1,
    policyHash: hash, binding: value, bindingHash: ai1ItemDispatchBindingHash(value) });
}
const terminal = () => ({ version: 1 as const, kind: "ai1_item_gateway_terminal" as const, dispatch: dispatch(),
  finishReason: "stop" as const, responseHash: hash, actualUsage: null, provenance: "unknown" as const });

describe("strict AI1 item binding and terminal shape, without authority", () => {
  it("clones the actual item identity without inventing a job or AI2 policy field", () => {
    const value = binding(), before = structuredClone(value), parsed = ai1ItemDispatchBindingSchema.parse(value);
    value.item.owner.instanceId = "changed"; value.review.inputHash = other;
    expect(parsed).toEqual(before); expect(parsed.review.policyHash).toBe(other);
    expect(parsed).not.toHaveProperty("job"); expect(parsed).not.toHaveProperty("inputPolicyHash");
    expect(ai1ItemModelDispatchSchema.safeParse(dispatch()).success).toBe(true);
  });
  it("requires the candidate logical root, exact item work key and complete binding hash", () => {
    const value = binding();
    for (const change of [{ logicalWorkKey: "ai1:18" }, { item: { ...value.item, workKey: "ai1:18" } },
      { item: { ...value.item, bindingHash: other } }])
      expect(ai1ItemDispatchBindingSchema.safeParse({ ...value, ...change }).success).toBe(false);
  });
  it("requires exact reviewer model and C charge", () => {
    for (const change of [{ model: "other" }, { chargedTokens: 4095 }])
      expect(ai1ItemDispatchBindingSchema.safeParse({ ...binding(), ...change }).success).toBe(false);
  });
  it("rejects other stages, unsafe attempt and incomplete or extra nested fields", () => {
    const value = binding();
    for (const change of [{ review: { ...value.review, stage: "fetch" } }, { attemptId: 0 },
      { attemptId: Number.MAX_SAFE_INTEGER + 1 }, { item: { ...value.item, itemEpoch: 0 } },
      { item: { ...value.item, owner: { ...value.item.owner, bootId: "bad" } } },
      { item: { ...value.item, leaseUntil: "2099-01-01" } }, { job: {} }, { inputPolicyHash: hash }])
      expect(ai1ItemDispatchBindingSchema.safeParse({ ...value, ...change }).success).toBe(false);
    expect(ai1DispatchBindingSchema.safeParse(value).success).toBe(false);
    expect(ai2DispatchBindingSchema.safeParse(value).success).toBe(false);
  });
  it("hashes canonically and distinguishes the physical claim and actual attempt", () => {
    const value = binding(), reverse = Object.fromEntries(Object.entries(value).reverse()) as Ai1ItemDispatchBinding;
    expect(ai1ItemDispatchBindingHash(value)).toBe(ai1ItemDispatchBindingHash(reverse));
    expect(ai1ItemDispatchBindingHash({ ...value, attemptId: 30 })).not.toBe(ai1ItemDispatchBindingHash(value));
    expect(ai1ItemDispatchBindingHash({ ...value, item: { ...value.item, token: randomUUID() } }))
      .not.toBe(ai1ItemDispatchBindingHash(value));
  });
  it("rejects old binding hashes and a different reservation owner", () => {
    const value = dispatch();
    expect(ai1ItemModelDispatchSchema.safeParse({ ...value, binding: { ...value.binding, attemptId: 30 } }).success).toBe(false);
    expect(ai1ItemModelDispatchSchema.safeParse({ ...value, owner: { ...value.owner, bootId: randomUUID() } }).success).toBe(false);
  });
  it("returns structured nested parse failure without throwing from safeParse", () => {
    const value = dispatch(), invalid = { ...value, binding: { ...value.binding, chargedTokens: 1 } };
    expect(() => ai1ItemModelDispatchSchema.safeParse(invalid)).not.toThrow();
    expect(ai1ItemModelDispatchSchema.safeParse(invalid).success).toBe(false);
  });
  it.each(["stop", "length", "tool_calls", "function_call", "content_filter"])("accepts %s while keeping unknown usage null", finishReason => {
    expect(ai1ItemGatewayTerminalEvidenceSchema.parse({ ...terminal(), finishReason }).actualUsage).toBeNull();
  });
  it("validates actual usage provenance, safe sum and the full C bound", () => {
    const value = terminal();
    expect(ai1ItemGatewayTerminalEvidenceSchema.parse({ ...value, actualUsage: { inputTokens: 0, outputTokens: 3, totalTokens: 3 },
      provenance: "upstream_reported" }).actualUsage?.totalTokens).toBe(3);
    for (const change of [{ actualUsage: null, provenance: "upstream_reported" },
      { actualUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, provenance: "unknown" },
      ...[{ inputTokens: 1, outputTokens: 2, totalTokens: 4 }, { inputTokens: 4096, outputTokens: 1, totalTokens: 4097 },
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER + 1 }]
        .map(actualUsage => ({ actualUsage, provenance: "upstream_reported" }))])
      expect(ai1ItemGatewayTerminalEvidenceSchema.safeParse({ ...value, ...change }).success).toBe(false);
  });
  it("does not accept copied terminal kinds, EOF or arbitrary flags", () => {
    for (const change of [{ finishReason: "eof" }, { kind: "ai1_gateway_terminal" }, { kind: "ai2_gateway_terminal" },
      { authority: true }, { dispatch: null }, { responseHash: "bad" }])
      expect(ai1ItemGatewayTerminalEvidenceSchema.safeParse({ ...terminal(), ...change }).success).toBe(false);
  });
});

// Mock rows isolate the fixed repository protocol; they are not actual permits or domain proof.
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: "Exact Model", providerBudgetId: "account", groupId: "engine" }] };
const control = () => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), cursor: 0 });
function requestFixture() {
  const value = binding();
  const identity = { owner: value.item.owner, workKey: `${value.logicalWorkKey}:${value.item.bindingHash}`,
    class: "first" as const, pool: "reviewer" as const, routeId: "crawl-agent-review", provider: "abcllm", model: value.model };
  const requestId = randomUUID(), token = randomUUID(), state = control();
  const handle = modelCapacityReservationSchema.parse({ requestId, owner: identity.owner, token,
    epoch: state.epoch, revision: state.revision, policyHash: state.policyHash });
  const row = { ...identity, requestId, token, epoch: 1, revision: 1, policyHash: state.policyHash,
    ownerInstanceId: identity.owner.instanceId, ownerBootId: identity.owner.bootId, state: "reserved",
    logicalWorkKey: value.logicalWorkKey, providerBudgetId: "account", groupId: "engine", reservedUntil: new Date(),
    dispatchBinding: null, dispatchBindingHash: null, dispatchedAt: null, terminalEvidence: null, terminalEvidenceHash: null };
  return { binding: value, identity, handle, row };
}
function legacyBinding(value: ReturnType<typeof binding>) {
  return { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: value.logicalWorkKey,
    candidateId: value.review.candidateId, attemptId: value.attemptId, inputHash: value.review.inputHash,
    sourceRevisionHash: value.review.sourceRevisionHash, reviewPolicyHash: value.review.policyHash,
    promptVersion: value.review.promptVersion, rulesVersion: value.review.rulesVersion, provider: value.provider,
    model: value.model, routeId: value.routeId, stageEpoch: value.item.stageEpoch, wireHash: value.wireHash,
    servingContractHash: value.servingContractHash, totalTokenBound: value.totalTokenBound, chargedTokens: value.chargedTokens,
    job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
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


describe("AI1 item companion repository protocol without SQL execution", () => {
  it("shares the exact-TX one-use lock with legacy finish in both directions", async () => {
    for (const itemFirst of [true, false]) {
      const value = requestFixture(), db = txFixture([[control()], [value.row], []], [[{ ...value.row, state: "dispatched" }]]);
      const lock = await lockAi1ModelCapacityDispatch(db.tx, { reservation: value.handle, identity: value.identity, candidateId: 17 });
      expect(lock).not.toBeNull(); expect(db.trace.slice(0, 4)).toEqual(["control", "update", "request", "update"]);
      await expect(finishAi1ItemModelCapacityDispatch({} as ProductTransaction, lock!, value.binding))
        .rejects.toThrow("invalid_ai1_capacity_dispatch_lock");
      if (itemFirst) {
        const result = await finishAi1ItemModelCapacityDispatch(db.tx, lock!, value.binding);
        expect(result.binding).toEqual(value.binding);
        await expect(finishAi1ModelCapacityDispatch(db.tx, lock!, legacyBinding(value.binding)))
          .rejects.toThrow("invalid_ai1_capacity_dispatch_lock");
      } else {
        await finishAi1ModelCapacityDispatch(db.tx, lock!, legacyBinding(value.binding));
        await expect(finishAi1ItemModelCapacityDispatch(db.tx, lock!, value.binding))
          .rejects.toThrow("invalid_ai1_capacity_dispatch_lock");
      }
      expect(db.inserts).toEqual([expect.objectContaining({ kind: "dispatch_started" })]);
    }
  });
  it("checks the full locked request work key and item owner before any write", async () => {
    for (const mutation of ["input", "owner"] as const) {
      const value = requestFixture(), db = txFixture([[control()], [value.row], []]);
      const lock = await lockAi1ModelCapacityDispatch(db.tx, { reservation: value.handle, identity: value.identity, candidateId: 17 });
      const changed = structuredClone(value.binding);
      if (mutation === "input") { changed.review.inputHash = other; changed.item.bindingHash = itemBindingHash(changed.review); }
      else changed.item.owner.bootId = randomUUID();
      await expect(finishAi1ItemModelCapacityDispatch(db.tx, lock!, changed))
        .rejects.toThrow("ai1_capacity_dispatch_binding_mismatch");
      expect(db.writes).toEqual([]); expect(db.inserts).toEqual([]);
    }
  });
  it("preserves the final reservation DB-wall CAS failure and writes no event", async () => {
    const value = requestFixture(), db = txFixture([[control()], [value.row], []]);
    const lock = await lockAi1ModelCapacityDispatch(db.tx, { reservation: value.handle, identity: value.identity, candidateId: 17 });
    await expect(finishAi1ItemModelCapacityDispatch(db.tx, lock!, value.binding)).rejects.toThrow("ai1_model_reservation_lost");
    expect(db.inserts).toEqual([]);
  });
  it("propagates the original event error after the fixed dispatch CAS", async () => {
    const value = requestFixture(), original = new Error("fixed event failure");
    const db = txFixture([[control()], [value.row], []], [[{ ...value.row, state: "dispatched" }]]);
    db.tx.insert = (() => ({ values: () => { throw original; } })) as never;
    const lock = await lockAi1ModelCapacityDispatch(db.tx, { reservation: value.handle, identity: value.identity, candidateId: 17 });
    await expect(finishAi1ItemModelCapacityDispatch(db.tx, lock!, value.binding)).rejects.toBe(original);
  });
  it("recognizes only the discriminated persisted item binding for unknown full-C charge", async () => {
    const value = dispatch(), row = { ...requestFixture().row, requestId: value.requestId,
      ownerInstanceId: value.owner.instanceId, ownerBootId: value.owner.bootId, token: value.token, policyHash: value.policyHash,
      state: "dispatched", dispatchBinding: value.binding, dispatchBindingHash: value.bindingHash };
    const db = txFixture([[control()], [], [row]], [[row]]);
    repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(db.tx));
    expect(await markModelDispatchIndeterminate(value, "transport_unknown")).toBe(true);
    expect(db.inserts).toEqual([expect.objectContaining({ kind: "dispatch_indeterminate", reason: "transport_unknown" })]);
    expect(db.writes).toEqual([expect.objectContaining({ state: "indeterminate" })]);
  });
  it("rejects copied or wrong-family terminal before DB access", async () => {
    repository.terminal.mockReturnValue(null);
    await expect(reconcileAi1ItemGatewayTerminal(terminal() as never)).rejects.toThrow("invalid_ai1_item_gateway_terminal");
    expect(repository.transaction).not.toHaveBeenCalled();
  });
  it("settles historical evidence once with an exact stored full binding and keeps C unchanged", async () => {
    const value = terminal(), d = value.dispatch;
    const row = { ...requestFixture().row, requestId: d.requestId, ownerInstanceId: d.owner.instanceId,
      ownerBootId: d.owner.bootId, token: d.token, policyHash: d.policyHash, state: "indeterminate",
      dispatchBinding: d.binding, dispatchBindingHash: d.bindingHash, dispatchedAt: new Date() };
    repository.terminal.mockReturnValue(value);
    const db = txFixture([[{ id: 1 }], [row]], [[{ ...row, state: "settled" }]]);
    repository.transaction.mockImplementation((load: (tx: ProductTransaction) => unknown) => load(db.tx));
    expect(await reconcileAi1ItemGatewayTerminal({} as never)).toEqual({ kind: "settled" });
    expect(db.inserts).toEqual([expect.objectContaining({ kind: "dispatch_settled", evidence: value })]);
    expect(db.writes[0]).not.toHaveProperty("chargedTokens");
  });
  it("fails replay before any SQL or native verifier invocation", async () => {
    repository.replay.mockReturnValue({});
    await expect(reconcileAi1ItemGatewayTerminal({} as never)).rejects.toThrow("model_capacity_replay_unsupported");
    expect(repository.transaction).not.toHaveBeenCalled(); expect(repository.terminal).not.toHaveBeenCalled();
  });
});

describe("additive AI1 item SQL metadata, not actual database conformance", () => {
  it("retains both old binding kinds and adds the fixed item CHECK branch", () => {
    const checks = getTableConfig(modelCapacityRequests).checks;
    for (const name of ["model_capacity_requests_dispatch_check", "model_capacity_requests_terminal_check"]) {
      const sql = new PgDialect().sqlToQuery(checks.find(check => check.name === name)!.value).sql;
      expect(sql).toContain("ai1_legacy_gateway"); expect(sql).toContain("ai2_item_gateway");
      expect(sql).toContain("ai1_item_gateway");
    }
  });
  it("adds actual AI1 item claim uniqueness while retaining original attempt and AI2 indexes", () => {
    const indexes = getTableConfig(modelCapacityRequests).indexes;
    for (const name of ["model_capacity_requests_ai1_attempt_idx", "model_capacity_requests_ai2_claim_idx",
      "model_capacity_requests_ai1_item_claim_idx"])
      expect(indexes.find(index => index.config.name === name)?.config.unique).toBe(true);
  });
});
