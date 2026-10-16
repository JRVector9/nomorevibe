import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { REVIEW_RETRIABLE_REASONS } from "@/lib/crawl/agent-review-contract";
import { runJob } from "@/lib/jobs/runner";
import { requestJob } from "@/lib/jobs/control";
import { fetchCrawlDocuments } from "@/lib/crawl/jobs/fetch";
import { getSettings } from "@/lib/crawl/settings";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { getDocument, getCandidate, recordAutomaticJudgement, claimFetchItem, markFrontier, dequeueWithAdmission } from "@/lib/crawl/repository";
const mocks = vi.hoisted(() => ({ repo: vi.fn() }));
vi.mock("@/lib/crawl/github", async original => ({ ...await original<typeof import("@/lib/crawl/github")>(), getRepo: mocks.repo }));
const client = postgres(TEST_DATABASE_URL, { max: 3 });
const prefix = "pr12-source-buffer";
const names = ["crawl-fetch", "crawl-judge", "crawl-agent-review", "crawl-publish"];
const observationKeys = ["crawl:source-buffer", ...names.map(name => `job:${name}`)];
type Raw = Record<string, unknown>;
let tables: string[] = [], baseline: Record<string, Raw[]>, originalBaseline: Record<string, Raw[]>, catalog: unknown;
let preparing: Promise<void> | undefined;
let setup: Promise<void> | undefined, cleaning: Promise<void> | undefined;
const heldRows: { table: "crawl_frontier" | "crawl_candidates"; original: Raw; held: Raw }[] = [];
const placeholders: Raw[] = [];
const work = new Set<Promise<unknown>>(), frontierIds = new Set<number>(), documentIds = new Set<number>(), candidateIds = new Set<number>();
const ownItemKeys = new Set<string>(), sourceRepos = new Set<string>(), jobTokens = new Set<string>();
const ownInsertedJobs = new Set<string>();
function track<T>(p: Promise<T>): Promise<T> { work.add(p); void p.catch(() => {}); return p; }
async function drain() {
  const pending = [...work]; const settled = await Promise.allSettled(pending);
  pending.forEach(p => work.delete(p));
  return settled;
}
async function snapshot(tx: postgres.Sql | postgres.TransactionSql = client) {
  const rows = await tx.unsafe(tables.map(table => `SELECT '${table}' AS name, coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${table}" t`).join(" UNION ALL "));
  return Object.fromEntries(rows.map(row => [row.name, row.rows])) as Record<string, Raw[]>;
}
async function catalogSnapshot() {
  return client`SELECT (select jsonb_agg(to_jsonb(t) order by relname) from
    (select relname,relacl from pg_class where relnamespace='public'::regnamespace) t) AS relations,
    (select datacl from pg_database where datname=current_database()) AS database_acl,
    (select coalesce(jsonb_agg(to_jsonb(t) order by oid),'[]'::jsonb) from pg_default_acl t) AS defaults,
    (select jsonb_agg(to_jsonb(t) order by rolname) from
      (select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolbypassrls from pg_roles) t) AS roles`;
}
async function restore(tx: postgres.TransactionSql, table: string, key: string, value: string | number) {
  const original = baseline[table].find(row => row[key] === value);
  const [selected] = await tx.unsafe(`SELECT to_jsonb(t) AS value FROM "${table}" t WHERE "${key}"=$1 FOR UPDATE`, [value]);
  const current = selected?.value as Raw | undefined;
  if (isDeepStrictEqual(current, original)) return;
  if (table === "jobs" && !original)
    expect(ownInsertedJobs.has(String(value)), "unowned absent-baseline job must remain untouched").toBe(true);
  if (table === "jobs" && current?.lease_token !== null && current?.lease_token !== undefined)
    expect(jobTokens.has(String(current.lease_token)), "unknown replacement job must remain untouched").toBe(true);
  expect(current, `missing managed row ${table}:${value}`).toBeDefined();
  if (!original) {
    const changed = await tx.unsafe(`DELETE FROM "${table}" t WHERE "${key}"=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING "${key}"`, [value, JSON.stringify(current)]);
    expect(changed).toHaveLength(1); return;
  }
  const fields = Object.keys(original).filter(field => field !== key).map(field => `"${field}"`);
  const changed = await tx.unsafe(`UPDATE "${table}" t SET (${fields.join(',')})=(${fields.map(field => `r.${field}`).join(',')}) FROM jsonb_populate_record(NULL::"${table}",$1::text::jsonb) r WHERE t."${key}"=$2 AND to_jsonb(t)=$3::text::jsonb RETURNING t."${key}"`, [JSON.stringify(original), value, JSON.stringify(current)]);
  expect(changed).toHaveLength(1);
}
async function cleanupOnce() {
  await setup; await drain(); if (!baseline) return;
  await client.begin(async tx => {
    if (ownItemKeys.size) await tx`DELETE FROM pipeline_item_leases WHERE stage='fetch' AND work_key=ANY(${[...ownItemKeys]})`;
    if (candidateIds.size) await tx`DELETE FROM crawl_candidates WHERE id=ANY(${[...candidateIds]}) AND repo LIKE ${prefix+'/%'}`;
    if (documentIds.size) await tx`DELETE FROM crawl_documents WHERE id=ANY(${[...documentIds]}) AND repo LIKE ${prefix+'/%'}`;
    if (sourceRepos.size) await tx`DELETE FROM crawl_documents WHERE repo=ANY(${[...sourceRepos]})`;
    if (frontierIds.size) await tx`DELETE FROM crawl_frontier WHERE id=ANY(${[...frontierIds]}) AND repo LIKE ${prefix+'/%'}`;
    for (const name of [...names].sort()) await restore(tx, "jobs", "name", name);
    for (const key of observationKeys) await restore(tx, "operations_observations", "key", key);
    await restore(tx, "crawl_settings", "id", 1);
    await restore(tx, "crawl_source_buffer_control", "id", 1);
    for (const stage of ["fetch", "ai1", "ai2"]) await restore(tx, "pipeline_stage_modes", "stage", stage);
    expect(await snapshot(tx)).toEqual(baseline);
  });
  candidateIds.clear(); documentIds.clear(); frontierIds.clear(); ownItemKeys.clear(); sourceRepos.clear(); jobTokens.clear();
  ownInsertedJobs.clear();
  expect(await catalogSnapshot()).toEqual(catalog);
}
async function cleanup() {
  if (cleaning) return cleaning;
  const task = cleanupOnce(); cleaning = task;
  try { await task; } finally { if (cleaning === task) cleaning = undefined; }
}
async function restoreForeign() {
  if (!baseline || !originalBaseline) return;
  await client.begin(async tx => {
    for (const row of placeholders) {
      const changed = await tx`DELETE FROM crawl_candidates t WHERE id=${row.id as number}
        AND to_jsonb(t)=${JSON.stringify(row)}::text::jsonb RETURNING id`;
      expect(changed).toHaveLength(1);
    }
    for (const row of heldRows) {
      const changed = await tx.unsafe(`UPDATE "${row.table}" t SET state=r.state
        FROM jsonb_populate_record(NULL::"${row.table}",$1::text::jsonb) r
        WHERE t.id=$2 AND to_jsonb(t)=$3::text::jsonb RETURNING t.id`, [JSON.stringify(row.original), row.original.id as number, JSON.stringify(row.held)]);
      expect(changed).toHaveLength(1);
    }
    expect(await snapshot(tx)).toEqual(originalBaseline);
  });
  expect(await catalogSnapshot()).toEqual(catalog);
}
beforeAll(() => setup = (async () => {
  ensureSchema();
  tables = (await client`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`).map(row => row.tablename);
  const original = await snapshot(), originalCatalog = await catalogSnapshot();
  expect((await client`SELECT repo FROM crawl_frontier WHERE repo LIKE ${prefix+'/%'}`)).toHaveLength(0);
  expect((await client`SELECT repo FROM crawl_documents WHERE repo LIKE ${prefix+'/%'}`)).toHaveLength(0);
  expect((await client`SELECT repo FROM crawl_candidates WHERE repo LIKE ${prefix+'/%'}`)).toHaveLength(0);
  expect((await client`SELECT name FROM jobs WHERE lease_token IS NOT NULL AND locked_at>clock_timestamp()-interval '90 seconds' AND name=ANY(${names})`)).toHaveLength(0);
  const suspended: typeof heldRows = [], inserted: Raw[] = [];
  const isolated = await client.begin(async tx => {
    // These file-local holds exclude foreign work from the actual global handler/selectors.
    // Only state is changed; all original decisions, source bytes and stored microseconds survive.
    for (const table of ["crawl_frontier", "crawl_candidates"] as const) for (const row of original[table]) {
      const hold = table === "crawl_frontier" ? ["pending", "fetching"].includes(String(row.state))
        : ["new", "approved"].includes(String(row.state)) || row.state === "needs_review"
          && REVIEW_RETRIABLE_REASONS.some(reason => reason === row.reason);
      if (!hold) continue;
      const changed = await tx.unsafe(`UPDATE "${table}" t SET state=$1 WHERE id=$2 AND to_jsonb(t)=$3::text::jsonb RETURNING to_jsonb(t) AS value`,
        [table === "crawl_frontier" ? "done" : "rejected", row.id as number, JSON.stringify(row)]);
      expect(changed).toHaveLength(1);
      suspended.push({ table, original: row, held: changed[0].value });
    }
    for (const document of original.crawl_documents) {
      if (original.crawl_candidates.some(candidate => candidate.repo === document.repo)) continue;
      // A NULL joined candidate is unconditionally judge-eligible; only absent repos get an owned placeholder.
      const changed = await tx`INSERT INTO crawl_candidates(repo,state) VALUES(${String(document.repo)},'rejected')
        ON CONFLICT(repo) DO NOTHING RETURNING to_jsonb(crawl_candidates) AS value`;
      expect(changed).toHaveLength(1); inserted.push(changed[0].value);
    }
    return snapshot(tx);
  });
  originalBaseline = original; baseline = isolated; catalog = originalCatalog;
  heldRows.push(...suspended); placeholders.push(...inserted);
  writeFileSync(`/tmp/nomorevibe-pr12-b-fixture-baseline-20261016.json`, JSON.stringify({ originalBaseline, baseline, catalog, heldRows, placeholders }));
})());
function prepareCase() { return preparing = (async () => {
  await cleanup(); mocks.repo.mockReset().mockResolvedValue({ ok: true, value: { homepage: null, id: 997731, stargazers_count: 1 } });
  const settings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "off",
    agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: false, enforceEligibility: false },
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: false },
    discover: { ...DEFAULT_CRAWL_SETTINGS.discover, sourceBuffer: { enabled: true } } };
  const inserted = await client.begin(async tx => {
    const insertedNames: string[] = [];
    await tx`INSERT INTO crawl_settings(id,values) VALUES(1,${JSON.stringify(settings)}::text::jsonb)
      ON CONFLICT(id) DO UPDATE SET values=excluded.values`;
    for (const name of [...names].sort()) {
      const original = baseline.jobs.find(row => row.name === name);
      const changed = original
        ? await tx`UPDATE jobs t SET not_before=NULL,locked_at=NULL,lease_token=NULL
          WHERE name=${name} AND to_jsonb(t)=${JSON.stringify(original)}::text::jsonb RETURNING name`
        : await tx`INSERT INTO jobs(name) VALUES(${name}) ON CONFLICT(name) DO NOTHING RETURNING name`;
      expect(changed, `fixed job setup collision: ${name}`).toHaveLength(1);
      if (!original) insertedNames.push(name);
    }
    return insertedNames;
  });
  inserted.forEach(name => ownInsertedJobs.add(name));
})(); }
beforeEach(prepareCase);
afterEach(async () => {
  await Promise.allSettled([preparing]);
  await cleanup();
});
afterAll(async () => {
  const errors: unknown[] = [];
  const pending = await Promise.allSettled([setup, preparing]);
  for (const result of pending) if (result.status === "rejected") errors.push(result.reason);
  let cleaned = false;
  try { await cleanup(); cleaned = true; } catch (e) { errors.push(e); }
  try { await drain(); } catch (e) { errors.push(e); }
  if (cleaned) try { await restoreForeign(); } catch (e) { errors.push(e); }
  try { await client.end({ timeout: 2 }); } catch (e) { errors.push(e); }
  if (errors.length) throw new AggregateError(errors, "source_buffer_fixture_cleanup");
});
async function pressure(count = 500) {
  const docs = await client`INSERT INTO crawl_documents(repo,repo_meta,fetched_at)
    SELECT ${prefix+'/pressure-'}||i,'{}'::jsonb,clock_timestamp()-interval '6 minutes' FROM generate_series(1,${count}) i RETURNING id,repo`;
  docs.forEach(row => documentIds.add(row.id));
  const candidates = await client`INSERT INTO crawl_candidates(repo,state,decided_by,updated_at)
    SELECT repo,'new','auto',clock_timestamp()-interval '6 minutes' FROM crawl_documents WHERE id=ANY(${docs.map(row=>row.id)}) RETURNING id`;
  candidates.forEach(row => candidateIds.add(row.id));
}
async function frontier(label: string, priority = 0) {
  const [row] = await client`INSERT INTO crawl_frontier(repo,signal,priority) VALUES(${prefix+'/'+label},'fixture',${priority}) RETURNING *`;
  frontierIds.add(row.id);
  expect(await client`SELECT repo FROM crawl_documents WHERE repo=${row.repo}`).toHaveLength(0);
  sourceRepos.add(row.repo);
  const key = `fetch:${row.id}`;
  expect(await client`SELECT work_key FROM pipeline_item_leases WHERE stage='fetch' AND work_key=${key}`).toHaveLength(0);
  ownItemKeys.add(key);
  return row;
}
async function runFetch() {
  await requestJob("crawl-fetch");
  // Real runner, claim, ownership and source writer; only the external GitHub adapter is mocked.
  return runJob<null>("crawl-fetch", async ctx => { jobTokens.add(ctx.lease!.token); return fetchCrawlDocuments(ctx); }, { requestedOnly: true });
}

it("leaves a disabled legacy fetch control unchanged", () => track((async () => {
  await client`UPDATE crawl_settings SET values=jsonb_set(values,'{discover,sourceBuffer,enabled}','false'::jsonb) WHERE id=1`;
  const row = await frontier("disabled");
  {
    expect(await runFetch()).toMatchObject({ status: "completed" });
    expect(mocks.repo).toHaveBeenCalledTimes(1);
    const docs = await client`SELECT id FROM crawl_documents WHERE repo=${row.repo}`;
    docs.forEach(doc => documentIds.add(doc.id));
    expect(docs).toHaveLength(1);
  }
})()));
it("blocks only new raw supply under downstream pressure without an HTTP call or attempt", () => track((async () => {
  await pressure();
  const row = await frontier("blocked");
  const before = await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`;
  {
    expect(await runFetch()).toMatchObject({ status: "deferred", reason: "source_buffer" });
    expect(mocks.repo).not.toHaveBeenCalled();
    expect(await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`).toEqual(before);
    const [job] = await client`SELECT requested_version,processed_version,lease_token FROM jobs WHERE name='crawl-fetch'`;
    expect(BigInt(job.requested_version)).toBeGreaterThan(BigInt(job.processed_version)); expect(job.lease_token).toBeNull();
  }
})()));

async function withFetch(run: (ctx: JobContext<null>) => Promise<JobOutcome<null>>) {
  await requestJob("crawl-fetch");
  return runJob<null>("crawl-fetch", async ctx => { jobTokens.add(ctx.lease!.token); return run(ctx); }, { requestedOnly: true });
}
async function refresh(label = "refresh") {
  const row = await frontier(label, -1);
  const [doc] = await client`INSERT INTO crawl_documents(repo,repo_meta,fetched_at) VALUES(${row.repo},'{}'::jsonb,clock_timestamp()-interval '6 minutes') RETURNING id`;
  documentIds.add(doc.id);
  const [candidate] = await client`INSERT INTO crawl_candidates(repo,state,reason,decided_by) VALUES(${row.repo},'needs_review','source_refresh_failed','admin') RETURNING id`;
  candidateIds.add(candidate.id);
  return row;
}
async function hold(kind: "control" | "expired-job") {
  let release!: () => void, entered!: (pid: number) => void, reject!: (error: unknown) => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<number>((resolve, fail) => { entered = resolve; reject = fail; });
  const execution = track(client.begin(async tx => {
    if (kind === "control") await tx`SELECT id FROM crawl_source_buffer_control WHERE id=1 FOR UPDATE`;
    else await tx`UPDATE jobs SET locked_at=clock_timestamp()-interval '91 seconds' WHERE name='crawl-fetch'`;
    const [pid] = await tx`SELECT pg_backend_pid() AS pid`;
    entered(pid.pid); await released;
  }));
  void execution.catch(reject);
  return { pid: await ready, release, execution };
}
async function waitingFor(pid: number) {
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    const rows = await client`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
      AND ${pid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`;
    if (rows.length) return rows;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("source_buffer_expected_actual_blocker");
}
it("selects an existing human-owned refresh before LIMIT while leaving blocked discovery keys untouched", () => track((async () => {
  await pressure();
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(await frontier(`new-${i}`, 100));
  const existing = await refresh();
  const before = await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=ANY(${rows.map(row=>row.id)}) ORDER BY id`;
  const human = await client`SELECT to_jsonb(t) AS value FROM crawl_candidates t WHERE repo=${existing.repo}`;
  expect(await runFetch()).toMatchObject({ status: "deferred", reason: "source_buffer" });
  expect(mocks.repo.mock.calls.map(args => args[0])).toEqual([existing.repo]);
  expect(await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=ANY(${rows.map(row=>row.id)}) ORDER BY id`).toEqual(before);
  expect(await client`SELECT to_jsonb(t) AS value FROM crawl_candidates t WHERE repo=${existing.repo}`).toEqual(human);
  expect((await client`SELECT state FROM crawl_frontier WHERE id=${existing.id}`)[0].state).toBe("done");
})()));
it("does not reopen a completed human-owned refresh through the bypass predicate", () => track((async () => {
  await pressure(); const row = await refresh("completed-refresh");
  await client`UPDATE crawl_frontier SET state='done' WHERE id=${row.id}`;
  const before = await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`;
  expect(await withFetch(async ctx => {
    expect(await dequeueWithAdmission(1, undefined, ctx.lease!)).toEqual({ kind: "buffer_blocked" });
    return { done: false, deferred: "source_buffer" };
  })).toMatchObject({ status: "deferred", reason: "source_buffer" });
  expect(await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`).toEqual(before);
})()));
it("keeps the real judgement consumer usable while new source admission is blocked", () => track((async () => {
  await pressure(); await frontier("consumer-control");
  expect(await runFetch()).toMatchObject({ status: "deferred" });
  const repo = prefix+"/pressure-1", document = await getDocument(repo), candidate = await getCandidate(repo), settings = await getSettings();
  expect(document).toBeDefined(); expect(candidate).toBeDefined();
  const result = await runJob<null>("crawl-judge", async ctx => {
    jobTokens.add(ctx.lease!.token);
    expect(await recordAutomaticJudgement({ document: document!, candidate, settings,
      verdict: { state: "rejected", reason: "no_homepage", signals: {} }, lease: ctx.lease })).toBe(true);
    return { done: true };
  });
  expect(result.status).toBe("completed");
  expect((await getCandidate(repo))?.state).toBe("rejected");
})()));
it("preserves a concurrent producer request, pause, cursor and history when releasing only its blocked token", () => track((async () => {
  await pressure(); await frontier("request-cas");
  let expected: unknown;
  const result = await withFetch(async ctx => {
    expect(await dequeueWithAdmission(1, undefined, ctx.lease!)).toEqual({ kind: "buffer_blocked" });
    await requestJob("crawl-fetch");
    await client`UPDATE jobs SET not_before='2100-01-01 00:00:00.123456',cursor='{"preserved":1}'::jsonb,
      last_success_at='2026-10-15 01:02:03.123456',last_error='preserved-history',updated_at='2026-10-15 01:02:03.654321' WHERE name='crawl-fetch'`;
    expected = await client`SELECT to_jsonb(t)-'locked_at'-'lease_token' AS value FROM jobs t WHERE name='crawl-fetch'`;
    return { done: false, deferred: "source_buffer" };
  });
  expect(result).toMatchObject({ status: "deferred", reason: "source_buffer" });
  expect(await client`SELECT to_jsonb(t)-'locked_at'-'lease_token' AS value FROM jobs t WHERE name='crawl-fetch'`).toEqual(expected);
  expect((await client`SELECT lease_token,locked_at FROM jobs WHERE name='crawl-fetch'`)[0]).toMatchObject({ lease_token: null, locked_at: null });
})()));
it("rolls back a bounded control/read timeout before deferring the pending request", () => track((async () => {
  const row = await frontier("read-timeout");
  const before = await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`;
  const control = await client`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`;
  const held = await hold("control");
  const errors: unknown[] = [];
  try {
    const pending = track(runFetch());
    expect((await waitingFor(held.pid)).length).toBeGreaterThan(0);
    expect(await pending).toMatchObject({ status: "deferred", reason: "source_buffer" });
    expect(mocks.repo).not.toHaveBeenCalled();
    expect(await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`).toEqual(before);
  } catch (error) { errors.push(error); }
  finally { held.release(); try { await held.execution; } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "source_buffer_read_timeout_fixture");
  expect(await client`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`).toEqual(control);
})()));
it("rejects the expired actual job after its final row wait and rolls source/control writes back", () => track((async () => {
  const row = await frontier("job-expiry");
  const before = await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`;
  const control = await client`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`;
  const result = await withFetch(async ctx => {
    const held = await hold("expired-job");
    const errors: unknown[] = [];
    try {
      const pending = track(dequeueWithAdmission(1, undefined, ctx.lease!));
      expect((await waitingFor(held.pid)).length).toBeGreaterThan(0);
      held.release(); await held.execution;
      await pending;
      throw new Error("expired_job_was_accepted");
    } catch (error) { errors.push(error); }
    finally { held.release(); try { await held.execution; } catch (error) { errors.push(error); } }
    // Keep a lone authority failure unchanged; simultaneous cleanup failure is explicit.
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "source_buffer_job_expiry_fixture");
    return { done: true };
  });
  expect(result).toMatchObject({ status: "failed" });
  expect(await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`).toEqual(before);
  expect(await client`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`).toEqual(control);
})()));
it("applies the same gate before item LIMIT and preserves a healthy original item owner", () => track((async () => {
  await pressure();
  for (let i = 0; i < 25; i++) await frontier(`item-new-${i}`,100);
  const row = await refresh("item-refresh");
  await client`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='fetch'`;
  const claim = await claimFetchItem({ owner: { instanceId: prefix, bootId: "7d073f42-735d-446c-81bb-b70a290b28a8" }, ttlMs: 90000 });
  expect(claim?.id).toBe(row.id); expect(claim?.ownership.kind).toBe("item");
  const original = await client`SELECT to_jsonb(t) AS value FROM pipeline_item_leases t WHERE stage='fetch' AND work_key=${`fetch:${row.id}`}`;
  expect(await claimFetchItem({ owner: { instanceId: prefix+"-other", bootId: "45c654b3-250b-43af-aafc-3fb95582ef30" }, ttlMs: 90000 })).toBeNull();
  expect(await client`SELECT to_jsonb(t) AS value FROM pipeline_item_leases t WHERE stage='fetch' AND work_key=${`fetch:${row.id}`}`).toEqual(original);
  await markFrontier(claim!,"skipped","github_not_found");
  expect((await client`SELECT token FROM pipeline_item_leases WHERE stage='fetch' AND work_key=${`fetch:${row.id}`}`)[0].token).toBeNull();
})()));
it("rejects a forged job even when an active zero-size claim is blocked", () => track((async () => {
  await pressure(); const control = await client`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`;
  expect(await withFetch(async ctx => {
    await expect(dequeueWithAdmission(0, undefined, { ...ctx.lease!, token: randomUUID() })).rejects.toThrow();
    return { done: true };
  })).toMatchObject({ status: "completed" });
  expect(await client`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`).toEqual(control);
})()));
it("keeps a later claim-write cancellation as its original error instead of a read defer", () => track((async () => {
  const row = await frontier("write-cancellation");
  const before = await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`;
  const control = await client`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`;
  expect(await client`SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='pr12_claim_write_fault'`).toHaveLength(0);
  expect(await client`SELECT oid FROM pg_trigger WHERE tgname='pr12_claim_write_fault'`).toHaveLength(0);
  const errors: unknown[] = []; let observed: unknown, functionCreated = false, triggerCreated = false;
  try {
    await client`CREATE FUNCTION public.pr12_claim_write_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.repo='pr12-source-buffer/write-cancellation' THEN
        RAISE EXCEPTION 'pr12_claim_write_cancelled' USING ERRCODE='57014'; END IF; RETURN NEW; END $$`;
    functionCreated = true;
    await client`CREATE TRIGGER pr12_claim_write_fault BEFORE UPDATE ON crawl_frontier FOR EACH ROW EXECUTE FUNCTION public.pr12_claim_write_fault()`;
    triggerCreated = true;
    expect(await withFetch(async ctx => {
      try { await dequeueWithAdmission(1, undefined, ctx.lease!); }
      catch (error) { observed = error; throw error; }
      return { done: true };
    })).toMatchObject({ status: "failed" });
    expect(observed).toMatchObject({ cause: { code: "57014", message: "pr12_claim_write_cancelled" } });
    expect(await client`SELECT to_jsonb(t) AS value FROM crawl_frontier t WHERE id=${row.id}`).toEqual(before);
    expect(await client`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`).toEqual(control);
  } catch (error) { errors.push(error); }
  finally {
    for (const step of [() => triggerCreated ? client`DROP TRIGGER pr12_claim_write_fault ON crawl_frontier` : Promise.resolve(),
      () => functionCreated ? client`DROP FUNCTION public.pr12_claim_write_fault()` : Promise.resolve()]) {
      try { await step(); } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, "source_buffer_claim_write_fixture");
})()));
