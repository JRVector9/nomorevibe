import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { beginModelDispatch as rawBegin, cancelReservedModelSlot as rawCancel,
  markModelDispatchIndeterminate as rawMark, requestModelSlot as rawRequest } from "@/lib/llm/capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const instanceId = `pr05a-repository-${randomUUID()}`;
const owner = { instanceId, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr05a-model-capacity-repository" } });
const requests = new Map<string, ModelCapacityRequest>();
const ownedRequests = new Map<string, ModelCapacityRequest>();
const ownershipChecks = new Map<string, Promise<void>>();
const apiWork = new Set<Promise<unknown>>();
const hookWork = new Set<Promise<unknown>>();
const pending = new Set<Promise<unknown>>();
let originalControl: unknown, originalForeign: unknown, originalCatalog: unknown;
let initialized = false, bodyError: unknown;
let cleanupWork: Promise<void> | undefined;

function tracked<T>(work: Promise<T>, set: Set<Promise<unknown>>): Promise<T> {
  set.add(work); void work.then(() => set.delete(work), () => set.delete(work)); return work;
}
async function drainWork(): Promise<void> {
  const errors: unknown[] = [];
  while (apiWork.size || hookWork.size || pending.size) {
    const results = await Promise.allSettled([...apiWork, ...hookWork, ...pending]);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
  }
  if (errors.length) throw new AggregateError(errors, "model_capacity_pending_work_failed");
}
function ownRequest(value: ModelCapacityRequest): Promise<void> {
  if (ownedRequests.has(value.requestId)) return Promise.resolve();
  const existing = ownershipChecks.get(value.requestId); if (existing) return existing;
  const work = (async () => {
    const expected = requests.get(value.requestId); if (!expected) throw new Error("undeclared_fixture_request");
    expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${value.requestId}`).toEqual([]);
    expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${value.requestId}`).toEqual([]);
    ownedRequests.set(value.requestId, structuredClone(expected));
  })();
  ownershipChecks.set(value.requestId, work); return work;
}
function requestModelSlot(value: ModelCapacityRequest) {
  const snapshot = structuredClone(value);
  return tracked(ownRequest(snapshot).then(() => rawRequest(snapshot)), apiWork);
}
const cancelReservedModelSlot: typeof rawCancel = value => tracked(rawCancel(value), apiWork);
const beginModelDispatch: typeof rawBegin = value => tracked(rawBegin(value), apiWork);
const markModelDispatchIndeterminate: typeof rawMark = (value, reason) => tracked(rawMark(value, reason), apiWork);

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2,
  providerLimits: { account: 2 }, groupLimits: { shared: 2 }, poolLimits: { reviewer: 2, text: 2 },
  weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "fixture-chat", provider: "fixture-provider", model: "fixture-model",
    providerBudgetId: "account", groupId: "shared" }] };

function request(overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest {
  const value: ModelCapacityRequest = { requestId: randomUUID(), workKey: randomUUID(), owner,
    class: "first", pool: "reviewer", routeId: "fixture-chat", provider: "fixture-provider",
    model: "fixture-model", ...overrides };
  requests.set(value.requestId, structuredClone(value)); return value;
}
function exercise(load: () => Promise<unknown>) {
  return async () => {
    const work = Promise.resolve().then(load); pending.add(work);
    try { await work; } catch (error) { bodyError = error; throw error; }
    finally { pending.delete(work); }
  };
}
async function catalogSnapshot(tx?: postgres.TransactionSql) {
  const reader = tx ?? admin;
  const [row] = await reader`SELECT jsonb_build_object(
    'database',(SELECT to_jsonb(d) - 'datfrozenxid' - 'datminmxid' FROM pg_database d WHERE datname=current_database()),
    'public',(SELECT to_jsonb(n) FROM pg_namespace n WHERE nspname='public'),
    'relations',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.relname,'acl',c.relacl) ORDER BY c.oid)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')),
    'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'acl',a.attacl) ORDER BY c.relname,a.attname),'[]'::jsonb)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND a.attacl IS NOT NULL),
    'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'name',p.proname,'acl',p.proacl,'body',p.prosrc) ORDER BY p.oid),'[]'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
    'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',t.oid,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.oid),'[]'::jsonb)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal)
    ) AS value`;
  return row.value;
}
async function foreignSnapshot(tx?: postgres.TransactionSql) {
  const reader = tx ?? admin, ids = [...ownedRequests.keys()];
  const [row] = await reader`SELECT jsonb_build_object(
    'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.queue_ordinal),'[]'::jsonb)
      FROM model_capacity_requests r WHERE NOT(r.request_id=ANY(${ids}::uuid[]))),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb)
      FROM model_capacity_events e WHERE NOT(e.request_id=ANY(${ids}::uuid[]))),
    'stages',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.stage) FROM pipeline_stage_modes s),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.stage,i.work_key),'[]'::jsonb) FROM pipeline_item_leases i)
    ) AS value`;
  return row.value;
}
function restoreOwnRows(): Promise<void> {
  if (cleanupWork) return cleanupWork;
  const work = restoreRows(); cleanupWork = work;
  void work.then(() => { if (cleanupWork === work) cleanupWork = undefined; }, () => { if (cleanupWork === work) cleanupWork = undefined; });
  return tracked(work, hookWork);
}
async function restoreRows() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`LOCK TABLE model_capacity_requests,model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const ids = [...ownedRequests.keys()];
    const rows = await tx`SELECT request_id,owner_instance_id,owner_boot_id FROM model_capacity_requests
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY queue_ordinal`;
    for (const row of rows) {
      const expected = ownedRequests.get(row.request_id)!;
      expect(row.owner_instance_id).toBe(expected.owner.instanceId);
      expect(row.owner_boot_id).toBe(expected.owner.bootId);
    }
    // Test owner only; no external calls exist. This is exact-row fixture
    // teardown, never evidence that a dispatched provider has terminated.
    const events = await tx`SELECT id::text AS id,request_id FROM model_capacity_events
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events e USING
      jsonb_to_recordset(${JSON.stringify(events)}::text::jsonb) AS observed(id bigint,request_id uuid)
      WHERE e.id=observed.id AND e.request_id=observed.request_id AND e.request_id=ANY(${ids}::uuid[])`;
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,
      policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      FROM jsonb_populate_recordset(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
    expect(await foreignSnapshot(tx)).toEqual(originalForeign);
    expect((await tx`SELECT to_jsonb(c) AS value FROM model_capacity_control c ORDER BY id`).map(row => row.value)).toEqual(originalControl);
    expect(await catalogSnapshot(tx)).toEqual(originalCatalog);
    expect(await tx`SELECT request_id FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`).toEqual([]);
  });
  expect(await foreignSnapshot()).toEqual(originalForeign);
  expect((await admin`SELECT to_jsonb(c) AS value FROM model_capacity_control c ORDER BY id`).map(row => row.value)).toEqual(originalControl);
  expect(await catalogSnapshot()).toEqual(originalCatalog);
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=ANY(${[...requests.keys()]}::uuid[])`).toEqual([]);
}
async function installPolicy(value: ModelCapacityPolicy = policy) {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}

beforeAll(() => tracked((async () => {
  ensureSchema();
  originalControl = (await admin`SELECT to_jsonb(c) AS value FROM model_capacity_control c ORDER BY id`).map(row => row.value);
  expect(originalControl).toEqual([expect.objectContaining({ id: 1, mode: "disabled", policy: null, policy_hash: null })]);
  expect(await admin`SELECT request_id FROM model_capacity_requests`).toEqual([]);
  expect(await admin`SELECT id FROM model_capacity_events`).toEqual([]);
  originalForeign = await foreignSnapshot(); originalCatalog = await catalogSnapshot(); initialized = true;
})(), hookWork));
beforeEach(async () => { await drainWork(); bodyError = undefined; await restoreOwnRows(); });
afterEach(async () => {
  const errors: unknown[] = bodyError === undefined ? [] : [bodyError];
  try { await drainWork(); } catch (error) { errors.push(error); }
  try { await restoreOwnRows(); } catch (error) { errors.push(error); }
  if (errors.length > (bodyError === undefined ? 0 : 1)) throw new AggregateError(errors, "model_capacity_test_cleanup_failed");
});
afterAll(async () => {
  const errors: unknown[] = [];
  try { await drainWork(); } catch (error) { errors.push(error); }
  try { await restoreOwnRows(); } catch (error) { errors.push(error); }
  try { await admin.end({ timeout: 3 }); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "model_capacity_repository_final_cleanup_failed");
});

it("keeps the default disabled control free of requests and events", exercise(async () => {
  const value = request();
  expect(await requestModelSlot(value)).toEqual({ kind: "deferred", reason: "disabled" });
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${value.requestId}`).toEqual([]);
  expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${value.requestId}`).toEqual([]);
}));

it("issues an actual reservation, reobserves the same token, and cancels the original token once", exercise(async () => {
  await installPolicy(); const value = request(), result = await requestModelSlot(value);
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("missing_fixture_reservation");
  const [row] = await admin`SELECT * FROM model_capacity_requests WHERE request_id=${value.requestId}`;
  expect(row).toMatchObject({ state: "reserved", owner_instance_id: owner.instanceId, owner_boot_id: owner.bootId,
    token: result.reservation.token, provider_budget_id: "account", group_id: "shared" });
  expect(await requestModelSlot(value)).toEqual(result);
  await expect(requestModelSlot({ ...value, workKey: "different-work" })).rejects.toThrow();
  expect(await cancelReservedModelSlot(result.reservation)).toBe(true);
  expect(await cancelReservedModelSlot(result.reservation)).toBe(false);
  expect((await admin`SELECT state FROM model_capacity_requests WHERE request_id=${value.requestId}`)[0].state).toBe("withdrawn");
  expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${value.requestId} ORDER BY id`).map(row => row.kind))
    .toEqual(["queued", "reserved", "reservation_cancelled"]);
}));

it("grants only the last global slot when two actual connections request it concurrently", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 1 });
  const values = [request(), request()], results = await Promise.all(values.map(value => requestModelSlot(value)));
  const [count] = await admin`SELECT count(*)::int AS active FROM model_capacity_requests
    WHERE request_id=ANY(${values.map(value => value.requestId)}::uuid[]) AND state IN ('reserved','dispatched','indeterminate')`;
  console.info("model-capacity-concurrency", { granted: results.filter(result => result.kind === "granted").length, active: count.active });
  expect(results.filter(result => result.kind === "granted")).toHaveLength(1);
  expect(count.active).toBe(1);
}));

async function issued(value: ModelCapacityRequest) {
  const result = await requestModelSlot(value); expect(result.kind).toBe("granted");
  if (result.kind !== "granted") throw new Error("fixture_reservation_not_issued");
  return result.reservation;
}
async function activeRows() {
  return admin`SELECT request_id,class,pool,provider_budget_id,group_id FROM model_capacity_requests
    WHERE state IN ('reserved','dispatched','indeterminate') ORDER BY queue_ordinal`;
}

for (const dimension of ["provider", "group", "pool"] as const) {
  it(`enforces the ${dimension} limit independently of spare global capacity`, exercise(async () => {
    await installPolicy({ ...policy,
      providerLimits: { account: dimension === "provider" ? 1 : 2 },
      groupLimits: { shared: dimension === "group" ? 1 : 2 },
      poolLimits: { reviewer: dimension === "pool" ? 1 : 2, text: 2 } });
    await issued(request()); const waiting = request();
    expect(await requestModelSlot(waiting)).toEqual({ kind: "deferred", reason: "capacity" });
    expect((await activeRows())).toHaveLength(1);
    expect((await admin`SELECT state FROM model_capacity_requests WHERE request_id=${waiting.requestId}`)[0].state).toBe("waiting");
  }));
}

it("uses explicit shared alias groups while skipping a capacity-unfit head in the same class", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 3,
    providerLimits: { account: 1, other: 2 }, groupLimits: { shared: 1, independent: 2 },
    poolLimits: { reviewer: 3, text: 3 }, routes: [...policy.routes,
      { routeId: "alias", provider: "other-provider", model: "different-alias", providerBudgetId: "other", groupId: "shared" },
      { routeId: "independent", provider: "other-provider", model: "independent-model", providerBudgetId: "other", groupId: "independent" }] });
  await issued(request());
  const blocked = request({ routeId: "alias", provider: "other-provider", model: "different-alias" });
  expect(await requestModelSlot(blocked)).toEqual({ kind: "deferred", reason: "capacity" });
  const free = request({ routeId: "independent", provider: "other-provider", model: "independent-model" });
  await issued(free);
  expect((await activeRows()).map(row => row.group_id)).toEqual(["shared", "independent"]);
  expect((await admin`SELECT state FROM model_capacity_requests WHERE request_id=${blocked.requestId}`)[0].state).toBe("waiting");
}));

it("loans an idle review share to background work and applies pool limits without class aliasing", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 3, providerLimits: { account: 3 }, groupLimits: { shared: 3 },
    poolLimits: { reviewer: 1, text: 2 } });
  await issued(request());
  expect(await requestModelSlot(request({ class: "second" }))).toEqual({ kind: "deferred", reason: "capacity" });
  await issued(request({ class: "background", pool: "text" }));
  await issued(request({ class: "background", pool: "text" }));
  expect((await activeRows()).map(row => row.pool)).toEqual(["reviewer", "text", "text"]);
}));

it("grants one queued row per poll in weighted order, preserves class FIFO, and returns no foreign token", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 1 });
  const blocker = await issued(request({ class: "background" }));
  const queued = [request(), request(), request(), request(), request({ class: "second" }),
    request({ class: "second" }), request({ class: "background" }), request({ class: "background" })];
  for (const value of queued) expect(await requestModelSlot(value)).toEqual({ kind: "deferred", reason: "capacity" });
  expect((await admin`SELECT cursor FROM model_capacity_control WHERE id=1`)[0].cursor).toBe(0);
  expect(await cancelReservedModelSlot(blocker)).toBe(true);
  const classes: string[] = [], ids: string[] = [];
  for (let index = 0; index < queued.length; index++) {
    const [waiting] = await admin`SELECT request_id FROM model_capacity_requests WHERE state='waiting' ORDER BY queue_ordinal DESC LIMIT 1`;
    const polled = requests.get(waiting.request_id)!;
    const outcome = await requestModelSlot(polled), active = await activeRows();
    expect(active).toHaveLength(1);
    const granted = active[0]; classes.push(granted.class); ids.push(granted.request_id);
    if (granted.request_id !== polled.requestId) expect(outcome).toEqual({ kind: "deferred", reason: "capacity" });
    else expect(outcome).toMatchObject({ kind: "granted", reservation: { requestId: polled.requestId } });
    const own = await issued(requests.get(granted.request_id)!);
    expect(await cancelReservedModelSlot(own)).toBe(true);
  }
  expect(classes).toEqual(["first", "first", "second", "background", "first", "first", "second", "background"]);
  expect(ids).toEqual([queued[0], queued[1], queued[4], queued[6], queued[2], queued[3], queued[5], queued[7]].map(value => value.requestId));
}));

it("grants at most one waiting row per poll even when several slots are spare", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 3, providerLimits: { account: 3 },
    groupLimits: { shared: 3 }, poolLimits: { reviewer: 3, text: 3 } });
  const occupied = await Promise.all([request(), request(), request()].map(value => issued(value)));
  const waiting = [request(), request(), request()];
  for (const value of waiting) expect(await requestModelSlot(value)).toEqual({ kind: "deferred", reason: "capacity" });
  for (const reservation of occupied) expect(await cancelReservedModelSlot(reservation)).toBe(true);
  expect(await requestModelSlot(waiting[2])).toEqual({ kind: "deferred", reason: "capacity" });
  expect((await activeRows()).map(row => row.request_id)).toEqual([waiting[0].requestId]);
  expect((await admin`SELECT request_id FROM model_capacity_requests WHERE state='waiting' ORDER BY queue_ordinal`).map(row => row.request_id))
    .toEqual([waiting[1].requestId, waiting[2].requestId]);
}));

it("bounds waiting rows and refuses a second live request identity for the same owner work", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 1, maxWaiting: 1 });
  const running = request(); await issued(running);
  const duplicate = request({ workKey: running.workKey });
  expect(await requestModelSlot(duplicate)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${duplicate.requestId}`).toEqual([]);
  const waiting = request(); expect(await requestModelSlot(waiting)).toEqual({ kind: "deferred", reason: "capacity" });
  const overflow = request(); expect(await requestModelSlot(overflow)).toEqual({ kind: "deferred", reason: "queue_full" });
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${overflow.requestId}`).toEqual([]);
  expect((await admin`SELECT count(*)::int AS n FROM model_capacity_requests WHERE state='waiting'`)[0].n).toBe(1);
}));

it("never queues disabled, draining, or unmapped new requests", exercise(async () => {
  await installPolicy();
  const unmapped = request({ model: "unconfigured-model" });
  expect(await requestModelSlot(unmapped)).toEqual({ kind: "deferred", reason: "unmapped" });
  await admin`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
  const draining = request(); expect(await requestModelSlot(draining)).toEqual({ kind: "deferred", reason: "draining" });
  expect(await admin`SELECT request_id FROM model_capacity_requests`).toEqual([]);
  expect(await admin`SELECT id FROM model_capacity_events`).toEqual([]);
}));

it("withdraws expired reservations once, denies their late begin, and grants the freed slot", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 1 });
  const expired = request(), old = await issued(expired);
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()-interval '1 millisecond' WHERE request_id=${expired.requestId}`;
  });
  expect(await beginModelDispatch(old)).toEqual({ kind: "ownership_lost" });
  expect(await requestModelSlot(expired)).toEqual({ kind: "deferred", reason: "withdrawn" });
  expect(await cancelReservedModelSlot(old)).toBe(false);
  await issued(request());
  expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${expired.requestId} ORDER BY id`).map(row => row.kind))
    .toEqual(["queued", "reserved", "reservation_expired"]);
}));

it("withdraws an expired waiting request without issuing a token", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 1 }); await issued(request());
  const waiting = request(); expect(await requestModelSlot(waiting)).toEqual({ kind: "deferred", reason: "capacity" });
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`UPDATE model_capacity_requests SET queue_until=clock_timestamp()-interval '1 millisecond' WHERE request_id=${waiting.requestId}`;
  });
  expect(await requestModelSlot(waiting)).toEqual({ kind: "deferred", reason: "withdrawn" });
  expect((await admin`SELECT state,token,reserved_until FROM model_capacity_requests WHERE request_id=${waiting.requestId}`)[0])
    .toEqual({ state: "withdrawn", token: null, reserved_until: null });
  expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${waiting.requestId} ORDER BY id`).map(row => row.kind))
    .toEqual(["queued", "wait_expired"]);
}));

it("does not reinterpret stale waiting identity under a replacement policy", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 1 });
  const occupied = await issued(request()), waiting = request();
  expect(await requestModelSlot(waiting)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await cancelReservedModelSlot(occupied)).toBe(true);
  const replacement = { ...policy, globalLimit: 1, groupLimits: { renamed: 2 },
    routes: policy.routes.map(route => ({ ...route, groupId: "renamed" })) };
  await installPolicy(replacement);
  await admin`UPDATE model_capacity_control SET revision=revision+1 WHERE id=1`;
  expect(await requestModelSlot(waiting)).toEqual({ kind: "deferred", reason: "withdrawn" });
  const [row] = await admin`SELECT group_id,policy_hash,state FROM model_capacity_requests WHERE request_id=${waiting.requestId}`;
  expect(row).toEqual({ group_id: "shared", policy_hash: modelCapacityPolicyHash({ ...policy, globalLimit: 1 }), state: "withdrawn" });
  expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${waiting.requestId} ORDER BY id`).map(row => row.kind))
    .toEqual(["queued", "policy_changed"]);
  await issued(request());
}));

it("retains dispatched unknown occupancy through expiry and policy renaming", exercise(async () => {
  await installPolicy({ ...policy, globalLimit: 1 });
  const value = request(), reservation = await issued(value), begun = await beginModelDispatch(reservation);
  expect(begun.kind).toBe("dispatched"); if (begun.kind !== "dispatched") throw new Error("fixture_dispatch_not_issued");
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()-interval '1 hour' WHERE request_id=${value.requestId}`;
  });
  const replacement = { ...policy, globalLimit: 1, groupLimits: { renamed: 2 },
    routes: policy.routes.map(route => ({ ...route, groupId: "renamed" })) };
  await installPolicy(replacement); await admin`UPDATE model_capacity_control SET epoch=epoch+1,revision=revision+1 WHERE id=1`;
  expect(await markModelDispatchIndeterminate(begun.dispatch, "transport_unknown")).toBe(true);
  expect(await markModelDispatchIndeterminate(begun.dispatch, "transport_unknown")).toBe(true);
  expect(await cancelReservedModelSlot(reservation)).toBe(false);
  const next = request(); expect(await requestModelSlot(next)).toEqual({ kind: "deferred", reason: "policy_changed" });
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${next.requestId}`).toEqual([]);
  expect((await activeRows()).map(row => row.request_id)).toEqual([value.requestId]);
  expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${value.requestId} ORDER BY id`).map(row => row.kind))
    .toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate"]);
}));
