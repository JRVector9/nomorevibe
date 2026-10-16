import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { PROFILE_MODEL } from "@/lib/domain/products/search-profile";
import { pendingProfiles, prepareProfileModelDispatch, type ProfileTask } from "@/lib/domain/products/search-profiles";
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { runJob, type JobContext } from "@/lib/jobs/runner";
import { jobsForRole } from "@/lib/jobs/catalog";
import { requestJob, type JobLease } from "@/lib/jobs/control";
import { releaseRole, tryAcquireRole, type RoleLease } from "@/lib/jobs/role-leader";
import { requestModelSlot, requestTextProfileModelSlot, cancelReservedModelSlot } from "@/lib/llm/capacity-repository";
import { modelCapacityPolicyHash, textProfileInputHash, type ModelCapacityPolicy, type ModelCapacityRequest,
  type ModelCapacityRequestIdentity } from "@/lib/llm/capacity";
import type { TextProfileServingContract } from "@/lib/llm/text-profile-serving-contract";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const serving = vi.hoisted(() => ({ contract: null as TextProfileServingContract | null }));
vi.mock("@/lib/llm/text-profile-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/text-profile-serving-contract")>(), resolveTextProfileServingContract: () => serving.contract,
}));
type Raw = Record<string, unknown>;
const prefix = `profile-native-${randomUUID().slice(0, 12)}`, jobName = "product-search-profile";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const managedJobs = jobsForRole("text"), ownerBoots = new Set<string>(), ownProducts = new Map<number, string>(), ownRequests = new Map<string, Raw>();
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
let initial: Record<string, unknown>, initialized = false, role: RoleLease, serial = 0, cleaning: Promise<void> | undefined;
const basePolicy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: jobName, provider: "abcllm", model: PROFILE_MODEL, providerBudgetId: "account", groupId: "engine" },
    { routeId: "crawl-agent-review", provider: "abcllm", model: PROFILE_MODEL, providerBudgetId: "account", groupId: "engine" }] };
const tracked = <T>(pending: Promise<T>, set = work): Promise<T> => { const actual = Promise.resolve(pending); set.add(actual); void actual.catch(() => {}); return actual; };
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), exercises);
async function drain(set: Set<Promise<unknown>>, report = false) {
  const errors: unknown[] = [];
  while (set.size) { const pending = [...set], results = await Promise.allSettled(pending);
    for (const promise of pending) set.delete(promise);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason); }
  if (report && errors.length) throw new AggregateError(errors, "profile_fixture_pending_failure");
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "profile_fixture_cleanup_failed", { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  } return result;
}
function baseline(table: string): Raw[] { return initial[table] as Raw[]; }
async function restore(tx: postgres.TransactionSql, table: "model_capacity_control" | "role_leases" | "jobs" | "operations_observations", key: string, value: string | number) {
  const saved = baseline(table).find(row => row[key] === value);
  const [current] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE "${key}"=$1 FOR UPDATE`, [value]);
  if (!current) { expect(saved).toBeUndefined(); return; }
  if (!saved) { expect(await tx.unsafe(`DELETE FROM ${table} t WHERE "${key}"=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING "${key}"`, [value, JSON.stringify(current.row)])).toHaveLength(1); return; }
  const columns = Object.keys(saved).map(name => '"' + name.replaceAll('"', '""') + '"').join(',');
  expect(await tx.unsafe(`UPDATE ${table} t SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::${table},$1::text::jsonb)) WHERE "${key}"=$2 AND to_jsonb(t)=$3::text::jsonb RETURNING "${key}"`,
    [JSON.stringify(saved), value, JSON.stringify(current.row)])).toHaveLength(1);
}
async function adoptRequests(tx: postgres.TransactionSql) {
  const rows = await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r ORDER BY queue_ordinal FOR UPDATE`;
  for (const { row } of rows) {
    expect(row.owner_instance_id).toBe(prefix); expect(ownerBoots.has(row.owner_boot_id)).toBe(true);
    if (row.route_id === jobName) {
      expect(row.class).toBe("background"); expect(row.pool).toBe("text");
      expect([...ownProducts.keys()].some(id => row.logical_work_key === `text:profile:${id}`)).toBe(true);
    } else expect(ownRequests.has(row.request_id)).toBe(true);
    ownRequests.set(row.request_id, row);
  }
}
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const [currentRole] = await tx`SELECT * FROM role_leases WHERE role='text' FOR UPDATE`;
    if (currentRole?.owner_instance_id !== null && currentRole?.owner_instance_id !== undefined) {
      expect(currentRole.owner_instance_id).toBe(prefix); expect(ownerBoots.has(currentRole.owner_boot_id)).toBe(true);
    }
    // This dedicated fresh/exclusive fixture protects live replacement owners; it does not park foreign idle work.
    const currentJobs = await tx`SELECT * FROM jobs WHERE name=ANY(${managedJobs}::text[]) ORDER BY name FOR UPDATE`;
    for (const job of currentJobs.filter(row => row.lease_token !== null)) {
      // Only the late-terminal case may leave this fixture's expired job token. TTL alone never proves transport end.
      expect(job.name).toBe(jobName);
      const [finished] = await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}
        AND state='settled' AND terminal_evidence IS NOT NULL AND dispatch_binding->'job'->>'token'=${job.lease_token}`;
      expect(finished).toBeDefined();
      expect((await tx`SELECT locked_at<clock_timestamp()-interval '90 seconds' AS expired FROM jobs WHERE name=${jobName}`)[0].expired).toBe(true);
    }
    await adoptRequests(tx); const ids = [...ownRequests.keys()];
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const guards = async () => Array.from(await tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`);
    expect(await guards()).toEqual([{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }]);
    const events = await tx`SELECT id::text,request_id,to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events e WHERE id=${event.id}::bigint AND request_id=${event.request_id}::uuid AND to_jsonb(e)=${JSON.stringify(event.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    expect(await guards()).toEqual([{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }]);
    for (const [id, row] of ownRequests) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${id}::uuid AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    for (const [id, slug] of ownProducts) {
      const [current] = await tx`SELECT to_jsonb(p) AS row FROM products p WHERE id=${id} AND slug=${slug} FOR UPDATE`;
      expect(current).toBeDefined(); expect(current.row.slug).toBe(slug);
      expect(await tx`SELECT id FROM product_audit_items WHERE product_id=${id}`).toEqual([]);
      expect(await tx`DELETE FROM products p WHERE id=${id} AND slug=${slug} AND to_jsonb(p)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      const purges = await tx`SELECT id,to_jsonb(c) AS row FROM cdn_purges c WHERE slug=${slug} FOR UPDATE`;
      for (const purge of purges) {
        expect(purge.row.reason).toBe("deleted"); expect(baseline("cdn_purges").some(row => row.id === purge.id || row.slug === slug)).toBe(false);
        expect(await tx`DELETE FROM cdn_purges c WHERE id=${purge.id} AND slug=${slug} AND to_jsonb(c)=${JSON.stringify(purge.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      }
    }
    await restore(tx, "model_capacity_control", "id", 1); await restore(tx, "role_leases", "role", "text");
    for (const name of managedJobs) await restore(tx, "jobs", "name", name);
    const observations = await tx`SELECT key FROM operations_observations WHERE key=${`job:${jobName}`} OR key=${`batch-result:${prefix}:${jobName}`} ORDER BY key FOR UPDATE`;
    for (const { key } of observations) await restore(tx, "operations_observations", "key", key);
    expect(await whole(tx)).toEqual(initial);
  });
  ownRequests.clear(); ownProducts.clear();
}
function cleanup() {
  if (cleaning) return cleaning; const pending = performCleanup(); cleaning = pending;
  const clear = () => { if (cleaning === pending) cleaning = undefined; }; void pending.then(clear, () => {}); return pending;
}
async function install(policy = basePolicy, mode = "open") {
  await admin`UPDATE model_capacity_control SET mode=${mode},policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}
async function elect() {
  const bootId = randomUUID(); ownerBoots.add(bootId);
  const acquired = await tracked(tryAcquireRole({ role: "text", instanceId: prefix, bootId, release: "local-profile-fixture", kind: "primary" }));
  expect(acquired).not.toBeNull(); if (!acquired) throw new Error("fixture_role_required"); role = acquired;
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "text", ROLE_LEASE_INSTANCE_ID: role.instanceId, ROLE_LEASE_BOOT_ID: role.bootId,
    ROLE_LEASE_RELEASE: role.release, ROLE_LEASE_EPOCH: String(role.epoch) })) vi.stubEnv(key, value);
  for (const key of ["ROLE_LEASE_BATCH_VERSION", "ROLE_LEASE_HOST", "ROLE_LEASE_BATCH_EPOCH"]) vi.stubEnv(key, undefined);
}
async function seed(): Promise<ProfileTask> {
  const slug = `${prefix}-${++serial}`;
  expect(await admin`SELECT id FROM products WHERE slug=${slug}`).toEqual([]); expect(await admin`SELECT id FROM cdn_purges WHERE slug=${slug}`).toEqual([]);
  const [row] = await tracked(db.insert(products).values({ slug, name: "Expense Demo", url: `https://${slug}.test`, tagline: "Track household expenses",
    description: "Track household expenses", category: "Productivity", status: "seeded", source: "crawler", verifyToken: "fixture", editTokenHash: "fixture" }).returning());
  ownProducts.set(row.id, slug); // registration follows successful commit; absence checked before INSERT.
  const tasks = await tracked(pendingProfiles(12)); expect(tasks.map(task => task.product.id)).toEqual([row.id]); return tasks[0];
}
const replyBody = () => ({ id: "profile-local", object: "chat.completion", created: 1, model: "served-profile",
  choices: [{ index: 0, message: { role: "assistant", content: '{"keywords_en":["expense tracker"],"keywords_ko":["가계부"]}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 70, completion_tokens: 20, total_tokens: 90 }, usage_provenance: "upstream_reported" });
async function server(run: (state: { bodies: string[]; setReply: (reply: (response: ServerResponse) => void) => void }) => Promise<void>) {
  const bodies: string[] = [], responses = new Set<Promise<unknown>>(), failures: unknown[] = [];
  let reply = (response: ServerResponse) => { response.end(JSON.stringify(replyBody())); };
  const http = createServer((request, response) => {
    const closed = new Promise<void>(resolve => response.once("close", resolve));
    tracked((async () => { let body = ""; for await (const part of request) body += part.toString(); bodies.push(body); reply(response); await closed; })(), responses);
  });
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
    // Explicit test-only allowlist; this does not certify production serving C or readiness.
    serving.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: jobName, provider: "abcllm", model: PROFILE_MODEL,
      responseModel: "served-profile", deploymentRevision: "local-only", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, totalTokenBound: 8000 };
    await run({ bodies, setReply: next => { reply = next; } });
  } catch (error) { failures.push(error); }
  finally {
    serving.contract = null;
    await steps([() => drain(work), () => new Promise<void>((resolve, reject) => http.listening ? http.close(error => error ? reject(error) : resolve()) : resolve()),
      () => drain(responses, true)], failures);
  }
}
async function tick() { await tracked(requestJob(jobName)); return tracked(runJob(jobName, writeSearchProfiles, { requestedOnly: true, roleLease: role, budgetMs: 55_000 })); }
function identity(request: ModelCapacityRequest): ModelCapacityRequestIdentity { const { requestId: _id, ...value } = request; return value; }
async function reserve(task: ProfileTask, lease: JobLease) {
  const ready = await tracked(prepareProfileModelDispatch(task, lease, { roleLease: role, timeoutMs: 1000 }));
  expect(ready.kind).toBe("ready"); if (ready.kind !== "ready") throw new Error("fixture_prepare_required");
  const request: ModelCapacityRequest = { requestId: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
    class: "background", pool: "text", routeId: jobName, provider: "abcllm", model: PROFILE_MODEL,
    workKey: `text:profile:${task.product.id}:${textProfileInputHash(ready.intent.input)}` };
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${request.requestId}::uuid`).toEqual([]);
  const result = await tracked(requestTextProfileModelSlot(request, task.product.id));
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("fixture_reservation_required");
  return { ready, request, handle: result.reservation };
}
async function custom(_task: ProfileTask, run: (lease: JobLease) => Promise<void>) {
  await tracked(requestJob(jobName));
  return tracked(runJob(jobName, async (ctx: JobContext<null>) => { expect(ctx.lease).toBeDefined(); await run(ctx.lease!); return { done: true }; }, { requestedOnly: true, roleLease: role }));
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 3000; while (!await check()) { if (Date.now() >= end) throw new Error("fixture_barrier_deadline"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeAll(() => tracked((async () => {
  ensureSchema(); initial = await whole();
  // CI must run this file in its fresh-first step; no truncation or foreign work parking.
  expect(baseline("model_capacity_requests")).toEqual([]); expect(await pendingProfiles(1)).toEqual([]);
  expect(baseline("role_leases").filter(row => row.role === "text").every(row => row.owner_instance_id === null)).toBe(true);
  expect((await admin`SELECT lease_token FROM jobs WHERE name=ANY(${managedJobs}::text[])`).every(row => row.lease_token === null)).toBe(true);
  expect(baseline("job_batch_control")[0]).toMatchObject({ mode: "legacy", writer_contract_version: 0 }); initialized = true;
})(), hooks));
beforeEach(() => tracked((async () => { vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await install(); await elect(); })(), hooks));
afterEach(() => tracked(steps([() => drain(exercises), () => drain(work), cleanup, async () => { serving.contract = null; vi.unstubAllEnvs(); vi.unstubAllGlobals(); }]), hooks));
afterAll(async () => { await steps([() => drain(exercises), () => drain(work), () => drain(hooks), cleanup, () => admin.end()]); });

it("commits real text role/job dispatch, one native POST, historical terminal, original keyword writer and ACK", exercise(async () => {
  const task = await seed();
  await server(async ({ bodies }) => {
    expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(1);
    const [row] = await admin`SELECT * FROM model_capacity_requests WHERE logical_work_key=${`text:profile:${task.product.id}`}`;
    expect(row.state).toBe("settled"); expect(row.dispatch_binding).toMatchObject({ productId: task.product.id, role: { instanceId: role.instanceId, bootId: role.bootId, epoch: role.epoch }, chargedTokens: 8000 });
    expect(row.terminal_evidence.dispatch.bindingHash).toBe(row.dispatch_binding_hash);
    expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${row.request_id}::uuid AND kind='dispatch_settled'`).toHaveLength(1);
    const [profile] = await admin`SELECT * FROM product_search_profiles WHERE product_id=${task.product.id}`;
    expect(profile).toMatchObject({ keywords_en: ["expense tracker"], keywords_ko: ["가계부"], attempts: 1, verified_at: null, verify_attempts: 0 });
    expect((await admin`SELECT search_keywords FROM products WHERE id=${task.product.id}`)[0].search_keywords).toBe("expense tracker · 가계부");
    const [job] = await admin`SELECT * FROM jobs WHERE name=${jobName}`; expect(job.processed_version).toBe(job.requested_version); expect(job.lease_token).toBeNull();
    // Durable JSON CHECK evidence is separate from opaque terminal authority.
    await expect(admin.begin(async tx => { await tx`UPDATE model_capacity_requests SET terminal_evidence=terminal_evidence-'finishReason' WHERE request_id=${row.request_id}::uuid`; }))
      .rejects.toMatchObject({ code: "23514" });
  });
}));
it("preserves production unsupported, disabled original transport and source-hash reuse without capacity rows", exercise(async () => {
  const task = await seed(); expect(await tick()).toMatchObject({ status: "deferred", reason: "model_capacity" }); expect(await admin`SELECT request_id FROM model_capacity_requests`).toEqual([]);
  await install(basePolicy, "disabled"); const legacy = vi.fn(async () => new Response(JSON.stringify(replyBody()))); vi.stubGlobal("fetch", legacy);
  expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(legacy).toHaveBeenCalledTimes(1);
  await admin`UPDATE product_search_profiles SET updated_at=now()-interval '31 days' WHERE product_id=${task.product.id}`;
  await install(); expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(legacy).toHaveBeenCalledTimes(1);
  expect(await admin`SELECT request_id FROM model_capacity_requests`).toEqual([]);
}));
it("reuses its actual pending ID after a shared engine cap is released", exercise(async () => {
  const task = await seed(); await install({ ...basePolicy, globalLimit: 1 });
  await server(async ({ bodies }) => {
    const other: ModelCapacityRequest = { requestId: randomUUID(), owner: { instanceId: prefix, bootId: role.bootId },
      workKey: "profile-cap-control", class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model: PROFILE_MODEL };
    expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${other.requestId}::uuid`).toEqual([]);
    ownRequests.set(other.requestId, {}); const slot = await tracked(requestModelSlot(other)); expect(slot.kind).toBe("granted");
    expect(await tick()).toMatchObject({ status: "deferred", reason: "model_capacity" }); expect(bodies).toHaveLength(0);
    const [waiting] = await admin`SELECT request_id,state FROM model_capacity_requests WHERE logical_work_key=${`text:profile:${task.product.id}`}`; expect(waiting.state).toBe("waiting");
    if (slot.kind !== "granted") throw new Error("fixture_capacity_control"); await tracked(cancelReservedModelSlot(slot.reservation));
    expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(1);
    expect((await admin`SELECT request_id,state FROM model_capacity_requests WHERE logical_work_key=${`text:profile:${task.product.id}`}`)[0]).toEqual({ request_id: waiting.request_id, state: "settled" });
  });
}));
it("rejects changed source/profile generation on reserved reentry and cancels only unused capacity", exercise(async () => {
  const task = await seed(); await server(async ({ bodies }) => {
    expect(await custom(task, async lease => {
      const { ready, request, handle } = await reserve(task, lease);
      await db.update(products).set({ tagline: "Changed by a human" }).where(eq(products.id, task.product.id));
      expect(await prepareProfileModelDispatch(task, lease, { timeoutMs: 1000, roleLease: role,
        reserved: { reservation: handle, identity: identity(request), expected: ready.intent.input, call: ready.call } })).toEqual({ kind: "skipped" });
      expect(await cancelReservedModelSlot(handle)).toBe(true);
    })).toMatchObject({ status: "completed" }); expect(bodies).toHaveLength(0);
    expect(await admin`SELECT product_id FROM product_search_profiles WHERE product_id=${task.product.id}`).toEqual([]);
    expect((await admin`SELECT state,dispatch_binding FROM model_capacity_requests`)[0]).toEqual({ state: "withdrawn", dispatch_binding: null });
  });
}));
it("uses actual PG blocking and reservation DBwall expiry before any dispatch or HTTP", exercise(async () => {
  const task = await seed(); await server(async ({ bodies }) => {
    const result = await custom(task, async lease => {
      const { ready, request, handle } = await reserve(task, lease);
      const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, connection: { application_name: `${prefix}-holder` } });
      const held = latch(), release = latch(); let pid = 0;
      const holding = tracked(holder.begin(async tx => { pid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid); await tx`SELECT id FROM products WHERE id=${task.product.id} FOR UPDATE`; held.resolve(); await release.promise; }));
      let entry: Promise<unknown> | undefined;
      try {
        await Promise.race([held.promise, holding.then(() => { throw new Error("fixture_holder_ended_before_ready"); })]);
        const [anchor] = await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()+interval '750 milliseconds' WHERE request_id=${request.requestId}::uuid RETURNING reserved_until::text AS expiry`;
        entry = tracked(prepareProfileModelDispatch(task, lease, { timeoutMs: 1000, roleLease: role,
          reserved: { reservation: handle, identity: identity(request), expected: ready.intent.input, call: ready.call } }));
        await until(async () => (await admin`SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length === 1);
        await until(async () => (await admin`SELECT clock_timestamp()>${anchor.expiry}::text::timestamptz AS expired`)[0].expired === true);
        release.resolve(); await holding; await expect(entry).rejects.toThrow("text_profile_model_reservation_lost");
      } finally { release.resolve(); await steps([async () => { await Promise.allSettled([holding, ...(entry ? [entry] : [])]); }, () => holder.end()]); }
      expect(await cancelReservedModelSlot(handle)).toBe(false);
    }); expect(result).toMatchObject({ status: "completed" }); expect(bodies).toHaveLength(0);
    expect((await admin`SELECT count(*)::int AS n FROM model_capacity_events WHERE kind='dispatch_started'`)[0].n).toBe(0);
  });
}));
it("rolls dispatch event INSERT failure back with no keyword attempt or POST", exercise(async () => {
  const task = await seed(); await server(async ({ bodies }) => {
    const name = `profile_fault_${randomUUID().replaceAll('-', '')}`;
    expect(await admin`SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=${name}`).toEqual([]);
    expect(await admin`SELECT oid FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname=${name}`).toEqual([]);
    try {
      await admin.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='dispatch_started' THEN RAISE EXCEPTION 'profile dispatch fault'; END IF; RETURN NEW; END $$`);
      await admin.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON model_capacity_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const result = await tick(); expect(result).toMatchObject({ status: "failed" });
      expect(bodies).toHaveLength(0); expect(await admin`SELECT product_id FROM product_search_profiles WHERE product_id=${task.product.id}`).toEqual([]);
      expect((await admin`SELECT state,dispatch_binding FROM model_capacity_requests`)[0]).toEqual({ state: "withdrawn", dispatch_binding: null });
      expect(await admin`SELECT id FROM model_capacity_events WHERE kind='dispatch_started'`).toEqual([]);
    } finally { await steps([async () => {
      const triggers = await admin`SELECT p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='model_capacity_events'::regclass AND t.tgname=${name}`;
      if (triggers.length) { expect(triggers).toEqual([{ proname: name }]); await admin.unsafe(`DROP TRIGGER ${name} ON model_capacity_events`); }
    }, async () => {
      const functions = await admin`SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=${name}`;
      if (functions.length) { expect(functions).toEqual([{ prosrc: " BEGIN IF NEW.kind='dispatch_started' THEN RAISE EXCEPTION 'profile dispatch fault'; END IF; RETURN NEW; END " }]); await admin.unsafe(`DROP FUNCTION ${name}()`); }
    }]); }
  });
}));
it("settles historical terminal after actual job expiry while mandatory writer and ACK roll back", exercise(async () => {
  const task = await seed(); await server(async ({ bodies, setReply }) => {
    const arrived = latch(), release = latch();
    setReply(response => { arrived.resolve(); tracked(release.promise.then(() => { response.end(JSON.stringify(replyBody())); })); });
    const running = tracked(tick());
    try {
      await Promise.race([arrived.promise, running.then(outcome => { throw new Error("fixture_job_ended_before_post", { cause: outcome }); })]);
      const [anchor] = await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '90 seconds'+interval '500 milliseconds' WHERE name=${jobName} RETURNING (locked_at+interval '90 seconds')::text AS expiry`;
      await until(async () => (await admin`SELECT clock_timestamp()>${anchor.expiry}::text::timestamp AS expired`)[0].expired === true);
    } finally { release.resolve(); }
    expect(await running).toMatchObject({ status: "failed", error: "job_lease_lost" }); expect(bodies).toHaveLength(1);
    expect((await admin`SELECT state FROM model_capacity_requests`)[0].state).toBe("settled");
    expect(await admin`SELECT product_id FROM product_search_profiles WHERE product_id=${task.product.id}`).toEqual([]);
    const [job] = await admin`SELECT * FROM jobs WHERE name=${jobName}`; expect(Number(job.processed_version)).toBeLessThan(Number(job.requested_version));
  });
}));
it("keeps EOF full-C unknown fenced across a new boot and changed source without another POST", exercise(async () => {
  const task = await seed(); await server(async ({ bodies, setReply }) => {
    setReply(response => { response.writeHead(200, { "Content-Length": "1000" }); response.write("{"); response.socket?.destroy(); });
    expect(await tick()).toMatchObject({ status: "completed" }); expect(bodies).toHaveLength(1);
    const [unknown] = await admin`SELECT * FROM model_capacity_requests`; expect(unknown.state).toBe("indeterminate"); expect(unknown.dispatch_binding.chargedTokens).toBe(8000);
    expect((await admin`SELECT attempts FROM product_search_profiles WHERE product_id=${task.product.id}`)[0].attempts).toBe(1);
    const [beforeSource] = await admin`SELECT source_revision FROM product_search_profiles WHERE product_id=${task.product.id}`;
    expect(await tracked(releaseRole(role))).toBe(true); await elect();
    await db.update(products).set({ tagline: "New source after unknown" }).where(eq(products.id, task.product.id));
    const [afterSource] = await admin`SELECT attempts,source_revision FROM product_search_profiles WHERE product_id=${task.product.id}`;
    expect(afterSource).toEqual({ attempts: 0, source_revision: beforeSource.source_revision + 1 });
    await admin`UPDATE product_search_profiles SET error_code=NULL,retry_at=NULL,needs_refresh=true WHERE product_id=${task.product.id}`;
    expect(await tick()).toMatchObject({ status: "deferred", reason: "model_capacity" }); expect(bodies).toHaveLength(1);
    expect((await admin`SELECT request_id,state FROM model_capacity_requests`)).toEqual([{ request_id: unknown.request_id, state: "indeterminate" }]);
    expect((await admin`SELECT attempts,source_revision FROM product_search_profiles WHERE product_id=${task.product.id}`)[0]).toEqual(afterSource);
  });
}));
