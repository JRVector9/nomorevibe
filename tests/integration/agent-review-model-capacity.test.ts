import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";

const transport = vi.hoisted(() => ({ gateway: vi.fn(), cli: vi.fn(), grok: vi.fn(), readme: vi.fn() }));
vi.mock("@/lib/crawl/agent-review-gateway", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: transport.gateway,
}));
vi.mock("@/lib/crawl/agent-review", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: transport.cli,
}));
vi.mock("@/lib/crawl/agent-review-grok", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-grok")>(), reviewWithGrokCli: transport.grok,
}));
vi.mock("@/lib/crawl/readme", async original => ({
  ...await original<typeof import("@/lib/crawl/readme")>(), fetchReadmeSample: transport.readme,
}));

import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, jobs } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { claimAgentReview, claimItemAgentReview, loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { reviewHash, reviewPolicyHash, REVIEW_RULES_VERSION, type ReviewOutcome } from "@/lib/crawl/agent-review-contract";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { requestJob, type JobLease } from "@/lib/jobs/control";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { runJob } from "@/lib/jobs/runner";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { runFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

type Raw = Record<string, unknown>;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr05b-ai1-admission-admin" } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr05b-ai1-admission-observer" } });
const prefix = `pr05b-admission-${randomUUID().slice(0, 8)}/`;
const managedJobs = ["crawl-agent-review", "crawl-fetch", "crawl-publish", "second-review"];
const tables = {
  crawl_candidates: ["id"], crawl_documents: ["id"], crawl_frontier: ["id"], crawl_review_attempts: ["id"],
  second_reviews: ["id"], pipeline_item_leases: ["stage", "work_key"], pipeline_stage_modes: ["stage"],
  crawl_settings: ["id"], jobs: ["name"], operations_observations: ["key"],
  model_capacity_control: ["id"], model_capacity_requests: ["request_id"], model_capacity_events: ["id"],
  crawl_publication_changes: ["id"],
} as const;
type Table = keyof typeof tables;
let baseline: Record<Table, Raw[]> | undefined;
const candidates: number[] = [], documents: number[] = [], repos: string[] = [];
const ownItemKeys = new Set<string>();
const work = new Set<Promise<unknown>>();
let cleanupFlight: Promise<void> | undefined;
function tracked<T>(promise: Promise<T>): Promise<T> { work.add(promise); void promise.catch(() => {}); return promise; }
function exercise(load: () => Promise<void>) { return tracked(load()); }
async function drain() {
  const pending = [...work];
  await Promise.allSettled(pending);
  for (const task of pending) work.delete(task);
}
async function allSteps(steps: Array<() => Promise<unknown>>, prior: unknown[] = []) {
  const errors = [...prior];
  for (const step of steps) try { await step(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "PR05b fixture cleanup failed");
}
const rows = async (table: Table, tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Raw[]> =>
  [...await tx.unsafe(`SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY ${tables[table].map(key => `"${key}"`).join(",")}`)]
    .map(row => row.value as Raw);
async function whole() {
  const result = {} as Record<Table, Raw[]>;
  for (const table of Object.keys(tables) as Table[]) result[table] = await rows(table);
  return result;
}
async function restore(table: Table, originals: Raw[], tx: postgres.TransactionSql) {
  if (!originals.length) return;
  const keys = tables[table] as readonly string[];
  const columns = Object.keys(originals[0]).filter(key => !keys.includes(key));
  await tx.unsafe(`UPDATE "${table}" t SET ${columns.map(key => `"${key}" = saved."${key}"`).join(",")}
    FROM jsonb_populate_recordset(NULL::"${table}", $1::text::jsonb) saved
    WHERE ${keys.map(key => `t."${key}" = saved."${key}"`).join(" AND ")}`, [JSON.stringify(originals)]);
}
function cleanup() {
  if (cleanupFlight) return cleanupFlight;
  const task = (async () => {
    const original = baseline;
    if (!original) return;
    await admin.begin(async tx => {
      if (ownItemKeys.size) await tx`DELETE FROM pipeline_item_leases WHERE stage='ai1' AND work_key=ANY(${[...ownItemKeys]})`;
      if (candidates.length) {
        await tx`DELETE FROM crawl_candidates WHERE id=ANY(${candidates}) AND repo=ANY(${repos})`;
      }
      if (documents.length) await tx`DELETE FROM crawl_documents WHERE id=ANY(${documents}) AND repo=ANY(${repos})`;
      if (repos.length) await tx`DELETE FROM crawl_frontier WHERE repo=ANY(${repos})`;
      for (const table of ["jobs", "operations_observations", "crawl_settings", "pipeline_stage_modes", "model_capacity_control"] as const) {
        const originals = original[table].filter(row => table === "jobs" ? managedJobs.includes(String(row.name))
          : table === "operations_observations" ? managedJobs.map(name => `job:${name}`).includes(String(row.key)) : true);
        await restore(table, originals, tx);
        if (table === "jobs") {
          const absent = managedJobs.filter(name => !originals.some(row => row.name === name));
          if (absent.length) await tx`DELETE FROM jobs WHERE name=ANY(${absent})`;
        } else if (table === "operations_observations") {
          const absent = managedJobs.map(name => `job:${name}`).filter(key => !originals.some(row => row.key === key));
          if (absent.length) await tx`DELETE FROM operations_observations WHERE key=ANY(${absent})`;
        } else if (table === "crawl_settings" && !originals.length) await tx`DELETE FROM crawl_settings WHERE id=1`;
      }
    });
    candidates.length = documents.length = repos.length = 0;
    ownItemKeys.clear();
  })();
  cleanupFlight = task;
  void task.finally(() => { if (cleanupFlight === task) cleanupFlight = undefined; }).catch(() => {});
  return task;
}
function settings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "observe", reviewConcurrency: 1,
    firstReview: { provider: "abcllm", model: "pr05b-fixture-model" },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false } };
}
const policy: ModelCapacityPolicy = {
  version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 },
  maxWaiting: 4, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: "pr05b-fixture-model", providerBudgetId: "account", groupId: "engine" }],
};
async function mode(value: "disabled" | "open" | "draining", configured = policy) {
  await admin`UPDATE model_capacity_control SET mode=${value},policy=${JSON.stringify(configured)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(configured)} WHERE id=1`;
}
async function source() {
  const repo = `${prefix}app-${repos.length + 1}`;
  repos.push(repo);
  const [{ at }] = await admin`SELECT date_trunc('milliseconds',clock_timestamp())-interval '2 seconds' AS at`;
  const fetchedAt = new Date(at), productUrl = `https://${prefix.slice(0, -1)}-${repos.length}.example`;
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt, pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", pushed_at: fetchedAt.toISOString(), owner: { type: "User" }, stargazers_count: 3 },
    pageMeta: { title: "Task tracker", description: "Create projects and manage tasks online", textSample: "Create projects and manage tasks online.",
      readmeSample: "A deployed task tracker", readmeSampleVersion: README_SAMPLE_VERSION },
  }).returning();
  documents.push(document.id);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed",
    decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt }).returning();
  candidates.push(candidate.id);
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${`ai1:${candidate.id}`}`).toHaveLength(0);
  ownItemKeys.add(`ai1:${candidate.id}`);
  return { candidate, document };
}
const attemptRows = (id: number) => admin`SELECT to_jsonb(a) AS value FROM crawl_review_attempts a WHERE candidate_id=${id} ORDER BY id`;
const jobRow = async () => (await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name='crawl-agent-review'`)[0].value as Raw;
const tick = () => tracked(runJob("crawl-agent-review", reviewCrawlCandidates, { requestedOnly: true }));

beforeAll(() => tracked((async () => {
  ensureSchema();
  baseline = await whole();
  const full: Record<string, unknown> = {};
  for (const table of await admin`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const name = String(table.tablename).replaceAll('"', '""');
    full[name] = [...await admin.unsafe(`SELECT to_jsonb(t) AS value FROM public."${name}" t ORDER BY to_jsonb(t)::text`)].map(row => row.value);
  }
  const catalog = {
    relations: [...await admin`SELECT n.nspname,c.relname,c.relkind,c.relacl,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') ORDER BY 1,2`],
    columns: [...await admin`SELECT table_schema,table_name,column_name,data_type,column_default,is_nullable
      FROM information_schema.columns WHERE table_schema IN ('public','drizzle') ORDER BY 1,2,ordinal_position`],
    schemas: [...await admin`SELECT nspname,nspacl FROM pg_namespace WHERE nspname='public' OR nspname LIKE 'pipeline_replay%' ORDER BY 1`],
    triggers: [...await admin`SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname='public' ORDER BY 1,2,3`],
    functions: [...await admin`SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args,
      p.proacl,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind='f' ORDER BY 1,2,3`],
    roles: [...await admin`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolconfig
      FROM pg_roles ORDER BY rolname`],
    database: [...await admin`SELECT datname,datacl FROM pg_database WHERE datname=current_database()`],
    defaults: [...await admin`SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,
      current_setting('deadlock_timeout') AS deadlock_timeout,current_setting('jit') AS jit`],
    journal: [...await admin`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`],
  };
  const baselinePath = `/tmp/nomorevibe-pr05b-c-db-baseline-${randomUUID()}.json`;
  await writeFile(baselinePath, JSON.stringify({ full, catalog }, null, 2));
  console.log(`PR05B_BASELINE=${baselinePath}`);
  if (baseline.crawl_candidates.length) await admin`UPDATE crawl_candidates SET decided_by='admin'
    WHERE id=ANY(${baseline.crawl_candidates.map(row => Number(row.id))})`;
})()));
beforeEach(() => tracked((async () => {
  await cleanup();
  vi.resetAllMocks();
  const answer = { ok: true, outcome: { decision: "approve", confidence: 0.99, reason: "A deployed task tracker", evidenceIds: ["product"] } };
  for (const mock of [transport.gateway, transport.cli, transport.grok]) mock.mockResolvedValue(answer);
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: "pr05b-fixture" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings(), updatedBy: "pr05b-fixture" } });
  await db.insert(jobs).values({ name: "crawl-agent-review", requestedVersion: 12, processedVersion: 4,
    cursor: { next: "pr05b" }, lastError: "prior site error", lastSuccessAt: new Date("2026-01-01T00:00:00Z") })
    .onConflictDoUpdate({ target: jobs.name, set: { requestedVersion: 12, processedVersion: 4, lockedAt: null, leaseToken: null,
      cursor: { next: "pr05b" }, lastError: "prior site error", notBefore: null, lastSuccessAt: new Date("2026-01-01T00:00:00Z") } });
})()));
afterEach(async () => { await allSteps([drain, cleanup]); });
afterAll(async () => {
  await allSteps([drain, cleanup, async () => {
    if (!baseline) return;
    await admin.begin(async tx => {
      if (baseline!.crawl_candidates.length) await tx`UPDATE crawl_candidates c SET decided_by=saved.decided_by
        FROM jsonb_populate_recordset(NULL::crawl_candidates,${JSON.stringify(baseline!.crawl_candidates)}::text::jsonb) saved WHERE c.id=saved.id`;
    });
    const after = await whole();
    expect(after).toEqual(baseline);
  }, () => admin.end({ timeout: 3 }), () => observer.end({ timeout: 3 })]);
});

it("keeps a disabled legacy model control on the actual claim, transport and result path", () => exercise(async () => {
  const context = await source();
  await mode("disabled");
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(transport.gateway).toHaveBeenCalledOnce();
  expect((await attemptRows(context.candidate.id)).map(row => row.value)).toMatchObject([{ state: "succeeded", attempt_number: 1 }]);
}));

it.each(["open", "draining"] as const)("defers fresh AI1 in %s without consuming a model attempt or acknowledging the request", value => exercise(async () => {
  const context = await source();
  await mode(value);
  const before = await jobRow();
  const result = await tick();
  expect(result).toMatchObject({ status: "deferred", reason: "model_capacity" });
  expect(await attemptRows(context.candidate.id)).toHaveLength(0);
  for (const mock of [transport.gateway, transport.cli, transport.grok]) expect(mock).not.toHaveBeenCalled();
  const after = await jobRow();
  for (const key of ["requested_version", "processed_version", "cursor", "not_before", "last_error", "last_success_at"])
    expect(after[key], key).toEqual(before[key]);
  expect(after).toMatchObject({ locked_at: null, lease_token: null });
  expect(await rows("model_capacity_requests")).toEqual(baseline!.model_capacity_requests);
  expect(await rows("model_capacity_events")).toEqual(baseline!.model_capacity_events);
}));

const approve: ReviewOutcome = { decision: "approve", confidence: 0.99, reason: "A deployed task tracker", evidenceIds: ["product"] };
async function current(context: Awaited<ReturnType<typeof source>>) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, context.candidate.id));
  const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.id, context.document.id));
  const configured = settings();
  return { candidate, document, settings: configured, input: await loadReviewInput(candidate, document, configured),
    provider: configured.firstReview!.provider, model: configured.firstReview!.model };
}
async function withJob<T>(load: (lease: JobLease) => Promise<T>) {
  let value!: T;
  const result = await tracked(runJob("crawl-agent-review", async ctx => {
    value = await load(ctx.lease!); return { done: false };
  }));
  expect(result).toMatchObject({ status: "completed" });
  return value;
}
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function blockedBy(pid: number) {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    const found = await observer`SELECT pid,query,xact_start FROM pg_stat_activity
      WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`;
    if (found.length) return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("PR05b expected an observed PostgreSQL lock wait");
}

it("rejects an exact unmapped route with typed defer and leaves slot rows untouched", () => exercise(async () => {
  const context = await current(await source());
  await mode("open", { ...policy, routes: [{ ...policy.routes[0], model: "Other Exact Model" }] });
  const before = await attemptRows(context.candidate.id);
  await withJob(async lease => {
    await expect(claimAgentReview({ ...context, lease })).rejects.toMatchObject({ name: "ModelCapacityDeferredError", reason: "unmapped" });
  });
  expect(await attemptRows(context.candidate.id)).toEqual(before);
  expect(await rows("model_capacity_requests")).toEqual(baseline!.model_capacity_requests);
  expect(await rows("model_capacity_events")).toEqual(baseline!.model_capacity_events);
}));

it("propagates malformed control as its original error and rolls back the fresh claim", () => exercise(async () => {
  const context = await current(await source());
  await mode("disabled");
  await admin`UPDATE model_capacity_control SET policy_hash=${"a".repeat(64)} WHERE id=1`;
  await withJob(async lease => {
    await expect(claimAgentReview({ ...context, lease })).rejects.toThrow("model_capacity_policy_hash_mismatch");
  });
  expect(await attemptRows(context.candidate.id)).toHaveLength(0);
  for (const mock of [transport.gateway, transport.cli, transport.grok]) expect(mock).not.toHaveBeenCalled();
}));

it("rolls back a generic item acquisition made before the fresh admission refusal", () => exercise(async () => {
  const context = await current(await source());
  await mode("open");
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai1'`;
  const beforeItems = await rows("pipeline_item_leases"), beforeCandidate = await rows("crawl_candidates");
  await expect(claimItemAgentReview({ ...context, owner: { instanceId: "pr05b-item", bootId: randomUUID() }, ttlMs: 90_000 }))
    .rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(await attemptRows(context.candidate.id)).toHaveLength(0);
  expect(await rows("pipeline_item_leases")).toEqual(beforeItems);
  expect(await rows("crawl_candidates")).toEqual(beforeCandidate);
}));

it("rolls the old running-attempt supersede back when the replacement fresh claim is deferred", () => exercise(async () => {
  const context = await current(await source());
  await mode("disabled");
  const original = await withJob(lease => claimAgentReview({ ...context, lease }));
  expect(original.kind).toBe("claimed");
  const before = await attemptRows(context.candidate.id);
  await mode("open");
  await withJob(async lease => {
    await expect(claimAgentReview({ ...context, lease })).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  });
  expect(await attemptRows(context.candidate.id)).toEqual(before);
  expect(before.map(row => row.value)).toMatchObject([{ state: "running", error_code: null }]);
}));

it.each(["direct_reuse", "semantic_reuse"] as const)("keeps actual %s model-free while the capacity policy is open", origin => exercise(async () => {
  const fixture = await source();
  let context = await current(fixture);
  await mode("disabled");
  const first = await withJob(async lease => {
    const claim = await claimAgentReview({ ...context, lease });
    if (claim.kind === "skipped") throw new Error(claim.reason);
    await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve });
    return claim;
  });
  const original = await attemptRows(context.candidate.id);
  if (origin === "semantic_reuse") {
    await admin`UPDATE crawl_documents SET fetched_at=fetched_at-interval '1 second' WHERE id=${context.document.id}`;
    const changed = await current(fixture);
    expect(changed.input.inputHash).toBe(context.input.inputHash);
    expect(changed.input.sourceRevisionHash).not.toBe(context.input.sourceRevisionHash);
    context = changed;
  }
  await mode("open");
  const reused = await withJob(async lease => {
    const claim = await claimAgentReview({ ...context, lease });
    if (claim.kind === "skipped") throw new Error(claim.reason);
    expect(claim.receipt.origin).toBe(origin);
    await recordAgentReview({ ...context, receipt: claim.receipt, outcome: claim.attempt.outcome! });
    return claim;
  });
  expect(reused.kind).toBe("reused");
  expect((await attemptRows(context.candidate.id)).find(row => row.value.id === first.attempt.id)).toEqual(original[0]);
  for (const mock of [transport.gateway, transport.cli, transport.grok]) expect(mock).not.toHaveBeenCalled();
}));

it("keeps server rules model-free while capacity is draining", () => exercise(async () => {
  const context = await current(await source());
  await mode("draining");
  const claim = await withJob(async lease => {
    const claimed = await claimAgentReview({ ...context, lease, provider: "rules", model: REVIEW_RULES_VERSION });
    if (claimed.kind === "skipped") throw new Error(claimed.reason);
    await recordAgentReview({ ...context, receipt: claimed.receipt, outcome: approve });
    return claimed;
  });
  expect(claim.kind).toBe("claimed");
  expect((await attemptRows(context.candidate.id)).map(row => row.value)).toMatchObject([{ state: "succeeded", provider: "rules" }]);
  for (const mock of [transport.gateway, transport.cli, transport.grok]) expect(mock).not.toHaveBeenCalled();
}));

it("preserves a concurrent producer request and pause when a typed error defers the actual runner", () => exercise(async () => {
  const before = await jobRow(), pause = new Date("2101-01-01T00:00:00.000Z");
  const result = await tracked(runJob("crawl-agent-review", async () => {
    await requestJob("crawl-agent-review");
    await db.update(jobs).set({ notBefore: pause }).where(eq(jobs.name, "crawl-agent-review"));
    throw new ModelCapacityDeferredError("draining");
  }, { requestedOnly: true }));
  expect(result).toMatchObject({ status: "deferred", reason: "model_capacity" });
  const after = await jobRow();
  expect(after.requested_version).toBe(Number(before.requested_version) + 1);
  expect(after.not_before).toBe("2101-01-01T00:00:00");
  for (const key of ["processed_version", "cursor", "last_error", "last_success_at"]) expect(after[key], key).toEqual(before[key]);
  expect(after).toMatchObject({ locked_at: null, lease_token: null });
}));

it("takes the model control lock before any S3, candidate or job locks in its domain claim", () => exercise(async () => {
  await source();
  await mode("disabled");
  let running: ReturnType<typeof tick> | undefined;
  const failures: unknown[] = [];
  try {
    await admin.begin(async tx => {
      const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
      running = tick();
      const waiters = await blockedBy(pid);
      expect(waiters.some(row => String(row.query).includes("model_capacity_control"))).toBe(true);
      // NOWAIT proves these locks have not been retained while the control waits.
      await observer.begin(async probe => {
        await probe`SELECT stage FROM pipeline_stage_modes FOR UPDATE NOWAIT`;
        await probe`SELECT id FROM crawl_candidates WHERE id=ANY(${candidates}) FOR UPDATE NOWAIT`;
        await probe`SELECT name FROM jobs WHERE name='crawl-agent-review' FOR UPDATE NOWAIT`;
      });
    });
  } catch (error) { failures.push(error); }
  finally {
    if (running) {
      const settled = await Promise.allSettled([running]);
      if (settled[0].status === "rejected") failures.push(settled[0].reason);
      else try { expect(settled[0].value).toMatchObject({ status: "deferred", reason: "model_capacity" }); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failures);
}));

it("does not touch a genuine replacement job owner when the old tick is deferred", () => exercise(async () => {
  const started = latch(), finish = latch();
  let replacement: ReturnType<typeof runJob> | undefined, protectedRow: Raw | undefined;
  try {
    const old = await tracked(runJob("crawl-agent-review", async () => {
      await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '91 seconds' WHERE name='crawl-agent-review'`;
      replacement = tracked(runJob("crawl-agent-review", async () => {
        started.resolve(); await finish.promise; return { done: false };
      }, { requestedOnly: true }));
      await Promise.race([started.promise, replacement]);
      protectedRow = await jobRow();
      throw new ModelCapacityDeferredError("draining");
    }, { requestedOnly: true }));
    expect(old).toMatchObject({ status: "failed", error: "job_lease_lost" });
    expect(await jobRow()).toEqual(protectedRow);
  } finally { finish.resolve(); if (replacement) await Promise.allSettled([replacement]); }
}));

it("rechecks the original job's actual DB wall after its deferred unlock waits", () => exercise(async () => {
  const started = latch(), finish = latch();
  let holding: Promise<unknown> | undefined, running: ReturnType<typeof runJob> | undefined;
  let pid = 0, until = "", protectedRow: Raw | undefined;
  const failures: unknown[] = [];
  try {
    running = tracked(runJob("crawl-agent-review", async () => {
      await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '89 seconds' WHERE name='crawl-agent-review'`;
      protectedRow = await jobRow();
      holding = tracked(admin.begin(async tx => {
        const [owner] = await tx`SELECT pg_backend_pid() AS pid,to_char(locked_at+interval '90 seconds', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS until
          FROM jobs WHERE name='crawl-agent-review' FOR UPDATE`;
        pid = owner.pid; until = String(owner.until); started.resolve(); await finish.promise;
      }));
      await Promise.race([started.promise, holding]);
      throw new ModelCapacityDeferredError("draining");
    }, { requestedOnly: true }));
    await Promise.race([started.promise, running]);
    const waiters = await blockedBy(pid);
    expect(waiters.length).toBe(1);
    const [timing] = await observer`SELECT xact_start<${until}::timestamptz AS healthy_at_start
      FROM pg_stat_activity WHERE pid=${waiters[0].pid}`;
    expect(timing.healthy_at_start).toBe(true);
    const deadline = Date.now() + 2_500;
    let expired = false;
    while (Date.now() < deadline) {
      const [clock] = await observer`SELECT clock_timestamp()>=${until}::timestamptz AS expired`;
      if (clock.expired) { expired = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(expired).toBe(true);
  } catch (error) { failures.push(error); }
  finally {
    finish.resolve();
    const settled = await Promise.allSettled([holding, running]);
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures);
  expect(await running).toMatchObject({ status: "failed", error: "job_lease_lost" });
  expect(await jobRow()).toEqual(protectedRow);
}));

it("keeps genuine fixed replay on its private verified legacy path without model-control privileges", () => exercise(async () => {
  const context = await current(await source()), configured = settings(), reference = new Date();
  await mode("open");
  const identity = await tracked(getReplayHandlerIdentityPath());
  const errors: unknown[] = [];
  try {
    const [privileges] = await tracked(withReplayDatabaseScope(identity.identityPath, () => db.execute<{
      role: string; capacity_select: boolean; capacity_update: boolean;
    }>(sql`SELECT current_user AS role,has_table_privilege(current_user,'public.model_capacity_control','SELECT') AS capacity_select,
      has_column_privilege(current_user,'public.model_capacity_control','id','UPDATE') AS capacity_update`)));
    expect(privileges.role).toMatch(/^nomorevibe_replay_/);
    expect(privileges.capacity_select).toBe(false);
    expect(privileges.capacity_update).toBe(false);
    const first = configured.firstReview!;
    const manifest: CapacityManifest = { version: 1, runId: `pr05b-replay-${randomUUID()}`, revision: "cc43a1d9", mode: "fixtures", cacheMode: "cold",
      referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
      inputPolicyHash: reviewPolicyHash(configured), fullReviewPolicyHash: fullReviewPolicyHash(configured),
      comparisonPolicyHash: comparisonReviewPolicyHash(configured), initialStateHash: reviewHash(context.input),
      models: { first: { ...first, canonicalModel: canonicalReviewModel(first.model!) },
        second: configured.secondReview.voters.map(value => ({ ...value, canonicalModel: canonicalReviewModel(value.model) })),
        fallbacks: (configured.secondReview.fallbacks ?? []).map(value => ({ ...value, canonicalModel: canonicalReviewModel(value.model) })) },
      inputs: [{ candidateId: context.candidate.id, inputHash: context.input.inputHash, sourceRevisionHash: context.input.sourceRevisionHash,
        readyAt: reference.toISOString(), stratum: "new", reReview: false }],
      limits: { maxCalls: 2, maxTokens: 200, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 1 } };
    const result = await tracked(runFixtureReviewReplay({ identityPath: identity.identityPath, manifest,
      inputs: [{ candidateId: context.candidate.id, input: context.input }], jobs: ["crawl-agent-review"],
      fixture: async () => ({ result: { ok: true, outcome: approve, usage: { inputTokens: 8, outputTokens: 2 } },
        receipt: { inputTokens: 8, outputTokens: 2 } }) }));
    expect(result.jobs).toMatchObject([{ name: "crawl-agent-review", result: { status: "completed" } }]);
    expect((await attemptRows(context.candidate.id)).map(row => row.value)).toMatchObject([{ state: "succeeded" }]);
    for (const mock of [transport.gateway, transport.cli, transport.grok]) expect(mock).not.toHaveBeenCalled();
  } catch (error) { errors.push(error); }
  finally { await allSteps([() => identity.release()], errors); }
}));
