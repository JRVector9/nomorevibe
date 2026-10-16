import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { modelCapacityPolicyHash, crawlTaglineMemberKeys, crawlTaglineGenerationHash, crawlTaglineLogicalWorkKey,
  crawlTaglineInputHash, crawlTaglineDispatchBindingHash, crawlTaglineGatewayTerminalEvidenceSchema,
  reasonTranslationMemberKeys, reasonTranslationLogicalWorkKey, reasonTranslationInputHash, reasonTranslationDispatchBindingSchema,
  productTranslationMemberKeys, productTranslationLogicalWorkKey, productTranslationInputHash, productTranslationDispatchBindingSchema,
  productTaglineKoMemberKeys, productTaglineKoLogicalWorkKey, productTaglineKoInputHash, productTaglineKoDispatchBindingSchema,
  type ModelCapacityPolicy, type ModelCapacityRequest, type ModelCapacityRequestIdentity, type ModelCapacityReservation,
  type ModelSlotResult, type CrawlTaglineInput, type CrawlTaglineDispatchBinding, type CrawlTaglineModelDispatch,
  type CrawlTaglineGatewayTerminalEvidence, type CrawlTaglineOutcome } from "@/lib/llm/capacity";
import { requestModelSlot, requestCrawlTaglineModelSlot, findOwnPendingModelRequest, cancelReservedModelSlot,
  lockCrawlTaglineModelCapacityDispatch, finishCrawlTaglineModelCapacityDispatch, reconcileCrawlTaglineGatewayTerminal,
  readCrawlTaglineContinuation, beginModelDispatch, markModelDispatchIndeterminate } from "@/lib/llm/capacity-repository";
import type { CrawlTaglineGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// 실제 PostgreSQL ledger 전용. Native 발급 경계만 fixture이며 provider/domain/role/job 권한을 주장하지 않는다.
const native = vi.hoisted(() => ({ evidence: new WeakMap<object, unknown>() }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ readCrawlTaglineGatewayTerminal: (value: unknown) =>
  value && typeof value === "object" ? native.evidence.get(value) ?? null : null }));
if (process.env.TEST_DATABASE_URL !== TEST_DATABASE_URL) throw new Error("crawl_tagline_ledger_test_database_required");
type Raw = Record<string, unknown>;
type Whole = Record<string, unknown>;
const prefix = `crawl-ledger-${randomUUID().slice(0, 12)}`, modelA = "crawl-ledger-a", modelB = "crawl-ledger-b";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
const planned = new Map<string, ModelCapacityRequest>(), committed = new Map<string, ModelCapacityRequest>();
const plannedMembers = new Map<string, readonly string[] | null>();
let initial: Whole, initialCatalog: Whole, originalControl: Raw, setupWork: Promise<void> | undefined, cleaning: Promise<void> | undefined;
let captured = false;
const hashes = ["a", "b", "c", "d"].map(value => value.repeat(64));
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [
    ...[modelA, modelB].map(model => ({ routeId: "crawl-tagline", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" })),
    { routeId: "crawl-ledger-busy", provider: "fixture", model: modelA, providerBudgetId: "account", groupId: "engine" }] };
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
  if (errors.length) throw new AggregateError(errors, "crawl_tagline_ledger_fixture_cleanup_failed", { cause: errors[0] });
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
function input(candidateId = 21, model = modelA): CrawlTaglineInput {
  return { member: { candidateId, repo: `owner/project-${candidateId}`, sourceHash: hashes[0],
    candidateRowIdentityHash: hashes[1], documentRowIdentityHash: hashes[2], cache: { kind: "absent" } }, model, askOrdinal: 1, parent: null };
}
async function request(value?: CrawlTaglineInput, unbound = false): Promise<ModelCapacityRequest> {
  const result: ModelCapacityRequest = { requestId: randomUUID(), owner: { instanceId: `${prefix}-${randomUUID().slice(0, 8)}`, bootId: randomUUID() },
    workKey: value ? `${crawlTaglineLogicalWorkKey(value)}:${crawlTaglineInputHash(value)}` : randomUUID(), class: "background", pool: "text",
    routeId: value || unbound ? "crawl-tagline" : "crawl-ledger-busy", provider: value || unbound ? "abcllm" : "fixture", model: value?.model ?? modelA };
  expect(await rawRequest(result.requestId)).toBeUndefined(); expect(await rawEvents(result.requestId)).toEqual([]);
  planned.set(result.requestId, structuredClone(result)); plannedMembers.set(result.requestId, value ? crawlTaglineMemberKeys(value.member) : null);
  return result;
}
function identity(value: ModelCapacityRequest): ModelCapacityRequestIdentity {
  const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result;
}
function ask(value: ModelCapacityRequest, data?: CrawlTaglineInput): Promise<ModelSlotResult> {
  const snapshot = structuredClone(value), checked = data && structuredClone(data);
  return tracked((async () => {
    const result = await tracked(checked ? requestCrawlTaglineModelSlot(snapshot, checked) : requestModelSlot(snapshot));
    const row = await rawRequest(snapshot.requestId);
    if (row) { sameIdentity(row, snapshot); committed.set(snapshot.requestId, snapshot); }
    return result;
  })());
}
function granted(value: ModelSlotResult): ModelCapacityReservation {
  expect(value.kind).toBe("granted"); if (value.kind !== "granted") throw new Error("crawl_tagline_ledger_reservation_required");
  return value.reservation;
}
function binding(value: ModelCapacityRequest, data: CrawlTaglineInput): CrawlTaglineDispatchBinding {
  return { ...structuredClone(data), kind: "crawl_tagline_gateway", version: 1, generationHash: crawlTaglineGenerationHash(data),
    logicalWorkKey: crawlTaglineLogicalWorkKey(data), inputHash: crawlTaglineInputHash(data), provider: "abcllm", routeId: "crawl-tagline",
    wireHash: hashes[0], servingContractHash: hashes[1], totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: "crawl-tagline", token: randomUUID(), requestedVersion: 1 }, role: { role: "text", instanceId: value.owner.instanceId,
      bootId: value.owner.bootId, release: "ledger-fixture", kind: "primary", epoch: 1, batch: { mode: "legacy" } } };
}
async function finish(value: ModelCapacityRequest, data: CrawlTaglineInput, reservation: ModelCapacityReservation,
  bound = binding(value, data)): Promise<CrawlTaglineModelDispatch> {
  return tracked(db.transaction(async tx => {
    const lock = await lockCrawlTaglineModelCapacityDispatch(tx, { reservation, identity: identity(value), input: data });
    expect(lock).not.toBeNull(); if (!lock) throw new Error("crawl_tagline_ledger_dispatch_lock_required");
    return finishCrawlTaglineModelCapacityDispatch(tx, lock, bound);
  }));
}
async function dispatch(value: ModelCapacityRequest, data: CrawlTaglineInput) {
  return finish(value, data, granted(await ask(value, data)));
}
function terminal(value: CrawlTaglineModelDispatch, outcome: CrawlTaglineOutcome = { ok: true, tagline: "", source: "page" }) {
  const evidence = crawlTaglineGatewayTerminalEvidenceSchema.parse({ version: 1, kind: "crawl_tagline_gateway_terminal", dispatch: value,
    finishReason: "stop", responseHash: hashes[3], actualUsage: { inputTokens: 120, outputTokens: 3, totalTokens: 123 },
    provenance: "upstream_reported", outcome });
  const opaque = Object.freeze({ fixture: randomUUID() }) as unknown as CrawlTaglineGatewayTerminal;
  native.evidence.set(opaque, structuredClone(evidence)); return { opaque, evidence };
}
function parent(value: CrawlTaglineGatewayTerminalEvidence) {
  return { requestId: value.dispatch.requestId, bindingHash: value.dispatch.bindingHash, responseHash: value.responseHash };
}
async function rollback(load: (tx: postgres.TransactionSql) => Promise<void>) {
  const sentinel = new Error("crawl_tagline_ledger_intentional_rollback");
  try { await tracked(admin.begin(async tx => { await load(tx); throw sentinel; })); }
  catch (error) { if (error !== sentinel) throw error; }
}
function pgFailure(error: unknown): { code?: string; constraint_name?: string; message?: string } {
  const seen = new Set<unknown>(); let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") return { code: current.code,
      constraint_name: "constraint_name" in current && typeof current.constraint_name === "string" ? current.constraint_name : undefined,
      message: "message" in current && typeof current.message === "string" ? current.message : undefined };
    current = "cause" in current ? current.cause : null;
  }
  throw new Error("crawl_tagline_ledger_expected_pg_error", { cause: error });
}
async function insertRaw(tx: postgres.TransactionSql, base: Raw, overrides: Raw, decimal = false) {
  let text = JSON.stringify({ ...base, ...overrides });
  if (decimal) {
    expect(text.match(/"askOrdinal":1(?=[,}])/g)).toHaveLength(1);
    text = text.replace(/"askOrdinal":1(?=[,}])/, '"askOrdinal":1.0');
  }
  return tx`INSERT INTO model_capacity_requests SELECT (r).* FROM jsonb_populate_record(NULL::model_capacity_requests,
    ${text}::text::jsonb || jsonb_build_object('queue_ordinal',nextval('model_capacity_requests_queue_ordinal_seq'))) r
    RETURNING request_id,dispatch_binding->'askOrdinal' AS ordinal,(dispatch_binding->'askOrdinal')::text AS ordinal_text`;
}
async function sequences() {
  return Array.from(await admin`SELECT schemaname,sequencename,last_value FROM pg_sequences
    WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,sequencename`);
}
let initialSequences: unknown;
beforeAll(() => {
  setupWork = tracked(Promise.resolve().then(async () => {
    const globals = globalThis as { pgClient?: postgres.Sql; db?: unknown };
    expect(globals.pgClient).toBeUndefined(); expect(globals.db).toBeUndefined(); vi.stubEnv("DB_POOL_MAX", "2"); ensureSchema();
    const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toContain("0091_model_capacity_crawl_tagline_terminal");
    const migrations = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(migrations[0].count).toBe(journal.entries.length);
    const indexes = await admin`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='model_capacity_requests_crawl_tagline_phase_idx'`;
    expect(indexes).toHaveLength(1); expect(indexes[0].indexdef).toContain("dispatch_binding -> 'askOrdinal'::text");
    initial = await whole(); initialCatalog = await catalog(); initialSequences = await sequences();
    expect(initial.model_capacity_requests).toEqual([]); expect(initial.model_capacity_events).toEqual([]);
    const controls = initial.model_capacity_control as Raw[]; expect(controls).toHaveLength(1); originalControl = controls[0];
    expect(originalControl).toMatchObject({ id: 1, mode: "disabled", epoch: 1, revision: 1, policy: null, policy_hash: null, cursor: 0 });
    captured = true; console.info("crawl_tagline_ledger_migrations", { journal: journal.entries.length, applied: migrations[0].count, indexes });
  }), hooks); return setupWork;
});
afterEach(() => tracked(steps([async () => { await setupWork; }, () => drain(exercises), () => drain(work), cleanup]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => drain(hooks), () => drain(exercises), () => drain(work), cleanup,
  async () => { if (captured) {
    expect(await whole()).toEqual(initial); expect(await catalog()).toEqual(initialCatalog);
    const evidence = { before: initialSequences, after: await sequences(), wholeRestored: true, catalogRestored: true };
    writeFileSync("/tmp/nomorevibe-pr05b11-lane-b-cleanup-20261017.json", JSON.stringify(evidence, null, 2) + "\n");
    console.info("crawl_tagline_ledger_owned_rows_and_catalog_restored");
  } }, async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end({ timeout: 5 }); },
  async () => { await admin.end({ timeout: 5 }); }, async () => { vi.unstubAllEnvs(); }]));

it("stores the stable target in the first waiting INSERT and polls the same ID without a second event", exercise(async () => {
  await install({ ...policy, globalLimit: 1 }); const busy = await request(), occupied = granted(await ask(busy));
  const data = input(), waiting = await request(data);
  expect(await ask(waiting, data)).toEqual({ kind: "deferred", reason: "capacity" });
  const before = await rawRequest(waiting.requestId), events = await rawEvents(waiting.requestId);
  expect(before).toMatchObject({ state: "waiting", token: null, reserved_until: null, logical_member_keys: ["crawl-tagline:21"],
    logical_work_key: crawlTaglineLogicalWorkKey(data), dispatch_binding: null });
  expect(await tracked(findOwnPendingModelRequest(identity(waiting)))).toEqual({ requestId: waiting.requestId, state: "waiting" });
  expect(await ask(waiting, structuredClone(data))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(waiting.requestId)).toEqual(before); expect(await rawEvents(waiting.requestId)).toEqual(events);
  await expect(tracked(requestCrawlTaglineModelSlot({ ...waiting, owner: { ...waiting.owner, bootId: randomUUID() } }, data)))
    .rejects.toThrow("model_capacity_request_identity_mismatch");
  const changed = { ...data, model: modelB, member: { ...data.member, sourceHash: hashes[3] } }, foreign = await request(changed);
  expect(await ask(foreign, changed)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(foreign.requestId)).toBeUndefined(); expect(await rawEvents(foreign.requestId)).toEqual([]);
  expect(await tracked(cancelReservedModelSlot(occupied))).toBe(true);
  const reservation = granted(await ask(waiting, data)); expect(granted(await ask(waiting, data))).toEqual(reservation);
  expect(await rawRequest(waiting.requestId)).toMatchObject({ state: "reserved", queue_ordinal: before!.queue_ordinal,
    logical_member_keys: before!.logical_member_keys });
}));

it.each(["same-generation", "changed-generation"] as const)("serializes %s actors on two observed PostgreSQL backends", exerciseRace);
function exerciseRace(mode: "same-generation" | "changed-generation") {
  return tracked(Promise.resolve().then(async () => {
    await install(); const leftInput = input(), rightInput: CrawlTaglineInput = mode === "same-generation"
      ? { ...leftInput, member: { ...leftInput.member, candidateRowIdentityHash: hashes[3], documentRowIdentityHash: hashes[1] } }
      : { ...leftInput, model: modelB, member: { ...leftInput.member, repo: "owner/changed", sourceHash: hashes[3],
        cache: { kind: "present", rowIdentityHash: hashes[2], attempts: 7 } } };
    expect(crawlTaglineGenerationHash(rightInput) === crawlTaglineGenerationHash(leftInput)).toBe(mode === "same-generation");
    const left = await request(leftInput), right = await request(rightInput), ready = latch(), release = latch();
    const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, connection: { application_name: `${prefix}-holder` } });
    let holderPid = 0, leftWork: Promise<ModelSlotResult> | undefined, rightWork: Promise<ModelSlotResult> | undefined;
    const errors: unknown[] = [];
    const holding = tracked(holder.begin(async tx => {
      await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
      holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0].pid; ready.resolve(); await release.promise;
    }));
    try {
      await Promise.race([ready.promise, holding.then(() => { throw new Error("crawl_tagline_ledger_holder_ended_before_ready"); })]);
      leftWork = ask(left, leftInput); rightWork = ask(right, rightInput); let blocked: Array<{ pid: number }> = [];
      const deadline = performance.now() + 2500;
      while (performance.now() < deadline) {
        blocked = Array.from(await tracked(admin<{ pid: number }[]>`WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${holderPid}=ANY(pg_blocking_pids(pid))
          UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database())
          SELECT pid FROM waiting ORDER BY pid`));
        if (blocked.length === 2) break;
        await Promise.race([new Promise(resolve => setTimeout(resolve, 10)),
          leftWork.then(value => { throw new Error("crawl_tagline_ledger_left_ended_before_blocking", { cause: value }); }),
          rightWork.then(value => { throw new Error("crawl_tagline_ledger_right_ended_before_blocking", { cause: value }); })]);
      }
      expect(blocked).toHaveLength(2); expect(new Set(blocked.map(row => row.pid)).size).toBe(2);
      const packet = { mode, holderPid, waiterPids: blocked.map(row => row.pid) };
      writeFileSync(`/tmp/nomorevibe-pr05b11-lane-b-pids-${mode}-20261017.json`, JSON.stringify(packet, null, 2) + "\n");
      console.info("crawl_tagline_ledger_actual_wait", packet); release.resolve(); await holding;
      const results = await Promise.all([leftWork, rightWork]);
      expect(results.filter(value => value.kind === "granted")).toHaveLength(1);
      expect(results.filter(value => value.kind === "deferred")).toEqual([{ kind: "deferred", reason: "capacity" }]);
      const winnerIndex = results.findIndex(value => value.kind === "granted"), winner = winnerIndex === 0 ? left : right;
      const winningInput = winnerIndex === 0 ? leftInput : rightInput, loser = winnerIndex === 0 ? right : left;
      expect(await rawRequest(loser.requestId)).toBeUndefined(); expect(await rawEvents(loser.requestId)).toEqual([]);
      const owned = await finish(winner, winningInput, granted(results[winnerIndex])), proof = terminal(owned, { ok: true, tagline: "durable", source: "both" });
      expect(await tracked(reconcileCrawlTaglineGatewayTerminal(proof.opaque))).toEqual({ kind: "settled" });
      const refetch = { ...winningInput, member: { ...winningInput.member, candidateRowIdentityHash: hashes[0] } }, repeat = await request(refetch);
      expect(await ask(repeat, refetch)).toEqual({ kind: "deferred", reason: "capacity" });
      expect(await rawRequest(repeat.requestId)).toBeUndefined();
      const fresh = { ...winningInput, member: { ...winningInput.member, sourceHash: hashes[2] } }, next = await request(fresh);
      expect(await tracked(cancelReservedModelSlot(granted(await ask(next, fresh))))).toBe(true);
    } catch (error) { errors.push(error); }
    finally {
      release.resolve(); await steps([async () => { await holding; }, async () => {
        const settled = await Promise.allSettled([leftWork, rightWork].filter((value): value is Promise<ModelSlotResult> => !!value));
        const rejected = settled.filter(value => value.status === "rejected");
        if (rejected.length) throw new AggregateError(rejected.map(value => value.reason), "crawl_tagline_ledger_actor_failed");
      }, async () => { await holder.end({ timeout: 5 }); }], errors);
    }
  }), exercises);
}

it("requires an actual settled empty parent and revalidates its binding response and generation before phase2", exercise(async () => {
  await install(); const firstInput = input(), firstRequest = await request(firstInput), first = await dispatch(firstRequest, firstInput);
  const proof = terminal(first), second: CrawlTaglineInput = { ...firstInput, askOrdinal: 2, parent: parent(proof.evidence) };
  const invalid = async (value: CrawlTaglineInput) => {
    const attempt = await request(value);
    await expect(ask(attempt, value)).rejects.toThrow("crawl_tagline_parent_mismatch");
    expect(await rawRequest(attempt.requestId)).toBeUndefined(); expect(await rawEvents(attempt.requestId)).toEqual([]);
  };
  await invalid(second); // shape-correct parent handle is insufficient while phase1 is dispatched.
  expect(await tracked(reconcileCrawlTaglineGatewayTerminal(proof.opaque))).toEqual({ kind: "settled" });
  const parentBefore = await rawRequest(firstRequest.requestId), parentEvents = await rawEvents(firstRequest.requestId);
  for (const changed of [{ ...second, parent: { ...second.parent!, requestId: randomUUID() } },
    { ...second, parent: { ...second.parent!, bindingHash: hashes[0] } }, { ...second, parent: { ...second.parent!, responseHash: hashes[1] } },
    { ...second, model: modelB }, ...[
      { ...second.member, candidateId: 22 }, { ...second.member, repo: "owner/renamed" }, { ...second.member, sourceHash: hashes[3] },
      { ...second.member, cache: { kind: "present" as const, rowIdentityHash: hashes[2], attempts: 7 } },
    ].map(member => ({ ...second, member }))]) await invalid(changed);
  expect(await rawRequest(firstRequest.requestId)).toEqual(parentBefore); expect(await rawEvents(firstRequest.requestId)).toEqual(parentEvents);
  const refetch = { ...second, member: { ...second.member, candidateRowIdentityHash: hashes[3], documentRowIdentityHash: hashes[0] } };
  const value = await request(refetch), reservation = granted(await ask(value, refetch)), before = await rawRequest(value.requestId);
  const changedEvidence = { ...proof.evidence, outcome: { ok: true as const, tagline: "nonempty", source: "page" as const } };
  try {
    expect(await tracked(admin`UPDATE model_capacity_requests SET terminal_evidence=${JSON.stringify(changedEvidence)}::text::jsonb,
      terminal_evidence_hash=${reviewHash(changedEvidence)} WHERE request_id=${first.requestId}::uuid RETURNING request_id`)).toHaveLength(1);
    await invalid(second);
    await expect(finish(value, refetch, reservation)).rejects.toThrow("crawl_tagline_parent_mismatch");
    expect(await rawRequest(value.requestId)).toEqual(before);
  } finally {
    expect(await tracked(admin`UPDATE model_capacity_requests SET terminal_evidence=${JSON.stringify(proof.evidence)}::text::jsonb,
      terminal_evidence_hash=${reviewHash(proof.evidence)} WHERE request_id=${first.requestId}::uuid RETURNING request_id`)).toHaveLength(1);
  }
  const forgedInput = { ...refetch, parent: { ...refetch.parent!, responseHash: hashes[1] } };
  await expect(finish(value, refetch, reservation, binding(value, forgedInput))).rejects.toThrow("crawl_tagline_capacity_dispatch_binding_mismatch");
  expect(await rawRequest(value.requestId)).toEqual(before);
  const secondDispatch = await finish(value, refetch, reservation), secondProof = terminal(secondDispatch, { ok: true, tagline: "complete", source: "readme" });
  expect(await tracked(reconcileCrawlTaglineGatewayTerminal(secondProof.opaque))).toEqual({ kind: "settled" });
  expect(await tracked(readCrawlTaglineContinuation(refetch))).toEqual({ generationHash: crawlTaglineGenerationHash(refetch),
    first: { ...parent(proof.evidence), outcome: proof.evidence.outcome }, second: { ...parent(secondProof.evidence), outcome: secondProof.evidence.outcome } });
}));

it("rolls back historical outcome and request settlement if the event insert fails in the same transaction", exercise(async () => {
  await install(); const data = input(), value = await request(data), owned = await dispatch(value, data);
  expect(await tracked(markModelDispatchIndeterminate(owned, "transport_unknown"))).toBe(true);
  const proof = terminal(owned, { ok: false, error: "invalid_output" }), before = await rawRequest(value.requestId), events = await rawEvents(value.requestId);
  await tracked(admin`UPDATE model_capacity_control SET mode='disabled',epoch=epoch+1,revision=revision+1,updated_at=clock_timestamp() WHERE id=1`);
  const fault = `crawl_ledger_fault_${randomUUID().replaceAll("-", "")}`; let faultInstalled = false;
  try {
    await tracked(admin.begin(async tx => {
      await tx.unsafe(`CREATE FUNCTION "${fault}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'crawl_tagline_fixture_event_failure'; RETURN NEW; END $$`);
      await tx.unsafe(`CREATE TRIGGER "${fault}" BEFORE INSERT ON model_capacity_events FOR EACH ROW
        WHEN (NEW.request_id='${value.requestId}'::uuid AND NEW.kind='dispatch_settled') EXECUTE FUNCTION "${fault}"()`);
    })); faultInstalled = true;
    let failure: unknown;
    try { await tracked(reconcileCrawlTaglineGatewayTerminal(proof.opaque)); } catch (error) { failure = error; }
    expect(pgFailure(failure)).toMatchObject({ code: "P0001", message: "crawl_tagline_fixture_event_failure" });
    expect(await rawRequest(value.requestId)).toEqual(before); expect(await rawEvents(value.requestId)).toEqual(events);
    expect(await tracked(readCrawlTaglineContinuation(data))).toBeNull();
  } finally {
    if (faultInstalled) await tracked(admin.begin(async tx => {
      await tx.unsafe(`DROP TRIGGER "${fault}" ON model_capacity_events`); await tx.unsafe(`DROP FUNCTION "${fault}"()`);
    }));
  }
  expect(await catalog()).toEqual(initialCatalog);
  expect(await tracked(reconcileCrawlTaglineGatewayTerminal(proof.opaque))).toEqual({ kind: "settled" });
  const settled = await rawRequest(value.requestId), settledEvents = await rawEvents(value.requestId);
  expect(settled).toMatchObject({ state: "settled", dispatch_binding: owned.binding, dispatch_binding_hash: owned.bindingHash,
    terminal_evidence: proof.evidence, terminal_evidence_hash: reviewHash(proof.evidence) });
  expect(settled!.settled_at).not.toBeNull();
  expect(settledEvents.filter(({ row }) => row.kind === "dispatch_settled")).toEqual([expect.objectContaining({ row: expect.objectContaining({
    from_state: "indeterminate", to_state: "settled", evidence: proof.evidence }) })]);
  expect(await tracked(reconcileCrawlTaglineGatewayTerminal(proof.opaque))).toEqual({ kind: "already_settled" });
  expect(await rawRequest(value.requestId)).toEqual(settled); expect(await rawEvents(value.requestId)).toEqual(settledEvents);
  expect(await tracked(readCrawlTaglineContinuation(data))).toEqual({ generationHash: crawlTaglineGenerationHash(data),
    first: { ...parent(proof.evidence), outcome: proof.evidence.outcome }, second: null });
  await expect(tracked(reconcileCrawlTaglineGatewayTerminal({ ...proof.opaque }))).rejects.toThrow("invalid_crawl_tagline_gateway_terminal");
  console.info("crawl_tagline_ledger_atomicity", { requestId: value.requestId, rollbackCode: "P0001", historicalSettlement: true });
}));

it("keeps the original binding and full C on unknown and fences a new target behind old unbound unknown", exercise(async () => {
  await install(); const data = input(), value = await request(data), owned = await dispatch(value, data);
  expect(await tracked(markModelDispatchIndeterminate(owned, "transport_unknown"))).toBe(true);
  const before = await rawRequest(value.requestId), events = await rawEvents(value.requestId);
  expect(before).toMatchObject({ state: "indeterminate", token: owned.token, dispatch_binding: owned.binding,
    dispatch_binding_hash: owned.bindingHash, terminal_evidence: null, terminal_evidence_hash: null, settled_at: null,
    logical_member_keys: crawlTaglineMemberKeys(data.member) });
  expect((before!.dispatch_binding as Raw).chargedTokens).toBe(8192); expect((before!.dispatch_binding as Raw).totalTokenBound).toBe(8192);
  const changed = { ...data, model: modelB, member: { ...data.member, sourceHash: hashes[3], repo: "owner/changed",
    cache: { kind: "present" as const, rowIdentityHash: hashes[2], attempts: 9 } } }, refused = await request(changed);
  expect(await ask(refused, changed)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(refused.requestId)).toBeUndefined(); expect(await rawEvents(refused.requestId)).toEqual([]);
  const separateInput = input(43), separate = await request(separateInput);
  expect(await tracked(cancelReservedModelSlot(granted(await ask(separate, separateInput))))).toBe(true);
  const legacy = await request(undefined, true), started = await tracked(beginModelDispatch(granted(await ask(legacy))));
  expect(started.kind).toBe("dispatched"); if (started.kind !== "dispatched") throw new Error("crawl_tagline_ledger_legacy_dispatch_required");
  expect(await tracked(markModelDispatchIndeterminate(started.dispatch, "transport_unknown"))).toBe(true);
  const legacyBefore = await rawRequest(legacy.requestId), legacyEvents = await rawEvents(legacy.requestId);
  expect(legacyBefore).toMatchObject({ state: "indeterminate", logical_work_key: null, logical_member_keys: null, dispatch_binding: null });
  const disjointInput = input(54, modelB), disjoint = await request(disjointInput);
  expect(await ask(disjoint, disjointInput)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await rawRequest(disjoint.requestId)).toBeUndefined(); expect(await rawEvents(disjoint.requestId)).toEqual([]);
  expect(await rawRequest(legacy.requestId)).toEqual(legacyBefore); expect(await rawEvents(legacy.requestId)).toEqual(legacyEvents);
  expect(await rawRequest(value.requestId)).toEqual(before); expect(await rawEvents(value.requestId)).toEqual(events);
}));

it("rejects ordinal JSON 1.0 as the same settled phase as JSON 1 with actual unique-index SQLSTATE 23505", exercise(async () => {
  await install(); const data = input(), value = await request(data), owned = await dispatch(value, data), proof = terminal(owned);
  expect(await tracked(reconcileCrawlTaglineGatewayTerminal(proof.opaque))).toEqual({ kind: "settled" });
  const base = (await rawRequest(value.requestId))!;
  expect((await tracked(admin`SELECT (dispatch_binding->'askOrdinal')::text AS ordinal FROM model_capacity_requests
    WHERE request_id=${value.requestId}::uuid`))[0].ordinal).toBe("1");
  const make = (other: CrawlTaglineInput) => {
    const candidate = { ...value, requestId: randomUUID(), owner: { instanceId: `${prefix}-raw-${randomUUID().slice(0, 8)}`, bootId: randomUUID() } };
    const bound = binding(candidate, other);
    return { request_id: candidate.requestId, owner_instance_id: candidate.owner.instanceId, owner_boot_id: candidate.owner.bootId,
      token: randomUUID(), state: "dispatched", work_key: `${bound.logicalWorkKey}:${bound.inputHash}`, logical_work_key: bound.logicalWorkKey,
      logical_member_keys: crawlTaglineMemberKeys(bound.member), dispatch_binding: bound, dispatch_binding_hash: crawlTaglineDispatchBindingHash(bound),
      terminal_evidence: null, terminal_evidence_hash: null, settled_at: null };
  };
  const before = await whole(); await rollback(async tx => {
    const control = await insertRaw(tx, base, make(input(32)), true);
    expect(control).toHaveLength(1); expect(control[0]).toMatchObject({ ordinal: 1, ordinal_text: "1.0" });
    let failure: unknown;
    try { await tx.savepoint(async savepoint => { await insertRaw(savepoint, base, make(data), true); }); } catch (error) { failure = error; }
    expect(pgFailure(failure)).toMatchObject({ code: "23505", constraint_name: "model_capacity_requests_crawl_tagline_phase_idx" });
    console.info("crawl_tagline_ledger_ordinal_uniqueness", { storedControl: control[0].ordinal_text, code: pgFailure(failure).code,
      constraint: pgFailure(failure).constraint_name });
  }); expect(await whole()).toEqual(before);
}));

it("accepts one INSERT plus terminal/event for each existing Korean product and reason kind after 0091", exercise(async () => {
  await install(); const data = input(), value = await request(data), owned = await dispatch(value, data), base = (await rawRequest(value.requestId))!;
  const common = { version: 1, model: modelA, provider: "abcllm", wireHash: hashes[0], servingContractHash: hashes[1],
    totalTokenBound: 8192, chargedTokens: 8192, role: owned.binding.role };
  const koreanMembers = [{ productId: 21, slug: "ledger-21", sourceIdentityHash: hashes[1], sourceHash: hashes[0],
    cache: { kind: "present" as const, rowIdentityHash: hashes[2], attempts: 13, qualityRejections: 7 } }];
  const productMembers = [{ productId: 21, slug: "ledger-21", locale: "en" as const, field: "tagline" as const, sourceHash: hashes[0],
    demand: { rowIdentityHash: hashes[2], attempts: 2 } }];
  const reasonMembers = [{ sourceHash: hashes[0], cache: { kind: "present" as const, rowIdentityHash: hashes[2], attempts: 13 } }];
  const controls = [
    { terminalKind: "product_tagline_ko_gateway_terminal", keys: productTaglineKoMemberKeys(koreanMembers), bound: productTaglineKoDispatchBindingSchema.parse({
      ...common, kind: "product_tagline_ko_gateway", routeId: "product-tagline-ko", members: koreanMembers,
      logicalWorkKey: productTaglineKoLogicalWorkKey(koreanMembers), inputHash: productTaglineKoInputHash({ members: koreanMembers, model: modelA }),
      job: { name: "product-tagline-ko", token: randomUUID(), requestedVersion: 1 } }) },
    { terminalKind: "product_translation_gateway_terminal", keys: productTranslationMemberKeys(productMembers), bound: productTranslationDispatchBindingSchema.parse({
      ...common, kind: "product_translation_gateway", routeId: "product-translate", members: productMembers,
      logicalWorkKey: productTranslationLogicalWorkKey(productMembers), inputHash: productTranslationInputHash({ members: productMembers, model: modelA }),
      job: { name: "product-translate", token: randomUUID(), requestedVersion: 1 } }) },
    { terminalKind: "reason_translation_gateway_terminal", keys: reasonTranslationMemberKeys(reasonMembers), bound: reasonTranslationDispatchBindingSchema.parse({
      ...common, kind: "reason_translation_gateway", routeId: "reason-translate", members: reasonMembers,
      logicalWorkKey: reasonTranslationLogicalWorkKey(reasonMembers), inputHash: reasonTranslationInputHash({ members: reasonMembers, model: modelA }),
      job: { name: "reason-translate", token: randomUUID(), requestedVersion: 1 } }) },
  ];
  const before = await whole(); await rollback(async tx => {
    for (const control of controls) {
      const id = randomUUID(), token = randomUUID(), bound = control.bound, bindingHash = reviewHash(bound);
      expect(await insertRaw(tx, base, { request_id: id, token, route_id: bound.routeId,
        work_key: `${bound.logicalWorkKey}:${bound.inputHash}`, logical_work_key: bound.logicalWorkKey, logical_member_keys: control.keys,
        dispatch_binding: bound, dispatch_binding_hash: bindingHash })).toHaveLength(1);
      const evidence = { version: 1, kind: control.terminalKind, dispatch: { requestId: id, owner: owned.owner, token,
        epoch: owned.epoch, revision: owned.revision, policyHash: owned.policyHash, binding: bound, bindingHash },
        finishReason: "stop", responseHash: hashes[3], actualUsage: null, provenance: "unknown" };
      expect(await tx`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(evidence)}::text::jsonb,
        terminal_evidence_hash=${reviewHash(evidence)},settled_at=clock_timestamp() WHERE request_id=${id}::uuid RETURNING request_id`).toHaveLength(1);
      expect(await tx`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,evidence)
        VALUES (${id}::uuid,'dispatch_settled',${owned.epoch},${owned.revision},${owned.policyHash},'dispatched','settled',
          ${JSON.stringify(evidence)}::text::jsonb) RETURNING id`).toHaveLength(1);
      console.info("crawl_tagline_ledger_old_kind_insert", bound.kind);
    }
  }); expect(await whole()).toEqual(before);
}));
