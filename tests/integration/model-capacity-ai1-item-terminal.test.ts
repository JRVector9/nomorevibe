import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { itemBindingHash, type Ai1ItemBinding, type ItemLease } from "@/lib/jobs/items/types";
import { claimItemLease, lockItemStage, releaseItemLease } from "@/lib/jobs/items/repository";
import { ai1ItemDispatchBindingHash, modelCapacityPolicyHash, type Ai1ItemDispatchBinding,
  type ModelCapacityPolicy, type ModelCapacityRequest, type ModelCapacityReservation, type ModelSlotResult } from "@/lib/llm/capacity";
import { beginModelDispatch, cancelReservedModelSlot, finishAi1ItemModelCapacityDispatch, lockAi1ModelCapacityDispatch, finishAi1ModelCapacityDispatch,
  markModelDispatchIndeterminate, reconcileAi1ItemGatewayTerminal, requestAi1ModelSlot, requestModelSlot } from "@/lib/llm/capacity-repository";
import { prepareAi1GatewayCall, readAi1ItemGatewayTerminal, reviewWithReservedAi1ItemGateway,
  type PreparedAi1GatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const serving = vi.hoisted(() => ({ contract: null as Ai1GatewayServingContract | null }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: () => serving.contract,
}));
type Raw = Record<string, unknown>;
const prefix = `ai1-item-terminal-${randomUUID()}`, owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "ai1-item-terminal-fixture" } });
const owned = new Map<string, ModelCapacityRequest>(), items = new Map<string, ItemLease>();
const work = new Set<Promise<unknown>>(), bodies = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
const hash = "a".repeat(64), model = "Exact Model";
let serial = Number.parseInt(randomUUID().slice(0, 8), 16), initial: Record<string, unknown>, initialized = false;
let originalControl: Raw, originalStage: Raw, setup: Promise<void> | undefined, cleaning: Promise<void> | undefined;
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" }] };
function tracked<T>(pending: Promise<T>, set = work): Promise<T> { set.add(pending); void pending.catch(() => {}); return pending; }
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), bodies);
async function drain(set: Set<Promise<unknown>>, report = false) {
  const errors: unknown[] = [];
  while (set.size) {
    const pending = [...set], results = await Promise.allSettled(pending);
    for (const promise of pending) set.delete(promise);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
  }
  if (report && errors.length) throw new AggregateError(errors, "ai1_item_terminal_fixture_work_failed");
}
async function steps(loads: readonly (() => Promise<unknown>)[], priorErrors: readonly unknown[] = []) {
  const errors = [...priorErrors];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "ai1_item_terminal_fixture_cleanup_failed", { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const value: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    value[tablename] = row.value;
  }
  return value;
}
async function restoreManaged(tx: postgres.TransactionSql) {
  await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,
    policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
  await tx`UPDATE pipeline_stage_modes s SET mode=r.mode,epoch=r.epoch,writer_contract_version=r.writer_contract_version,
    draining_from=r.draining_from,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::pipeline_stage_modes,${JSON.stringify(originalStage)}::text::jsonb) r WHERE s.stage=r.stage`;
}
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...owned.keys()];
    for (const row of await tx`SELECT * FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[]) ORDER BY queue_ordinal FOR UPDATE`) {
      const value = owned.get(row.request_id)!;
      expect([row.work_key, row.owner_instance_id, row.owner_boot_id, row.class, row.pool, row.route_id, row.provider, row.model])
        .toEqual([value.workKey, value.owner.instanceId, value.owner.bootId, value.class, value.pool, value.routeId, value.provider, value.model]);
    }
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    expect(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`)
      .toEqual([{ tgenabled: "A" }, { tgenabled: "A" }]);
    const events = await tx`SELECT id::text,request_id FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events WHERE id=${event.id}::bigint
        AND request_id=${event.request_id}::uuid RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    for (const lease of items.values()) {
      const [row] = await tx`SELECT * FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${lease.workKey} FOR UPDATE`;
      expect(row).toBeDefined();
      expect([row.binding_hash, row.item_epoch, row.stage_epoch]).toEqual([lease.bindingHash, String(lease.itemEpoch), String(lease.stageEpoch)]);
      expect([row.token, row.owner_instance_id, row.owner_boot_id]).toEqual(row.token === null
        ? [null, null, null] : [lease.token, lease.owner.instanceId, lease.owner.bootId]);
      expect(await tx`DELETE FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${lease.workKey}
        AND binding_hash=${lease.bindingHash} AND item_epoch=${lease.itemEpoch} RETURNING work_key`).toHaveLength(1);
    }
    await restoreManaged(tx);
    expect(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`)
      .toEqual([{ tgenabled: "A" }, { tgenabled: "A" }]);
    expect(await whole(tx)).toEqual(initial);
  });
  owned.clear(); items.clear();
}
function cleanup() {
  if (cleaning) return cleaning;
  const pending = performCleanup(); cleaning = pending;
  const clear = () => { if (cleaning === pending) cleaning = undefined; };
  void pending.then(clear, clear); return pending;
}
async function install(value = policy) {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1,draining_from=NULL,
    updated_at=clock_timestamp() WHERE stage='ai1'`;
}
function review(extra: Partial<Ai1ItemBinding> = {}): Ai1ItemBinding {
  const id = ++serial;
  // Generic AI1 adapter only: candidateId/attemptId are synthetic strict values, not an actual domain attempt or writer proof.
  return { stage: "ai1", candidateId: id, inputHash: hash, sourceRevisionHash: hash,
    policyHash: hash, promptVersion: "fixture", rulesVersion: "fixture",
    reviewer: { provider: "abcllm", model }, ...extra };
}
const target = (value: Ai1ItemBinding) => value.candidateId;
const logical = (value: Ai1ItemBinding) => `ai1:${value.candidateId}`;
function identity(value: ModelCapacityRequest) { const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result; }
async function request(value: Ai1ItemBinding, extra: Partial<ModelCapacityRequest> = {}): Promise<ModelCapacityRequest> {
  const result: ModelCapacityRequest = { requestId: randomUUID(), workKey: `${logical(value)}:${itemBindingHash(value)}`,
    owner: { ...owner }, class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model, ...extra };
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${result.requestId}::uuid`).toEqual([]);
  expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${result.requestId}::uuid`).toEqual([]);
  owned.set(result.requestId, structuredClone(result)); return result;
}
function granted(value: ModelSlotResult): ModelCapacityReservation {
  expect(value.kind).toBe("granted"); if (value.kind !== "granted") throw new Error("actual_reservation_required");
  return value.reservation;
}
function bound(value: Ai1ItemBinding, lease: ItemLease, extra: Partial<Ai1ItemDispatchBinding> = {}): Ai1ItemDispatchBinding {
  return { kind: "ai1_item_gateway", version: 1, logicalWorkKey: logical(value), review: value,
    attemptId: value.candidateId,
    item: { workKey: lease.workKey, owner: lease.owner, token: lease.token,
      stageEpoch: lease.stageEpoch, itemEpoch: lease.itemEpoch, bindingHash: lease.bindingHash },
    routeId: "crawl-agent-review", provider: "abcllm", model, wireHash: hash, servingContractHash: hash,
    totalTokenBound: 8_000, chargedTokens: 8_000, ...extra };
}
async function atomicDispatch(value: Ai1ItemBinding, requested: ModelCapacityRequest, handle: ModelCapacityReservation,
  extra: Partial<Ai1ItemDispatchBinding> = {}) {
  const key = `ai1:${value.candidateId}`;
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${key}`).toEqual([]);
  const result = await tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), candidateId: target(value) });
    if (!lock) throw new Error("actual_capacity_lock_required");
    const stage = await lockItemStage(tx, "ai1"), lease = await claimItemLease(tx, stage, value, requested.owner, 90_000);
    if (!lease) throw new Error("actual_item_claim_required");
    const dispatch = await finishAi1ItemModelCapacityDispatch(tx, lock, bound(value, lease, extra));
    await expect(finishAi1ModelCapacityDispatch(tx, lock, {} as never)).rejects.toThrow("invalid_ai1_capacity_dispatch_lock");
    return { lease, dispatch };
  }));
  items.set(result.lease.workKey, result.lease); return result;
}
async function requestRow(id: string) {
  return (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`)[0]?.value as Raw;
}

beforeAll(() => tracked(setup = (async () => {
  ensureSchema(); initial = await whole();
  if ((initial.model_capacity_requests as Raw[]).some(row => ["waiting", "reserved", "dispatched", "indeterminate"].includes(String(row.state))))
    throw new Error("ai1_item_terminal_fixture_active_capacity");
  originalControl = (initial.model_capacity_control as Raw[])[0];
  originalStage = (initial.pipeline_stage_modes as Raw[]).find(row => row.stage === "ai1")!;
  if (!originalControl || !originalStage || (initial.pipeline_item_leases as Raw[]).some(row => row.stage === "ai1" && row.token !== null))
    throw new Error("ai1_item_terminal_fixture_stage_busy");
  initialized = true;
})(), hooks));
afterEach(() => tracked(steps([async () => { await setup; }, () => drain(bodies), () => drain(work), cleanup,
  async () => { serving.contract = null; vi.unstubAllEnvs(); }]), hooks));
afterAll(() => steps([async () => { await setup; }, () => drain(hooks, true), () => drain(bodies, true),
  () => drain(work), cleanup, async () => { if (initialized) expect(await whole()).toEqual(initial); },
  async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, async () => { await admin.end(); }]));

it("atomically binds an actual generic item claim and preserves generic dispatch refusal", exercise(async () => {
  await install(); const value = review(), requested = await request(value);
  const handle = granted(await tracked(requestAi1ModelSlot(requested, target(value))));
  await expect(tracked(beginModelDispatch(handle))).rejects.toThrow("ai1_bound_dispatch_required");
  const result = await atomicDispatch(value, requested, handle);
  expect(await requestRow(requested.requestId)).toMatchObject({ state: "dispatched", logical_work_key: logical(value),
    dispatch_binding: result.dispatch.binding, dispatch_binding_hash: ai1ItemDispatchBindingHash(result.dispatch.binding) });
  expect(await admin`SELECT token,item_epoch FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${result.lease.workKey}`)
    .toEqual([{ token: result.lease.token, item_epoch: String(result.lease.itemEpoch) }]);
  expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${requested.requestId}::uuid ORDER BY id`)
    .toEqual([{ kind: "queued" }, { kind: "reserved" }, { kind: "dispatch_started" }]);
}));

it("keeps same-ID waiting and cross-boot AI1 fences while permitting another candidate", exercise(async () => {
  await install({ ...policy, globalLimit: 2 });
  const busyReview = review(), busy = await request(busyReview);
  const busyHandle = granted(await tracked(requestAi1ModelSlot(busy, target(busyReview))));
  const otherBusyReview = review(), otherBusy = await request(otherBusyReview);
  const otherBusyHandle = granted(await tracked(requestAi1ModelSlot(otherBusy, target(otherBusyReview))));
  const first = review(), waiting = await request(first);
  expect(await tracked(requestAi1ModelSlot(waiting, target(first)))).toEqual({ kind: "deferred", reason: "capacity" });
  const before = await requestRow(waiting.requestId);
  expect(await tracked(requestAi1ModelSlot(waiting, target(first)))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await requestRow(waiting.requestId)).toEqual(before);
  const differentBoot = await request(first, { owner: { instanceId: prefix, bootId: randomUUID() } });
  expect(await tracked(requestAi1ModelSlot(differentBoot, target(first)))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await requestRow(differentBoot.requestId)).toBeUndefined();
  expect(await tracked(cancelReservedModelSlot(busyHandle))).toBe(true);
  expect((await tracked(requestAi1ModelSlot(waiting, target(first)))).kind).toBe("granted");
  expect(await tracked(cancelReservedModelSlot(otherBusyHandle))).toBe(true);
  const another = review(), independent = await request(another);
  expect((await tracked(requestAi1ModelSlot(independent, target(another)))).kind).toBe("granted");
}));

it("blocks the entire old unbound AI1 route after dispatch and unknown without TTL refunds", exercise(async () => {
  await install(); const value = review(), old = await request(value, { workKey: randomUUID() });
  const handle = granted(await tracked(requestModelSlot(old))), result = await tracked(beginModelDispatch(handle));
  expect(result.kind).toBe("dispatched"); if (result.kind !== "dispatched") throw new Error("actual_dispatch_required");
  expect(await tracked(markModelDispatchIndeterminate(result.dispatch, "transport_unknown"))).toBe(true);
  const next = review(), requested = await request(next);
  expect(await tracked(requestAi1ModelSlot(requested, target(next)))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await requestRow(requested.requestId)).toBeUndefined();
  expect(await requestRow(old.requestId)).toMatchObject({ state: "indeterminate", logical_work_key: null, token: handle.token });
}));

it("rolls back the fresh item claim, dispatch and event in the same actual transaction", exercise(async () => {
  await install(); const value = review(), requested = await request(value);
  const handle = granted(await tracked(requestAi1ModelSlot(requested, target(value))));
  const before = await requestRow(requested.requestId), stop = new Error("fixture_after_dispatch_rollback");
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${`ai1:${value.candidateId}`}`).toEqual([]);
  await expect(tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), candidateId: target(value) });
    expect(lock).not.toBeNull(); const stage = await lockItemStage(tx, "ai1");
    const lease = await claimItemLease(tx, stage, value, owner, 90_000);
    if (!lease) throw new Error("actual_item_claim_required");
    await finishAi1ItemModelCapacityDispatch(tx, lock!, bound(value, lease)); throw stop;
  }))).rejects.toBe(stop);
  expect(await requestRow(requested.requestId)).toEqual(before);
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${`ai1:${value.candidateId}`}`).toEqual([]);
  expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${requested.requestId}::uuid ORDER BY id`)
    .toEqual([{ kind: "queued" }, { kind: "reserved" }]);
}));

it("rejects type-confused binding numbers and reused AI1 attempt identity without changing original rows", exercise(async () => {
  await install(); const value = review(), requested = await request(value);
  const handle = granted(await tracked(requestAi1ModelSlot(requested, target(value))));
  const first = await atomicDispatch(value, requested, handle), before = await requestRow(requested.requestId);
  const invalid = { ...first.dispatch.binding, totalTokenBound: "8000", chargedTokens: "8000" };
  await expect(admin`UPDATE model_capacity_requests SET dispatch_binding=${JSON.stringify(invalid)}::text::jsonb
    WHERE request_id=${requested.requestId}::uuid`).rejects.toMatchObject({ code: "23514" });
  expect(await requestRow(requested.requestId)).toEqual(before);
  const changed = { ...value, candidateId: ++serial }, next = await request(changed);
  const nextHandle = granted(await tracked(requestAi1ModelSlot(next, target(changed))));
  await expect(tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: nextHandle, identity: identity(next), candidateId: target(changed) });
    expect(lock).not.toBeNull();
    // Negative SQL attempt replay only, not a second domain authority: another candidate cannot reuse the stored attemptId.
    await finishAi1ItemModelCapacityDispatch(tx, lock!, bound(changed, { ...first.lease, binding: changed,
      workKey: logical(changed), bindingHash: itemBindingHash(changed) }, { attemptId: first.dispatch.binding.attemptId }));
  }))).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
  expect(await requestRow(next.requestId)).toMatchObject({ state: "reserved", dispatch_binding: null });
  expect(await requestRow(requested.requestId)).toEqual(before);
}));

async function nativeServer(run: (state: { call: PreparedAi1GatewayCall; input: ReturnType<typeof createReviewInput>; posts: () => number }) => Promise<void>) {
  let posts = 0; const handlers = new Set<Promise<unknown>>(), errors: unknown[] = [];
  const server = createServer((request, response) => {
    const closed = new Promise<void>(resolve => response.once("close", resolve));
    const pending = (async () => {
      for await (const _chunk of request) { void _chunk; }
      posts++; response.end(JSON.stringify({ id: "local-response", object: "chat.completion", created: 1, model: "native-model",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ decision: "approve", reason: "A working tool.",
          evidenceIds: ["product"], confidence: 0.9 }) }, finish_reason: "stop" }] })); await closed;
    })(); tracked(pending, handlers);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
    serving.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model,
      responseModel: "native-model", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, deploymentRevision: "local-test-only", totalTokenBound: 8_000 };
    vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
    const now = new Date("2026-10-16T00:00:00.000Z");
    const input = createReviewInput({ repo: prefix, productUrl: "https://fixture.example", judgedAt: now } as CrawlCandidate,
      { id: 1, repo: prefix, productUrl: "https://fixture.example", repoMeta: { description: "A usable tool" },
        pageMeta: { title: "Tool", textSample: "A working tool" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
      DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
    const call = prepareAi1GatewayCall(input, { model, timeoutMs: 2_500 });
    expect(call.kind).toBe("prepared"); if (call.kind !== "prepared") throw new Error("actual_prepared_required");
    await run({ call, input, posts: () => posts });
  } catch (error) { errors.push(error); }
  finally {
    serving.contract = null;
    let forced = false;
    const timer = setTimeout(() => { forced = true; server.closeAllConnections(); }, 3_000);
    try {
      await steps([() => drain(work), () => drain(handlers, true), () => new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve(); server.close(error => error ? reject(error) : resolve());
      })]);
      if (forced) errors.push(new Error("fixture_forced_socket_cleanup"));
    } catch (error) { errors.push(error); }
    finally { clearTimeout(timer); }
  }
  if (errors.length) throw new AggregateError(errors, "ai1_item_terminal_native_fixture_failed", { cause: errors[0] });
}

it("settles an actual native terminal historically once, rejects copied proof and retains full C for unknown usage", exercise(async () => {
  await install();
  await nativeServer(async ({ call, input, posts }) => {
    const value = review({ inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
      promptVersion: input.snapshot.policy.promptVersion, rulesVersion: input.snapshot.policy.rulesVersion });
    const requested = await request(value), handle = granted(await tracked(requestAi1ModelSlot(requested, target(value))));
    const result = await atomicDispatch(value, requested, handle, { wireHash: call.wireHash,
      servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound });
    const native = await tracked(reviewWithReservedAi1ItemGateway(input, result.dispatch, call, { timeoutMs: 2_500 }));
    expect(posts()).toBe(1); expect(readAi1ItemGatewayTerminal(native.terminal)).toMatchObject({ actualUsage: null, provenance: "unknown" });
    expect(native.terminal).not.toBeNull(); if (!native.terminal) throw new Error("actual_native_terminal_required");
    await tracked(db.transaction(async tx => { const stage = await lockItemStage(tx, "ai1"); await releaseItemLease(tx, stage, result.lease); }));
    await admin`UPDATE model_capacity_control SET mode='draining',epoch=epoch+1,revision=revision+1,updated_at=clock_timestamp() WHERE id=1`;
    await expect(tracked(reconcileAi1ItemGatewayTerminal(structuredClone(native.terminal)))).rejects.toThrow("invalid_ai1_item_gateway_terminal");
    expect(await tracked(reconcileAi1ItemGatewayTerminal(native.terminal))).toEqual({ kind: "settled" });
    expect(await tracked(reconcileAi1ItemGatewayTerminal(native.terminal))).toEqual({ kind: "already_settled" });
    expect(await requestRow(requested.requestId)).toMatchObject({ state: "settled", dispatch_binding: result.dispatch.binding,
      terminal_evidence: { actualUsage: null, provenance: "unknown" } });
    expect((await requestRow(requested.requestId)).dispatch_binding).toMatchObject({ chargedTokens: call.totalTokenBound });
    expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${requested.requestId}::uuid AND kind='dispatch_settled'`)
      .toEqual([{ kind: "dispatch_settled" }]);
    expect(posts()).toBe(1);
    // A historical settled request no longer fences a new request, but its physical claim can never be charged twice.
    await install(); const next = await request(value);
    const nextHandle = granted(await tracked(requestAi1ModelSlot(next, target(value))));
    await expect(tracked(db.transaction(async tx => {
      const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: nextHandle, identity: identity(next), candidateId: target(value) });
      expect(lock).not.toBeNull();
      await finishAi1ItemModelCapacityDispatch(tx, lock!, { ...result.dispatch.binding, attemptId: ++serial });
    }))).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505", constraint_name: "model_capacity_requests_ai1_item_claim_idx" }) });
    expect(await requestRow(next.requestId)).toMatchObject({ state: "reserved", dispatch_binding: null });
    expect(posts()).toBe(1);
  });
}));
