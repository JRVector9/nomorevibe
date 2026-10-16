import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { db, onReplica } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { currentReplayDb, withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest,
  type ModelCapacityRequestIdentity, type ModelCapacityReservation, type ModelSlotResult } from "@/lib/llm/capacity";
import { beginModelDispatch, cancelReservedModelSlot, findOwnPendingModelRequest,
  markModelDispatchIndeterminate, requestModelSlot } from "@/lib/llm/capacity-repository";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

type Raw = Record<string, unknown>;
const prefix = `model-resume-${randomUUID()}`, owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "model-resume-fixture" } });
const owned = new Map<string, ModelCapacityRequest>(), work = new Set<Promise<unknown>>();
const bodies = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
let initial: Record<string, unknown>, baseline: Record<string, unknown>, control: Raw;
let setupWork: Promise<void> | undefined, cleanupWork: Promise<void> | undefined;
let sentinel: ModelCapacityRequest | undefined, initialized = false;

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1,
  providerLimits: { account: 1 }, groupLimits: { engine: 1 }, poolLimits: { reviewer: 1, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "resume", provider: "test", model: "Exact Model", providerBudgetId: "account", groupId: "engine" }] };

function tracked<T>(pending: Promise<T>, set = work): Promise<T> {
  set.add(pending); void pending.catch(() => {}); return pending;
}
function exercise(load: () => Promise<void>) { return () => tracked(Promise.resolve().then(load), bodies); }
async function settle(set: Set<Promise<unknown>>, preserveErrors = false) {
  const pending = [...set], results = await Promise.allSettled(pending);
  for (const promise of pending) set.delete(promise);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (preserveErrors && errors.length) throw new AggregateError(errors, "model_resume_work_failed", { cause: errors[0] });
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "model_resume_cleanup_failed", { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const tables = await tx`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`;
  const result: Record<string, unknown> = {};
  for (const { relname } of tables) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(relname).replaceAll('"', '""')}" t`);
    result[relname] = row.value;
  }
  return result;
}
async function restoreControl(tx: postgres.TransactionSql) {
  await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,
    policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(control)}::text::jsonb) r
    WHERE c.id=r.id`;
}
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...owned.keys()];
    const rows = await tx`SELECT to_jsonb(r) AS value FROM model_capacity_requests r
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY queue_ordinal FOR UPDATE`;
    for (const { value } of rows) {
      const expected = owned.get(value.request_id)!;
      expect([value.owner_instance_id, value.owner_boot_id, value.work_key, value.class, value.pool,
        value.route_id, value.provider, value.model]).toEqual([expected.owner.instanceId, expected.owner.bootId,
        expected.workKey, expected.class, expected.pool, expected.routeId, expected.provider, expected.model]);
    }
    // No transport is connected. Exact owner-only fixture deletion is not an external-end proof.
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const [guard] = await tx`SELECT tgenabled FROM pg_trigger
      WHERE tgrelid='model_capacity_events'::regclass AND tgname='model_capacity_events_no_change'`;
    expect(guard.tgenabled).toBe("A");
    const events = await tx`SELECT id::text,request_id FROM model_capacity_events
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events
        WHERE id=${event.id}::bigint AND request_id=${event.request_id}::uuid RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    await restoreControl(tx);
    expect(await whole(tx)).toEqual(baseline);
    expect(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`)
      .toEqual([{ tgenabled: "A" }, { tgenabled: "A" }]);
  });
  owned.clear();
}
function cleanup() {
  if (cleanupWork) return cleanupWork;
  const pending = performCleanup(); cleanupWork = pending;
  const clear = () => { if (cleanupWork === pending) cleanupWork = undefined; };
  void pending.then(clear, clear); return pending;
}
async function install(value = policy) {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}
async function request(overrides: Partial<ModelCapacityRequestIdentity> = {}): Promise<ModelCapacityRequest> {
  const value: ModelCapacityRequest = { requestId: randomUUID(), workKey: randomUUID(), owner: { ...owner },
    class: "first", pool: "reviewer", routeId: "resume", provider: "test", model: "Exact Model", ...overrides };
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${value.requestId}::uuid`).toEqual([]);
  expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${value.requestId}::uuid`).toEqual([]);
  owned.set(value.requestId, structuredClone(value)); return value;
}
function identity(value: ModelCapacityRequest): ModelCapacityRequestIdentity {
  const result = { ...value };
  Reflect.deleteProperty(result, "requestId");
  return result;
}
function granted(result: ModelSlotResult): ModelCapacityReservation {
  expect(result.kind).toBe("granted");
  if (result.kind !== "granted") throw new Error("actual_model_reservation_required");
  return result.reservation;
}
async function row(id: string) {
  const [value] = await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`;
  return value?.value as Raw;
}
async function preparationSnapshot() {
  const snapshot = await whole();
  // Setup must not poll or expire another fixture's existing requests.
  if (!Array.isArray(snapshot.model_capacity_requests) || snapshot.model_capacity_requests.length)
    throw new Error("model_resume_fixture_requires_empty_requests");
  return snapshot;
}

beforeAll(() => {
  setupWork = (async () => {
    ensureSchema(); initial = await preparationSnapshot(); baseline = initial;
    [control] = initial.model_capacity_control as Raw[];
    initialized = true;
    await install(); sentinel = await request({ owner: { instanceId: `${prefix}-foreign`, bootId: randomUUID() } });
    const handle = granted(await tracked(requestModelSlot(sentinel)));
    expect(await tracked(cancelReservedModelSlot(handle))).toBe(true);
    await admin.begin(restoreControl);
    baseline = await whole(); owned.delete(sentinel.requestId);
  })();
  return tracked(setupWork, hooks);
});
afterEach(() => tracked(steps([async () => { await setupWork; }, () => settle(bodies),
  () => settle(work), cleanup]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => settle(hooks, true),
  () => settle(bodies, true), () => settle(work), cleanup, async () => {
    if (!initialized) return;
    if (sentinel) owned.set(sentinel.requestId, structuredClone(sentinel));
    baseline = initial; await cleanup(); expect(await whole()).toEqual(initial);
  }, async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); },
  async () => { await admin.end(); }]));

it("keeps genuine reservation and owner cancellation unchanged", exercise(async () => {
  await install(); const value = await request();
  const handle = granted(await tracked(requestModelSlot(value)));
  expect(await row(value.requestId)).toMatchObject({ state: "reserved", token: handle.token,
    owner_instance_id: value.owner.instanceId, owner_boot_id: value.owner.bootId });
  expect(await tracked(cancelReservedModelSlot(handle))).toBe(true);
  expect(await row(value.requestId)).toMatchObject({ state: "withdrawn", token: handle.token });
}));

it("rediscovers the same queued request after another actual owner poll grants it", exercise(async () => {
  await install(); const blocker = await request(), queued = await request();
  const first = granted(await tracked(requestModelSlot(blocker)));
  expect(await tracked(requestModelSlot(queued))).toEqual({ kind: "deferred", reason: "capacity" });
  const waiting = await row(queued.requestId);
  expect(await tracked(cancelReservedModelSlot(first))).toBe(true);
  const other = await request({ owner: { instanceId: `${prefix}-poller`, bootId: randomUUID() } });
  expect(await tracked(requestModelSlot(other))).toEqual({ kind: "deferred", reason: "capacity" });
  const reserved = await row(queued.requestId), before = await whole();
  expect(reserved).toMatchObject({ state: "reserved", queue_ordinal: waiting.queue_ordinal, queue_until: waiting.queue_until });
  const found = await tracked(findOwnPendingModelRequest(identity(queued)));
  expect(found).toEqual({ requestId: queued.requestId, state: "reserved" });
  expect(await whole()).toEqual(before);
  const handle = granted(await tracked(requestModelSlot({ ...identity(queued), requestId: found!.requestId })));
  expect(handle.token).toBe(reserved.token);
  expect(await tracked(cancelReservedModelSlot(handle))).toBe(true);
}));

it("looks up waiting work without mutation and rejects every mismatched tuple component", exercise(async () => {
  await install(); const blocker = await request(), queued = await request({ class: "background" });
  granted(await tracked(requestModelSlot(blocker)));
  expect(await tracked(requestModelSlot(queued))).toEqual({ kind: "deferred", reason: "capacity" });
  const checked = identity(queued), before = await whole();
  expect(await tracked(findOwnPendingModelRequest(checked))).toEqual({ requestId: queued.requestId, state: "waiting" });
  for (const patch of [{ class: "second" }, { pool: "text" }, { routeId: "other" }, { provider: "other" }, { model: "exact model" }])
    await expect(tracked(findOwnPendingModelRequest({ ...checked, ...patch } as ModelCapacityRequestIdentity)))
      .rejects.toThrow("model_capacity_request_identity_mismatch");
  for (const patch of [{ workKey: "other-work" }, { owner: { ...checked.owner, bootId: randomUUID() } },
    { owner: { ...checked.owner, instanceId: "other-owner" } }])
    expect(await tracked(findOwnPendingModelRequest({ ...checked, ...patch }))).toBeNull();
  await expect(tracked(Reflect.apply(findOwnPendingModelRequest, undefined, [{ ...checked, requestId: queued.requestId }])))
    .rejects.toThrow();
  expect(await whole()).toEqual(before);
}));

it.each(["waiting", "reserved"] as const)("leaves expired %s readback unchanged until the existing poll withdraws it", state => exercise(async () => {
  await install();
  if (state === "waiting") granted(await tracked(requestModelSlot(await request())));
  const value = await request(), result = await tracked(requestModelSlot(value));
  expect(result.kind).toBe(state === "waiting" ? "deferred" : "granted");
  if (state === "waiting") await admin`UPDATE model_capacity_requests SET queue_until=clock_timestamp()-interval '1 millisecond'
    WHERE request_id=${value.requestId}::uuid`;
  else await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()-interval '1 millisecond'
    WHERE request_id=${value.requestId}::uuid`;
  const before = await whole();
  expect(await tracked(findOwnPendingModelRequest(identity(value)))).toEqual({ requestId: value.requestId, state });
  expect(await whole()).toEqual(before);
  expect(await tracked(requestModelSlot(value))).toEqual({ kind: "deferred", reason: "withdrawn" });
  expect(await tracked(findOwnPendingModelRequest(identity(value)))).toBeNull();
})());

it("lets the original poll reject a policy change after a waiting ID was found", exercise(async () => {
  await install(); const blocker = granted(await tracked(requestModelSlot(await request()))), value = await request();
  expect(await tracked(requestModelSlot(value))).toEqual({ kind: "deferred", reason: "capacity" });
  const found = await tracked(findOwnPendingModelRequest(identity(value)));
  expect(found).toEqual({ requestId: value.requestId, state: "waiting" });
  expect(await tracked(cancelReservedModelSlot(blocker))).toBe(true);
  await admin`UPDATE model_capacity_control SET epoch=epoch+1,revision=revision+1 WHERE id=1`;
  const before = await whole();
  expect(await tracked(findOwnPendingModelRequest(identity(value)))).toEqual(found);
  expect(await whole()).toEqual(before);
  expect(await tracked(requestModelSlot({ ...identity(value), requestId: found!.requestId })))
    .toEqual({ kind: "deferred", reason: "withdrawn" });
  expect(await tracked(findOwnPendingModelRequest(identity(value)))).toBeNull();
  expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${value.requestId}::uuid ORDER BY id`)
    .map(event => event.kind)).toEqual(["queued", "policy_changed"]);
}));

it("returns only ID and state for dispatched or indeterminate work without releasing its charge", exercise(async () => {
  await install(); const value = await request(), handle = granted(await tracked(requestModelSlot(value)));
  const begun = await tracked(beginModelDispatch(handle));
  expect(begun.kind).toBe("dispatched");
  if (begun.kind !== "dispatched") throw new Error("actual_dispatch_intent_required");
  let before = await whole();
  expect(await tracked(findOwnPendingModelRequest(identity(value)))).toEqual({ requestId: value.requestId, state: "dispatched" });
  expect(await whole()).toEqual(before);
  expect(await tracked(markModelDispatchIndeterminate(begun.dispatch, "transport_unknown"))).toBe(true);
  await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()-interval '1 second'
    WHERE request_id=${value.requestId}::uuid`;
  await admin`UPDATE model_capacity_control SET mode='draining',epoch=epoch+1,revision=revision+1 WHERE id=1`;
  before = await whole();
  expect(await tracked(findOwnPendingModelRequest(identity(value)))).toEqual({ requestId: value.requestId, state: "indeterminate" });
  expect(await tracked(cancelReservedModelSlot(handle))).toBe(false);
  expect(await tracked(requestModelSlot(value))).toEqual({ kind: "deferred", reason: "dispatched" });
  expect(await whole()).toEqual(before);
}));

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
it("waits on control first with a synchronous identity snapshot and no request row lock", exercise(async () => {
  await install(); const value = await request();
  granted(await tracked(requestModelSlot(value)));
  const checked = identity(value), ready = latch(), release = latch(), errors: unknown[] = [];
  const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "model-resume-holder" } });
  let pid = 0, reading: ReturnType<typeof findOwnPendingModelRequest> | undefined;
  const holding = tracked(holder.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    [pid] = (await tx`SELECT pg_backend_pid() pid`).map(row => row.pid);
    ready.resolve(); await release.promise;
  }));
  try {
    await Promise.race([ready.promise, holding]);
    reading = tracked(findOwnPendingModelRequest(checked));
    checked.owner.instanceId = "mutated-after-entry";
    let blockers: { pid: number }[] = [];
    const deadline = performance.now() + 2_000;
    while (performance.now() < deadline) {
      blockers = await admin`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))`;
      if (blockers.length) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(blockers).toHaveLength(1);
    await admin.begin(async tx => {
      expect(await tx`SELECT request_id FROM model_capacity_requests WHERE request_id=${value.requestId}::uuid FOR UPDATE NOWAIT`)
        .toHaveLength(1);
    });
    release.resolve(); await holding;
    expect(await reading).toEqual({ requestId: value.requestId, state: "reserved" });
  } catch (error) { errors.push(error); }
  finally {
    release.resolve();
    await steps([async () => { await holding; }, async () => { await reading; }, async () => { await holder.end(); }], errors);
  }
}));

it("reads on primary inside a real read-only scope without changing that enclosing scope", exercise(async () => {
  await install(); const value = await request(); granted(await tracked(requestModelSlot(value)));
  const globals = globalThis as unknown as { readDb?: typeof db | null };
  const saved = Object.getOwnPropertyDescriptor(globals, "readDb"), errors: unknown[] = [];
  const reader = postgres(TEST_DATABASE_URL, { max: 1, prepare: false,
    connection: { application_name: "model-resume-read-only", default_transaction_read_only: true } });
  try {
    globals.readDb = drizzle(reader, { schema });
    await onReplica(async () => {
      const mode = async () => (await db.execute<{ mode: string }>(sql`SELECT current_setting('transaction_read_only') mode`))[0].mode;
      expect(await mode()).toBe("on");
      expect(await tracked(findOwnPendingModelRequest(identity(value)))).toEqual({ requestId: value.requestId, state: "reserved" });
      expect(await mode()).toBe("on");
    });
  } catch (error) { errors.push(error); }
  finally {
    await steps([async () => {
      if (saved) Object.defineProperty(globals, "readDb", saved); else Reflect.deleteProperty(globals, "readDb");
    }, async () => { await reader.end(); }], errors);
  }
}));

it("rejects replay lookup before SQL in a genuine restricted scope with no model grants", exercise(async () => {
  const value = await request(), before = await whole(), errors: unknown[] = [];
  const acls = async () => (await admin`SELECT jsonb_build_object(
    'database',(SELECT datacl FROM pg_database WHERE datname=current_database()),
    'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) AS value`)[0].value;
  const beforeAcl = await acls();
  let profile: Awaited<ReturnType<typeof getReplayHandlerIdentityPath>> | undefined;
  try {
    profile = await getReplayHandlerIdentityPath();
    await withReplayDatabaseScope(profile.identityPath, async () => {
      const [privilege] = await db.execute<{ allowed: boolean }>(sql`SELECT has_table_privilege(current_user,'public.model_capacity_control','SELECT') allowed`);
      expect(privilege.allowed).toBe(false);
      const executor = currentReplayDb()!, original = executor.transaction;
      const saved = Object.getOwnPropertyDescriptor(executor, "transaction");
      let entries = 0;
      Object.defineProperty(executor, "transaction", { configurable: true, writable: true,
        value: function (...args: unknown[]) { entries++; return Reflect.apply(original, this, args); } });
      try {
        await expect(tracked(findOwnPendingModelRequest(identity(value)))).rejects.toThrow("model_capacity_replay_unsupported");
        expect(entries).toBe(0);
      } finally {
        if (saved) Object.defineProperty(executor, "transaction", saved); else Reflect.deleteProperty(executor, "transaction");
      }
    });
  } catch (error) { errors.push(error); }
  finally {
    await steps([async () => { await profile?.release(); }, async () => {
      await writeFile(`/tmp/nomorevibe-pr05b2-replay-acl-${owner.bootId}.json`,
        JSON.stringify({ beforeAcl, afterAcl: await acls() }, null, 2));
      expect(await whole()).toEqual(before);
    }], errors);
  }
}));

it("rejects preparation with an actual foreign waiting request before any fixture DML", exercise(async () => {
  await install(); granted(await tracked(requestModelSlot(await request())));
  const foreign = await request({ owner: { instanceId: `${prefix}-existing-owner`, bootId: randomUUID() } });
  expect(await tracked(requestModelSlot(foreign))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await row(foreign.requestId)).toMatchObject({ state: "waiting", token: null });
  const before = await whole(), errors: unknown[] = [];
  try {
    await expect(tracked(preparationSnapshot())).rejects.toThrow("model_resume_fixture_requires_empty_requests");
  } catch (error) { errors.push(error); }
  finally {
    await steps([async () => { expect(await whole()).toEqual(before); }], errors);
  }
}));
