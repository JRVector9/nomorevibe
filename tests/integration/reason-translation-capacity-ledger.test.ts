import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { modelCapacityPolicyHash, reasonTranslationInputHash, reasonTranslationLogicalWorkKey,
  type ModelCapacityPolicy, type ModelCapacityRequest,
  type ModelCapacityRequestIdentity, type ModelCapacityReservation, type ModelSlotResult,
  type ReasonTranslationMember, type ReasonTranslationDispatchBinding, type ReasonTranslationModelDispatch } from "@/lib/llm/capacity";
import { requestModelSlot, requestReasonTranslationModelSlot, findOwnPendingModelRequest, cancelReservedModelSlot,
  lockReasonTranslationModelCapacityDispatch, finishReasonTranslationModelCapacityDispatch,
  beginModelDispatch, markModelDispatchIndeterminate } from "@/lib/llm/capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// Ledger-only: no gateway, provider, domain row, role election or job ACK occurs.
type Raw = Record<string, unknown>;
type Whole = Record<string, unknown>;
const prefix = `reason-ledger-${randomUUID().slice(0, 12)}`, modelA = "reason-ledger-a", modelB = "reason-ledger-b";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: prefix } });
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
const planned = new Map<string, ModelCapacityRequest>(), committed = new Map<string, ModelCapacityRequest>();
const plannedMembers = new Map<string, readonly string[] | null>();
let initial: Whole, originalControl: Raw, setupWork: Promise<void> | undefined, cleaning: Promise<void> | undefined;
let initialized = false;
const hashes = ["a", "b", "c", "d"].map(value => value.repeat(64));
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [
    { routeId: "reason-translate", provider: "abcllm", model: modelA, providerBudgetId: "account", groupId: "engine" },
    { routeId: "reason-translate", provider: "abcllm", model: modelB, providerBudgetId: "account", groupId: "engine" },
    { routeId: "reason-ledger-busy", provider: "fixture", model: modelA, providerBudgetId: "account", groupId: "engine" }] };
function tracked<T>(pending: PromiseLike<T>, set = work): Promise<T> {
  const actual = Promise.resolve(pending); set.add(actual); void actual.catch(() => {}); return actual;
}
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), exercises);
async function drain(set: Set<Promise<unknown>>) {
  while (set.size) {
    const pending = [...set]; await Promise.allSettled(pending);
    for (const promise of pending) set.delete(promise);
  }
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "reason_ledger_fixture_cleanup_failed", { cause: errors[0] });
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Whole> {
  const rows: Whole = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [result] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    rows[tablename] = result.value;
  }
  return rows;
}
const guards = async (tx: postgres.TransactionSql) => Array.from(await tx`SELECT tgname,tgenabled
  FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
    AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`);
const expectedGuards = [{ tgname: "model_capacity_events_no_change", tgenabled: "A" },
  { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }];
function sameIdentity(raw: Raw, value: ModelCapacityRequest) {
  expect([raw.request_id, raw.work_key, raw.owner_instance_id, raw.owner_boot_id, raw.class, raw.pool,
    raw.route_id, raw.provider, raw.model]).toEqual([value.requestId, value.workKey, value.owner.instanceId,
    value.owner.bootId, value.class, value.pool, value.routeId, value.provider, value.model]);
}
async function rawRequest(id: string, tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Raw | undefined> {
  return (await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE request_id=${id}::uuid`)[0]?.row;
}
async function cleanupActual() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...planned.keys()];
    const rows = await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY queue_ordinal FOR UPDATE`;
    // A commit-ack-unknown/unregistered row is evidence to preserve, not permission to adopt it.
    for (const { row } of rows) {
      expect(committed.has(row.request_id)).toBe(true); sameIdentity(row, committed.get(row.request_id)!);
      expect(row.logical_member_keys).toEqual(plannedMembers.get(row.request_id));
    }
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    expect(await guards(tx)).toEqual(expectedGuards);
    const events = await tx`SELECT id::text,request_id,to_jsonb(e) AS row FROM model_capacity_events e
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    for (const event of events) expect(committed.has(event.request_id)).toBe(true);
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events e WHERE id=${event.id}::bigint
        AND request_id=${event.request_id}::uuid AND to_jsonb(e)=${JSON.stringify(event.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    expect(await guards(tx)).toEqual(expectedGuards);
    for (const { row } of rows) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${row.request_id}::uuid
      AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    const [current] = await tx`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1 FOR UPDATE`;
    expect(await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,
      policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r
      WHERE c.id=r.id AND to_jsonb(c)=${JSON.stringify(current.row)}::text::jsonb RETURNING c.id`).toHaveLength(1);
    expect(await whole(tx)).toEqual(initial);
  });
  committed.clear(); planned.clear(); plannedMembers.clear();
}
function cleanup() {
  if (cleaning) return cleaning;
  const pending = cleanupActual(); cleaning = pending;
  void pending.then(() => { if (cleaning === pending) cleaning = undefined; }, () => {});
  return pending;
}
async function install(value = policy, revision = 1) {
  await tracked(admin`UPDATE model_capacity_control SET mode='open',revision=${revision},policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)},cursor=0,updated_at=clock_timestamp() WHERE id=1`);
}
function members(...indices: number[]): ReasonTranslationMember[] {
  return indices.map(index => ({ sourceHash: hashes[index], cache: { kind: "absent" } }));
}
async function request(batch?: readonly ReasonTranslationMember[], model = modelA, kind: "busy" | "unbound-reason" = "busy"): Promise<ModelCapacityRequest> {
  const reason = !!batch || kind === "unbound-reason";
  const value: ModelCapacityRequest = { requestId: randomUUID(), owner: { instanceId: `${prefix}-${randomUUID().slice(0, 8)}`, bootId: randomUUID() },
    workKey: batch ? `${reasonTranslationLogicalWorkKey(batch)}:${reasonTranslationInputHash({ members: batch, model })}` : randomUUID(),
    class: "background", pool: "text", routeId: reason ? "reason-translate" : "reason-ledger-busy",
    provider: reason ? "abcllm" : "fixture", model };
  expect(await tracked(admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${value.requestId}::uuid`)).toHaveLength(0);
  expect(await tracked(admin`SELECT id FROM model_capacity_events WHERE request_id=${value.requestId}::uuid`)).toHaveLength(0);
  planned.set(value.requestId, structuredClone(value));
  plannedMembers.set(value.requestId, batch ? batch.map(member => `ko:${member.sourceHash}`).sort() : null);
  return value;
}
function identity(value: ModelCapacityRequest): ModelCapacityRequestIdentity {
  const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result;
}
async function ask(value: ModelCapacityRequest, batch?: readonly ReasonTranslationMember[]): Promise<ModelSlotResult> {
  const result = await tracked(batch ? requestReasonTranslationModelSlot(value, batch) : requestModelSlot(value));
  const raw = await rawRequest(value.requestId);
  if (raw) { sameIdentity(raw, value); committed.set(value.requestId, structuredClone(value)); }
  return result;
}
function granted(value: ModelSlotResult): ModelCapacityReservation {
  expect(value.kind).toBe("granted"); if (value.kind !== "granted") throw new Error("reason_ledger_reservation_required");
  return value.reservation;
}
function binding(value: ModelCapacityRequest, batch: readonly ReasonTranslationMember[]): ReasonTranslationDispatchBinding {
  // Strict ledger-only shape. These fields are not actual domain/role/job authority.
  return { kind: "reason_translation_gateway", version: 1, members: structuredClone(batch), model: value.model,
    logicalWorkKey: reasonTranslationLogicalWorkKey(batch), inputHash: reasonTranslationInputHash({ members: batch, model: value.model }),
    provider: "abcllm", routeId: "reason-translate", wireHash: hashes[0], servingContractHash: hashes[1], totalTokenBound: 8192,
    chargedTokens: 8192, job: { name: "reason-translate", token: randomUUID(), requestedVersion: 1 },
    role: { role: "text", instanceId: value.owner.instanceId, bootId: value.owner.bootId, release: "ledger-fixture",
      kind: "primary", epoch: 1, batch: { mode: "legacy" } } };
}
async function dispatch(value: ModelCapacityRequest, batch: readonly ReasonTranslationMember[]): Promise<ReasonTranslationModelDispatch> {
  const reservation = granted(await ask(value, batch));
  return tracked(db.transaction(async tx => {
    const lock = await lockReasonTranslationModelCapacityDispatch(tx, { reservation, identity: identity(value), members: batch });
    expect(lock).not.toBeNull(); if (!lock) throw new Error("reason_ledger_dispatch_lock_required");
    return finishReasonTranslationModelCapacityDispatch(tx, lock, binding(value, batch));
  }));
}
beforeAll(() => {
  setupWork = tracked(Promise.resolve().then(async () => {
    expect(process.env.TEST_DATABASE_URL).toBe(TEST_DATABASE_URL);
    const globals = globalThis as { pgClient?: postgres.Sql; db?: unknown };
    expect(globals.pgClient).toBeUndefined(); expect(globals.db).toBeUndefined();
    vi.stubEnv("DB_POOL_MAX", "2"); ensureSchema(); initial = await whole();
    // Fresh-first only. Expiry/grant APIs must never mutate pre-existing requests.
    expect(initial.model_capacity_requests).toEqual([]);
    const controls = initial.model_capacity_control as Raw[];
    expect(controls).toHaveLength(1); originalControl = controls[0];
    expect(originalControl).toMatchObject({ id: 1, mode: "disabled", epoch: 1, revision: 1, policy: null, policy_hash: null, cursor: 0 });
    initialized = true;
  }), hooks); return setupWork;
});
afterEach(() => tracked(steps([async () => { await setupWork; }, () => drain(exercises), () => drain(work), cleanup]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => drain(hooks), () => drain(exercises), () => drain(work), cleanup,
  async () => { if (initialized) expect(await whole()).toEqual(initial); },
  async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); },
  async () => { await admin.end(); }, async () => { vi.unstubAllEnvs(); }]));

it("stores sorted membership in the first waiting INSERT and resumes the same ID after order-only polling", exercise(async () => {
  await install({ ...policy, globalLimit: 1 });
  const busy = await request(), busyHandle = granted(await ask(busy));
  const batch = members(0, 1), waiting = await request(batch);
  expect(await ask(waiting, batch)).toEqual({ kind: "deferred", reason: "capacity" });
  const before = await rawRequest(waiting.requestId);
  expect(before).toMatchObject({ state: "waiting", token: null, logical_member_keys: [`ko:${hashes[0]}`, `ko:${hashes[1]}`],
    logical_work_key: reasonTranslationLogicalWorkKey(batch), dispatch_binding: null });
  expect(await tracked(findOwnPendingModelRequest(identity(waiting)))).toEqual({ requestId: waiting.requestId, state: "waiting" });
  const events = await admin`SELECT to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=${waiting.requestId}::uuid ORDER BY id`;
  expect(await ask(waiting, [...batch].reverse())).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(waiting.requestId)).toEqual(before);
  expect(await admin`SELECT to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=${waiting.requestId}::uuid ORDER BY id`).toEqual(events);
  expect(await tracked(cancelReservedModelSlot(busyHandle))).toBe(true);
  const handle = granted(await ask(waiting, [...batch].reverse()));
  expect(handle.requestId).toBe(waiting.requestId);
  expect(await rawRequest(waiting.requestId)).toMatchObject({ queue_ordinal: before!.queue_ordinal,
    logical_member_keys: [`ko:${hashes[0]}`, `ko:${hashes[1]}`], state: "reserved" });
}));

it("serializes overlapping batches on two actual waiting backends across owner boot model and order", exercise(async () => {
  await install();
  const leftBatch = members(0, 1), rightBatch = members(1, 2);
  const left = await request(leftBatch), right = await request(rightBatch, modelB), ready = latch(), release = latch();
  const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, connection: { application_name: `${prefix}-holder` } });
  let holderPid = 0, leftWork: Promise<ModelSlotResult> | undefined, rightWork: Promise<ModelSlotResult> | undefined;
  const handles: ModelCapacityReservation[] = [], errors: unknown[] = [];
  const holding = tracked(holder.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0].pid; ready.resolve(); await release.promise;
  }));
  try {
    await Promise.race([ready.promise, holding.then(() => { throw new Error("reason_ledger_holder_ended_before_ready"); })]);
    leftWork = ask(left, leftBatch); rightWork = ask(right, rightBatch);
    let blocked: Array<{ pid: number }> = [];
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      blocked = Array.from(await admin<{ pid: number }[]>`WITH RECURSIVE waiting(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${holderPid}=ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
          WHERE a.datname=current_database()) SELECT pid FROM waiting ORDER BY pid`);
      if (blocked.length === 2) break;
      await Promise.race([new Promise(resolve => setTimeout(resolve, 10)),
        leftWork.then(value => { throw new Error("reason_ledger_left_ended_before_blocking", { cause: value }); }),
        rightWork.then(value => { throw new Error("reason_ledger_right_ended_before_blocking", { cause: value }); })]);
    }
    expect(blocked).toHaveLength(2); expect(new Set(blocked.map(row => row.pid)).size).toBe(2);
    console.info("reason_ledger_actual_wait", { holderPid, waiterPids: blocked.map(row => row.pid) });
    release.resolve(); await holding;
    const results = await Promise.all([leftWork, rightWork]);
    console.info("reason_ledger_actor_results", { kinds: results.map(result => result.kind) });
    expect(results.filter(result => result.kind === "granted")).toHaveLength(1);
    expect(results.filter(result => result.kind === "deferred")).toEqual([{ kind: "deferred", reason: "capacity" }]);
    for (const result of results) if (result.kind === "granted") handles.push(result.reservation);
    const winnerIndex = results.findIndex(result => result.kind === "granted");
    const winnerBatch = winnerIndex === 0 ? leftBatch : rightBatch, loser = winnerIndex === 0 ? right : left;
    expect(await rawRequest(loser.requestId)).toBeUndefined();
    expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${loser.requestId}::uuid`).toHaveLength(0);
    for (const selectedModel of [modelA, modelB]) {
      const reversed = [...winnerBatch].reverse(), foreign = await request(reversed, selectedModel);
      expect(await ask(foreign, reversed)).toEqual({ kind: "deferred", reason: "capacity" });
      expect(await rawRequest(foreign.requestId)).toBeUndefined();
    }
    const unrelated = members(3), separate = await request(unrelated);
    handles.push(granted(await ask(separate, unrelated)));
  } catch (error) { errors.push(error); }
  finally {
    release.resolve();
    await steps([async () => { await holding; }, async () => {
      const results = await Promise.allSettled([leftWork, rightWork].filter((value): value is Promise<ModelSlotResult> => !!value));
      const rejected: unknown[] = [];
      for (const result of results) {
        if (result.status === "rejected") rejected.push(result.reason);
        else if (result.value.kind === "granted") {
          const handle = result.value.reservation;
          if (!handles.some(existing => existing.requestId === handle.requestId)) handles.push(handle);
        }
      }
      if (rejected.length) throw new AggregateError(rejected, "reason_ledger_actor_failed");
    }, async () => { for (const handle of handles) expect(await tracked(cancelReservedModelSlot(handle))).toBe(true); },
    async () => { await holder.end(); }], errors);
  }
}));

it("keeps unknown full C fenced across identity changes and blocks a disjoint set behind an old unbound reason", exercise(async () => {
  await install(); const batch = members(0, 1), value = await request(batch), owned = await dispatch(value, batch);
  expect(await tracked(markModelDispatchIndeterminate(owned, "transport_unknown"))).toBe(true);
  const before = await rawRequest(value.requestId), beforeEvents = await admin`SELECT to_jsonb(e) AS row FROM model_capacity_events e
    WHERE request_id=${value.requestId}::uuid ORDER BY id`;
  expect(before).toMatchObject({ state: "indeterminate", token: owned.token, dispatch_binding: { chargedTokens: 8192, totalTokenBound: 8192 } });
  await install({ ...policy, globalLimit: 5, providerLimits: { account: 5 }, groupLimits: { engine: 5 }, poolLimits: { reviewer: 5, text: 5 } }, 2);
  const changed = [{ sourceHash: hashes[1], cache: { kind: "present" as const, rowIdentityHash: hashes[2], attempts: 3 } }, batch[0]];
  const next = await request(changed, modelB);
  expect(await ask(next, changed)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(next.requestId)).toBeUndefined(); expect(await rawRequest(value.requestId)).toEqual(before);
  expect(await admin`SELECT to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=${value.requestId}::uuid ORDER BY id`).toEqual(beforeEvents);
  await install(); // Do not mistake the old-policy active guard for the unbound-route fence below.
  const generic = await request(undefined, modelA, "unbound-reason");
  const started = await tracked(beginModelDispatch(granted(await ask(generic))));
  expect(started.kind).toBe("dispatched"); if (started.kind !== "dispatched") throw new Error("reason_ledger_generic_dispatch_required");
  expect(await tracked(markModelDispatchIndeterminate(started.dispatch, "transport_unknown"))).toBe(true);
  const genericBefore = await rawRequest(generic.requestId);
  expect(genericBefore).toMatchObject({ state: "indeterminate", logical_work_key: null, logical_member_keys: null, dispatch_binding: null });
  const disjoint = members(2), refused = await request(disjoint, modelB);
  expect(await ask(refused, disjoint)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(refused.requestId)).toBeUndefined(); expect(await rawRequest(generic.requestId)).toEqual(genericBefore);
  expect(await rawRequest(value.requestId)).toEqual(before);
}));

it("enforces bounded members and strict dispatch terminal event shapes in actual savepoints", exercise(async () => {
  await install(); const batch = members(0, 1), value = await request(batch), owned = await dispatch(value, batch);
  const before = await whole(), rollback = new Error("reason_ledger_shape_control_rollback");
  try {
    await tracked(admin.begin(async tx => {
      const reject = async (write: (savepoint: postgres.TransactionSql) => PromiseLike<unknown>) => {
        const rawBefore = await rawRequest(value.requestId, tx); let failure: unknown;
        try { await tx.savepoint(async savepoint => { await write(savepoint); }); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: "23514" }); expect(await rawRequest(value.requestId, tx)).toEqual(rawBefore);
      };
      for (const keys of [null, [], [`ko:${hashes[0]}`, `ko:${hashes[0]}`], [`ko:${hashes[1]}`, `ko:${hashes[0]}`], [null, `ko:${hashes[1]}`]])
        await reject(savepoint => savepoint`UPDATE model_capacity_requests SET logical_member_keys=${keys}::text[] WHERE request_id=${value.requestId}::uuid`);
      await reject(savepoint => savepoint`UPDATE model_capacity_requests SET logical_member_keys=ARRAY[ARRAY[${`ko:${hashes[0]}`},${`ko:${hashes[1]}`}]]::text[] WHERE request_id=${value.requestId}::uuid`);
      await reject(savepoint => savepoint`UPDATE model_capacity_requests SET logical_member_keys=array_fill(${`ko:${hashes[0]}`}::text,ARRAY[2],ARRAY[0]) WHERE request_id=${value.requestId}::uuid`);
      const missingMembers = { ...owned.binding } as Record<string, unknown>; delete missingMembers.members;
      for (const changed of [missingMembers, { ...owned.binding, members: null },
        { ...owned.binding, members: [] }, { ...owned.binding, members: [null] },
        { ...owned.binding, members: [batch[0], batch[0]] }, { ...owned.binding, members: [{ sourceHash: hashes[0],
          cache: { kind: "present", rowIdentityHash: hashes[0], attempts: Number.MAX_SAFE_INTEGER + 1 } }, batch[1]] }])
        await reject(savepoint => savepoint`UPDATE model_capacity_requests SET dispatch_binding=${JSON.stringify(changed)}::text::jsonb WHERE request_id=${value.requestId}::uuid`);
      const evidence = { version: 1, kind: "reason_translation_gateway_terminal", dispatch: owned, finishReason: "length",
        responseHash: hashes[0], actualUsage: null, provenance: "unknown" };
      // JSON acceptance is a durable CHECK control, never the opaque runtime settlement API.
      expect(await tx`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(evidence)}::text::jsonb,
        terminal_evidence_hash=${reviewHash(evidence)},settled_at=clock_timestamp() WHERE request_id=${value.requestId}::uuid RETURNING request_id`).toHaveLength(1);
      const missingFinish = { ...evidence } as Record<string, unknown>; delete missingFinish.finishReason;
      const invalid = [missingFinish, { ...evidence, responseHash: "invalid" }, { ...evidence, provenance: "upstream_reported",
        actualUsage: { inputTokens: 8192, outputTokens: 1, totalTokens: 8193 } }];
      for (const changed of invalid) await reject(savepoint => savepoint`UPDATE model_capacity_requests
        SET terminal_evidence=${JSON.stringify(changed)}::text::jsonb WHERE request_id=${value.requestId}::uuid`);
      for (const changed of invalid) await reject(savepoint => savepoint`INSERT INTO model_capacity_events
        (request_id,kind,epoch,revision,policy_hash,from_state,to_state,evidence) VALUES
        (${value.requestId}::uuid,'dispatch_settled',${owned.epoch},${owned.revision},${owned.policyHash},'dispatched','settled',${JSON.stringify(changed)}::text::jsonb)`);
      expect(await tx`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,evidence) VALUES
        (${value.requestId}::uuid,'dispatch_settled',${owned.epoch},${owned.revision},${owned.policyHash},'dispatched','settled',${JSON.stringify(evidence)}::text::jsonb) RETURNING id`).toHaveLength(1);
      throw rollback;
    }));
  } catch (error) { if (error !== rollback) throw error; }
  expect(await whole()).toEqual(before);
}));
