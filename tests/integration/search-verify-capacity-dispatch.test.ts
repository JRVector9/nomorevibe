import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { products, productSearchProfiles } from "@/lib/db/schema";
import { profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { VERIFY_MODEL } from "@/lib/domain/products/search-verify";
import { pendingVerifications, prepareSearchVerifyModelDispatch, recordVerificationResult, type ProfileTask } from "@/lib/domain/products/search-profiles";
import { verifyKeywordsWithModelCapacity } from "@/lib/domain/products/search-verify-model-capacity";
import { prepareSearchVerifyGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { runJob, type JobContext } from "@/lib/jobs/runner";
import { requestJob, type JobLease } from "@/lib/jobs/control";
import { JobLeaseLostError } from "@/lib/jobs/lease";
import { tryAcquireRole, type RoleLease } from "@/lib/jobs/role-leader";
import { requestModelSlot, requestSearchVerifyModelSlot, cancelReservedModelSlot } from "@/lib/llm/capacity-repository";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { modelCapacityPolicyHash, searchVerifyInputHash, searchVerifyLogicalWorkKey, type ModelCapacityPolicy,
  type ModelCapacityRequest, type SearchVerifyInput, type SearchVerifyMember } from "@/lib/llm/capacity";
import type { SearchVerifyServingContract } from "@/lib/llm/search-verify-serving-contract";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// 실제 PostgreSQL + loopback native 전용. provider/serving 계약은 fixture이며 실제 C·배포를 주장하지 않는다.
const serving = vi.hoisted(() => ({ contract: null as SearchVerifyServingContract | null }));
vi.mock("@/lib/llm/search-verify-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/search-verify-serving-contract")>(), resolveSearchVerifyServingContract: () => serving.contract,
}));
type Raw = Record<string, unknown>;
const prefix = `sv-native-${randomUUID().slice(0, 12)}`, jobName = "product-search-verify", busyRoute = `${prefix}-busy`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const ownBoots = new Set<string>(), ownProducts = new Map<number, string>();
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>(), setups = new Set<Promise<unknown>>();
let initial: Record<string, unknown>, initialized = false, role: RoleLease, serial = 0, cleaning: Promise<void> | undefined;
const basePolicy = (limit: number, change: Partial<ModelCapacityPolicy> = {}): ModelCapacityPolicy => ({ version: 1, globalLimit: limit,
  providerLimits: { account: limit }, groupLimits: { engine: limit }, poolLimits: { reviewer: limit, text: limit },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: jobName, provider: "abcllm", model: VERIFY_MODEL, providerBudgetId: "account", groupId: "engine" },
    { routeId: busyRoute, provider: "fixture", model: VERIFY_MODEL, providerBudgetId: "account", groupId: "engine" }], ...change });
const tracked = <T>(pending: PromiseLike<T>, set = work): Promise<T> => { const actual = Promise.resolve(pending); set.add(actual); void actual.catch(() => {}); return actual; };
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), exercises);
async function drain(set: Set<Promise<unknown>>, report = false) {
  const errors: unknown[] = [];
  while (set.size) { const pending = [...set], results = await Promise.allSettled(pending);
    for (const promise of pending) set.delete(promise);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason); }
  if (report && errors.length) throw new AggregateError(errors, "search_verify_fixture_pending_failure");
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "search_verify_fixture_cleanup_failed", { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  } return result;
}
const baseline = (table: string): Raw[] => initial[table] as Raw[];
async function restore(tx: postgres.TransactionSql, table: "model_capacity_control" | "role_leases" | "jobs" | "operations_observations", key: string, value: string | number) {
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
    const requests = await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id LIKE ${prefix + "%"} ORDER BY queue_ordinal FOR UPDATE`;
    const ids = requests.map(({ row }) => { expect(ownBoots.has(row.owner_boot_id)).toBe(true); expect([jobName, busyRoute]).toContain(row.route_id);
      if (row.logical_member_keys) expect(row.logical_member_keys.every((key: string) => ownProducts.has(Number(/^search-verify:(\d+)$/.exec(key)?.[1])))).toBe(true);
      return row.request_id as string; });
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const guards = async () => Array.from(await tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`);
    const expected = [{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }];
    expect(await guards()).toEqual(expected);
    const events = await tx`SELECT id::text,request_id,to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events e WHERE id=${event.id}::bigint AND request_id=${event.request_id}::uuid AND to_jsonb(e)=${JSON.stringify(event.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    expect(await guards()).toEqual(expected);
    for (const { row } of requests) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${row.request_id}::uuid AND owner_instance_id LIKE ${prefix + "%"} AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    for (const [id, slug] of ownProducts) {
      expect(baseline("products").some(row => row.id === id || row.slug === slug)).toBe(false);
      const [current] = await tx`SELECT to_jsonb(p) AS row FROM products p WHERE id=${id} AND slug=${slug} FOR UPDATE`; expect(current).toBeDefined();
      expect(await tx`DELETE FROM products p WHERE id=${id} AND slug=${slug} AND to_jsonb(p)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      for (const purge of await tx`SELECT id,to_jsonb(c) AS row FROM cdn_purges c WHERE slug=${slug} FOR UPDATE`) {
        expect(baseline("cdn_purges").some(row => row.id === purge.id || row.slug === slug)).toBe(false);
        expect(await tx`DELETE FROM cdn_purges c WHERE id=${purge.id} AND slug=${slug} AND to_jsonb(c)=${JSON.stringify(purge.row)}::text::jsonb RETURNING id`).toHaveLength(1); }
    }
    await restore(tx, "model_capacity_control", "id", 1); await restore(tx, "role_leases", "role", "text"); await restore(tx, "jobs", "name", jobName);
    await restore(tx, "operations_observations", "key", `job:${jobName}`); await restore(tx, "operations_observations", "key", `batch-result:${prefix}:${jobName}`);
    expect(await whole(tx)).toEqual(initial);
  }); ownProducts.clear();
}
function cleanup() { if (cleaning) return cleaning; const pending = performCleanup(); cleaning = pending;
  void pending.then(() => { if (cleaning === pending) cleaning = undefined; }, () => {}); return pending; }
async function install(mode = "open", policy = basePolicy(4)) { await admin`UPDATE model_capacity_control SET mode=${mode},policy=${JSON.stringify(policy)}::text::jsonb,
  policy_hash=${modelCapacityPolicyHash(policy)},epoch=epoch+1,cursor=0,updated_at=clock_timestamp() WHERE id=1`; }
async function elect() {
  const bootId = randomUUID(); ownBoots.add(bootId);
  const acquired = await tracked(tryAcquireRole({ role: "text", instanceId: prefix, bootId, release: "local-verify-fixture", kind: "primary" }));
  expect(acquired).not.toBeNull(); if (!acquired) throw new Error("fixture_role_required"); role = acquired;
}
async function seed(en: string[], verifyError: string | null = "invalid_output"): Promise<ProfileTask> {
  const slug = `${prefix}-${++serial}`;
  expect(await admin`SELECT id FROM products WHERE slug=${slug}`).toEqual([]);
  const [row] = await tracked(db.insert(products).values({ slug, name: `Academy ${serial}`, url: `https://${slug}.test`, tagline: "Sports academy software",
    description: "Manage classes and members", category: "Sports", status: "seeded", source: "crawler", verifyToken: "fixture", editTokenHash: "fixture",
    searchKeywords: en.join(" · ") }).returning());
  ownProducts.set(row.id, slug);
  await tracked(db.insert(productSearchProfiles).values({ productId: row.id, keywordsEn: en, keywordsKo: [], sourceHash: profileHash(profileEvidence(row, null)),
    model: "fixture", attempts: 1, verifyAttempts: verifyError ? 1 : 0, verifyError }));
  const task = (await tracked(pendingVerifications(1000))).find(candidate => candidate.product.id === row.id);
  expect(task).toBeDefined(); return task!;
}
const keywords = (count: number, tag = "k") => Array.from({ length: count }, (_, index) => `${tag}${serial + 1}-${index}`);
const envelope = (content: string) => ({ id: "verify-local", object: "chat.completion", created: 1, model: "served-verify",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 70, completion_tokens: 20, total_tokens: 90 }, usage_provenance: "upstream_reported" });
type Reply = (sent: string[], response: ServerResponse) => Promise<void> | void;
const fits = (unsupported: readonly string[], rewrite = false): Reply => (sent, response) => {
  const checks = sent.map(keyword => ({ keyword: rewrite && sent.length === 5 ? `${keyword} rewritten` : keyword, fits: !unsupported.includes(keyword) }));
  response.end(JSON.stringify(envelope(JSON.stringify({ product: "academy", checks }))));
};
async function server(run: (state: { bodies: string[][]; idle: number[]; visible: number[]; setReply: (reply: Reply) => void }) => Promise<void>) {
  const bodies: string[][] = [], idle: number[] = [], visible: number[] = [], responses = new Set<Promise<unknown>>(), failures: unknown[] = [];
  let reply: Reply = fits([]);
  const http = createServer((request, response) => { const closed = new Promise<void>(resolve => response.once("close", resolve));
    tracked((async () => { let body = ""; for await (const part of request) body += part.toString();
      const sent = JSON.parse(JSON.parse(body).messages[1].content.split("\n")[1]).keywords as string[]; bodies.push(sent);
      // Commit ACK precedes POST and no app DB transaction is held across the external call.
      idle.push((await admin`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND state LIKE 'idle in transaction%'`)[0].count);
      visible.push((await admin`SELECT count(*)::int AS count FROM model_capacity_requests WHERE owner_instance_id=${prefix} AND state='dispatched'`)[0].count);
      await reply(sent, response); await closed; })(), responses); });
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
    serving.contract = { version: 1, protocol: "abcllm-search-verify-total-bound-v1", routeId: jobName, provider: "abcllm", model: VERIFY_MODEL,
      responseModel: "served-verify", deploymentRevision: "local-only", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, totalTokenBound: 8000 };
    await run({ bodies, idle, visible, setReply: next => { reply = next; } });
  } catch (error) { failures.push(error); }
  finally { serving.contract = null; await steps([() => drain(work),
    () => new Promise<void>((resolve, reject) => http.listening ? http.close(error => error ? reject(error) : resolve()) : resolve()), () => drain(responses, true)], failures); }
}
async function custom(run: (lease: JobLease) => Promise<void>) { await tracked(requestJob(jobName));
  return tracked(runJob(jobName, async (ctx: JobContext<null>) => { expect(ctx.lease).toBeDefined(); await run(ctx.lease!); return { done: true }; }, { requestedOnly: true, roleLease: role })); }
const verify = (task: ProfileTask, lease: JobLease, timeoutMs = 60_000, request?: typeof fetch) => tracked(verifyKeywordsWithModelCapacity(task, lease,
  { timeoutMs, chunked: !!task.profile!.verifyError, roleLease: role, request }));
const ledger = async (productId: number) => Array.from(await admin`SELECT request_id,state,dispatch_binding AS binding,terminal_evidence->'outcome' AS outcome,
  logical_member_keys FROM model_capacity_requests WHERE route_id=${jobName} AND logical_member_keys && ARRAY[${`search-verify:${productId}`}]::text[] ORDER BY queue_ordinal`);
const profileRow = async (productId: number) => (await admin`SELECT to_jsonb(p) AS row FROM product_search_profiles p WHERE product_id=${productId}`)[0].row as Raw;
async function busy() {
  const request: ModelCapacityRequest = { requestId: randomUUID(), workKey: `${busyRoute}:hold`, owner: { instanceId: `${prefix}-b`, bootId: role.bootId },
    class: "background", pool: "text", routeId: busyRoute, provider: "fixture", model: VERIFY_MODEL };
  return { request, poll: () => tracked(requestModelSlot(request)) };
}

beforeAll(() => tracked((async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toContain("0092_model_capacity_search_verify_terminal");
  const [applied] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  expect((await admin`SELECT indexdef FROM pg_indexes WHERE indexname='model_capacity_requests_search_verify_step_idx'`)[0]?.indexdef).toContain("(dispatch_binding -> 'step'::text)");
  initial = await whole();
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toEqual([]);
  expect(baseline("role_leases").filter(row => row.role === "text").every(row => row.owner_instance_id === null)).toBe(true);
  expect(baseline("jobs").filter(row => row.name === jobName).every(row => row.lease_token === null)).toBe(true);
  initialized = true;
})(), setups));
beforeEach(() => tracked((async () => { vi.stubEnv("ABCLLM_API_KEY", "local-only"); await install(); await elect(); })(), setups));
afterEach(() => tracked(steps([() => drain(setups), () => drain(exercises), () => drain(work), cleanup,
  async () => { serving.contract = null; vi.unstubAllEnvs(); }]), hooks));
afterAll(async () => { await steps([() => drain(setups), () => drain(exercises), () => drain(work), () => drain(hooks), cleanup,
  () => admin.end({ timeout: 5 }), async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end({ timeout: 5 }); }]); });

it("dispatches each chunk and singleton under its own permit and writes only the complete verification", exercise(async () => {
  const words = keywords(7), task = await seed(words), before = await profileRow(task.product.id);
  await server(async ({ bodies, idle, visible, setReply }) => {
    setReply(fits([words[2]], true));
    expect(await custom(async lease => {
      const outcome = await verify(task, lease);
      expect(outcome).toMatchObject({ kind: "result", result: { ok: true, unsupported: [words[2]] } });
      if (outcome.kind !== "result" || !outcome.expectation) throw new Error("fixture_positive_result_required");
      expect(await tracked(recordVerificationResult(task, lease, { kind: "success", removed: outcome.result.ok ? outcome.result.unsupported : [], model: VERIFY_MODEL }, outcome.expectation))).toBe(true);
    })).toMatchObject({ status: "completed" });
    expect(bodies.map(sent => sent.length)).toEqual([5, 1, 1, 1, 1, 1, 2]);
    expect(idle.every(count => count === 0)).toBe(true); expect(visible).toEqual(bodies.map(() => 1));
  });
  const rows = await ledger(task.product.id);
  expect(rows.map(row => [row.state, row.binding.step])).toEqual([["settled", { kind: "chunk", chunk: 0 }],
    ...[0, 1, 2, 3, 4].map(item => ["settled", { kind: "single", chunk: 0, item }]), ["settled", { kind: "chunk", chunk: 1 }]]);
  expect(rows[0].outcome).toEqual({ ok: false, error: "invalid_output" });
  expect(rows.every((row, index) => index === 0 ? row.binding.parent === null : row.binding.parent.requestId === rows[index - 1].request_id)).toBe(true);
  expect(new Set(rows.map(row => row.binding.deadlineAt)).size).toBe(1); expect(new Set(rows.map(row => row.binding.execution))).toEqual(new Set([0]));
  expect(rows.every(row => row.binding.chargedTokens === 8000 && row.binding.role.instanceId === prefix)).toBe(true);
  for (const row of rows) expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${row.request_id}::uuid ORDER BY id`).map(event => event.kind))
    .toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  const after = await profileRow(task.product.id);
  expect(after).toMatchObject({ removed_keywords: [words[2]], verify_attempts: Number(before.verify_attempts) + 1, verify_error: null, verify_model: VERIFY_MODEL });
  expect(after.verified_at).not.toBeNull();
  expect((await admin`SELECT search_keywords FROM products WHERE id=${task.product.id}`)[0].search_keywords).not.toContain(words[2]);
}), 20_000);

it("keeps a settled prefix durable on a capacity deferral and resumes the same execution inside its deadline", exercise(async () => {
  await install("open", basePolicy(1));
  const words = keywords(12), task = await seed(words), before = await profileRow(task.product.id), blocker = await busy();
  let waiting = "";
  await server(async ({ bodies, setReply }) => {
    let held = false;
    setReply(async (sent, response) => { if (!held) { held = true; expect(await blocker.poll()).toMatchObject({ kind: "deferred", reason: "capacity" }); }
      return fits([words[1], words[11]])(sent, response); });
    expect(await custom(async lease => {
      await expect(verify(task, lease)).rejects.toMatchObject({ reason: "capacity" });
    })).toMatchObject({ status: "completed" });
    expect(bodies.map(sent => sent.length)).toEqual([5]);
    expect(await profileRow(task.product.id)).toEqual(before);
    const partial = await ledger(task.product.id);
    expect(partial.map(row => [row.state, row.binding?.step ?? null])).toEqual([["settled", { kind: "chunk", chunk: 0 }], ["waiting", null]]);
    waiting = partial[1].request_id as string;
    const granted = await blocker.poll(); expect(granted.kind).toBe("granted");
    if (granted.kind === "granted") expect(await tracked(cancelReservedModelSlot(granted.reservation))).toBe(true);
    expect(await custom(async lease => {
      const outcome = await verify(task, lease);
      expect(outcome).toMatchObject({ kind: "result", result: { ok: true, unsupported: [words[1], words[11]] } });
      if (outcome.kind !== "result" || !outcome.expectation || !outcome.result.ok) throw new Error("fixture_positive_result_required");
      expect(await tracked(recordVerificationResult(task, lease, { kind: "success", removed: outcome.result.unsupported, model: VERIFY_MODEL }, outcome.expectation))).toBe(true);
    })).toMatchObject({ status: "completed" });
    expect(bodies.map(sent => sent.length)).toEqual([5, 5, 2]);
  });
  const rows = await ledger(task.product.id);
  expect(rows.map(row => [row.request_id === waiting, row.state, row.binding.execution, row.binding.step])).toEqual([
    [false, "settled", 0, { kind: "chunk", chunk: 0 }], [true, "settled", 0, { kind: "chunk", chunk: 1 }], [false, "settled", 0, { kind: "chunk", chunk: 2 }]]);
  expect(rows[1].binding.job.token).not.toBe(rows[0].binding.job.token); expect(rows[1].binding.deadlineAt).toBe(rows[0].binding.deadlineAt);
  expect(await profileRow(task.product.id)).toMatchObject({ verify_attempts: Number(before.verify_attempts) + 1, removed_keywords: [words[1], words[11]] });
}), 20_000);

it("discards an expired prefix without attempt or failure and starts a new execution with a fresh deadline", exercise(async () => {
  await install("open", basePolicy(1, { queueTtlMs: 1_500 }));
  const words = keywords(12), task = await seed(words), before = await profileRow(task.product.id), blocker = await busy();
  await server(async ({ bodies, setReply }) => {
    let held = false;
    setReply(async (sent, response) => { if (!held) { held = true; expect(await blocker.poll()).toMatchObject({ kind: "deferred" });
      return fits([words[0]])(sent, response); } return fits([words[6]])(sent, response); });
    expect(await custom(async lease => { await expect(verify(task, lease, 1_200)).rejects.toBeInstanceOf(ModelCapacityDeferredError); })).toMatchObject({ status: "completed" });
    const granted = await blocker.poll(); if (granted.kind === "granted") await tracked(cancelReservedModelSlot(granted.reservation));
    await new Promise(resolve => setTimeout(resolve, 1_700));
    expect(await profileRow(task.product.id)).toEqual(before);
    expect(await custom(async lease => {
      const outcome = await verify(task, lease);
      expect(outcome).toMatchObject({ kind: "result", result: { ok: true, unsupported: [words[6]] } });
    })).toMatchObject({ status: "completed" });
    expect(bodies.map(sent => sent.length)).toEqual([5, 5, 5, 2]);
  });
  const rows = (await ledger(task.product.id)).filter(row => row.state === "settled");
  expect(rows.map(row => [row.binding.execution, row.binding.step.chunk])).toEqual([[0, 0], [1, 0], [1, 1], [1, 2]]);
  expect(rows[1].binding.parent).toBeNull(); expect(rows[1].binding.deadlineAt - rows[0].binding.deadlineAt).toBeGreaterThan(55_000);
  expect(await profileRow(task.product.id)).toEqual(before);
}), 20_000);

it("refuses stale raw rows by one microsecond and a lost job lease after historical settlement", exercise(async () => {
  const words = keywords(3), task = await seed(words, null);
  await server(async ({ bodies }) => {
    let stale: Awaited<ReturnType<typeof verify>> | undefined, late: Awaited<ReturnType<typeof verify>> | undefined, lateLease: JobLease | undefined;
    await custom(async lease => {
      stale = await verify(task, lease);
      await admin`UPDATE product_search_profiles SET updated_at=updated_at+interval '1 microsecond' WHERE product_id=${task.product.id}`;
      if (stale.kind !== "result" || !stale.expectation) throw new Error("fixture_positive_result_required");
      expect(await tracked(recordVerificationResult(task, lease, { kind: "success", removed: [], model: VERIFY_MODEL }, stale.expectation))).toBe(false);
      await expect(recordVerificationResult(task, lease, { kind: "success", removed: [], model: VERIFY_MODEL }, stale.expectation)).rejects.toThrow("invalid_search_verify_write_expectation");
    });
    const [fresh] = (await tracked(pendingVerifications(1000))).filter(candidate => candidate.product.id === task.product.id);
    expect(await custom(async lease => { lateLease = lease; late = await verify(fresh, lease); })).toMatchObject({ status: "completed" });
    if (!late || late.kind !== "result" || !late.expectation || !lateLease) throw new Error("fixture_late_result_required");
    await expect(recordVerificationResult(fresh, lateLease, { kind: "success", removed: [], model: VERIFY_MODEL }, late.expectation)).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(bodies).toHaveLength(2);
  });
  expect((await ledger(task.product.id)).map(row => row.state)).toEqual(["settled", "settled"]);
  expect(await profileRow(task.product.id)).toMatchObject({ verified_at: null, verify_attempts: 0, removed_keywords: [] });
}), 20_000);

it("fences the fixed product target across owners, reuses own ID and blocks exact-step or numeric-spelling duplicates", exercise(async () => {
  const words = keywords(2), task = await seed(words, null);
  await server(async () => { await custom(async lease => { expect((await verify(task, lease)).kind).toBe("result"); }); });
  const [settled] = await ledger(task.product.id);
  const member = settled.binding.member as SearchVerifyMember, other = { ...member, profile: { ...member.profile, rowIdentityHash: "e".repeat(64) } };
  const request = (value: SearchVerifyMember, instanceId: string, bootId: string) => {
    const input: SearchVerifyInput = { member: value, model: VERIFY_MODEL, execution: 0, step: { kind: "full" }, parent: null };
    return { input, request: { requestId: randomUUID(), owner: { instanceId, bootId }, class: "background" as const, pool: "text" as const,
      routeId: jobName, provider: "abcllm", model: VERIFY_MODEL, workKey: `${searchVerifyLogicalWorkKey(input)}:${searchVerifyInputHash(input)}` } };
  };
  expect(await tracked(requestSearchVerifyModelSlot(request(member, prefix, role.bootId).request, request(member, prefix, role.bootId).input)))
    .toEqual({ kind: "deferred", reason: "capacity" });
  const first = request(other, prefix, role.bootId), bootB = randomUUID(); ownBoots.add(bootB);
  const granted = await tracked(requestSearchVerifyModelSlot(first.request, first.input)); expect(granted.kind).toBe("granted");
  expect((await admin`SELECT logical_member_keys FROM model_capacity_requests WHERE request_id=${first.request.requestId}::uuid`)[0].logical_member_keys).toEqual([`search-verify:${task.product.id}`]);
  const second = request({ ...other, profile: { ...other.profile, verifyAttempts: 9 } }, `${prefix}-b`, bootB);
  expect(await tracked(requestSearchVerifyModelSlot(second.request, second.input))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${second.request.requestId}::uuid`).toEqual([]);
  expect(await tracked(requestSearchVerifyModelSlot(first.request, first.input))).toEqual(granted);
  if (granted.kind === "granted") expect(await tracked(cancelReservedModelSlot(granted.reservation))).toBe(true);
  const copy = (binding: string) => admin.begin(async tx => tx`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,
    model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,logical_member_keys,dispatch_binding,dispatch_binding_hash,dispatched_at,token,
    reserved_until,queue_until) SELECT gen_random_uuid(),work_key,owner_instance_id,${bootB}::uuid,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,
    policy_hash,'dispatched',logical_work_key,logical_member_keys,${binding}::text::jsonb,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until
    FROM model_capacity_requests WHERE request_id=${settled.request_id}::uuid`);
  const moved = { ...settled.binding, role: { ...settled.binding.role, bootId: bootB } };
  await expect(copy(JSON.stringify(moved))).rejects.toMatchObject({ code: "23505", constraint_name: "model_capacity_requests_search_verify_step_idx" });
  await expect(copy(JSON.stringify(moved).replace('"execution":0', '"execution":0.0'))).rejects.toMatchObject({ code: "23514" });
  await expect(copy(JSON.stringify({ ...moved, step: { kind: "chunk", chunk: 0 } }))).rejects.toMatchObject({ code: "23514" });
}), 20_000);

it("rejects a forged parent and an expired reservation before any POST", exercise(async () => {
  const words = keywords(7), task = await seed(words);
  await server(async ({ bodies }) => {
    await custom(async lease => { expect((await verify(task, lease)).kind).toBe("result"); });
    const [root] = await ledger(task.product.id), count = bodies.length;
    const member = root.binding.member as SearchVerifyMember;
    const input: SearchVerifyInput = { member, model: VERIFY_MODEL, execution: 0, step: { kind: "single", chunk: 0, item: 0 },
      parent: { requestId: root.request_id, bindingHash: (await admin`SELECT dispatch_binding_hash AS hash FROM model_capacity_requests WHERE request_id=${root.request_id}::uuid`)[0].hash,
        responseHash: (await admin`SELECT terminal_evidence->>'responseHash' AS hash FROM model_capacity_requests WHERE request_id=${root.request_id}::uuid`)[0].hash } };
    const identity = { owner: { instanceId: prefix, bootId: role.bootId }, class: "background" as const, pool: "text" as const, routeId: jobName, provider: "abcllm",
      model: VERIFY_MODEL, workKey: `${searchVerifyLogicalWorkKey(input)}:${searchVerifyInputHash(input)}` };
    const slot = await tracked(requestSearchVerifyModelSlot({ ...identity, requestId: randomUUID() }, input)); expect(slot.kind).toBe("granted");
    if (slot.kind !== "granted") throw new Error("fixture_reservation_required");
    const call = prepareSearchVerifyGatewayCall({ evidence: profileEvidence(task.product, task.reviewerNote), keywords: [words[0]] }, { model: VERIFY_MODEL, timeoutMs: 60_000 });
    if (call.kind !== "prepared") throw new Error("fixture_call_required");
    await custom(async lease => {
      await expect(prepareSearchVerifyModelDispatch(task, lease, { roleLease: role, keywords: words, mode: "chunk", call,
        reserved: { reservation: slot.reservation, identity, input, role: root.binding.role, remainingMs: 60_000 } })).rejects.toThrow("search_verify_parent_mismatch");
    });
    expect(await tracked(cancelReservedModelSlot(slot.reservation))).toBe(true);
    await install("open", basePolicy(4, { reservationTtlMs: 200 }));
    const fresh = await seed(keywords(2), null), freshInput = { ...input, member: { ...member, productId: fresh.product.id, slug: fresh.product.slug, mode: "full" as const, keywordCount: 2 },
      step: { kind: "full" as const }, parent: null };
    const freshIdentity = { ...identity, workKey: `${searchVerifyLogicalWorkKey(freshInput)}:${searchVerifyInputHash(freshInput)}` };
    const expiring = await tracked(requestSearchVerifyModelSlot({ ...freshIdentity, requestId: randomUUID() }, freshInput)); expect(expiring.kind).toBe("granted");
    if (expiring.kind !== "granted") throw new Error("fixture_reservation_required");
    await new Promise(resolve => setTimeout(resolve, 300));
    await custom(async lease => {
      await expect(prepareSearchVerifyModelDispatch(fresh, lease, { roleLease: role, keywords: fresh.profile!.keywordsEn, mode: "full", call,
        reserved: { reservation: expiring.reservation, identity: freshIdentity, input: freshInput, role: root.binding.role, remainingMs: 60_000 } }))
        .rejects.toMatchObject({ reason: "reservation_lost" });
    });
    expect(bodies).toHaveLength(count);
    expect((await admin`SELECT count(*)::int AS count FROM model_capacity_requests WHERE owner_instance_id=${prefix} AND state IN ('dispatched','indeterminate')`)[0].count).toBe(0);
  });
}), 20_000);

it("keeps the disabled legacy leaf, wire and writer with no ledger row", exercise(async () => {
  await install("disabled");
  const words = keywords(3), task = await seed(words, null);
  await server(async ({ bodies, setReply }) => {
    setReply(fits([words[0]]));
    const request = ((_url: RequestInfo | URL, init?: RequestInit) => fetch(serving.contract!.endpoint, init)) as typeof fetch;
    expect(await custom(async lease => {
      const outcome = await verify(task, lease, 60_000, request);
      expect(outcome).toEqual({ kind: "result", result: { ok: true, unsupported: [words[0]] } });
      expect(await tracked(recordVerificationResult(task, lease, { kind: "success", removed: [words[0]], model: VERIFY_MODEL }))).toBe(true);
    })).toMatchObject({ status: "completed" });
    expect(bodies).toEqual([words]);
  });
  expect(await ledger(task.product.id)).toEqual([]);
  expect(await profileRow(task.product.id)).toMatchObject({ removed_keywords: [words[0]], verify_attempts: 1 });
}), 20_000);

it("re-verifies the settled ledger chain in the writer: a changed stored outcome or a different result writes nothing", exercise(async () => {
  await server(async ({ setReply }) => {
    for (const tamper of ["ledger_outcome", "result"] as const) {
      const words = keywords(7), current = await seed(words), before = await profileRow(current.product.id);
      setReply(fits([words[1], words[6]]));
      expect(await custom(async lease => {
        const outcome = await verify(current, lease);
        if (outcome.kind !== "result" || !outcome.expectation || !outcome.result.ok) throw new Error("fixture_positive_result_required");
        expect(outcome.result.unsupported).toEqual([words[1], words[6]]);
        let removed = outcome.result.unsupported;
        if (tamper === "ledger_outcome") {
          // A self-consistent stored row (matching evidence hash) whose parsed outcome differs from what this result claims.
          const rows = (await ledger(current.product.id)).filter(row => row.state === "settled");
          const [stored] = await admin`SELECT terminal_evidence FROM model_capacity_requests WHERE request_id=${rows.at(-2)!.request_id}::uuid`;
          const evidence = { ...stored.terminal_evidence, outcome: { ok: true, removed: [] } };
          await admin`UPDATE model_capacity_requests SET terminal_evidence=${JSON.stringify(evidence)}::text::jsonb,
            terminal_evidence_hash=${reviewHash(evidence)} WHERE request_id=${rows.at(-2)!.request_id}::uuid`;
        } else removed = [words[1]];
        expect(await tracked(recordVerificationResult(current, lease, { kind: "success", removed, model: VERIFY_MODEL }, outcome.expectation))).toBe(false);
      })).toMatchObject({ status: "completed" });
      expect(await profileRow(current.product.id)).toEqual(before);
    }
  });
}), 20_000);
