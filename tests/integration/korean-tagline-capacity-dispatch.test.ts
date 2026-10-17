import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { TRANSLATE_MODEL } from "@/lib/crawl/translate";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { pendingKoreanTaglines, prepareKoreanTaglineDispatch, recordKoreanTaglines, koreanTaglineSource,
  type KoreanTaglineTask } from "@/lib/domain/products/korean-taglines";
import { writeKoreanTaglines, packTaglineBatch } from "@/lib/jobs/products/korean-tagline";
import { translateKoreanTaglinesWithModelCapacity } from "@/lib/domain/products/korean-tagline-model-capacity";
import { displayProjectName } from "@/lib/domain/products/display-name";
import { prepareProductTaglineKoGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { batchCanaryAnchorKey, batchPolicyHash } from "@/lib/jobs/batches";
import { runJob, type JobContext } from "@/lib/jobs/runner";
import { jobsForRole } from "@/lib/jobs/catalog";
import { requestJob, type JobLease } from "@/lib/jobs/control";
import { releaseRole, tryAcquireRole, type RoleLease } from "@/lib/jobs/role-leader";
import { requestProductTaglineKoModelSlot, cancelReservedModelSlot } from "@/lib/llm/capacity-repository";
import { modelCapacityPolicyHash, productTaglineKoInputHash, productTaglineKoLogicalWorkKey,
  type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import type { ProductTaglineKoServingContract } from "@/lib/llm/product-tagline-ko-serving-contract";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const serving = vi.hoisted(() => ({ contract: null as ProductTaglineKoServingContract | null }));
vi.mock("@/lib/llm/product-tagline-ko-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/product-tagline-ko-serving-contract")>(), resolveProductTaglineKoServingContract: () => serving.contract,
}));
type Raw = Record<string, unknown>;
const prefix = `korean-native-${randomUUID().slice(0, 12)}`, jobName = "product-tagline-ko";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const managedJobs = [...new Set(jobsForRole("text"))].sort();
const ownerBoots = new Set<string>(), ownProducts = new Map<number, string>();
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>(), setups = new Set<Promise<unknown>>();
let initial: Record<string, unknown>, initialized = false, role: RoleLease, serial = 0, cleaning: Promise<void> | undefined;
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: jobName, provider: "abcllm", model: TRANSLATE_MODEL, providerBudgetId: "account", groupId: "engine" }] };
const tracked = <T>(pending: PromiseLike<T>, set = work): Promise<T> => { const actual = Promise.resolve(pending); set.add(actual); void actual.catch(() => {}); return actual; };
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), exercises);
async function drain(set: Set<Promise<unknown>>, report = false) {
  const errors: unknown[] = [];
  while (set.size) { const pending = [...set], results = await Promise.allSettled(pending);
    for (const promise of pending) set.delete(promise);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason); }
  if (report && errors.length) throw new AggregateError(errors, "korean_fixture_pending_failure");
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "korean_fixture_cleanup_failed", { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  } return result;
}
const baseline = (table: string): Raw[] => initial[table] as Raw[];
async function restore(tx: postgres.TransactionSql, table: "model_capacity_control" | "job_batch_control" | "role_leases" | "jobs" | "operations_observations", key: string, value: string | number) {
  const saved = baseline(table).find(row => row[key] === value);
  const [current] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE "${key}"=$1 FOR UPDATE`, [value]);
  if (!current) { expect(saved).toBeUndefined(); return; }
  if (!saved) { expect(await tx.unsafe(`DELETE FROM ${table} t WHERE "${key}"=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING "${key}"`, [value, JSON.stringify(current.row)])).toHaveLength(1); return; }
  const columns = Object.keys(saved).map(name => '"' + name.replaceAll('"', '""') + '"').join(',');
  expect(await tx.unsafe(`UPDATE ${table} t SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::${table},$1::text::jsonb)) WHERE "${key}"=$2 AND to_jsonb(t)=$3::text::jsonb RETURNING "${key}"`,
    [JSON.stringify(saved), value, JSON.stringify(current.row)])).toHaveLength(1);
}
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`SELECT id FROM job_batch_control WHERE id=1 FOR UPDATE`;
    const currentJobs = await tx`SELECT * FROM jobs WHERE name=ANY(${managedJobs}::text[]) ORDER BY name FOR UPDATE`;
    // Fresh/exclusive fixture. Only the historical case may retain its own expired, physically settled job token.
    for (const job of currentJobs.filter(row => row.lease_token !== null)) {
      expect(job.name).toBe(jobName);
      const [settled] = await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}
        AND state='settled' AND terminal_evidence IS NOT NULL AND dispatch_binding->'job'->>'token'=${job.lease_token}`;
      expect(settled).toBeDefined();
      expect((await tx`SELECT locked_at<clock_timestamp()-interval '90 seconds' AS expired FROM jobs WHERE name=${jobName}`)[0].expired).toBe(true);
    }
    for (const currentRole of await tx`SELECT * FROM role_leases WHERE role IN ('text','translation') ORDER BY role FOR UPDATE`) {
      if (currentRole.owner_instance_id !== null) {
        expect(currentRole.owner_instance_id).toBe(prefix); expect(ownerBoots.has(currentRole.owner_boot_id)).toBe(true);
      }
    }
    const requests = await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal FOR UPDATE`;
    const ids = requests.map(({ row }) => { expect(ownerBoots.has(row.owner_boot_id)).toBe(true); expect(row.route_id).toBe(jobName);
      expect(row.logical_member_keys.every((key: string) => { const match = /^product-tagline-ko:(\d+)$/.exec(key); return match && ownProducts.has(Number(match[1])); })).toBe(true);
      return row.request_id as string; });
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
    for (const { row } of requests) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${row.request_id}::uuid AND owner_instance_id=${prefix} AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    for (const [id, slug] of ownProducts) {
      expect(baseline("products").some(row => row.id === id || row.slug === slug)).toBe(false);
      const [current] = await tx`SELECT to_jsonb(p) AS row FROM products p WHERE id=${id} AND slug=${slug} FOR UPDATE`; expect(current).toBeDefined();
      expect(await tx`SELECT id FROM product_audit_items WHERE product_id=${id}`).toEqual([]);
      expect(await tx`DELETE FROM products p WHERE id=${id} AND slug=${slug} AND to_jsonb(p)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      const purges = await tx`SELECT id,to_jsonb(c) AS row FROM cdn_purges c WHERE slug=${slug} FOR UPDATE`;
      for (const purge of purges) { expect(purge.row.reason).toBe("deleted");
        expect(baseline("cdn_purges").some(row => row.id === purge.id || row.slug === slug)).toBe(false);
        expect(await tx`DELETE FROM cdn_purges c WHERE id=${purge.id} AND slug=${slug} AND to_jsonb(c)=${JSON.stringify(purge.row)}::text::jsonb RETURNING id`).toHaveLength(1); }
    }
    const candidates = await tx`SELECT role,instance_id,to_jsonb(c) AS row FROM job_batch_candidates c WHERE instance_id=${prefix} FOR UPDATE`;
    for (const candidate of candidates) { expect(baseline("job_batch_candidates").some(row => row.instance_id === prefix)).toBe(false);
      expect(await tx`DELETE FROM job_batch_candidates c WHERE role=${candidate.role} AND instance_id=${prefix} AND to_jsonb(c)=${JSON.stringify(candidate.row)}::text::jsonb RETURNING role`).toHaveLength(1); }
    await restore(tx, "model_capacity_control", "id", 1); await restore(tx, "job_batch_control", "id", 1);
    for (const name of ["text", "translation"]) await restore(tx, "role_leases", "role", name);
    for (const name of managedJobs) await restore(tx, "jobs", "name", name);
    for (const name of [jobName]) await restore(tx, "operations_observations", "key", `job:${name}`);
    await restore(tx, "operations_observations", "key", `batch-result:${prefix}:${jobName}`);
    await restore(tx, "operations_observations", "key", batchCanaryAnchorKey("translation", prefix));
    expect(await whole(tx)).toEqual(initial);
  }); ownProducts.clear();
}
function cleanup() { if (cleaning) return cleaning; const pending = performCleanup(); cleaning = pending;
  void pending.then(() => { if (cleaning === pending) cleaning = undefined; }, () => {}); return pending; }
async function install(mode = "open") { await admin`UPDATE model_capacity_control SET mode=${mode},policy=${JSON.stringify(policy)}::text::jsonb,
  policy_hash=${modelCapacityPolicyHash(policy)},cursor=0,updated_at=clock_timestamp() WHERE id=1`; }
async function elect() {
  const bootId = randomUUID(); ownerBoots.add(bootId);
  const acquired = await tracked(tryAcquireRole({ role: "text", instanceId: prefix, bootId, release: "local-korean-fixture", kind: "primary" }));
  expect(acquired).not.toBeNull(); if (!acquired) throw new Error("fixture_role_required"); role = acquired;
  environment();
}
function environment() {
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: role.role, ROLE_LEASE_INSTANCE_ID: role.instanceId, ROLE_LEASE_BOOT_ID: role.bootId,
    ROLE_LEASE_RELEASE: role.release, ROLE_LEASE_EPOCH: String(role.epoch) })) vi.stubEnv(key, value);
  for (const [key, value] of Object.entries({ ROLE_LEASE_BATCH_VERSION: role.batchVersion ? "1" : undefined,
    ROLE_LEASE_HOST: role.host, ROLE_LEASE_BATCH_EPOCH: role.batchEpoch ? String(role.batchEpoch) : undefined })) vi.stubEnv(key, value);
}
async function seed(count = 1) {
  const rows: (typeof products.$inferSelect)[] = [];
  for (let index = 0; index < count; index++) {
    const slug = `${prefix}-${++serial}`;
    expect(await admin`SELECT id FROM products WHERE slug=${slug}`).toEqual([]); expect(await admin`SELECT id FROM cdn_purges WHERE slug=${slug}`).toEqual([]);
    const [row] = await tracked(db.insert(products).values({ slug, name: "Notes", url: `https://${slug}.test`, tagline: "Document management tools for teams",
      description: "Document management", taglineSource: "ai_page", category: "Productivity", status: "seeded", source: "crawler", verifyToken: "fixture", editTokenHash: "fixture" }).returning());
    ownProducts.set(row.id, slug); rows.push(row); // actual committed ID, lazy builder assimilated once
  }
  const tasks = (await tracked(pendingKoreanTaglines(32, []))).filter(task => ownProducts.has(task.productId));
  expect(tasks).toHaveLength(count); return { products: rows, tasks };
}
const replyBody = (outputs: string[] = ["문서를 관리하는 도구"]) => ({ id: "korean-local", object: "chat.completion", created: 1, model: "served-korean",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(outputs) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 70, completion_tokens: 20, total_tokens: 90 }, usage_provenance: "upstream_reported" });
async function server(run: (state: { bodies: string[]; setReply: (reply: (response: ServerResponse, body: string) => void) => void }) => Promise<void>) {
  const bodies: string[] = [], responses = new Set<Promise<unknown>>(), failures: unknown[] = [];
  let reply = (response: ServerResponse, body: string) => { const wire = JSON.parse(body); const items = JSON.parse(wire.messages[1].content);
    response.end(JSON.stringify(replyBody(items.map(() => "문서를 관리하는 도구")))); };
  const http = createServer((request, response) => { const closed = new Promise<void>(resolve => response.once("close", resolve));
    tracked((async () => { let body = ""; for await (const part of request) body += part.toString(); bodies.push(body); reply(response, body); await closed; })(), responses); });
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
    serving.contract = { version: 1, protocol: "abcllm-product-tagline-ko-total-bound-v1", routeId: jobName, provider: "abcllm", model: TRANSLATE_MODEL,
      responseModel: "served-korean", deploymentRevision: "local-only", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, totalTokenBound: 8000 };
    await run({ bodies, setReply: next => { reply = next; } });
  } catch (error) { failures.push(error); }
  finally { serving.contract = null; await steps([() => drain(work),
    () => new Promise<void>((resolve, reject) => http.listening ? http.close(error => error ? reject(error) : resolve()) : resolve()), () => drain(responses, true)], failures); }
}
async function tick() { await tracked(requestJob(jobName)); return tracked(runJob(jobName, writeKoreanTaglines, { requestedOnly: true, roleLease: role })); }
async function custom(run: (lease: JobLease) => Promise<void>) { await tracked(requestJob(jobName));
  return tracked(runJob(jobName, async (ctx: JobContext<null>) => { expect(ctx.lease).toBeDefined(); await run(ctx.lease!); return { done: true }; }, { requestedOnly: true, roleLease: role })); }
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 3000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("fixture_barrier_deadline"); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function barrier(ready: Promise<void>, operation: Promise<unknown>) { await Promise.race([ready,
  operation.then(value => { throw new Error("fixture_operation_finished_before_barrier", { cause: value }); })]); }
async function blocking(pid: number, operation: Promise<unknown>) {
  let result: { value?: unknown; error?: unknown } | undefined;
  void operation.then(value => { result = { value }; }, error => { result = { error }; });
  await until(async () => { if (result) { if ("error" in result) throw result.error; throw new Error("fixture_operation_finished_before_block", { cause: result.value }); }
    return (await admin`SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length > 0; });
}
async function reserve(tasks: KoreanTaglineTask[], lease: JobLease, home: string[] = []) {
  const call = prepareProductTaglineKoGatewayCall(tasks.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: koreanTaglineSource(task) })), { model: TRANSLATE_MODEL, timeoutMs: 45_000 });
  expect(call.kind).toBe("prepared"); if (call.kind !== "prepared") throw new Error("fixture_native_contract_required");
  const ready = await tracked(prepareKoreanTaglineDispatch(tasks, home, lease, { roleLease: role, call }));
  expect(ready.kind).toBe("ready"); if (ready.kind !== "ready" || !("members" in ready)) throw new Error("fixture_current_input_required");
  const request: ModelCapacityRequest = { requestId: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
    class: "background", pool: "text", routeId: jobName, provider: "abcllm", model: TRANSLATE_MODEL,
    workKey: `${productTaglineKoLogicalWorkKey(ready.members)}:${productTaglineKoInputHash({ members: ready.members, model: TRANSLATE_MODEL })}` };
  const slot = await tracked(requestProductTaglineKoModelSlot(request, ready.members));
  expect(slot.kind).toBe("granted"); if (slot.kind !== "granted") throw new Error("fixture_reservation_required");
  const { requestId: _id, ...identity } = request; void _id; return { ready, call, reservation: slot.reservation, identity };
}
beforeAll(() => tracked((async () => {
  await ensureSchema(); initial = await whole();
  // Fresh dedicated first-step contract, without any global product-table vacancy requirement.
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toEqual([]);
  expect(await pendingKoreanTaglines(1, [])).toEqual([]);
  expect(baseline("role_leases").filter(row => ["text", "translation"].includes(String(row.role))).every(row => row.owner_instance_id === null)).toBe(true);
  expect(baseline("jobs").filter(row => managedJobs.includes(String(row.name))).every(row => row.lease_token === null)).toBe(true);
  expect(baseline("job_batch_control")[0]).toMatchObject({ mode: "legacy", writer_contract_version: 0 });
  expect(baseline("job_batch_candidates").some(row => row.instance_id === prefix)).toBe(false); initialized = true;
})(), setups));
beforeEach(() => tracked((async () => { vi.stubEnv("ABCLLM_API_KEY", "local-only"); await install(); await elect(); })(), setups));
afterEach(() => tracked(steps([() => drain(setups), () => drain(exercises), () => drain(work), cleanup,
  async () => { serving.contract = null; vi.unstubAllEnvs(); vi.unstubAllGlobals(); }]), hooks));
afterAll(async () => { await steps([() => drain(setups), () => drain(exercises), () => drain(work), () => drain(hooks), cleanup,
  () => admin.end({ timeout: 5 }), async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end({ timeout: 5 }); }]); });

it("dispatches the real ordered eight-member Korean job and ACKs only quality-checked stored results", exercise(async () => {
  const seeded = await seed(8); await tracked(requestJob(jobName));
  const [original] = await admin`SELECT processed_version FROM jobs WHERE name=${jobName}`;
  expect(await tick()).toMatchObject({ status: "deferred", reason: "model_capacity" });
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}`).toEqual([]);
  expect((await admin`SELECT processed_version FROM jobs WHERE name=${jobName}`)[0].processed_version).toBe(original.processed_version);
  await server(async ({ bodies, setReply }) => {
    setReply(response => response.end(JSON.stringify(replyBody(Array.from({ length: 8 }, (_, index) => index === 7 ? "" : "문서를 관리하는 도구")))));
    expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(1);
    const wire = JSON.parse(bodies[0]); expect(wire.stream).toBe(false); expect(wire.max_tokens).toBe(1800);
    expect(JSON.parse(wire.messages[1].content)).toEqual(seeded.tasks.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: koreanTaglineSource(task) })));
    const [request] = await admin`SELECT to_jsonb(r) AS raw FROM model_capacity_requests r WHERE owner_instance_id=${prefix}`;
    expect(request.raw).toMatchObject({ state: "settled", route_id: jobName,
      dispatch_binding: { kind: "product_tagline_ko_gateway", chargedTokens: 8000, totalTokenBound: 8000, role: { role: "text", batch: { mode: "legacy" } } } });
    expect(request.raw.dispatch_binding.members.map((member: Raw) => member.productId)).toEqual(seeded.tasks.map(task => task.productId));
    expect(request.raw.dispatch_binding.members.every((member: Raw) => (member.cache as Raw).kind === "absent")).toBe(true);
    expect(request.raw.terminal_evidence.actualUsage).toEqual({ inputTokens: 70, outputTokens: 20, totalTokens: 90 });
    expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${request.raw.request_id}::uuid ORDER BY id`).map(row => row.kind))
      .toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
    const rows = await admin`SELECT product_id,attempts,quality_rejections,error_code,tagline_ko FROM product_korean_taglines WHERE product_id=ANY(${seeded.products.map(row => row.id)}::int[])`;
    expect(rows).toHaveLength(8); expect(rows.filter(row => row.error_code === null && row.tagline_ko === "문서를 관리하는 도구")).toHaveLength(7);
    expect(rows.filter(row => row.error_code === "rejected:empty" && row.quality_rejections === 1)).toHaveLength(1);
    expect(rows.every(row => row.attempts === 1)).toBe(true);
    const [job] = await admin`SELECT requested_version,processed_version,lease_token FROM jobs WHERE name=${jobName}`;
    expect(job.processed_version).toBe(job.requested_version); expect(job.lease_token).toBeNull();
  });
}), 20_000);

it("admits the actual versioned translation role after local stored-result readback and preserves disabled legacy behavior", exercise(async () => {
  const first = await seed();
  await server(async ({ bodies }) => {
    const batchPolicy = { version: 1 as const, release: role.release, instances: [{ instanceId: prefix, host: "oracle-osaka-smoke" as const }] };
    await admin`UPDATE job_batch_control SET writer_contract_version=1,policy=${JSON.stringify(batchPolicy)}::text::jsonb,policy_hash=${batchPolicyHash(batchPolicy)} WHERE id=1`;
    expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(1);
    expect(await tracked(releaseRole(role))).toBe(true);
    const [clock] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
    const [observation] = await admin`SELECT value->'batchResult' AS result FROM operations_observations WHERE key=${`batch-result:${prefix}:${jobName}`}`;
    const capability = { host: "oracle-osaka-smoke", release: role.release, instanceId: prefix, dbPrivileges: "verified",
      dbRole: "local-fixture-only", effectivePrivilegeHash: "a".repeat(64), modelBoundEvidenceHash: "b".repeat(64), http: "verified", model: "verified", observedAt: clock.at };
    const readback = { host: "oracle-osaka-smoke", release: role.release, instanceId: prefix, job: jobName, requestedVersion: observation.result.requestedVersion,
      domainReadbackHash: reviewHash((await admin`SELECT to_jsonb(k) AS row FROM product_korean_taglines k WHERE product_id=${first.products[0].id}`)[0].row), observedAt: clock.at };
    // Explicit operator fixture seeds; these are not physical Oracle privilege/host/C evidence.
    await admin`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence)
      VALUES('translation',${prefix},'oracle-osaka-smoke',${role.bootId},${role.release},${batchPolicyHash(batchPolicy)},${JSON.stringify(capability)}::text::jsonb,${JSON.stringify(readback)}::text::jsonb)`;
    await admin`UPDATE job_batch_control SET mode='versioned',draining_from=NULL,writer_contract_version=1 WHERE id=1`;
    const acquired = await tracked(tryAcquireRole({ role: "translation", instanceId: prefix, bootId: role.bootId, release: role.release,
      kind: "primary", batchVersion: 1, host: "oracle-osaka-smoke" }));
    expect(acquired).not.toBeNull(); if (!acquired) throw new Error("fixture_translation_role_required"); role = acquired; environment();
    await seed(); expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(2);
    const [latest] = await admin`SELECT dispatch_binding FROM model_capacity_requests WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal DESC LIMIT 1`;
    expect(latest.dispatch_binding.role).toMatchObject({ role: "translation", batch: { mode: "versioned", host: "oracle-osaka-smoke", batchEpoch: role.batchEpoch } });
    expect((await admin`SELECT value->'batchResult'->>'role' AS role FROM operations_observations WHERE key=${`batch-result:${prefix}:${jobName}`}`)[0].role).toBe("translation");
    // Original disabled leaf and writer remain available; only redirect its HTTP boundary to this loopback.
    await install("disabled"); const last = await seed(), originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => originalFetch(serving.contract!.endpoint, init));
    expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(3);
    expect((await admin`SELECT attempts,error_code FROM product_korean_taglines WHERE product_id=${last.products[0].id}`)[0]).toEqual({ attempts: 1, error_code: null });
    expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}`).toHaveLength(2);
  });
}), 20_000);

it("retains network attempts beyond six and the actual home-extra shortened solo input without changing quality count", exercise(async () => {
  const seeded = await seed(), product = seeded.products[0];
  await tracked(db.update(products).set({ tagline: "Document management tools. Additional details for teams." }).where(eq(products.id, product.id)));
  await admin`INSERT INTO product_korean_taglines(product_id,source_tagline,model,attempts,quality_rejections,error_code,retry_at)
    SELECT id,tagline,'fixture',9,4,'rejected:too_long',clock_timestamp()-interval '1 second' FROM products WHERE id=${product.id}`;
  expect((await pendingKoreanTaglines(16, [])).filter(task => task.productId === product.id)).toEqual([]);
  const [task] = (await tracked(pendingKoreanTaglines(16, [product.slug]))).filter(task => task.productId === product.id);
  expect(task).toMatchObject({ attempts: 9, lastError: "rejected:too_long" }); expect(packTaglineBatch([task, ...seeded.tasks])).toEqual([task]);
  await server(async ({ bodies, setReply }) => {
    setReply(response => { response.statusCode = 429; response.end("rate limited"); });
    expect(await custom(async lease => {
      const outcome = await tracked(translateKoreanTaglinesWithModelCapacity([task], [product.slug], lease, { timeoutMs: 45_000, roleLease: role }));
      if (outcome.kind !== "result") throw new Error("fixture_native_result_required");
      expect(outcome.result).toEqual({ ok: false, error: "rate_limit" });
      expect(await tracked(recordKoreanTaglines([{ task, result: { kind: "failure", error: "rate_limit", model: TRANSLATE_MODEL } }], lease, outcome.expectation))).toBe(1);
    })).toMatchObject({ status: "completed" });
    expect(bodies).toHaveLength(1); expect(JSON.parse(JSON.parse(bodies[0]).messages[1].content)).toEqual([{ name: "Notes", tagline: koreanTaglineSource(task) }]);
    expect(koreanTaglineSource(task)).not.toBe(task.tagline);
    const [stored] = await admin`SELECT attempts,quality_rejections,error_code,retry_at>clock_timestamp() AS future FROM product_korean_taglines WHERE product_id=${product.id}`;
    expect(stored).toEqual({ attempts: 10, quality_rejections: 4, error_code: "rate_limit", future: true });
    expect((await admin`SELECT state,dispatch_binding->'members'->0->'cache' AS cache FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0])
      .toMatchObject({ state: "indeterminate", cache: { kind: "present", attempts: 9, qualityRejections: 4 } });
  });
}), 20_000);

it("preserves absent and microsecond-only cache winners plus a newer producer request after physical settlement", exercise(async () => {
  const seeded = await seed(2), first = seeded.tasks[0], second = seeded.tasks[1];
  await admin`INSERT INTO product_korean_taglines(product_id,source_tagline,model,attempts,quality_rejections,error_code,retry_at)
    VALUES(${first.productId},${first.tagline},'fixture',0,0,'network',NULL)`;
  await server(async ({ bodies, setReply }) => {
    const arrived = latch(); let response: ServerResponse | undefined;
    setReply(value => { response = value; arrived.resolve(); });
    const running = tracked(tick()), errors: unknown[] = [];
    try { await barrier(arrived.promise, running);
      const [old] = await admin`SELECT updated_at::text AS stamp FROM product_korean_taglines WHERE product_id=${first.productId}`;
      const [replacement] = await admin`UPDATE product_korean_taglines SET updated_at=updated_at+interval '1 microsecond'
        WHERE product_id=${first.productId} RETURNING updated_at::text AS stamp`; expect(replacement.stamp).not.toBe(old.stamp);
      await admin`INSERT INTO product_korean_taglines(product_id,source_tagline,model,attempts,quality_rejections,error_code)
        VALUES(${second.productId},${second.tagline},'concurrent-local',0,0,'network')`;
      const before = await admin`SELECT to_jsonb(k) AS row FROM product_korean_taglines k WHERE product_id=ANY(${[first.productId, second.productId]}::int[]) ORDER BY product_id`;
      const newer = await tracked(requestJob(jobName)); response!.end(JSON.stringify(replyBody(["문서를 관리하는 도구", "문서를 관리하는 도구"])));
      expect(await running).toMatchObject({ status: "completed", done: false }); expect(bodies).toHaveLength(1);
      expect(await admin`SELECT to_jsonb(k) AS row FROM product_korean_taglines k WHERE product_id=ANY(${[first.productId, second.productId]}::int[]) ORDER BY product_id`).toEqual(before);
      const [job] = await admin`SELECT requested_version,processed_version FROM jobs WHERE name=${jobName}`;
      expect(Number(job.requested_version)).toBe(newer.requestedVersion); expect(Number(job.processed_version)).toBeLessThan(newer.requestedVersion);
      expect((await admin`SELECT state FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0].state).toBe("settled");
      expect(await admin`SELECT key FROM operations_observations WHERE key=${`batch-result:${prefix}:${jobName}`}`).toEqual([]);
    } catch (error) { errors.push(error); }
    finally { if (response && !response.writableEnded) response.end(JSON.stringify(replyBody(["문서를 관리하는 도구", "문서를 관리하는 도구"]))); await steps([() => running], errors); }
  });
}), 20_000);

it("rolls dispatch and event back when reservation DBwall expires during actual event INSERT wait", exercise(async () => {
  const { products: [product], tasks } = await seed(); await server(async ({ bodies }) => {
    expect(await custom(async lease => {
      const slot = await reserve(tasks, lease), holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
      const ready = latch(), release = latch(); let pid = 0;
      const holding = tracked(holder.begin(async tx => { await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
        pid = (await tx`SELECT pg_backend_pid() AS pid`)[0].pid; ready.resolve(); await release.promise; }));
      let dispatching: ReturnType<typeof prepareKoreanTaglineDispatch> | undefined; const errors: unknown[] = [];
      try { await barrier(ready.promise, holding);
        const [anchor] = await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()+interval '3 seconds'
          WHERE request_id=${slot.reservation.requestId}::uuid AND state='reserved' RETURNING reserved_until::text AS expiry`;
        expect(anchor).toBeDefined();
        dispatching = tracked(prepareKoreanTaglineDispatch(tasks, [], lease, { roleLease: role, call: slot.call,
          reserved: { ...slot, members: slot.ready.members, role: slot.ready.role } }));
        await blocking(pid, dispatching);
        await until(async () => (await admin`SELECT clock_timestamp()>${anchor.expiry}::text::timestamptz AS past`)[0].past);
        release.resolve(); await expect(dispatching).rejects.toMatchObject({ reason: "reservation_lost" }); await holding;
        const [row] = await admin`SELECT state,dispatch_binding,dispatched_at FROM model_capacity_requests WHERE request_id=${slot.reservation.requestId}::uuid`;
        expect(row).toEqual({ state: "reserved", dispatch_binding: null, dispatched_at: null });
        expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${slot.reservation.requestId}::uuid AND kind='dispatch_started'`).toEqual([]);
      } catch (error) { errors.push(error); }
      finally { release.resolve(); await steps([() => holding, async () => { if (dispatching) await Promise.allSettled([dispatching]); },
        () => holder.end({ timeout: 5 }), () => tracked(cancelReservedModelSlot(slot.reservation))], errors); }
      // The actual runner gets a typed refusal, so its original request is not acknowledged.
      throw new ModelCapacityDeferredError("reservation_lost");
    })).toMatchObject({ status: "deferred", reason: "model_capacity" }); expect(bodies).toHaveLength(0);
    expect(await admin`SELECT product_id FROM product_korean_taglines WHERE product_id=${product.id}`).toEqual([]);
    const [job] = await admin`SELECT requested_version,processed_version FROM jobs WHERE name=${jobName}`; expect(Number(job.processed_version)).toBeLessThan(Number(job.requested_version));
  });
}), 20_000);

it("preserves the genuine dispatch event INSERT failure with no committed dispatch, business write or ACK", exercise(async () => {
  const { products: [product], tasks } = await seed(), fault = `korean_event_${randomUUID().replaceAll("-", "")}`;
  let attempted = false, functionBody: string | undefined, original: unknown; const errors: unknown[] = [];
  try { await server(async ({ bodies }) => {
    expect(await custom(async lease => {
      const slot = await reserve(tasks, lease);
      expect(await admin`SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=${fault}`).toEqual([]);
      expect(await admin`SELECT oid FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname=${fault}`).toEqual([]);
      functionBody = ` BEGIN IF NEW.request_id='${slot.reservation.requestId}'::uuid AND NEW.kind='dispatch_started' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='korean_fixture_dispatch_event_fault'; END IF; RETURN NEW; END `;
      attempted = true;
      await admin.begin(async tx => {
        await tx.unsafe(`CREATE FUNCTION public.${fault}() RETURNS trigger LANGUAGE plpgsql AS $$${functionBody}$$`);
        await tx.unsafe(`CREATE TRIGGER ${fault} BEFORE INSERT ON model_capacity_events FOR EACH ROW EXECUTE FUNCTION public.${fault}()`);
      });
      try { await tracked(prepareKoreanTaglineDispatch(tasks, [], lease, { roleLease: role, call: slot.call,
        reserved: { ...slot, members: slot.ready.members, role: slot.ready.role } })); }
      catch (error) { original = error; }
      await tracked(cancelReservedModelSlot(slot.reservation));
      throw original;
    })).toMatchObject({ status: "failed" }); expect(bodies).toHaveLength(0);
    // Assert outside the actual runner catch boundary; a swallowed AssertionError is not fault evidence.
    expect(original).toBeDefined(); let cause = original, found = false;
    for (let index = 0; index < 6 && cause instanceof Error; index++, cause = cause.cause) if (cause.message.includes("korean_fixture_dispatch_event_fault")) found = true;
    expect(found).toBe(true);
    expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix} AND dispatch_binding IS NOT NULL`).toEqual([]);
    expect(await admin`SELECT id FROM model_capacity_events WHERE request_id IN (SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}) AND kind='dispatch_started'`).toEqual([]);
    expect(await admin`SELECT product_id FROM product_korean_taglines WHERE product_id=${product.id}`).toEqual([]);
    const [job] = await admin`SELECT requested_version,processed_version FROM jobs WHERE name=${jobName}`; expect(Number(job.processed_version)).toBeLessThan(Number(job.requested_version));
  }); } catch (error) { errors.push(error); }
  finally { await steps([async () => { if (!attempted) return;
    await admin.begin(async tx => {
      const functions = await tx`SELECT oid,prosrc,prorettype::regtype::text AS returns,pronargs,prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=${fault}`;
      const triggers = await tx`SELECT tgfoid,tgtype,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname=${fault}`;
      if (!functions.length && !triggers.length) return; // The atomic CREATE rolled back before commit.
      expect(functions).toHaveLength(1); expect(triggers).toHaveLength(1);
      expect(functions[0]).toMatchObject({ prosrc: functionBody, returns: "trigger", pronargs: 0, prosecdef: false });
      expect(triggers[0]).toEqual({ tgfoid: functions[0].oid, tgtype: 7, tgenabled: "O" });
      await tx.unsafe(`DROP TRIGGER ${fault} ON model_capacity_events`); await tx.unsafe(`DROP FUNCTION public.${fault}()`);
    }); }], errors); }
}), 20_000);

it("keeps EOF full-C unknown fenced across changed source and a genuinely re-elected owner boot", exercise(async () => {
  const { products: [product] } = await seed(); await server(async ({ bodies, setReply }) => {
    setReply(response => { response.end('{"id":"partial"'); });
    expect(await tick()).toMatchObject({ status: "completed" }); expect(bodies).toHaveLength(1);
    const [unknown] = await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${prefix}`;
    expect(unknown.row).toMatchObject({ state: "indeterminate", terminal_evidence: null,
      dispatch_binding: { totalTokenBound: 8000, chargedTokens: 8000 } });
    expect((await admin`SELECT attempts,error_code IS NOT NULL AS failed FROM product_korean_taglines WHERE product_id=${product.id}`)[0]).toEqual({ attempts: 1, failed: true });
    expect(await tracked(releaseRole(role))).toBe(true); await elect(); expect(role.bootId).not.toBe(unknown.row.owner_boot_id);
    await tracked(db.update(products).set({ tagline: "Search and organize documents for teams" }).where(eq(products.id, product.id)));
    const [changed] = await admin`SELECT to_jsonb(t) AS row FROM product_korean_taglines t WHERE product_id=${product.id}`;
    expect(changed.row).toMatchObject({ attempts: 1 }); // original cache is historical; new source is eligible without mutating it
    expect((await tracked(pendingKoreanTaglines(16, []))).find(task => task.productId === product.id)?.attempts).toBe(0);
    expect(await tick()).toMatchObject({ status: "deferred", reason: "model_capacity" }); expect(bodies).toHaveLength(1);
    expect((await admin`SELECT to_jsonb(t) AS row FROM product_korean_taglines t WHERE product_id=${product.id}`)[0].row).toEqual(changed.row);
    expect((await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE request_id=${unknown.row.request_id}::uuid`)[0].row).toEqual(unknown.row);
    expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}`).toHaveLength(1);
  });
}), 20_000);

it("settles the historical physical terminal before rejecting the expired current job and withholding its ACK", exercise(async () => {
  const { products: [product] } = await seed(); await server(async ({ bodies, setReply }) => {
    const arrived = latch(); let response: ServerResponse | undefined;
    setReply(value => { response = value; arrived.resolve(); });
    const running = tracked(tick()), errors: unknown[] = [];
    const before = await admin`SELECT to_jsonb(t) AS row FROM product_korean_taglines t WHERE product_id=${product.id}`;
    try { await barrier(arrived.promise, running);
      const [anchor] = await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '90 seconds'+interval '500 milliseconds'
        WHERE name=${jobName} AND lease_token IS NOT NULL RETURNING (locked_at+interval '90 seconds')::text AS expiry`;
      expect(anchor).toBeDefined();
      await until(async () => (await admin`SELECT clock_timestamp()>${anchor.expiry}::text::timestamptz AS past`)[0].past);
      response!.end(JSON.stringify(replyBody()));
      expect(await running).toMatchObject({ status: "failed", error: "job_lease_lost" }); expect(bodies).toHaveLength(1);
      expect((await admin`SELECT state,terminal_evidence IS NOT NULL AS terminal FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0]).toEqual({ state: "settled", terminal: true });
      expect(await admin`SELECT to_jsonb(t) AS row FROM product_korean_taglines t WHERE product_id=${product.id}`).toEqual(before);
      const [job] = await admin`SELECT requested_version,processed_version FROM jobs WHERE name=${jobName}`; expect(Number(job.processed_version)).toBeLessThan(Number(job.requested_version));
    } catch (error) { errors.push(error); }
    finally { if (response && !response.writableEnded) response.end(JSON.stringify(replyBody())); await steps([() => running], errors); }
  });
}), 20_000);
