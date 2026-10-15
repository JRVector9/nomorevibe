import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { db, onReplica } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { currentReplayDb, withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest,
  type ModelCapacityReservation, type ModelCapacityDispatch, type ModelCapacityIndeterminateReason,
  type ModelSlotResult } from "@/lib/llm/capacity";
import { requestModelSlot as requestApi, cancelReservedModelSlot as cancelApi,
  beginModelDispatch as beginApi, markModelDispatchIndeterminate as markApi } from "@/lib/llm/capacity-repository";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// No transport is connected. Owner-only fixture deletion is not an external-end
// proof and never adds a runtime post-dispatch release API.
const suffix = randomUUID().slice(0, 8), sentinel = `pr05a-capacity-c-${suffix}-sentinel`;
const owner = { instanceId: `capacity-c-${suffix}`, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr05a-capacity-c-admin" } });
type Raw = Record<string, unknown>;
const owned = new Map<string, ModelCapacityRequest>(), exercises = new Set<Promise<void>>();
// Verified normal-profile release can materialize exactly these16 NULL ACLs as
// owner defaults. Preserve raw evidence; compare their effective grants only.
const profileAclRelations = ["agent_repository_observations", "agent_repository_scans", "crawl_candidates",
  "crawl_documents", "crawl_frontier", "crawl_frontier_id_seq", "crawl_review_attempts", "crawl_review_attempts_id_seq",
  "crawl_settings", "jobs", "operations_observations", "pipeline_item_leases", "pipeline_stage_modes", "products",
  "second_reviews", "second_reviews_id_seq"];
const apiTasks = new Set<Promise<unknown>>(), hookTasks = new Set<Promise<unknown>>();
let setupWork: Promise<void> | undefined, cleanupWork: Promise<void> | undefined;
let original: unknown, withSentinel: unknown, originalControl: Raw, identity: Raw;
let sentinelRaw: Raw, initialized = false, serial = 0;

const policy = (): ModelCapacityPolicy => ({ version: 1, globalLimit: 1,
  providerLimits: { shared: 1 }, groupLimits: { serving: 1 }, poolLimits: { reviewer: 1, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8,
  queueTtlMs: 10_000, reservationTtlMs: 60_000, routes: [
    { routeId: "primary", provider: "test", model: "same-model", providerBudgetId: "shared", groupId: "serving" },
  ] });
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function allSteps(steps: readonly (() => Promise<unknown>)[], priorErrors: readonly unknown[] = []) {
  const errors = [...priorErrors];
  for (const step of steps) try { await step(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "model_capacity_c_cleanup_failed", { cause: errors[0] });
}
function exercise(load: () => Promise<void>) {
  return () => {
    const work = Promise.resolve().then(load); exercises.add(work);
    void work.catch(() => {}); return work;
  };
}
async function settleExercises() {
  const pending = [...exercises], results = await Promise.allSettled(pending);
  for (const work of pending) exercises.delete(work);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "model_capacity_c_exercise_failed", { cause: errors[0] });
}
function actualApi<T>(work: Promise<T>): Promise<T> {
  apiTasks.add(work);
  void work.then(() => apiTasks.delete(work), () => apiTasks.delete(work));
  return work;
}
function requestModelSlot(value: ModelCapacityRequest) { return actualApi(requestApi(value)); }
function cancelReservedModelSlot(value: ModelCapacityReservation) { return actualApi(cancelApi(value)); }
function beginModelDispatch(value: ModelCapacityReservation) { return actualApi(beginApi(value)); }
function markModelDispatchIndeterminate(value: ModelCapacityDispatch, reason: ModelCapacityIndeterminateReason) {
  return actualApi(markApi(value, reason));
}
async function settleTasks(tasks: Set<Promise<unknown>>) {
  const pending = [...tasks], results = await Promise.allSettled(pending);
  for (const work of pending) tasks.delete(work);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "model_capacity_c_pending_work_failed");
}
async function databaseIdentity(tx: postgres.Sql | postgres.TransactionSql) {
  const [row] = await tx`SELECT d.oid::int AS database_oid,d.datdba::int AS owner_oid,
    r.oid::int AS current_oid,current_database() AS database_name,current_user AS current_name,
    session_user AS session_name FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database()`;
  return row;
}
async function wholeSnapshot(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const rows: Record<string, unknown> = {};
  const tables = await tx`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`;
  for (const table of tables) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows
      FROM public."${String(table.relname).replaceAll('"', '""')}" t`);
    rows[String(table.relname)] = row.rows;
  }
  const [metadata] = await tx`SELECT jsonb_build_object(
    'triggers',(SELECT jsonb_agg(jsonb_build_object('oid',t.oid,'table',c.relname,'name',t.tgname,
      'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal),
    'functions',(SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),
      'owner',p.proowner,'acl',p.proacl) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind IN ('f','p')),
    'databaseAcl',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type)
      FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
      WHERE d.datname=current_database()),
    'publicAcl',(SELECT nspacl FROM pg_namespace WHERE nspname='public'),
    'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',c.relowner,'acl',
      CASE WHEN c.relname=ANY(${profileAclRelations}) THEN
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type),'[]'::jsonb)
          FROM aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a)
      ELSE to_jsonb(c.relacl) END) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f')),
    'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'acl',a.attacl) ORDER BY c.relname,a.attnum)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped),
    'roles',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'name',rolname,'config',rolconfig,
      'super',rolsuper,'login',rolcanlogin) ORDER BY oid) FROM pg_roles WHERE rolname !~ '^pg_'),
    'roleSettings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY setdatabase,setrole) FROM pg_db_role_setting s)) AS value`;
  return { rows, metadata: metadata.value };
}
async function performCleanup() {
  if (!initialized) return;
  const ids = [...owned.keys()];
  await admin.begin(async tx => {
    expect(await databaseIdentity(tx)).toEqual(identity);
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const requests = ids.length ? await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY queue_ordinal FOR UPDATE` : [];
    for (const { row } of requests) {
      const expected = owned.get(row.request_id);
      if (!expected || row.owner_instance_id !== expected.owner.instanceId || row.owner_boot_id !== expected.owner.bootId
        || row.work_key !== expected.workKey) throw new Error("model_capacity_c_fixture_owner_mismatch");
    }
    // Quiescent task-owned DB only. This is the sole permitted audit guard
    // change, transactional and restored before commit. TRUNCATE stays guarded.
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const [guard] = await tx`SELECT tgenabled FROM pg_trigger
      WHERE tgrelid='model_capacity_events'::regclass AND tgname='model_capacity_events_no_change'`;
    if (!guard || !["O", "A"].includes(guard.tgenabled)) throw new Error("model_capacity_c_guard_mismatch");
    const events = ids.length ? await tx`SELECT id::text,request_id FROM model_capacity_events
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id` : [];
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) await tx`DELETE FROM model_capacity_events
        WHERE id=${event.id}::bigint AND request_id=${event.request_id}::uuid`;
      if (guard.tgenabled === "A") await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
      else await tx`ALTER TABLE model_capacity_events ENABLE TRIGGER model_capacity_events_no_change`;
    }
    if (ids.length) await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,
      policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
    expect(await wholeSnapshot(tx)).toEqual(withSentinel);
  });
  owned.clear();
}
function cleanup(): Promise<void> {
  if (cleanupWork) return cleanupWork;
  const work = performCleanup(); cleanupWork = work;
  const clear = () => { if (cleanupWork === work) cleanupWork = undefined; };
  void work.then(clear, clear); return work;
}
async function openPolicy(value = policy()) {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}
async function makeRequest(overrides: Partial<Omit<ModelCapacityRequest, "requestId">> = {}): Promise<ModelCapacityRequest> {
  const requestId = randomUUID();
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${requestId}::uuid`).toEqual([]);
  const value: ModelCapacityRequest = { requestId, owner: { ...owner }, workKey: `capacity-c:${suffix}:${++serial}`,
    class: "first", pool: "reviewer", routeId: "primary", provider: "test", model: "same-model", ...overrides };
  owned.set(requestId, value); return value;
}
function reservation(result: ModelSlotResult): ModelCapacityReservation {
  expect(result.kind).toBe("granted");
  if (result.kind !== "granted") throw new Error("actual_model_reservation_required");
  return result.reservation;
}
async function rowFor(id: string) {
  const [row] = await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`;
  return row?.value as Raw | undefined;
}

async function setup() {
  ensureSchema(); identity = await databaseIdentity(admin);
  expect(identity.database_name).toBe("nomorevibe_test");
  expect(identity.current_oid).toBe(identity.owner_oid); expect(identity.current_name).toBe(identity.session_name);
  original = await wholeSnapshot();
  const [control] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  originalControl = control.row;
  expect(originalControl).toMatchObject({ mode: "disabled", epoch: 1, revision: 1, policy: null, policy_hash: null, cursor: 0 });
  expect(await admin`SELECT request_id FROM model_capacity_requests`).toEqual([]);
  expect(await admin`SELECT name FROM jobs WHERE name=${sentinel}`).toEqual([]);
  const [job] = await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
    VALUES(${sentinel},7,3,'{"page":19,"paused":true}'::jsonb,'2001-01-01T00:00:00.123456'::timestamp,
      '2001-01-01T00:00:00.654321'::timestamp) RETURNING to_jsonb(jobs) AS row`;
  sentinelRaw = job.row; initialized = true; withSentinel = await wholeSnapshot();
}
beforeAll(() => { setupWork = setup(); void setupWork.catch(() => {}); return setupWork; });
afterEach(() => {
  const work = allSteps([async () => { await setupWork; }, settleExercises, () => settleTasks(apiTasks), cleanup,
    async () => { if (initialized) expect(await wholeSnapshot()).toEqual(withSentinel); }]);
  hookTasks.add(work); void work.then(() => hookTasks.delete(work), () => hookTasks.delete(work)); return work;
});
afterAll(async () => {
  await allSteps([async () => { await setupWork; }, () => settleTasks(hookTasks), settleExercises,
    () => settleTasks(apiTasks), cleanup, async () => {
    if (!initialized) return;
    const [job] = await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${sentinel}`;
    expect(job.row).toEqual(sentinelRaw);
    await admin`DELETE FROM jobs WHERE name=${sentinel}`;
    expect(await wholeSnapshot()).toEqual(original);
  }, async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end({ timeout: 3 }); },
  async () => { await admin.end({ timeout: 3 }); }]);
});

it("keeps default-disabled admission free of request and event writes", exercise(async () => {
  const value = await makeRequest(), before = await wholeSnapshot();
  expect(await requestModelSlot(value)).toEqual({ kind: "deferred", reason: "disabled" });
  expect(await wholeSnapshot()).toEqual(before);
}));

it("issues a real persisted reservation and cancels it through the original handle", exercise(async () => {
  await openPolicy();
  const value = await makeRequest(), handle = reservation(await requestModelSlot(value));
  const errors: unknown[] = [];
  try {
    expect(await rowFor(value.requestId)).toMatchObject({ request_id: value.requestId, owner_instance_id: owner.instanceId,
      owner_boot_id: owner.bootId, token: handle.token, epoch: handle.epoch, revision: handle.revision,
      policy_hash: handle.policyHash, state: "reserved", provider_budget_id: "shared", group_id: "serving" });
    expect(handle.token).toMatch(/^[0-9a-f-]{36}$/);
  } catch (error) { errors.push(error); }
  finally { await allSteps([async () => { expect(await cancelReservedModelSlot(handle)).toBe(true); }], errors); }
  expect(await rowFor(value.requestId)).toMatchObject({ state: "withdrawn", token: handle.token });
  const events = await admin`SELECT kind FROM model_capacity_events WHERE request_id=${value.requestId}::uuid ORDER BY id`;
  expect(events.map(row => row.kind)).toEqual(["queued", "reserved", "reservation_cancelled"]);
}));

it("admits one actual request across two blocked connections at global cap1", exercise(async () => {
  await openPolicy();
  const left = await makeRequest(), right = await makeRequest(), started = latch(), finish = latch();
  const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false,
    connection: { application_name: "pr05a-capacity-c-holder" } });
  let holderPid = 0, pending: Promise<ModelSlotResult[]> | undefined, results: ModelSlotResult[] = [];
  const holding = holder.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const [row] = await tx`SELECT pg_backend_pid() AS pid`; holderPid = row.pid;
    started.resolve(); await finish.promise;
  });
  void holding.catch(() => {});
  const errors: unknown[] = [];
  try {
    await Promise.race([started.promise, holding]);
    pending = Promise.all([requestModelSlot(left), requestModelSlot(right)]); void pending.catch(() => {});
    let blocked: Raw[] = [];
    const deadline = performance.now() + 2_500;
    while (performance.now() < deadline) {
      // A queued row-lock waiter can block the next waiter itself. Follow the
      // actual blocking graph instead of counting only the holder's direct edge.
      blocked = await admin`WITH RECURSIVE waiting(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${holderPid}=ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
          WHERE a.datname=current_database()) SELECT pid FROM waiting ORDER BY pid`;
      if (blocked.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toHaveLength(2);
    expect(new Set(blocked.map(row => row.pid)).size).toBe(2);
    finish.resolve(); await holding; results = await pending;
    expect(results.filter(result => result.kind === "granted")).toHaveLength(1);
    expect(results.filter(result => result.kind === "deferred")).toEqual([{ kind: "deferred", reason: "capacity" }]);
    const active = await admin`SELECT request_id FROM model_capacity_requests
      WHERE state IN ('reserved','dispatched','indeterminate') ORDER BY queue_ordinal`;
    expect(active).toHaveLength(1);
  } catch (error) { errors.push(error); }
  finally {
    finish.resolve();
    await allSteps([async () => { await holding; }, async () => { if (pending) results = await pending; },
      async () => { for (const result of results) if (result.kind === "granted") await cancelReservedModelSlot(result.reservation); },
      async () => { await holder.end({ timeout: 3 }); }], errors);
  }
}));

async function dispatched(handle: ModelCapacityReservation) {
  const result = await beginModelDispatch(handle);
  expect(result.kind).toBe("dispatched");
  if (result.kind !== "dispatched") throw new Error("actual_model_dispatch_required");
  return result.dispatch;
}
async function pastReservation(id: string) {
  const deadline = performance.now() + 2_500;
  while (performance.now() < deadline) {
    const [row] = await admin`SELECT reserved_until<=clock_timestamp() AS expired
      FROM model_capacity_requests WHERE request_id=${id}::uuid`;
    if (row?.expired === true) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("actual_reservation_did_not_expire");
}
function databaseCause(error: unknown): unknown {
  if (error instanceof Error && "cause" in error && error.cause) return databaseCause(error.cause);
  return error;
}

it("counts explicit cross-provider aliases together while permitting an unrelated group", exercise(async () => {
  const value: ModelCapacityPolicy = { ...policy(), globalLimit: 3,
    providerLimits: { one: 2, two: 2 }, groupLimits: { serving: 1, other: 2 },
    poolLimits: { reviewer: 3, text: 2 }, reservationTtlMs: 60_000,
    routes: [{ ...policy().routes[0], providerBudgetId: "one" },
      { routeId: "alias", provider: "other-provider", model: "different-alias", providerBudgetId: "two", groupId: "serving" },
      { routeId: "independent", provider: "other-provider", model: "other-model", providerBudgetId: "two", groupId: "other" }] };
  await openPolicy(value);
  const first = reservation(await requestModelSlot(await makeRequest()));
  const alias = await makeRequest({ routeId: "alias", provider: "other-provider", model: "different-alias" });
  expect(await requestModelSlot(alias)).toEqual({ kind: "deferred", reason: "capacity" });
  const other = reservation(await requestModelSlot(await makeRequest({ routeId: "independent", provider: "other-provider", model: "other-model" })));
  expect(other.token).not.toBe(first.token);
  expect(await rowFor(alias.requestId)).toMatchObject({ state: "waiting", token: null, group_id: "serving", provider_budget_id: "two" });
  expect(await cancelReservedModelSlot(first)).toBe(true);
  expect(await cancelReservedModelSlot(other)).toBe(true);
}));

it("does not infer provider or MLX aliases absent from the exact route map", exercise(async () => {
  await openPolicy();
  for (const override of [{ provider: "TEST" }, { model: "[MLX] same-model" }, { routeId: "other-route" }]) {
    const value = await makeRequest(override), before = await wholeSnapshot();
    expect(await requestModelSlot(value)).toEqual({ kind: "deferred", reason: "unmapped" });
    expect(await wholeSnapshot()).toEqual(before);
  }
}));

const badHandles = ["requestId", "instanceId", "bootId", "token", "epoch", "revision", "policyHash"] as const;
for (const field of badHandles) it(`refuses a forged ${field} while preserving the genuine owner and audit rows`, exercise(async () => {
  await openPolicy({ ...policy(), reservationTtlMs: 60_000 });
  const handle = reservation(await requestModelSlot(await makeRequest()));
  const bad = { ...handle, owner: { ...handle.owner } };
  if (field === "instanceId") bad.owner = { ...bad.owner, instanceId: "foreign-capacity-owner" };
  else if (field === "bootId") bad.owner = { ...bad.owner, bootId: randomUUID() };
  else if (field === "epoch" || field === "revision") bad[field] += 1;
  else if (field === "policyHash") bad.policyHash = "f".repeat(64);
  else bad[field] = randomUUID();
  const before = await wholeSnapshot();
  expect(await beginModelDispatch(bad)).toEqual({ kind: "ownership_lost" });
  expect(await cancelReservedModelSlot(bad)).toBe(false);
  expect(await wholeSnapshot()).toEqual(before);
  expect(await cancelReservedModelSlot(handle)).toBe(true);
}));

it("permits one dispatch commit when the same genuine reservation begins concurrently", exercise(async () => {
  await openPolicy();
  const handle = reservation(await requestModelSlot(await makeRequest()));
  const results = await Promise.all([beginModelDispatch(handle), beginModelDispatch(handle)]);
  expect(results.filter(result => result.kind === "dispatched")).toHaveLength(1);
  expect(results.filter(result => result.kind === "ownership_lost")).toHaveLength(1);
  expect(await cancelReservedModelSlot(handle)).toBe(false);
  expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${handle.requestId}::uuid ORDER BY id`)
    .map(row => row.kind)).toEqual(["queued", "reserved", "dispatch_started"]);
}));

it("does not dispatch after the genuine cancel committed first", exercise(async () => {
  await openPolicy();
  const handle = reservation(await requestModelSlot(await makeRequest()));
  expect(await cancelReservedModelSlot(handle)).toBe(true);
  const before = await wholeSnapshot();
  expect(await beginModelDispatch(handle)).toEqual({ kind: "ownership_lost" });
  expect(await wholeSnapshot()).toEqual(before);
}));

it("serializes actual begin-versus-cancel without granting a second dispatch permit", exercise(async () => {
  await openPolicy();
  const handle = reservation(await requestModelSlot(await makeRequest()));
  const [begun, cancelled] = await Promise.all([beginModelDispatch(handle), cancelReservedModelSlot(handle)]);
  const row = await rowFor(handle.requestId);
  if (begun.kind === "dispatched") { expect(cancelled).toBe(false); expect(row?.state).toBe("dispatched"); }
  else { expect(cancelled).toBe(true); expect(row?.state).toBe("withdrawn"); }
  expect(await beginModelDispatch(handle)).toEqual({ kind: "ownership_lost" });
  const transitions = await admin`SELECT kind FROM model_capacity_events WHERE request_id=${handle.requestId}::uuid
    AND kind IN ('dispatch_started','reservation_cancelled')`;
  expect(transitions).toHaveLength(1);
}));

it("checks DB expiry after waiting on the control lock rather than at TX start", exercise(async () => {
  await openPolicy({ ...policy(), reservationTtlMs: 1_000 });
  const handle = reservation(await requestModelSlot(await makeRequest()));
  const started = latch(), finish = latch(), holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
  let pid = 0, pending: ReturnType<typeof beginModelDispatch> | undefined;
  const holding = holder.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const [row] = await tx`SELECT pg_backend_pid() AS pid`; pid = row.pid; started.resolve(); await finish.promise;
  });
  void holding.catch(() => {});
  const errors: unknown[] = [];
  try {
    await Promise.race([started.promise, holding]);
    pending = beginModelDispatch(handle); void pending.catch(() => {});
    const deadline = performance.now() + 1_500;
    let observed = false, healthyAtStart: boolean | undefined;
    while (performance.now() < deadline) {
      const rows = await admin`SELECT a.pid,a.xact_start<r.reserved_until AS healthy_at_start
        FROM pg_stat_activity a CROSS JOIN model_capacity_requests r
        WHERE a.datname=current_database() AND ${pid}=ANY(pg_blocking_pids(a.pid)) AND r.request_id=${handle.requestId}::uuid`;
      if (rows.length) { observed = true; healthyAtStart = rows[0].healthy_at_start; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(observed).toBe(true); expect(healthyAtStart).toBe(true); await pastReservation(handle.requestId);
    finish.resolve(); await holding;
    expect(await pending).toEqual({ kind: "ownership_lost" });
    expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${handle.requestId}::uuid AND kind='dispatch_started'`).toEqual([]);
  } catch (error) { errors.push(error); }
  finally {
    finish.resolve(); await allSteps([async () => { await holding; }, async () => { await pending; },
      async () => { await holder.end({ timeout: 3 }); }], errors);
  }
}));

it("retains real dispatched and indeterminate occupancy past the original reservation expiry", exercise(async () => {
  await openPolicy({ ...policy(), reservationTtlMs: 1_000 });
  const handle = reservation(await requestModelSlot(await makeRequest())), dispatch = await dispatched(handle);
  await pastReservation(handle.requestId);
  expect(await cancelReservedModelSlot(handle)).toBe(false);
  expect(await requestModelSlot(await makeRequest())).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await markModelDispatchIndeterminate(dispatch, "local_abort")).toBe(true);
  const before = await rowFor(handle.requestId);
  expect(await markModelDispatchIndeterminate(dispatch, "process_exit")).toBe(true);
  expect(await rowFor(handle.requestId)).toEqual(before);
  expect(before).toMatchObject({ state: "indeterminate", token: handle.token, owner_boot_id: owner.bootId,
    epoch: handle.epoch, revision: handle.revision, policy_hash: handle.policyHash });
  expect(await requestModelSlot(await makeRequest())).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await admin`SELECT reason FROM model_capacity_events WHERE request_id=${handle.requestId}::uuid AND kind='dispatch_indeterminate'`)
    .toEqual([{ reason: "local_abort" }]);
}));

it("does not hide the old dispatch by changing epoch, revision, policy and group mapping", exercise(async () => {
  await openPolicy();
  const handle = reservation(await requestModelSlot(await makeRequest())), dispatch = await dispatched(handle);
  const changed: ModelCapacityPolicy = { ...policy(), groupLimits: { replacement: 1 },
    routes: [{ ...policy().routes[0], groupId: "replacement" }] };
  await openPolicy(changed);
  await admin`UPDATE model_capacity_control SET epoch=epoch+1,revision=revision+1 WHERE id=1`;
  const before = await rowFor(handle.requestId);
  expect(await requestModelSlot(await makeRequest())).toEqual({ kind: "deferred", reason: "policy_changed" });
  expect(await rowFor(handle.requestId)).toEqual(before);
  expect(await cancelReservedModelSlot(handle)).toBe(false);
  expect(await markModelDispatchIndeterminate(dispatch, "transport_unknown")).toBe(true);
  expect(await rowFor(handle.requestId)).toMatchObject({ state: "indeterminate", epoch: handle.epoch,
    revision: handle.revision, policy_hash: handle.policyHash, group_id: "serving", token: handle.token });
}));

for (const mode of ["disabled", "draining"] as const) it(`preserves the original dispatch while ${mode}`, exercise(async () => {
  await openPolicy();
  const handle = reservation(await requestModelSlot(await makeRequest())), dispatch = await dispatched(handle);
  await admin`UPDATE model_capacity_control SET mode=${mode} WHERE id=1`;
  const before = await rowFor(handle.requestId);
  expect(await requestModelSlot(await makeRequest())).toEqual({ kind: "deferred", reason: mode });
  expect(await cancelReservedModelSlot(handle)).toBe(false); expect(await rowFor(handle.requestId)).toEqual(before);
  expect(await markModelDispatchIndeterminate(dispatch, "process_exit")).toBe(true);
  expect(await rowFor(handle.requestId)).toMatchObject({ state: "indeterminate", token: handle.token });
}));

for (const kind of ["queued", "dispatch_started", "reservation_cancelled", "dispatch_indeterminate"] as const)
  it(`rolls back the request and cursor when the ${kind} event cannot append`, exercise(async () => {
    await openPolicy({ ...policy(), reservationTtlMs: 60_000 });
    const value = await makeRequest();
    const handle = kind === "queued" ? undefined : reservation(await requestModelSlot(value));
    const dispatch = kind === "dispatch_indeterminate" ? await dispatched(handle!) : undefined;
    const functionName = `capacity_c_fault_${suffix}`, triggerName = `capacity_c_fault_${suffix}`;
    const errors: unknown[] = [];
    try {
      await admin.unsafe(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.request_id='${value.requestId}'::uuid AND NEW.kind='${kind}' THEN
          RAISE EXCEPTION 'capacity_c_append_fault' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`);
      await admin.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON model_capacity_events
        FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
      const before = await wholeSnapshot();
      const work = kind === "queued" ? requestModelSlot(value) : kind === "dispatch_started" ? beginModelDispatch(handle!)
        : kind === "reservation_cancelled" ? cancelReservedModelSlot(handle!) : markModelDispatchIndeterminate(dispatch!, "transport_unknown");
      await expect(work).rejects.toSatisfy(error => (databaseCause(error) as { code?: string }).code === "P0001");
      expect(await wholeSnapshot()).toEqual(before);
    } catch (error) { errors.push(error); }
    finally { await allSteps([async () => { await admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON model_capacity_events`); },
      async () => { await admin.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`); }], errors); }
  }));

it("enforces owner-level append-only guards for real rows, zero rows and TRUNCATE", exercise(async () => {
  await openPolicy(); const handle = reservation(await requestModelSlot(await makeRequest()));
  expect(await cancelReservedModelSlot(handle)).toBe(true);
  const before = await wholeSnapshot();
  for (const statement of ["UPDATE model_capacity_events SET kind=kind WHERE false", "DELETE FROM model_capacity_events WHERE false",
    `UPDATE model_capacity_events SET kind=kind WHERE request_id='${handle.requestId}'::uuid`,
    `DELETE FROM model_capacity_events WHERE request_id='${handle.requestId}'::uuid`, "TRUNCATE model_capacity_events"]) {
    await expect(admin.unsafe(statement)).rejects.toMatchObject({ code: "55000", message: "model_capacity_events_append_only" });
    expect(await wholeSnapshot()).toEqual(before);
  }
}));

it("keeps an unprivileged probe unable to mutate audit rows or disable their guards", exercise(async () => {
  await openPolicy(); const handle = reservation(await requestModelSlot(await makeRequest()));
  expect(await cancelReservedModelSlot(handle)).toBe(true);
  const before = await wholeSnapshot(), role = `capacity_c_probe_${suffix}`, rollback = new Error("capacity_c_role_rollback");
  await expect(admin.begin(async tx => {
    await tx.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await tx.unsafe(`GRANT SELECT ON model_capacity_events TO ${role}`);
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    for (const statement of ["UPDATE model_capacity_events SET kind=kind WHERE false", "DELETE FROM model_capacity_events WHERE false",
      "TRUNCATE model_capacity_events", "ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change"]) {
      await expect(tx.savepoint(async savepoint => { await savepoint.unsafe(statement); })).rejects.toMatchObject({ code: "42501" });
    }
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await wholeSnapshot()).toEqual(before);
}));

it("uses primary admission inside an actual read-only replica context on the same test DB", exercise(async () => {
  await openPolicy({ ...policy(), reservationTtlMs: 60_000 });
  const globals = globalThis as unknown as { readDb?: typeof db | null };
  const saved = Object.getOwnPropertyDescriptor(globals, "readDb");
  const readClient = postgres(TEST_DATABASE_URL, { max: 1, prepare: false,
    connection: { application_name: "pr05a-capacity-c-read-only", default_transaction_read_only: true } });
  const errors: unknown[] = [];
  try {
    globals.readDb = drizzle(readClient, { schema });
    await onReplica(async () => {
      const [context] = await db.execute<{ readonly: string; application: string }>(sql`SELECT
        current_setting('transaction_read_only') AS readonly,current_setting('application_name') AS application`);
      expect(context).toEqual({ readonly: "on", application: "pr05a-capacity-c-read-only" });
      await expect(db.execute(sql`UPDATE model_capacity_control SET cursor=cursor WHERE false`))
        .rejects.toSatisfy(error => (databaseCause(error) as { code?: string }).code === "25006");
      const value = await makeRequest(), handle = reservation(await requestModelSlot(value));
      expect(await rowFor(value.requestId)).toMatchObject({ state: "reserved", token: handle.token });
      expect(await cancelReservedModelSlot(handle)).toBe(true);
      const [after] = await db.execute<{ readonly: string }>(sql`SELECT current_setting('transaction_read_only') AS readonly`);
      expect(after.readonly).toBe("on");
    });
  } catch (error) { errors.push(error); }
  finally {
    if (saved) Object.defineProperty(globals, "readDb", saved); else Reflect.deleteProperty(globals, "readDb");
    await allSteps([async () => { await readClient.end({ timeout: 3 }); }], errors);
  }
}));

it("rejects all four capacity APIs before transaction entry in a genuine restricted replay scope", exercise(async () => {
  await openPolicy();
  const value = await makeRequest(), handle = reservation(await requestModelSlot(value)), dispatch = await dispatched(handle);
  const beforeRow = await rowFor(value.requestId), errors: unknown[] = [];
  const rawAcls = async () => {
    const [row] = await admin`SELECT d.datacl,n.nspacl,
      (SELECT jsonb_agg(jsonb_build_object('name',c.relname,'raw',c.relacl,'effective',
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type),'[]'::jsonb)
          FROM aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a)) ORDER BY c.relname)
        FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public'
          AND c.relname=ANY(${profileAclRelations})) AS relations
      FROM pg_database d CROSS JOIN pg_namespace n
      WHERE d.datname=current_database() AND n.nspname='public'`;
    return row;
  };
  const beforeAcl = await rawAcls();
  let profile: Awaited<ReturnType<typeof getReplayHandlerIdentityPath>> | undefined;
  try {
    profile = await getReplayHandlerIdentityPath();
    await withReplayDatabaseScope(profile.identityPath, async () => {
      // The real restricted role has no model-table grant. A missing early
      // guard reaches this actual42501 instead of the required unsupported error.
      await expect(db.execute(sql`SELECT id FROM model_capacity_control`))
        .rejects.toSatisfy(error => (databaseCause(error) as { code?: string }).code === "42501");
      const executor = currentReplayDb()!, descriptor = Object.getOwnPropertyDescriptor(executor, "transaction");
      const originalMethod = executor.transaction;
      let transactionEntries = 0;
      Object.defineProperty(executor, "transaction", { configurable: true, writable: true,
        value: function (...args: unknown[]) { transactionEntries++; return Reflect.apply(originalMethod, this, args); } });
      try {
        await expect(requestModelSlot(value)).rejects.toThrow("model_capacity_replay_unsupported");
        await expect(beginModelDispatch(handle)).rejects.toThrow("model_capacity_replay_unsupported");
        await expect(cancelReservedModelSlot(handle)).rejects.toThrow("model_capacity_replay_unsupported");
        await expect(markModelDispatchIndeterminate(dispatch, "transport_unknown")).rejects.toThrow("model_capacity_replay_unsupported");
        expect(transactionEntries).toBe(0);
      } finally {
        if (descriptor) Object.defineProperty(executor, "transaction", descriptor);
        else Reflect.deleteProperty(executor, "transaction");
      }
    });
    expect(await rowFor(value.requestId)).toEqual(beforeRow);
  } catch (error) { errors.push(error); }
  finally {
    await allSteps([async () => { await profile?.release(); }, async () => {
      const afterAcl = await rawAcls();
      await writeFile(`/tmp/nomorevibe-pr05a-capacity-c-replay-acl-${suffix}.json`, JSON.stringify({ beforeAcl, afterAcl }, null, 2));
      expect(afterAcl.nspacl).toEqual(beforeAcl.nspacl);
      expect(afterAcl.relations.map((row: { name: string; effective: unknown }) => ({ name: row.name, effective: row.effective })))
        .toEqual(beforeAcl.relations.map((row: { name: string; effective: unknown }) => ({ name: row.name, effective: row.effective })));
    }], errors);
  }
}));
