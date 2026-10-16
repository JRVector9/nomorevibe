import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { modelCapacityPolicyHash, productTaglineKoMemberKeys, productTaglineKoLogicalWorkKey,
  productTaglineKoInputHash, reasonTranslationInputHash, reasonTranslationLogicalWorkKey,
  type ModelCapacityPolicy, type ModelCapacityRequest, type ModelCapacityRequestIdentity,
  type ModelCapacityReservation, type ModelSlotResult, type ProductTaglineKoMember,
  type ProductTaglineKoDispatchBinding, type ProductTaglineKoModelDispatch,
  type ReasonTranslationMember, type ReasonTranslationDispatchBinding } from "@/lib/llm/capacity";
import { requestModelSlot, requestProductTaglineKoModelSlot, requestReasonTranslationModelSlot,
  findOwnPendingModelRequest, cancelReservedModelSlot, beginModelDispatch, markModelDispatchIndeterminate,
  lockProductTaglineKoModelCapacityDispatch, finishProductTaglineKoModelCapacityDispatch,
  lockReasonTranslationModelCapacityDispatch, finishReasonTranslationModelCapacityDispatch } from "@/lib/llm/capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// Fresh/exclusive ledger fixture only: no product/cache, real role/job, native POST or result writer.
type Raw = Record<string, unknown>;
type Whole = Record<string, unknown>;
type Batch = { kind: "product"; members: readonly ProductTaglineKoMember[] }
  | { kind: "reason"; members: readonly ReasonTranslationMember[] } | { kind: "busy" | "unbound" };
const prefix = `tagline-ko-ledger-${randomUUID().slice(0, 12)}`, modelA = "tagline-ko-ledger-a", modelB = "tagline-ko-ledger-b";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: prefix } });
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
const planned = new Map<string, ModelCapacityRequest>(), committed = new Map<string, ModelCapacityRequest>();
const plannedMembers = new Map<string, readonly string[] | null>();
let initial: Whole, initialCatalog: Whole, originalControl: Raw, setupWork: Promise<void> | undefined, cleaning: Promise<void> | undefined;
let captured = false;
const hashes = ["a", "b", "c", "d"].map(value => value.repeat(64));
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [
    ...[modelA, modelB].map(model => ({ routeId: "product-tagline-ko", provider: "abcllm", model,
      providerBudgetId: "account", groupId: "engine" })),
    { routeId: "reason-translate", provider: "abcllm", model: modelA, providerBudgetId: "account", groupId: "engine" },
    { routeId: "tagline-ko-ledger-busy", provider: "fixture", model: modelA, providerBudgetId: "account", groupId: "engine" }] };
function tracked<T>(pending: PromiseLike<T>, set = work): Promise<T> {
  // Drizzle queries are lazy thenables: assimilate once, retain that actual native Promise.
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
  if (errors.length) throw new AggregateError(errors, "tagline_ko_ledger_fixture_cleanup_failed", { cause: errors[0] });
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
async function catalog(tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Whole> {
  // Semantic catalog/ACL capture; physical pg_class counters and sequences are external readback deltas.
  return {
    schemas: Array.from(await tx`SELECT oid,nspname,nspowner,nspacl FROM pg_namespace
      WHERE nspname IN ('public','drizzle') ORDER BY oid`),
    relations: Array.from(await tx`SELECT c.oid,n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.reloptions,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') ORDER BY c.oid`),
    columns: Array.from(await tx`SELECT c.oid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl,
      pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname IN ('public','drizzle') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.oid,a.attnum`),
    constraints: Array.from(await tx`SELECT k.oid,k.conrelid,k.conname,k.convalidated,pg_get_constraintdef(k.oid,true) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','drizzle') ORDER BY k.oid`),
    triggers: Array.from(await tx`SELECT t.oid,t.tgrelid,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','drizzle') AND NOT t.tgisinternal ORDER BY t.oid`),
    functions: Array.from(await tx`SELECT p.oid,p.proname,p.proowner,p.prosecdef,p.proconfig,p.proacl,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle') AND p.prokind IN ('f','p') ORDER BY p.oid`),
    roles: Array.from(await tx`SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_roles ORDER BY oid`),
    database: Array.from(await tx`SELECT oid,datdba,datacl FROM pg_database WHERE datname=current_database()`),
    defaults: Array.from(await tx`SELECT oid,defaclrole,defaclnamespace,defaclobjtype,defaclacl FROM pg_default_acl ORDER BY oid`),
  };
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
  return (await tracked(tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE request_id=${id}::uuid`))[0]?.row;
}
async function rawEvents(id: string) {
  return Array.from(await tracked(admin`SELECT to_jsonb(e) AS row FROM model_capacity_events e
    WHERE request_id=${id}::uuid ORDER BY id`));
}
async function cleanupActual() {
  if (!captured) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...planned.keys()];
    const rows = await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r
      WHERE request_id=ANY(${ids}::uuid[]) ORDER BY queue_ordinal FOR UPDATE`;
    for (const { row } of rows) {
      // Planned-only or commit-ack-unknown rows are evidence, never adopted cleanup ownership.
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
    expect(await whole(tx)).toEqual(initial); expect(await catalog(tx)).toEqual(initialCatalog);
  });
  committed.clear(); planned.clear(); plannedMembers.clear();
}
function cleanup() {
  if (cleaning) return cleaning;
  const pending = cleanupActual(); cleaning = pending;
  void pending.then(() => { if (cleaning === pending) cleaning = undefined; }, () => {});
  return pending;
}
async function install(value = policy) {
  await tracked(admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)},cursor=0,updated_at=clock_timestamp() WHERE id=1`);
}
function members(...ids: number[]): ProductTaglineKoMember[] {
  return ids.map((productId, index) => ({ productId, slug: `ledger-${productId}`,
    sourceIdentityHash: hashes[index % hashes.length], sourceHash: hashes[(index + 1) % hashes.length],
    cache: index % 2 === 0 ? { kind: "absent" } : { kind: "present", rowIdentityHash: hashes[2], attempts: 13, qualityRejections: 7 } }));
}
async function request(batch: Batch, model = modelA): Promise<ModelCapacityRequest> {
  const value: ModelCapacityRequest = { requestId: randomUUID(), owner: { instanceId: `${prefix}-${randomUUID().slice(0, 8)}`, bootId: randomUUID() },
    workKey: batch.kind === "product" ? `${productTaglineKoLogicalWorkKey(batch.members)}:${productTaglineKoInputHash({ members: batch.members, model })}`
      : batch.kind === "reason" ? `${reasonTranslationLogicalWorkKey(batch.members)}:${reasonTranslationInputHash({ members: batch.members, model })}` : randomUUID(),
    class: "background", pool: "text", routeId: batch.kind === "reason" ? "reason-translate"
      : batch.kind === "busy" ? "tagline-ko-ledger-busy" : "product-tagline-ko",
    provider: batch.kind === "busy" ? "fixture" : "abcllm", model };
  expect(await rawRequest(value.requestId)).toBeUndefined(); expect(await rawEvents(value.requestId)).toEqual([]);
  planned.set(value.requestId, structuredClone(value));
  plannedMembers.set(value.requestId, batch.kind === "product" ? productTaglineKoMemberKeys(batch.members)
    : batch.kind === "reason" ? batch.members.map(member => `ko:${member.sourceHash}`).sort() : null);
  return value;
}
function identity(value: ModelCapacityRequest): ModelCapacityRequestIdentity {
  const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result;
}
function ask(value: ModelCapacityRequest, batch: Batch): Promise<ModelSlotResult> {
  const snapshot = structuredClone(value), checked = structuredClone(batch);
  return tracked((async () => {
    const result = await tracked(checked.kind === "product" ? requestProductTaglineKoModelSlot(snapshot, checked.members)
      : checked.kind === "reason" ? requestReasonTranslationModelSlot(snapshot, checked.members) : requestModelSlot(snapshot));
    const raw = await rawRequest(snapshot.requestId);
    if (raw) { sameIdentity(raw, snapshot); committed.set(snapshot.requestId, snapshot); }
    return result;
  })());
}
function granted(value: ModelSlotResult): ModelCapacityReservation {
  expect(value.kind).toBe("granted"); if (value.kind !== "granted") throw new Error("tagline_ko_ledger_reservation_required");
  return value.reservation;
}
function ownerBinding(value: ModelCapacityRequest) {
  return { instanceId: value.owner.instanceId, bootId: value.owner.bootId, release: "ledger-fixture", kind: "primary" as const,
    epoch: 1, batch: { mode: "legacy" as const } };
}
function binding(value: ModelCapacityRequest, batch: readonly ProductTaglineKoMember[]): ProductTaglineKoDispatchBinding {
  return { kind: "product_tagline_ko_gateway", version: 1, members: structuredClone(batch), model: value.model,
    logicalWorkKey: productTaglineKoLogicalWorkKey(batch), inputHash: productTaglineKoInputHash({ members: batch, model: value.model }),
    provider: "abcllm", routeId: "product-tagline-ko", wireHash: hashes[0], servingContractHash: hashes[1], totalTokenBound: 8192,
    chargedTokens: 8192, job: { name: "product-tagline-ko", token: randomUUID(), requestedVersion: 1 },
    role: { role: "text", ...ownerBinding(value) } };
}
async function dispatch(value: ModelCapacityRequest, batch: readonly ProductTaglineKoMember[]): Promise<ProductTaglineKoModelDispatch> {
  const reservation = granted(await ask(value, { kind: "product", members: batch }));
  return tracked(db.transaction(async tx => {
    const lock = await lockProductTaglineKoModelCapacityDispatch(tx, { reservation, identity: identity(value), members: batch });
    expect(lock).not.toBeNull(); if (!lock) throw new Error("tagline_ko_ledger_dispatch_lock_required");
    return finishProductTaglineKoModelCapacityDispatch(tx, lock, binding(value, batch));
  }));
}
beforeAll(() => {
  setupWork = tracked(Promise.resolve().then(async () => {
    expect(process.env.TEST_DATABASE_URL).toBe(TEST_DATABASE_URL);
    const globals = globalThis as { pgClient?: postgres.Sql; db?: unknown };
    expect(globals.pgClient).toBeUndefined(); expect(globals.db).toBeUndefined();
    vi.stubEnv("DB_POOL_MAX", "2"); ensureSchema(); initial = await whole(); initialCatalog = await catalog();
    expect(initial.model_capacity_requests).toEqual([]); expect(initial.model_capacity_events).toEqual([]);
    const controls = initial.model_capacity_control as Raw[];
    expect(controls).toHaveLength(1); originalControl = controls[0];
    expect(originalControl).toMatchObject({ id: 1, mode: "disabled", epoch: 1, revision: 1, policy: null, policy_hash: null, cursor: 0 });
    captured = true;
  }), hooks); return setupWork;
});
afterEach(() => tracked(steps([async () => { await setupWork; }, () => drain(exercises), () => drain(work), cleanup]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => drain(hooks), () => drain(exercises), () => drain(work), cleanup,
  async () => { if (captured) { expect(await whole()).toEqual(initial); expect(await catalog()).toEqual(initialCatalog); } },
  async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end({ timeout: 5 }); },
  async () => { await admin.end({ timeout: 5 }); }, async () => { vi.unstubAllEnvs(); }]));

it("owns stable targets in the first waiting INSERT and resumes the original same ID", exercise(async () => {
  await install({ ...policy, globalLimit: 1 });
  const busyBatch: Batch = { kind: "busy" }, busy = await request(busyBatch), busyHandle = granted(await ask(busy, busyBatch));
  const batch = members(21, 32), product: Batch = { kind: "product", members: batch }, waiting = await request(product);
  expect(await ask(waiting, product)).toEqual({ kind: "deferred", reason: "capacity" });
  const before = await rawRequest(waiting.requestId), events = await rawEvents(waiting.requestId);
  expect(before).toMatchObject({ state: "waiting", token: null, reserved_until: null,
    logical_member_keys: ["product-tagline-ko:21", "product-tagline-ko:32"],
    logical_work_key: productTaglineKoLogicalWorkKey(batch), dispatch_binding: null });
  expect(await tracked(findOwnPendingModelRequest(identity(waiting)))).toEqual({ requestId: waiting.requestId, state: "waiting" });
  const reversed: Batch = { kind: "product", members: [...batch].reverse() };
  expect(await ask(waiting, reversed)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(waiting.requestId)).toEqual(before); expect(await rawEvents(waiting.requestId)).toEqual(events);
  const changed: Batch = { kind: "product", members: [{ ...batch[0], slug: "next-generation", sourceIdentityHash: hashes[3], sourceHash: hashes[3],
    cache: { kind: "present", rowIdentityHash: hashes[3], attempts: 14, qualityRejections: 8 } }] };
  const foreign = await request(changed, modelB);
  expect(await ask(foreign, changed)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(foreign.requestId)).toBeUndefined(); expect(await rawEvents(foreign.requestId)).toEqual([]);
  expect(await tracked(cancelReservedModelSlot(busyHandle))).toBe(true);
  expect(granted(await ask(waiting, reversed)).requestId).toBe(waiting.requestId);
  expect(await rawRequest(waiting.requestId)).toMatchObject({ state: "reserved", queue_ordinal: before!.queue_ordinal,
    logical_member_keys: before!.logical_member_keys });
}));

it("serializes overlapping product targets on two actual blocked backends and grants a disjoint product", exercise(async () => {
  await install();
  const leftBatch = members(21, 32), rightBatch: ProductTaglineKoMember[] = [{ ...leftBatch[1], slug: "changed-generation", sourceIdentityHash: hashes[3], sourceHash: hashes[3],
    cache: { kind: "absent" } }, ...members(43)];
  const leftInput: Batch = { kind: "product", members: leftBatch }, rightInput: Batch = { kind: "product", members: rightBatch };
  const left = await request(leftInput), right = await request(rightInput, modelB), ready = latch(), release = latch();
  const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, connection: { application_name: `${prefix}-holder` } });
  let holderPid = 0, leftWork: Promise<ModelSlotResult> | undefined, rightWork: Promise<ModelSlotResult> | undefined;
  const handles: ModelCapacityReservation[] = [], errors: unknown[] = [];
  const holding = tracked(holder.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0].pid; ready.resolve(); await release.promise;
  }));
  try {
    await Promise.race([ready.promise, holding.then(() => { throw new Error("tagline_ko_ledger_holder_ended_before_ready"); })]);
    leftWork = ask(left, leftInput); rightWork = ask(right, rightInput);
    let blocked: Array<{ pid: number }> = [];
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      blocked = Array.from(await tracked(admin<{ pid: number }[]>`WITH RECURSIVE waiting(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${holderPid}=ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
          WHERE a.datname=current_database()) SELECT pid FROM waiting ORDER BY pid`));
      if (blocked.length === 2) break;
      await Promise.race([new Promise(resolve => setTimeout(resolve, 10)),
        leftWork.then(value => { throw new Error("tagline_ko_ledger_left_ended_before_blocking", { cause: value }); }),
        rightWork.then(value => { throw new Error("tagline_ko_ledger_right_ended_before_blocking", { cause: value }); })]);
    }
    expect(blocked).toHaveLength(2); expect(new Set(blocked.map(row => row.pid)).size).toBe(2);
    const packet = { holderPid, waiterPids: blocked.map(row => row.pid) };
    writeFileSync("/tmp/nomorevibe-pr05b10-b-actual-ledger-pid-graph-20261016.json", JSON.stringify(packet, null, 2) + "\n");
    console.info("tagline_ko_ledger_actual_wait", packet);
    release.resolve(); await holding;
    const results = await Promise.all([leftWork, rightWork]);
    expect(results.filter(result => result.kind === "granted")).toHaveLength(1);
    expect(results.filter(result => result.kind === "deferred")).toEqual([{ kind: "deferred", reason: "capacity" }]);
    for (const result of results) if (result.kind === "granted") handles.push(result.reservation);
    const winnerIndex = results.findIndex(result => result.kind === "granted"), loser = winnerIndex === 0 ? right : left;
    expect(await rawRequest(loser.requestId)).toBeUndefined(); expect(await rawEvents(loser.requestId)).toEqual([]);
    const disjoint: Batch = { kind: "product", members: members(54) }, separate = await request(disjoint);
    handles.push(granted(await ask(separate, disjoint)));
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
      if (rejected.length) throw new AggregateError(rejected, "tagline_ko_ledger_actor_failed");
    }, async () => { for (const handle of handles) expect(await tracked(cancelReservedModelSlot(handle))).toBe(true); },
    async () => { await holder.end({ timeout: 5 }); }], errors);
  }
}));

it("preserves unknown full C across changed identity and fences disjoint work behind old unbound dispatch", exercise(async () => {
  await install(); const batch = members(21, 32), product: Batch = { kind: "product", members: batch }, value = await request(product);
  const owned = await dispatch(value, batch);
  expect(await tracked(markModelDispatchIndeterminate(owned, "transport_unknown"))).toBe(true);
  const before = await rawRequest(value.requestId), events = await rawEvents(value.requestId);
  expect(before).toMatchObject({ state: "indeterminate", token: owned.token, dispatch_binding: { chargedTokens: 8192, totalTokenBound: 8192 } });
  const changed: Batch = { kind: "product", members: [{ ...batch[0], slug: "later-generation", sourceIdentityHash: hashes[3], sourceHash: hashes[3],
    cache: { kind: "present", rowIdentityHash: hashes[3], attempts: 15, qualityRejections: 9 } }] }, refused = await request(changed, modelB);
  expect(await ask(refused, changed)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(refused.requestId)).toBeUndefined(); expect(await rawEvents(refused.requestId)).toEqual([]);
  expect(await rawRequest(value.requestId)).toEqual(before); expect(await rawEvents(value.requestId)).toEqual(events);
  const separate: Batch = { kind: "product", members: members(43) }, separateValue = await request(separate);
  expect(await tracked(cancelReservedModelSlot(granted(await ask(separateValue, separate))))).toBe(true);
  const unbound: Batch = { kind: "unbound" }, generic = await request(unbound);
  const started = await tracked(beginModelDispatch(granted(await ask(generic, unbound))));
  expect(started.kind).toBe("dispatched"); if (started.kind !== "dispatched") throw new Error("tagline_ko_ledger_generic_dispatch_required");
  expect(await tracked(markModelDispatchIndeterminate(started.dispatch, "transport_unknown"))).toBe(true);
  const genericBefore = await rawRequest(generic.requestId), genericEvents = await rawEvents(generic.requestId);
  expect(genericBefore).toMatchObject({ state: "indeterminate", logical_work_key: null, logical_member_keys: null, dispatch_binding: null });
  const newDisjoint: Batch = { kind: "product", members: members(54) }, next = await request(newDisjoint, modelB);
  expect(await ask(next, newDisjoint)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(next.requestId)).toBeUndefined(); expect(await rawEvents(next.requestId)).toEqual([]);
  expect(await rawRequest(generic.requestId)).toEqual(genericBefore); expect(await rawEvents(generic.requestId)).toEqual(genericEvents);
  expect(await rawRequest(value.requestId)).toEqual(before); expect(await rawEvents(value.requestId)).toEqual(events);
}));

it("enforces actual 0090 nested cache CHECKs while preserving old reason dispatch and terminal branches", exercise(async () => {
  await install(); const batch = members(21, 22, 23, 24, 25, 26, 27, 28);
  const value = await request({ kind: "product", members: batch }), owned = await dispatch(value, batch);
  expect((await rawRequest(value.requestId))?.dispatch_binding).toMatchObject({ members: batch });
  expect(batch[1].cache).toMatchObject({ kind: "present", attempts: 13, qualityRejections: 7 });
  const reasonBatch: ReasonTranslationMember[] = [{ sourceHash: hashes[2], cache: { kind: "absent" } }];
  const reason = await request({ kind: "reason", members: reasonBatch });
  const reasonHandle = granted(await ask(reason, { kind: "reason", members: reasonBatch }));
  const reasonBinding: ReasonTranslationDispatchBinding = { kind: "reason_translation_gateway", version: 1, members: reasonBatch, model: modelA,
    logicalWorkKey: reasonTranslationLogicalWorkKey(reasonBatch), inputHash: reasonTranslationInputHash({ members: reasonBatch, model: modelA }),
    provider: "abcllm", routeId: "reason-translate", wireHash: hashes[0], servingContractHash: hashes[1], totalTokenBound: 8192,
    chargedTokens: 8192, job: { name: "reason-translate", token: randomUUID(), requestedVersion: 1 }, role: { role: "text", ...ownerBinding(reason) } };
  const old = await tracked(db.transaction(async tx => {
    const lock = await lockReasonTranslationModelCapacityDispatch(tx, { reservation: reasonHandle, identity: identity(reason), members: reasonBatch });
    expect(lock).not.toBeNull(); if (!lock) throw new Error("tagline_ko_ledger_old_reason_lock_required");
    return finishReasonTranslationModelCapacityDispatch(tx, lock, reasonBinding);
  }));
  const before = await whole(), rollback = new Error("tagline_ko_ledger_shape_control_rollback");
  try {
    await tracked(admin.begin(async tx => {
      const reject = async (write: (savepoint: postgres.TransactionSql) => PromiseLike<unknown>, id = value.requestId) => {
        const row = await rawRequest(id, tx); let failure: unknown;
        try { await tx.savepoint(async savepoint => { await write(savepoint); }); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: "23514" }); expect(await rawRequest(id, tx)).toEqual(row);
      };
      const keys = productTaglineKoMemberKeys(batch);
      for (const changed of [null, [keys[0], keys[0]], [...keys].reverse()]) await reject(savepoint => savepoint`
        UPDATE model_capacity_requests SET logical_member_keys=${changed}::text[] WHERE request_id=${value.requestId}::uuid`);
      await reject(savepoint => savepoint`UPDATE model_capacity_requests SET logical_member_keys=ARRAY[${keys.slice(0, 4)}::text[],${keys.slice(4)}::text[]] WHERE request_id=${value.requestId}::uuid`);
      await reject(savepoint => savepoint`UPDATE model_capacity_requests SET logical_member_keys=('[0:7]={' || array_to_string(${keys}::text[],',') || '}')::text[] WHERE request_id=${value.requestId}::uuid`);
      const missing = { ...owned.binding } as Record<string, unknown>; delete missing.members;
      const replaceMember = (index: number, change: Record<string, unknown>) => ({ ...owned.binding,
        members: batch.map((member, at) => at === index ? { ...member, ...change } : member) });
      for (const changed of [missing, { ...owned.binding, members: null }, { ...owned.binding, members: [] },
        { ...owned.binding, members: [...batch, ...members(99)] },
        { ...owned.binding, members: [batch[0], batch[0], ...batch.slice(2)] },
        replaceMember(0, { cache: { kind: "absent", extra: true } }),
        replaceMember(1, { cache: { kind: "present", attempts: 13, qualityRejections: 7 } }),
        replaceMember(1, { cache: { kind: "present", rowIdentityHash: hashes[2], attempts: -1, qualityRejections: 7 } }),
        replaceMember(1, { cache: { kind: "present", rowIdentityHash: hashes[2], attempts: 13, qualityRejections: Number.MAX_SAFE_INTEGER + 1 } }),
        replaceMember(0, { sourceIdentityHash: "invalid" }), replaceMember(0, { sourceHash: "invalid" }),
        { ...owned.binding, role: { ...owned.binding.role, bootId: randomUUID() } }, { ...owned.binding, chargedTokens: 1 }])
        await reject(savepoint => savepoint`UPDATE model_capacity_requests SET dispatch_binding=${JSON.stringify(changed)}::text::jsonb WHERE request_id=${value.requestId}::uuid`);
      const evidence = { version: 1, kind: "product_tagline_ko_gateway_terminal", dispatch: owned, finishReason: "length",
        responseHash: hashes[0], actualUsage: null, provenance: "unknown" };
      // Durable owner CHECK control only: JSON acceptance is never opaque native authority.
      expect(await tx`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(evidence)}::text::jsonb,
        terminal_evidence_hash=${reviewHash(evidence)},settled_at=clock_timestamp() WHERE request_id=${value.requestId}::uuid RETURNING request_id`).toHaveLength(1);
      const missingFinish = { ...evidence } as Record<string, unknown>; delete missingFinish.finishReason;
      for (const changed of [missingFinish, { ...evidence, responseHash: "invalid" }, { ...evidence, provenance: "upstream_reported",
        actualUsage: { inputTokens: 8192, outputTokens: 1, totalTokens: 8193 } }]) {
        await reject(savepoint => savepoint`UPDATE model_capacity_requests SET terminal_evidence=${JSON.stringify(changed)}::text::jsonb WHERE request_id=${value.requestId}::uuid`);
        await reject(savepoint => savepoint`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,evidence) VALUES
          (${value.requestId}::uuid,'dispatch_settled',${owned.epoch},${owned.revision},${owned.policyHash},'dispatched','settled',${JSON.stringify(changed)}::text::jsonb)`);
      }
      expect(await tx`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,evidence) VALUES
        (${value.requestId}::uuid,'dispatch_settled',${owned.epoch},${owned.revision},${owned.policyHash},'dispatched','settled',${JSON.stringify(evidence)}::text::jsonb) RETURNING id`).toHaveLength(1);
      const oldEvidence = { ...evidence, kind: "reason_translation_gateway_terminal", dispatch: old };
      expect(await tx`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(oldEvidence)}::text::jsonb,
        terminal_evidence_hash=${reviewHash(oldEvidence)},settled_at=clock_timestamp() WHERE request_id=${reason.requestId}::uuid RETURNING request_id`).toHaveLength(1);
      expect(await tx`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,evidence) VALUES
        (${reason.requestId}::uuid,'dispatch_settled',${old.epoch},${old.revision},${old.policyHash},'dispatched','settled',${JSON.stringify(oldEvidence)}::text::jsonb) RETURNING id`).toHaveLength(1);
      const invalidOld = { ...oldEvidence, provenance: "upstream_reported", actualUsage: { inputTokens: 8192, outputTokens: 1, totalTokens: 8193 } };
      await reject(savepoint => savepoint`UPDATE model_capacity_requests SET terminal_evidence=${JSON.stringify(invalidOld)}::text::jsonb WHERE request_id=${reason.requestId}::uuid`, reason.requestId);
      throw rollback;
    }));
  } catch (error) { if (error !== rollback) throw error; }
  expect(await whole()).toEqual(before);
}));
