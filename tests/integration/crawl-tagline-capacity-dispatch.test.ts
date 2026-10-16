import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments } from "@/lib/db/schema";
import { TAGLINE_MODEL, taglineEvidence, crawlTaglineGatewayWire } from "@/lib/crawl/tagline";
import { pendingTaglines, prepareCrawlTaglineDispatch, recordTaglineResult, type TaglineTask } from "@/lib/crawl/taglines";
import { writeCrawlTaglineWithModelCapacity } from "@/lib/crawl/tagline-model-capacity";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { prepareCrawlTaglineGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { requestCrawlTaglineModelSlot, cancelReservedModelSlot } from "@/lib/llm/capacity-repository";
import { crawlTaglineInputHash, crawlTaglineLogicalWorkKey, modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { CrawlTaglineServingContract } from "@/lib/llm/crawl-tagline-serving-contract";
import { requestJob, type JobLease } from "@/lib/jobs/control";
import { runJob, type JobContext } from "@/lib/jobs/runner";
import { tryAcquireRole, releaseRole, type RoleLease } from "@/lib/jobs/role-leader";
import { jobsForRole } from "@/lib/jobs/catalog";
import { batchCanaryAnchorKey, batchPolicyHash } from "@/lib/jobs/batches";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// fresh 전용 테스트 DB만 허용한다(setup이 localhost·nomorevibe_test를 강제). 이 파일은 reset/truncate하지 않는다.
if (process.env.TEST_DATABASE_URL !== TEST_DATABASE_URL) throw new Error("crawl_tagline_runtime_test_database_required");
const serving = vi.hoisted(() => ({ contract: null as CrawlTaglineServingContract | null }));
vi.mock("@/lib/llm/crawl-tagline-serving-contract", async load => ({ ...await load<typeof import("@/lib/llm/crawl-tagline-serving-contract")>(),
  resolveCrawlTaglineServingContract: () => serving.contract }));
type Raw = Record<string, unknown>;
const prefix = `crawl-runtime-${randomUUID().slice(0, 12)}`, jobName = "crawl-tagline", ownRepos = new Set<string>(), boots = new Set<string>();
const managedJobs = [...new Set([...jobsForRole("text"), "crawl-publish"])].sort();
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
let initial: Record<string, Raw[]>, initialized = false, role: RoleLease, serial = 0;
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { local: 2 }, groupLimits: { local: 2 }, poolLimits: { reviewer: 2, text: 2 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: jobName, provider: "abcllm", model: TAGLINE_MODEL, providerBudgetId: "local", groupId: "local" }] };
const tracked = <T>(pending: PromiseLike<T>, set = work): Promise<T> => { const p = Promise.resolve(pending); set.add(p); void p.catch(() => {}); return p; };
const exercise = (run: () => Promise<void>) => () => tracked(Promise.resolve().then(run), exercises);
async function drain(set: Set<Promise<unknown>>, report = false) { const errors: unknown[] = [];
  while (set.size) { const pending = [...set], results = await Promise.allSettled(pending); pending.forEach(p => set.delete(p));
    for (const r of results) if (r.status === "rejected") errors.push(r.reason); }
  if (report && errors.length) throw new AggregateError(errors, "crawl_fixture_pending_failure");
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) { const errors = [...prior];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "crawl_fixture_cleanup_failed", { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) { const rows: Record<string, Raw[]> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    rows[tablename] = row.value;
  } return rows;
}
async function restore(tx: postgres.TransactionSql, table: string, key: string, value: string | number) {
  const saved = initial[table].find(row => row[key] === value), [current] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE "${key}"=$1 FOR UPDATE`, [value]);
  if (!current) { expect(saved).toBeUndefined(); return; }
  if (!saved) { expect(await tx.unsafe(`DELETE FROM ${table} t WHERE "${key}"=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING "${key}"`, [value, JSON.stringify(current.row)])).toHaveLength(1); return; }
  const cols = Object.keys(saved).map(c => '"' + c.replaceAll('"', '""') + '"').join(',');
  expect(await tx.unsafe(`UPDATE ${table} t SET (${cols})=(SELECT ${cols} FROM jsonb_populate_record(NULL::${table},$1::text::jsonb)) WHERE "${key}"=$2 AND to_jsonb(t)=$3::text::jsonb RETURNING "${key}"`,
    [JSON.stringify(saved), value, JSON.stringify(current.row)])).toHaveLength(1);
}
async function cleanup() { if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`SELECT id FROM job_batch_control WHERE id=1 FOR UPDATE`;
    const [owner] = await tx`SELECT owner_instance_id FROM role_leases WHERE role='text' FOR UPDATE`;
    expect(owner?.owner_instance_id === null || owner?.owner_instance_id === prefix || !owner).toBe(true);
    // 일부러 만료시킨 lease는 token이 남는다. 살아 있는 holder만 없으면 된다(아래 restore가 baseline으로 되돌린다).
    const locked = await tx`SELECT name,lease_token,locked_at<clock_timestamp()-${STALE_LOCK_MS}*interval '1 millisecond' AS stale
      FROM jobs WHERE name=ANY(${managedJobs}::text[]) ORDER BY name FOR UPDATE`;
    expect(locked.every(row => row.lease_token === null || row.stale === true)).toBe(true);
    const requests = await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal FOR UPDATE`;
    const ids = requests.map(({ row }) => { expect(boots.has(row.owner_boot_id)).toBe(true); expect(row.route_id).toBe(jobName); return row.request_id as string; });
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const guards = () => tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`;
    const expected = [{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }];
    expect(Array.from(await guards())).toEqual(expected);
    const events = await tx`SELECT id::text,request_id,to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) { await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events e WHERE id=${event.id}::bigint AND request_id=${event.request_id}::uuid
        AND to_jsonb(e)=${JSON.stringify(event.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`; }
    expect(Array.from(await guards())).toEqual(expected);
    for (const { row } of requests) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${row.request_id}::uuid
      AND owner_instance_id=${prefix} AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    for (const repo of ownRepos) for (const table of ["crawl_taglines", "crawl_candidates", "crawl_documents"]) {
      expect(initial[table].some(row => row.repo === repo)).toBe(false);
      const [current] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE repo=$1 FOR UPDATE`, [repo]);
      if (current) expect(await tx.unsafe(`DELETE FROM ${table} t WHERE repo=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING repo`, [repo, JSON.stringify(current.row)])).toHaveLength(1);
    }
    for (const candidate of await tx`SELECT role,instance_id,to_jsonb(c) AS row FROM job_batch_candidates c WHERE instance_id=${prefix} FOR UPDATE`)
      expect(await tx`DELETE FROM job_batch_candidates c WHERE role=${candidate.role} AND instance_id=${prefix} AND to_jsonb(c)=${JSON.stringify(candidate.row)}::text::jsonb RETURNING role`).toHaveLength(1);
    for (const [table, key, value] of [["model_capacity_control", "id", 1], ["job_batch_control", "id", 1], ["crawl_settings", "id", 1], ["role_leases", "role", "text"]] as const) await restore(tx, table, key, value);
    for (const name of managedJobs) await restore(tx, "jobs", "name", name);
    for (const key of [`job:${jobName}`, `batch-result:${prefix}:${jobName}`, batchCanaryAnchorKey("text", prefix)]) await restore(tx, "operations_observations", "key", key);
    expect(await whole(tx)).toEqual(initial); // foreign rows 및 raw µs 전체 보존; sequence는 되감지 않는다.
  }); ownRepos.clear();
}
function environment() { for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: role.role, ROLE_LEASE_INSTANCE_ID: role.instanceId,
  ROLE_LEASE_BOOT_ID: role.bootId, ROLE_LEASE_RELEASE: role.release, ROLE_LEASE_EPOCH: String(role.epoch),
  ROLE_LEASE_BATCH_VERSION: role.batchVersion ? "1" : undefined, ROLE_LEASE_BATCH_EPOCH: role.batchEpoch ? String(role.batchEpoch) : undefined, ROLE_LEASE_HOST: role.host })) vi.stubEnv(key, value); }
async function elect(versioned = false) { const bootId = randomUUID(); boots.add(bootId);
  const acquired = await tracked(tryAcquireRole({ role: "text", instanceId: prefix, bootId, release: "crawl-local", kind: "primary",
    ...(versioned ? { batchVersion: 1 as const, host: "m3" as const } : {}) }));
  expect(acquired).not.toBeNull(); if (!acquired) throw new Error("fixture_text_role_required"); role = acquired; environment();
}
async function seed(): Promise<TaglineTask> { const repo = `${prefix}/doc-${++serial}`;
  expect(await admin`SELECT repo FROM crawl_candidates WHERE repo=${repo}`).toEqual([]); ownRepos.add(repo);
  await tracked(db.insert(crawlDocuments).values({ repo, repoMeta: {}, productUrl: "https://doc.test", pageStatus: 200, pageMeta: { title: "Doc", textSample: "Document management tools" } }));
  await tracked(db.insert(crawlCandidates).values({ repo, productUrl: "https://doc.test", state: "needs_review", reason: "no_description", decidedBy: "auto" }));
  const selected = (await tracked(pendingTaglines(32))).find(task => task.candidate.repo === repo);
  expect(selected).toBeDefined(); if (!selected) throw new Error("fixture_pending_required"); return selected;
}
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 4000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("fixture_barrier_deadline"); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function barrier(ready: Promise<void>, operation: Promise<unknown>) { await Promise.race([ready, operation.then(value => { throw new Error("fixture_ended_before_barrier", { cause: value }); })]); }
async function blocking(pid: number, operation: Promise<unknown>) { let ended = false; void operation.then(() => { ended = true; }, () => { ended = true; });
  await until(async () => { if (ended) throw new Error("fixture_ended_before_block"); return (await admin`SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length > 0; }); }
const replyBody = (tagline = "Document manager") => ({ id: "crawl-local", object: "chat.completion", created: 1, model: "served-crawl",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ tagline, source: "page" }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 70, completion_tokens: 20, total_tokens: 90 }, usage_provenance: "upstream_reported" });
async function server(run: (state: { bodies: string[]; setReply: (reply: (response: ServerResponse) => void) => void }) => Promise<void>) {
  const bodies: string[] = [], responses = new Set<Promise<unknown>>(), errors: unknown[] = [];
  let reply = (response: ServerResponse) => { response.end(JSON.stringify(replyBody())); };
  const http = createServer((request, response) => { const closed = new Promise<void>(resolve => response.once("close", resolve));
    tracked((async () => { let body = ""; for await (const part of request) body += part.toString(); bodies.push(body); reply(response); await closed; })(), responses); });
  try { await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
    serving.contract = { version: 1, protocol: "abcllm-crawl-tagline-total-bound-v1", routeId: jobName, provider: "abcllm", model: TAGLINE_MODEL,
      responseModel: "served-crawl", deploymentRevision: "local-only", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, totalTokenBound: 8000 };
    await run({ bodies, setReply: next => { reply = next; } });
  } catch (error) { errors.push(error); }
  finally { serving.contract = null; const watchdog = setTimeout(() => { errors.push(new Error("fixture_forced_close_is_failure")); http.closeAllConnections(); }, 2000);
    // 기존 driver와 같이 클라이언트 작업이 모두 끝난 뒤에만 남은 연결을 정리한다(abort 뒤 undici가 빈 연결을 남길 수 있다).
    try { await steps([() => drain(work), () => { http.closeAllConnections(); return new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); }, () => drain(responses, true)], errors); }
    finally { clearTimeout(watchdog); }
    if (errors.length) throw new AggregateError(errors, "crawl_loopback_failed");
  }
}
async function tick() { await tracked(requestJob(jobName)); return tracked(runJob(jobName, writeTaglines, { requestedOnly: true, roleLease: role })); }
async function custom(run: (lease: JobLease) => Promise<void>) { await tracked(requestJob(jobName));
  return tracked(runJob(jobName, async (ctx: JobContext<null>) => { if (!ctx.lease) throw new Error("fixture_job_required"); await run(ctx.lease); return { done: true }; }, { requestedOnly: true, roleLease: role })); }
async function reserve(task: TaglineTask, lease: JobLease) {
  const call = prepareCrawlTaglineGatewayCall(taglineEvidence(task.candidate.repo, task.document), { model: TAGLINE_MODEL, timeoutMs: 45_000 });
  if (call.kind !== "prepared") throw new Error("fixture_call_required");
  const initial = await tracked(prepareCrawlTaglineDispatch(task, lease, { roleLease: role }));
  if (!("snapshot" in initial)) throw new Error("fixture_initial_required");
  const input = { member: initial.member, model: TAGLINE_MODEL, askOrdinal: 1 as const, parent: null };
  const identity = { owner: { instanceId: role.instanceId, bootId: role.bootId }, class: "background" as const, pool: "text" as const, routeId: jobName,
    provider: "abcllm", model: TAGLINE_MODEL, workKey: `${crawlTaglineLogicalWorkKey(input)}:${crawlTaglineInputHash(input)}` };
  const slot = await tracked(requestCrawlTaglineModelSlot({ ...identity, requestId: randomUUID() }, input));
  if (slot.kind !== "granted") throw new Error("fixture_slot_required");
  return { call, reserved: { reservation: slot.reservation, identity, input, initial } };
}
beforeAll(async () => {
  ensureSchema(); initial = await whole();
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toEqual([]);
  expect(await pendingTaglines(1)).toEqual([]);
  expect(initial.role_leases.filter(row => row.role === "text").every(row => row.owner_instance_id === null)).toBe(true);
  expect(initial.jobs.filter(row => managedJobs.includes(String(row.name))).every(row => row.lease_token === null)).toBe(true);
  expect(initial.job_batch_control[0]).toMatchObject({ mode: "legacy", writer_contract_version: 0 });
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] };
  expect(await admin`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).toEqual([{ n: journal.entries.length }]); initialized = true;
});
beforeEach(async () => { vi.stubEnv("ABCLLM_API_KEY", "local-only"); await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,
  policy_hash=${modelCapacityPolicyHash(policy)},cursor=0 WHERE id=1`;
  await admin`INSERT INTO crawl_settings(id,values) VALUES(1,'{"enabled":true}') ON CONFLICT(id) DO UPDATE SET values=crawl_settings.values||'{"enabled":true}'::jsonb`;
  await elect();
});
afterEach(() => tracked(steps([() => drain(exercises), () => drain(work), cleanup, async () => { serving.contract = null; vi.unstubAllEnvs(); }]), hooks));
afterAll(async () => { await steps([() => drain(exercises), () => drain(work), () => drain(hooks), cleanup, () => admin.end({ timeout: 5 }),
  async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end({ timeout: 5 }); }]); });

it("uses two independent actual requests/native proofs but one attempt and publish wakeup", exercise(async () => {
  const task = await seed();
  expect(await tick()).toMatchObject({ status: "deferred", reason: "model_capacity" });
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}`).toEqual([]);
  await server(async ({ bodies, setReply }) => { let asks = 0; setReply(response => response.end(JSON.stringify(replyBody(++asks === 1 ? "" : "Document manager"))));
    const before = await admin`SELECT requested_version FROM jobs WHERE name='crawl-publish'`;
    expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(2);
    expect(bodies).toEqual([crawlTaglineGatewayWire(taglineEvidence(task.candidate.repo, task.document), TAGLINE_MODEL), bodies[0]]);
    const rows = await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal`;
    expect(rows).toHaveLength(2); expect(rows[0].row.request_id).not.toBe(rows[1].row.request_id);
    expect(rows.map(({ row }) => row.dispatch_binding.askOrdinal)).toEqual([1, 2]);
    expect(rows.every(({ row }) => row.state === "settled" && row.dispatch_binding.role.role === "text" && row.dispatch_binding.role.batch.mode === "legacy")).toBe(true);
    expect(rows[1].row.dispatch_binding.parent).toEqual({ requestId: rows[0].row.request_id, bindingHash: rows[0].row.dispatch_binding_hash, responseHash: rows[0].row.terminal_evidence.responseHash });
    expect((await admin`SELECT attempts,tagline FROM crawl_taglines WHERE repo=${task.candidate.repo}`)[0]).toEqual({ attempts: 1, tagline: "Document manager" });
    expect(Number((await admin`SELECT requested_version FROM jobs WHERE name='crawl-publish'`)[0].requested_version)).toBe(Number(before[0]?.requested_version ?? 0) + 1);
    expect((await admin`SELECT requested_version=processed_version AS ack FROM jobs WHERE name=${jobName}`)[0].ack).toBe(true);
  });
}), 20_000);

it("admits actual versioned text role and job with explicit local operator readiness fixtures", exercise(async () => {
  expect(await tracked(releaseRole(role))).toBe(true);
  const batch = { version: 1 as const, release: "crawl-local", instances: [{ instanceId: prefix, host: "m3" as const }] };
  const [clock] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  const capability = { host: "m3", instanceId: prefix, release: "crawl-local", observedAt: clock.at, dbPrivileges: "verified", dbRole: "local-fixture",
    effectivePrivilegeHash: "a".repeat(64), modelBoundEvidenceHash: "b".repeat(64), http: "verified", model: "verified" };
  const result = { role: "text", batchEpoch: 1, job: jobName, instanceId: prefix, host: "m3", release: "crawl-local", bootId: role.bootId,
    recordedAt: clock.at, count: 1, requestedVersion: 1 };
  const readback = { job: result.job, instanceId: prefix, host: "m3", release: "crawl-local", requestedVersion: 1, domainReadbackHash: "c".repeat(64), observedAt: clock.at };
  // 모델/운영 권한 증명이 아니라 local batch election 입력 fixture다.
  await admin`INSERT INTO operations_observations(key,value) VALUES(${`batch-result:${prefix}:${jobName}`},${JSON.stringify({ batchResult: result })}::text::jsonb)`;
  await admin`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence)
    VALUES('text',${prefix},'m3',${role.bootId},'crawl-local',${batchPolicyHash(batch)},${JSON.stringify(capability)}::text::jsonb,${JSON.stringify(readback)}::text::jsonb)`;
  await admin`UPDATE job_batch_control SET mode='versioned',writer_contract_version=1,policy=${JSON.stringify(batch)}::text::jsonb,policy_hash=${batchPolicyHash(batch)} WHERE id=1`;
  await elect(true); await seed();
  await server(async ({ bodies }) => { expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(1);
    expect((await admin`SELECT dispatch_binding->'role' AS role FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0].role)
      .toMatchObject({ role: "text", batch: { mode: "versioned", host: "m3", batchEpoch: role.batchEpoch } }); });
}), 20_000);

it.each(["microsecond", "absent-insert", "source", "human"])("refuses %s replacement before native dispatch", exerciseCase(async race => {
  let task = await seed();
  if (race === "microsecond") { await admin`INSERT INTO crawl_taglines(repo,source,model,source_hash,document_at,error_code) VALUES(${task.candidate.repo},'page','fixture','',${task.document.fetchedAt},'network')`;
    task = (await pendingTaglines(32)).find(t => t.candidate.repo === task.candidate.repo)!; }
  await server(async ({ bodies }) => { expect(await custom(async lease => { const slot = await reserve(task, lease);
    try {
      if (race === "microsecond") await admin`UPDATE crawl_taglines SET updated_at=updated_at+interval '1 microsecond' WHERE repo=${task.candidate.repo}`;
      if (race === "source") await admin`UPDATE crawl_documents SET page_meta=page_meta||'{"title":"Replacement"}'::jsonb WHERE repo=${task.candidate.repo}`;
      if (race === "human") await admin`UPDATE crawl_candidates SET decided_by='admin',reason='manual_reject',state='rejected' WHERE id=${task.candidate.id}`;
      if (race === "absent-insert") await admin`INSERT INTO crawl_taglines(repo,source,model,source_hash,document_at,written_by,tagline) VALUES(${task.candidate.repo},'page','fixture','',${task.document.fetchedAt},'human','Human line')`;
      const before = await admin`SELECT to_jsonb(t) AS row FROM crawl_taglines t WHERE repo=${task.candidate.repo}`;
      expect(await tracked(prepareCrawlTaglineDispatch(task, lease, { roleLease: role, ...slot }))).toMatchObject({ kind: "skipped" });
      expect(await admin`SELECT to_jsonb(t) AS row FROM crawl_taglines t WHERE repo=${task.candidate.repo}`).toEqual(before);
      expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${slot.reserved.reservation.requestId}::uuid AND kind='dispatch_started'`).toEqual([]);
    } finally { await tracked(cancelReservedModelSlot(slot.reserved.reservation)); }
  })).toMatchObject({ status: "completed" }); expect(bodies).toHaveLength(0); });
}), 20_000);
function exerciseCase<T>(run: (value: T) => Promise<void>) { return (value: T) => tracked(Promise.resolve().then(() => run(value)), exercises); }
it.each(["request", "event"])("rolls back dispatch after an actual %s wait crosses the request DB wall", exerciseCase(async wait => {
  const task = await seed(); await server(async ({ bodies }) => { expect(await custom(async lease => {
    const slot = await reserve(task, lease), holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
    const [anchor] = await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()+interval '800 milliseconds'
      WHERE request_id=${slot.reserved.reservation.requestId}::uuid RETURNING reserved_until::text AS expiry`;
    const ready = latch(), release = latch(); let pid = 0, dispatching: ReturnType<typeof prepareCrawlTaglineDispatch> | undefined;
    const holding = tracked(holder.begin(async tx => { if (wait === "event") await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
      else await tx`SELECT request_id FROM model_capacity_requests WHERE request_id=${slot.reserved.reservation.requestId}::uuid FOR UPDATE`;
      pid = (await tx`SELECT pg_backend_pid() AS pid`)[0].pid; ready.resolve(); await release.promise; }));
    const errors: unknown[] = [];
    try { await barrier(ready.promise, holding);
      dispatching = tracked(prepareCrawlTaglineDispatch(task, lease, { roleLease: role, ...slot })); await blocking(pid, dispatching);
      await until(async () => (await admin`SELECT clock_timestamp()>${anchor.expiry}::text::timestamptz AS past`)[0].past);
      release.resolve(); await expect(dispatching).rejects.toMatchObject({ reason: "reservation_lost" }); await holding;
      expect((await admin`SELECT state,dispatch_binding,dispatched_at FROM model_capacity_requests WHERE request_id=${slot.reserved.reservation.requestId}::uuid`)[0])
        .toEqual({ state: "reserved", dispatch_binding: null, dispatched_at: null });
      expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${slot.reserved.reservation.requestId}::uuid AND kind='dispatch_started'`).toEqual([]);
    } catch (error) { errors.push(error); }
    finally { release.resolve(); await steps([() => holding, async () => { if (dispatching) await Promise.allSettled([dispatching]); },
      () => holder.end({ timeout: 5 }), () => tracked(cancelReservedModelSlot(slot.reserved.reservation))], errors); }
    throw new ModelCapacityDeferredError("reservation_lost");
  })).toMatchObject({ status: "deferred", reason: "model_capacity" }); expect(bodies).toHaveLength(0);
    expect(await admin`SELECT repo FROM crawl_taglines WHERE repo=${task.candidate.repo}`).toEqual([]);
    expect((await admin`SELECT processed_version<requested_version AS pending FROM jobs WHERE name=${jobName}`)[0].pending).toBe(true);
  });
}), 20_000);

it.each([1, 2])("resumes settled ask%d after a writer crash with no extra native call", async ordinal => exercise(async () => {
  const task = await seed(); await server(async ({ bodies, setReply }) => { let asks = 0; setReply(response => response.end(JSON.stringify(replyBody(ordinal === 2 && ++asks === 1 ? "" : "Document manager"))));
    expect(await custom(async lease => {
      let outcome = await tracked(writeCrawlTaglineWithModelCapacity(task, lease, { roleLease: role, timeoutMs: 45_000 }));
      if (outcome.kind !== "result") throw new Error("fixture_result_required");
      if (ordinal === 2) outcome = await tracked(writeCrawlTaglineWithModelCapacity(task, lease, { roleLease: role, timeoutMs: 45_000, previous: outcome }));
      expect(outcome).toMatchObject({ kind: "result", askOrdinal: ordinal });
      // 물리 settle 뒤 최종 writer를 호출하지 않은 crash 경계.
    })).toMatchObject({ status: "completed" });
    expect(await admin`SELECT repo FROM crawl_taglines WHERE repo=${task.candidate.repo}`).toEqual([]);
    expect(await tick()).toMatchObject({ status: "completed", done: true }); expect(bodies).toHaveLength(ordinal);
    expect((await admin`SELECT attempts,tagline FROM crawl_taglines WHERE repo=${task.candidate.repo}`)[0]).toEqual({ attempts: 1, tagline: "Document manager" });
  });
})(), 20_000);

it("settles late physical history but rejects expired job domain, outbox and ACK", exercise(async () => {
  const task = await seed(); await server(async ({ bodies, setReply }) => { const arrived = latch(); let response: ServerResponse | undefined;
    setReply(value => { response = value; arrived.resolve(); }); const running = tracked(tick()), errors: unknown[] = [];
    try { await barrier(arrived.promise, running);
      expect(await admin`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`).toEqual([]);
      const before = await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name='crawl-publish'`;
      await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '91 seconds' WHERE name=${jobName} AND lease_token IS NOT NULL`;
      response!.end(JSON.stringify(replyBody())); expect(await running).toMatchObject({ status: "failed", error: "job_lease_lost" });
      expect(bodies).toHaveLength(1); expect((await admin`SELECT state,terminal_evidence IS NOT NULL AS terminal FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0])
        .toEqual({ state: "settled", terminal: true });
      expect(await admin`SELECT repo FROM crawl_taglines WHERE repo=${task.candidate.repo}`).toEqual([]);
      expect(await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name='crawl-publish'`).toEqual(before);
      expect((await admin`SELECT processed_version<requested_version AS pending FROM jobs WHERE name=${jobName}`)[0].pending).toBe(true);
    } catch (error) { errors.push(error); }
    finally { if (response && !response.writableEnded) response.end(JSON.stringify(replyBody())); await steps([() => running], errors); }
  });
}), 20_000);

it.each(["EOF", "abort"])("retains full C after %s and fences reentry across source/boot change", exerciseCase(async failure => {
  let task = await seed(); await server(async ({ bodies, setReply }) => {
    const controller = new AbortController(); setReply(response => { if (failure === "EOF") response.end('{"partial":'); else controller.abort(); });
    expect(await custom(async lease => {
      const outcome = await tracked(writeCrawlTaglineWithModelCapacity(task, lease, { roleLease: role, timeoutMs: 1000, signal: controller.signal }));
      expect(outcome).toMatchObject({ kind: "result", result: { ok: false } });
    })).toMatchObject({ status: "completed" }); expect(bodies).toHaveLength(1);
    const [unknown] = await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${prefix}`;
    expect(unknown.row).toMatchObject({ state: "indeterminate", terminal_evidence: null, dispatch_binding: { chargedTokens: 8000, totalTokenBound: 8000 } });
    expect(await tracked(releaseRole(role))).toBe(true); await elect(); expect(role.bootId).not.toBe(unknown.row.owner_boot_id);
    await admin`UPDATE crawl_documents SET page_meta=page_meta||'{"title":"Changed"}'::jsonb WHERE repo=${task.candidate.repo}`;
    task = (await pendingTaglines(32)).find(t => t.candidate.repo === task.candidate.repo)!;
    expect(await tick()).toMatchObject({ status: "deferred", reason: "model_capacity" }); expect(bodies).toHaveLength(1);
    expect((await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE request_id=${unknown.row.request_id}::uuid`)[0].row).toEqual(unknown.row);
    expect(await admin`SELECT repo FROM crawl_taglines WHERE repo=${task.candidate.repo}`).toEqual([]);
  });
}), 20_000);

it("preserves disabled legacy cache against an older positive writer without consuming positive history", exercise(async () => {
  const task = await seed(); await server(async ({ bodies }) => {
    expect(await custom(async lease => {
      const outcome = await tracked(writeCrawlTaglineWithModelCapacity(task, lease, { roleLease: role, timeoutMs: 45_000 }));
      if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("fixture_positive_required");
      await admin`UPDATE model_capacity_control SET mode='disabled' WHERE id=1`;
      expect(await tracked(writeCrawlTaglineWithModelCapacity(task, lease, { roleLease: role, timeoutMs: 45_000 }))).toEqual({ kind: "disabled" });
      expect(await tracked(recordTaglineResult(task, lease, { kind: "success", tagline: "Legacy line", source: "page", model: TAGLINE_MODEL }))).toMatchObject({ stored: true });
      const [legacy] = await admin`SELECT to_jsonb(t) AS row FROM crawl_taglines t WHERE repo=${task.candidate.repo}`;
      expect(await tracked(recordTaglineResult(task, lease, { kind: "success", tagline: outcome.result.tagline, source: outcome.result.source, model: TAGLINE_MODEL }, outcome.expectation)))
        .toEqual({ stored: false, released: false });
      expect((await admin`SELECT to_jsonb(t) AS row FROM crawl_taglines t WHERE repo=${task.candidate.repo}`)[0].row).toEqual(legacy.row);
    })).toMatchObject({ status: "completed" }); expect(bodies).toHaveLength(1);
  });
}), 20_000);
