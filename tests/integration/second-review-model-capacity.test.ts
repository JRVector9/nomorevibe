import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const transport = vi.hoisted(() => ({ gateway: vi.fn(), cli: vi.fn(), grok: vi.fn() }));
vi.mock("@/lib/crawl/agent-review-gateway", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: transport.gateway,
}));
vi.mock("@/lib/crawl/agent-review", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: transport.cli,
}));
vi.mock("@/lib/crawl/agent-review-grok", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-grok")>(), reviewWithGrokCli: transport.grok,
}));

import { db, onReplica } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { crawlCandidates, crawlDocuments, crawlSettings, secondReviews } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { claimAgentReview, loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { secondReviewCandidates } from "@/lib/crawl/jobs/second-review";
import { enqueueSecondReviews, recordSecondReview } from "@/lib/crawl/second-review";
import { admitLegacySecondReview, claimItemSecondReview, renewSecondReviewOwnership,
  type SecondReviewItemReceipt } from "@/lib/crawl/second-review-ownership";
import { executeSecondReviewItem } from "@/lib/crawl/second-review-item-lifecycle";
import { requestJob, type JobLease } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { ReplayLedger } from "@/lib/operations/pipeline-replay-ledger";
import { runCertifiedFixtureReviewReplay, runCertifiedItemFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";
import { replayArtifactFromVerified } from "@/lib/operations/pipeline-replay-artifact";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";
import { getReplayItemHandlerIdentityPath } from "./replay-item-handler-fixtures";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

type Raw = Record<string, unknown>;
const prefix = `pr05b1-ai2-${randomUUID().slice(0, 8)}/`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr05b1-ai2-admin" } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr05b1-ai2-observer" } });
const managedJobs = ["crawl-agent-review", "crawl-publish", "second-review"];
const keys = { jobs: "name", operations_observations: "key", crawl_settings: "id",
  pipeline_stage_modes: "stage", model_capacity_control: "id" } as const;
const work = new Set<Promise<unknown>>(), ownRepos: string[] = [], ownCandidates: number[] = [], ownDocuments: number[] = [];
const ownItemKeys = new Set<string>(), ownItemTokens = new Set<string>(), jobTokens = new Set<string>();
type Hold = { table: "crawl_candidates" | "second_reviews"; original: Raw; held: Raw; columns: string[] };
let initialBaseline: Record<string, Raw[]> | undefined, baseline: Record<string, Raw[]> | undefined;
let cleanupFlight: Promise<void> | undefined;
const holds: Hold[] = [], createdJobs = new Set<string>(), createdObservations = new Set<string>();
function tracked<T>(promise: Promise<T>): Promise<T> { work.add(promise); void promise.catch(() => {}); return promise; }
function exercise(load: () => Promise<void>) { return tracked(load()); }
async function drain() {
  while (work.size) { const pending = [...work]; await Promise.allSettled(pending); for (const task of pending) work.delete(task); }
}
async function steps(loaders: Array<() => Promise<unknown>>) {
  const errors: unknown[] = [];
  for (const load of loaders) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "AI2 admission fixture cleanup failed");
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, Raw[]> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`) {
    result[tablename] = [...await tx.unsafe(`SELECT to_jsonb(t) value FROM public."${String(tablename).replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`)]
      .map(row => row.value as Raw);
  }
  return result;
}
async function currentRow(table: keyof typeof keys, key: unknown, tx: postgres.TransactionSql) {
  const rows = await tx.unsafe(`SELECT to_jsonb(t) value FROM "${table}" t WHERE "${keys[table]}"::text=$1 FOR UPDATE`, [String(key)]);
  return rows[0]?.value as Raw | undefined;
}
async function restore(table: keyof typeof keys, original: Raw[], tx: postgres.TransactionSql) {
  const key = keys[table];
  for (const saved of original) {
    const current = await currentRow(table, saved[key], tx);
    if (!current) throw new Error("AI2 fixture managed row disappeared");
    if (JSON.stringify(current) === JSON.stringify(saved)) continue;
    const columns = Object.keys(saved).filter(column => column !== key);
    const restored = await tx.unsafe(`UPDATE "${table}" t SET ${columns.map(column => `"${column}"=saved."${column}"`).join(",")}
      FROM jsonb_populate_record(NULL::"${table}",$1::text::jsonb) saved
      WHERE t."${key}"=saved."${key}" AND to_jsonb(t)=$2::text::jsonb RETURNING t."${key}"`,
    [JSON.stringify(saved), JSON.stringify(current)]);
    expect(restored).toHaveLength(1);
  }
}
async function holdSelectors(original: Record<string, Raw[]>) {
  return admin.begin(async tx => {
    const parked: Hold[] = [];
    for (const row of original.crawl_candidates.filter(row => row.decided_by === "auto")) {
      const changed = await tx`UPDATE crawl_candidates c SET decided_by='admin'
        WHERE id=${Number(row.id)} AND to_jsonb(c)=${JSON.stringify(row)}::text::jsonb RETURNING to_jsonb(c) value`;
      expect(changed).toHaveLength(1);
      parked.push({ table: "crawl_candidates", original: row, held: changed[0].value, columns: ["decided_by"] });
    }
    // Queue selection has no candidate join. Park both active votes and the
    // resolved/fallback roots the cleanup controller can otherwise still write.
    for (const row of original.second_reviews.filter(row => ["pending", "failed", "agreed", "needs_human"].includes(String(row.status))
      || row.status === "resolved" && row.resolution === "fallback")) {
      const changed = await tx`UPDATE second_reviews s SET status='resolved',resolution='superseded'
        WHERE id=${Number(row.id)} AND to_jsonb(s)=${JSON.stringify(row)}::text::jsonb RETURNING to_jsonb(s) value`;
      expect(changed).toHaveLength(1);
      parked.push({ table: "second_reviews", original: row, held: changed[0].value, columns: ["status", "resolution"] });
    }
    return { parked, snapshot: await whole(tx) };
  });
}
async function restoreSelectors() {
  await admin.begin(async tx => {
    for (const hold of holds) {
      const changed = await tx.unsafe(`UPDATE "${hold.table}" t SET ${hold.columns.map(column => `"${column}"=saved."${column}"`).join(",")}
        FROM jsonb_populate_record(NULL::"${hold.table}",$1::text::jsonb) saved
        WHERE t.id=saved.id AND to_jsonb(t)=$2::text::jsonb RETURNING t.id`,
      [JSON.stringify(hold.original), JSON.stringify(hold.held)]);
      expect(changed).toHaveLength(1);
    }
    if (initialBaseline) expect(await whole(tx)).toEqual(initialBaseline);
  });
  holds.length = 0;
}
async function prepareManagedJobs() {
  const committed = await admin.begin(async tx => {
    const created = { jobs: [] as string[], observations: [] as string[] };
    for (const name of managedJobs) {
      const original = baseline!.jobs.find(row => row.name === name);
      if (original) {
        if (original.lease_token !== null || original.locked_at !== null) throw new Error("AI2 fixture managed job has unknown original owner");
        const changed = await tx`UPDATE jobs j SET requested_version=0,processed_version=0,not_before=NULL
          WHERE name=${name} AND to_jsonb(j)=${JSON.stringify(original)}::text::jsonb RETURNING name`;
        expect(changed).toHaveLength(1);
      } else {
        const inserted = await tx`INSERT INTO jobs(name) VALUES(${name}) ON CONFLICT(name) DO NOTHING RETURNING name`;
        if (!inserted.length) throw new Error("AI2 fixture managed job appeared");
        created.jobs.push(name);
      }
      const observationKey = `job:${name}`;
      if (!baseline!.operations_observations.some(row => row.key === observationKey)) {
        const inserted = await tx`INSERT INTO operations_observations(key,value)
          VALUES(${observationKey},'{}'::jsonb)
          ON CONFLICT(key) DO NOTHING RETURNING key`;
        if (!inserted.length) throw new Error("AI2 fixture observation appeared");
        created.observations.push(observationKey);
      }
    }
    // The fixture's first verdict is constructed before each capacity mode case.
    const [control] = await tx`SELECT to_jsonb(c) value FROM model_capacity_control c WHERE id=1 FOR UPDATE`;
    expect(control?.value).toEqual(baseline!.model_capacity_control[0]);
    expect(await tx`UPDATE model_capacity_control c SET mode='disabled'
      WHERE id=1 AND to_jsonb(c)=${JSON.stringify(control.value)}::text::jsonb RETURNING id`).toHaveLength(1);
    return created;
  });
  for (const name of committed.jobs) createdJobs.add(name);
  for (const key of committed.observations) createdObservations.add(key);
}
function cleanup() {
  if (cleanupFlight) return cleanupFlight;
  const task = (async () => {
    const original = baseline;
    if (!original) return;
    await admin.begin(async tx => {
      // All managed job ownership must have settled; never erase a replacement.
      for (const row of await tx`SELECT name,lease_token,locked_at FROM jobs WHERE name=ANY(${managedJobs}) FOR UPDATE`) {
        const saved = original.jobs.find(saved => saved.name === row.name);
        if (row.lease_token !== null && !jobTokens.has(String(row.lease_token))
          && row.lease_token !== saved?.lease_token) throw new Error("AI2 fixture foreign replacement");
        if (row.lease_token === saved?.lease_token && row.lease_token !== null) {
          const current = await currentRow("jobs", row.name, tx);
          if (JSON.stringify(current) !== JSON.stringify(saved)) throw new Error("AI2 fixture original owner changed");
        }
      }
      if (ownItemKeys.size) {
        const items = await tx`SELECT to_jsonb(i) value FROM pipeline_item_leases i
          WHERE stage='ai2' AND work_key=ANY(${[...ownItemKeys]}) FOR UPDATE`;
        for (const { value } of items) {
          if (value.token !== null && !ownItemTokens.has(value.token)) throw new Error("AI2 fixture foreign item replacement");
          expect(await tx`DELETE FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${value.work_key}
            AND to_jsonb(i)=${JSON.stringify(value)}::text::jsonb RETURNING work_key`).toHaveLength(1);
        }
      }
      if (ownCandidates.length) await tx`DELETE FROM second_reviews WHERE candidate_id=ANY(${ownCandidates}) AND repo=ANY(${ownRepos})`;
      if (ownCandidates.length) await tx`DELETE FROM crawl_candidates WHERE id=ANY(${ownCandidates}) AND repo=ANY(${ownRepos})`;
      if (ownDocuments.length) await tx`DELETE FROM crawl_documents WHERE id=ANY(${ownDocuments}) AND repo=ANY(${ownRepos})`;
      for (const table of Object.keys(keys) as Array<keyof typeof keys>) {
        const originals = original[table].filter(row => table === "jobs" ? managedJobs.includes(String(row.name))
          : table === "operations_observations" ? managedJobs.map(name => `job:${name}`).includes(String(row.key))
            : table === "crawl_settings" ? row.id === 1 : true);
        await restore(table, originals, tx);
        const absent = (table === "jobs" ? managedJobs : table === "operations_observations" ? managedJobs.map(name => `job:${name}`)
          : table === "crawl_settings" ? [1] : []).filter(value => !originals.some(row => row[keys[table]] === value));
        for (const key of absent) {
          const current = await currentRow(table, key, tx);
          if (!current) continue;
          if (table === "jobs" && !createdJobs.has(String(key))) throw new Error("AI2 fixture unowned absent job");
          if (table === "operations_observations" && !createdObservations.has(String(key))) throw new Error("AI2 fixture unowned observation");
          expect(await tx.unsafe(`DELETE FROM "${table}" t WHERE "${keys[table]}"::text=$1
            AND to_jsonb(t)=$2::text::jsonb RETURNING "${keys[table]}"`, [String(key), JSON.stringify(current)])).toHaveLength(1);
        }
      }
      expect(await whole(tx)).toEqual(original);
    });
    ownRepos.length = ownCandidates.length = ownDocuments.length = 0;
    ownItemKeys.clear(); ownItemTokens.clear(); jobTokens.clear(); createdJobs.clear(); createdObservations.clear();
  })();
  cleanupFlight = task;
  void task.finally(() => { if (cleanupFlight === task) cleanupFlight = undefined; }).catch(() => {});
  return tracked(task);
}
function settings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "pr05b1-first" }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm", model: "pr05b1-second" }],
      fallbacks: [{ provider: "abcllm", model: "pr05b1-fallback" }] } };
}
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "second-review", provider: "abcllm", model: "pr05b1-second", providerBudgetId: "account", groupId: "engine" }] };
async function mode(value: "disabled" | "open" | "draining", configured = policy) {
  await admin`UPDATE model_capacity_control SET mode=${value},policy=${JSON.stringify(configured)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(configured)} WHERE id=1`;
}
async function actualJob<T>(name: "crawl-agent-review" | "second-review", body: (lease: JobLease) => Promise<T>) {
  let value!: T, failed = false, failure: unknown;
  const result = await tracked(runJob<null>(name, async ctx => {
    if (!ctx.lease) throw new Error("AI2 fixture missing actual job lease");
    jobTokens.add(ctx.lease.token);
    try { value = await body(ctx.lease); } catch (error) { failed = true; failure = error; throw error; }
    return { done: true };
  }));
  if (failed) throw failure;
  expect(result).toMatchObject({ status: "completed" });
  return value;
}
async function rawSource() {
  const configured = settings(), repo = `${prefix}app-${ownRepos.length + 1}`, now = new Date(Date.now() - 2_000);
  ownRepos.push(repo);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: `https://${repo.replaceAll("/", "-")}.example`,
    fetchedAt: now, pageStatus: 200, repoMeta: { description: "A deployed project application", stargazers_count: 3 },
    pageMeta: { title: "Projects", description: "Create projects and manage tasks", textSample: "Manage projects online",
      readmeSample: "A deployed task manager", readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  ownDocuments.push(document.id);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: document.productUrl,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: now, updatedAt: now }).returning();
  ownCandidates.push(candidate.id);
  const input = await loadReviewInput(candidate, document, configured);
  return { candidate, document, input, configured };
}
async function source() {
  const { candidate, document, input, configured } = await rawSource();
  await actualJob("crawl-agent-review", async lease => {
    const context = { candidate, document, settings: configured, input, provider: "abcllm" as const, model: "pr05b1-first", lease };
    const claim = await claimAgentReview(context);
    expect(claim.kind).toBe("claimed");
    if (claim.kind === "skipped") throw new Error(`AI2 fixture first skipped:${claim.reason}`);
    expect(await recordAgentReview({ ...context, receipt: claim.receipt,
      outcome: { decision: "approve", confidence: .99, reason: "Deployed task application", evidenceIds: ["product"] } }))
      .toMatchObject({ applied: true, state: "succeeded" });
  });
  expect(await actualJob("second-review", lease => enqueueSecondReviews(configured, undefined, lease))).toBe(1);
  const [row] = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, candidate.id));
  expect(row).toMatchObject({ status: "pending", model: "pr05b1-second" });
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`).toHaveLength(0);
  ownItemKeys.add(`ai2:${row.id}`);
  await requestJob("second-review");
  return { candidate, document, row };
}
const voteRows = (id: number) => admin`SELECT to_jsonb(s) value FROM second_reviews s WHERE candidate_id=${id} ORDER BY id`;
const jobRow = async () => (await admin`SELECT to_jsonb(j) value FROM jobs j WHERE name='second-review'`)[0].value as Raw;
const tick = () => tracked(runJob<null>("second-review", async ctx => {
  if (ctx.lease) jobTokens.add(ctx.lease.token);
  return secondReviewCandidates(ctx);
}, { requestedOnly: true }));

beforeAll(() => tracked((async () => {
  ensureSchema();
  initialBaseline = await whole();
  for (const row of initialBaseline.jobs.filter(row => managedJobs.includes(String(row.name))))
    if (row.lease_token !== null || row.locked_at !== null) throw new Error("AI2 fixture managed job has unknown original owner");
  const parked = await holdSelectors(initialBaseline);
  holds.push(...parked.parked);
  baseline = parked.snapshot;
})()));
beforeEach(() => tracked((async () => {
  await cleanup();
  await prepareManagedJobs();
  vi.resetAllMocks();
  for (const mock of Object.values(transport)) mock.mockResolvedValue({ ok: true,
    outcome: { decision: "approve", confidence: .99, reason: "Deployed application", evidenceIds: ["product"] } });
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: "pr05b1-ai2" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings(), updatedBy: "pr05b1-ai2" } });
})()));
afterEach(async () => { await steps([drain, cleanup]); });
afterAll(async () => { await steps([drain, cleanup, restoreSelectors, async () => {
  if (initialBaseline) expect(await whole()).toEqual(initialBaseline);
}, () => admin.end({ timeout: 3 }), () => observer.end({ timeout: 3 })]); });

it("keeps disabled AI2 on the actual legacy claim, transport and result path", () => exercise(async () => {
  const context = await source();
  await mode("disabled");
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(transport.gateway).toHaveBeenCalledOnce();
  expect((await voteRows(context.candidate.id)).map(row => row.value)).toMatchObject([{ status: "agreed", failure_count: 0 }]);
}));

it.each(["open", "draining"] as const)("defers fresh AI2 in %s without changing the vote, fallback or request ACK", value => exercise(async () => {
  const context = await source();
  await mode(value);
  const beforeVotes = await voteRows(context.candidate.id), beforeJob = await jobRow();
  const result = await tick();
  expect(result).toMatchObject({ status: "deferred", reason: "model_capacity" });
  expect(await voteRows(context.candidate.id)).toEqual(beforeVotes);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
  const after = await jobRow();
  for (const key of ["requested_version", "processed_version", "cursor", "not_before", "last_error", "last_success_at"])
    expect(after[key], key).toEqual(beforeJob[key]);
  expect(after).toMatchObject({ locked_at: null, lease_token: null });
  expect((await admin`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY to_jsonb(r)::text`).map(row => row.value))
    .toEqual(baseline!.model_capacity_requests);
  expect((await admin`SELECT to_jsonb(e) value FROM model_capacity_events e ORDER BY to_jsonb(e)::text`).map(row => row.value))
    .toEqual(baseline!.model_capacity_events);
}));

it("uses the actual exact AI2 route and preserves a genuine wrong-job error before typed defer", () => exercise(async () => {
  const { candidate, row } = await source();
  await mode("open", { ...policy, routes: [{ ...policy.routes[0], routeId: "crawl-agent-review" }] });
  const before = await voteRows(candidate.id);
  await actualJob("second-review", async lease => {
    await expect(admitLegacySecondReview(row.id, lease)).rejects.toMatchObject({ name: "ModelCapacityDeferredError", reason: "unmapped" });
    await expect(admitLegacySecondReview(row.id, { ...lease, name: "crawl-agent-review" })).rejects.toThrow("job_lease_lost");
  });
  expect(await voteRows(candidate.id)).toEqual(before);
}));

it("rolls back a fresh item acquisition before transport when its mapped model contract is unavailable", () => exercise(async () => {
  const { candidate, row } = await source();
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai2'`;
  await mode("open");
  const before = await voteRows(candidate.id);
  await expect(executeSecondReviewItem({ secondReviewId: row.id,
    owner: { instanceId: prefix, bootId: randomUUID() } })).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(await admin`SELECT * FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`).toHaveLength(0);
  expect(await voteRows(candidate.id)).toEqual(before);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));

it("keeps existing item renewal/cancel model-free and rolls a later released-row reclaim back", () => exercise(async () => {
  const { row } = await source();
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai2'`;
  const claim = await tracked(claimItemSecondReview(row.id, { instanceId: prefix, bootId: randomUUID() }, 60_000));
  if (claim.kind !== "skipped" && claim.receipt.ownership.kind === "item") ownItemTokens.add(claim.receipt.ownership.lease.token);
  expect(claim.kind).toBe("claimed");
  if (claim.kind === "skipped" || claim.receipt.ownership.kind !== "item") throw new Error("actual AI2 item receipt required");
  const receipt = claim.receipt as SecondReviewItemReceipt;
  await mode("draining");
  expect(await tracked(renewSecondReviewOwnership(receipt, 60_000))).toMatchObject({ token: receipt.ownership.lease.token });
  expect(await tracked(recordSecondReview({ receipt,
    result: { ok: false, error: "cancelled", provider: row.provider!, model: row.model! } }))).toEqual({ state: "cancelled" });
  const before = await admin`SELECT to_jsonb(i) value FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`;
  expect(before[0].value).toMatchObject({ token: null, owner_instance_id: null, item_epoch: 1 });
  await mode("open");
  await expect(claimItemSecondReview(row.id, { instanceId: prefix, bootId: randomUUID() }, 60_000))
    .rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(await admin`SELECT to_jsonb(i) value FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`).toEqual(before);
}));

it("settles an in-flight legacy failure while draining and defers only its fresh fallback model", () => exercise(async () => {
  const { candidate, row } = await source();
  await actualJob("second-review", async lease => {
    const claim = await tracked(admitLegacySecondReview(row.id, lease));
    expect(claim.kind).toBe("admitted");
    if (claim.kind === "skipped") throw new Error(claim.reason);
    await mode("draining");
    expect(await tracked(recordSecondReview({ receipt: claim.receipt,
      result: { ok: false, error: "timeout", provider: row.provider!, model: row.model! } }))).toEqual({ state: "recorded" });
    const chain = (await voteRows(candidate.id)).map(value => value.value);
    expect(chain).toMatchObject([{ id: row.id, status: "resolved", resolution: "fallback", failure_count: 1 },
      { fallback_for_id: row.id, status: "pending", model: "pr05b1-fallback", failure_count: 1 }]);
    const child = chain[1];
    ownItemKeys.add(`ai2:${child.id}`);
    await expect(admitLegacySecondReview(Number(child.id), lease)).rejects.toMatchObject({ reason: "draining" });
    expect(await voteRows(candidate.id)).toEqual(chain.map(value => ({ value })));
    await mode("open");
    // The mapped root route never licenses its differently configured fallback.
    await expect(admitLegacySecondReview(Number(child.id), lease)).rejects.toMatchObject({ reason: "unmapped" });
    expect(await voteRows(candidate.id)).toEqual(chain.map(value => ({ value })));
  });
}));

it("retains current-domain invalidation and healthy-chain skip precedence under draining", () => exercise(async () => {
  const { row } = await source();
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai2'`;
  const claim = await tracked(claimItemSecondReview(row.id, { instanceId: `${prefix}foreign`, bootId: randomUUID() }, 60_000));
  if (claim.kind !== "skipped" && claim.receipt.ownership.kind === "item") ownItemTokens.add(claim.receipt.ownership.lease.token);
  expect(claim.kind).toBe("claimed");
  if (claim.kind === "skipped" || claim.receipt.ownership.kind !== "item") throw new Error("actual AI2 item receipt required");
  const before = await admin`SELECT to_jsonb(i) value FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`;
  await admin`UPDATE pipeline_stage_modes SET mode='legacy',writer_contract_version=0 WHERE stage='ai2'`;
  await mode("draining");
  await actualJob("second-review", async lease => {
    expect(await admitLegacySecondReview(row.id, lease)).toEqual({ kind: "skipped", reason: "running" });
  });
  expect(await admin`SELECT to_jsonb(i) value FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`).toEqual(before);
  // Restore the original item stage so this actual owner can settle; no early
  // release or fabricated legacy proof is used to cross the healthy owner.
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai2'`;
  await recordSecondReview({ receipt: claim.receipt, result: { ok: false, error: "cancelled", provider: row.provider!, model: row.model! } });
  await admin`UPDATE pipeline_stage_modes SET mode='legacy',writer_contract_version=0 WHERE stage='ai2'`;
  await admin`UPDATE crawl_documents SET fetched_at=fetched_at-interval '1 second' WHERE id=ANY(${ownDocuments})`;
  await actualJob("second-review", async lease => {
    expect(await admitLegacySecondReview(row.id, lease)).toEqual({ kind: "skipped", reason: "input_changed" });
  });
  expect((await voteRows(row.candidateId!))[0].value).toMatchObject({ status: "resolved", resolution: "superseded", failure_count: 0 });
}));

function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function blockedBy(pid: number) {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    const result = await observer`SELECT pid,query,xact_start FROM pg_stat_activity WHERE datname=current_database()
      AND ${pid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`;
    if (result.length) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("AI2 admission expected an actual PostgreSQL lock wait");
}

it("takes model control SHARE before S3/domain/job and preserves a concurrent producer/pause on defer", () => exercise(async () => {
  const { candidate } = await source();
  await mode("disabled");
  const before = await jobRow(), finish = latch(), ready = latch();
  let holding: Promise<unknown> | undefined, running: ReturnType<typeof tick> | undefined, pid = 0;
  try {
    holding = tracked(admin.begin(async tx => {
      [{ pid }] = await tx`SELECT pg_backend_pid() pid`;
      await tx`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
      ready.resolve(); await finish.promise;
    }));
    await Promise.race([ready.promise, holding]);
    running = tick();
    const waiters = await blockedBy(pid);
    expect(waiters.some(row => String(row.query).includes("model_capacity_control"))).toBe(true);
    await observer.begin(async probe => {
      await probe`SELECT stage FROM pipeline_stage_modes FOR UPDATE NOWAIT`;
      await probe`SELECT id FROM crawl_candidates WHERE id=${candidate.id} FOR UPDATE NOWAIT`;
      await probe`SELECT name FROM jobs WHERE name='second-review' FOR UPDATE NOWAIT`;
      // A real concurrent producer and human pause are retained by deferred ACK.
      await probe`UPDATE jobs SET requested_version=requested_version+1,not_before='2101-01-01 00:00:00.123456'::timestamp
        WHERE name='second-review'`;
    });
  } finally {
    finish.resolve();
    await Promise.allSettled([holding, running]);
  }
  expect(await running).toMatchObject({ status: "deferred", reason: "model_capacity" });
  const after = await jobRow();
  expect(after.requested_version).toBe(Number(before.requested_version) + 1);
  expect(after.not_before).toBe("2101-01-01T00:00:00.123456");
  for (const key of ["processed_version", "cursor", "last_error", "last_success_at"]) expect(after[key], key).toEqual(before[key]);
}));

it("propagates malformed control and leaves actual pending vote authority unchanged", () => exercise(async () => {
  const { candidate, row } = await source();
  await mode("open");
  await admin`UPDATE model_capacity_control SET policy_hash=${"a".repeat(64)} WHERE id=1`;
  const before = await voteRows(candidate.id);
  await actualJob("second-review", async lease => {
    await expect(admitLegacySecondReview(row.id, lease)).rejects.toThrow("model_capacity_policy_hash_mismatch");
  });
  expect(await voteRows(candidate.id)).toEqual(before);
  expect((await admin`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY to_jsonb(r)::text`).map(row => row.value))
    .toEqual(baseline!.model_capacity_requests);
}));

it("uses primary fresh admission inside a real read-only context without changing its enclosing scope", () => exercise(async () => {
  const { row } = await source();
  const globals = globalThis as unknown as { readDb?: typeof db | null }, saved = Object.getOwnPropertyDescriptor(globals, "readDb");
  const reader = postgres(TEST_DATABASE_URL, { max: 1, prepare: false,
    connection: { application_name: "pr05b1-ai2-read-only", default_transaction_read_only: true } });
  try {
    globals.readDb = drizzle(reader, { schema });
    await actualJob("second-review", lease => onReplica(async () => {
      const [before] = await db.execute<{ readonly: string }>(sql`SELECT current_setting('transaction_read_only') readonly`);
      expect(before.readonly).toBe("on");
      const admitted = await tracked(admitLegacySecondReview(row.id, lease));
      expect(admitted.kind).toBe("admitted");
      const [after] = await db.execute<{ readonly: string }>(sql`SELECT current_setting('transaction_read_only') readonly`);
      expect(after.readonly).toBe("on");
    }));
  } finally {
    if (saved) Object.defineProperty(globals, "readDb", saved); else Reflect.deleteProperty(globals, "readDb");
    await reader.end({ timeout: 3 });
  }
}));

it("keeps a genuine replacement job untouched when the old actual handler returns model defer", () => exercise(async () => {
  await source();
  await mode("draining");
  const ready = latch(), finish = latch();
  let replacement: Promise<unknown> | undefined, protectedRow: Raw | undefined;
  try {
    const original = await tracked(runJob<null>("second-review", async ctx => {
      jobTokens.add(ctx.lease!.token);
      const outcome = await secondReviewCandidates(ctx);
      expect(outcome).toEqual({ done: false, deferred: "model_capacity" });
      await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '91 seconds'
        WHERE name='second-review' AND lease_token=${ctx.lease!.token}`;
      replacement = tracked(runJob("second-review", async next => {
        jobTokens.add(next.lease!.token);
        ready.resolve(); await finish.promise; return { done: false };
      }, { requestedOnly: true }));
      await Promise.race([ready.promise, replacement]);
      protectedRow = await jobRow();
      return outcome;
    }, { requestedOnly: true }));
    expect(original).toMatchObject({ status: "failed", error: "job_lease_lost" });
    expect(await jobRow()).toEqual(protectedRow);
  } finally { finish.resolve(); await Promise.allSettled([replacement]); }
}));

it("rejects expired job authority after the actual model-deferred unlock waits", () => exercise(async () => {
  await source();
  await mode("draining");
  const ready = latch(), finish = latch();
  let holding: Promise<unknown> | undefined, running: ReturnType<typeof tick> | undefined;
  let pid = 0, until = "", protectedRow: Raw | undefined;
  try {
    running = tracked(runJob<null>("second-review", async ctx => {
      jobTokens.add(ctx.lease!.token);
      const outcome = await secondReviewCandidates(ctx);
      expect(outcome).toEqual({ done: false, deferred: "model_capacity" });
      // Anchor at the handler tail, after real admission refused. The held
      // update commits only after a real final-unlock waiter crosses DB expiry.
      holding = tracked(admin.begin(async tx => {
        const [anchored] = await tx`UPDATE jobs j SET locked_at=clock_timestamp()-interval '90 seconds'+interval '750 milliseconds'
          WHERE name='second-review' AND lease_token=${ctx.lease!.token}
          RETURNING pg_backend_pid() pid,to_jsonb(j) value,
            to_char(locked_at+interval '90 seconds','YYYY-MM-DD"T"HH24:MI:SS.US') expiry`;
        if (!anchored) throw new Error("AI2 fixture actual job anchor lost");
        pid = anchored.pid; until = anchored.expiry; protectedRow = anchored.value;
        ready.resolve(); await finish.promise;
      }));
      await Promise.race([ready.promise, holding]);
      return outcome;
    }, { requestedOnly: true }));
    await Promise.race([ready.promise, running]);
    const waiters = await blockedBy(pid);
    const [started] = await observer`SELECT xact_start < ${until}::text::timestamp AS healthy_at_start
      FROM pg_stat_activity WHERE pid=${waiters[0].pid}`;
    expect(started.healthy_at_start).toBe(true);
    const deadline = Date.now() + 2_500;
    let expired = false;
    while (Date.now() < deadline) {
      const [wall] = await observer`SELECT clock_timestamp() >= ${until}::text::timestamp AS expired`;
      if (wall.expired) { expired = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(expired).toBe(true);
  } finally { finish.resolve(); await Promise.allSettled([holding, running]); }
  expect(await running).toMatchObject({ status: "failed", error: "job_lease_lost" });
  expect(await jobRow()).toEqual(protectedRow);
}));

it.each([false, true])("preserves genuine verified %s item replay without granting model-control access", item => exercise(async () => {
  const { candidate, input, configured } = await rawSource(), reference = new Date();
  await mode("open");
  if (item) await admin`UPDATE pipeline_stage_modes SET mode='items',epoch=2,writer_contract_version=1 WHERE stage='ai2'`;
  await requestJob("crawl-agent-review");
  const model = (value: CrawlSettings["secondReview"]["voters"][number]) => ({ ...value, canonicalModel: canonicalReviewModel(value.model) });
  const first = configured.firstReview;
  if (!first?.model) throw new Error("AI2 replay fixture requires its exact first model");
  const manifest: CapacityManifest = { version: 1, runId: randomUUID(), revision: "db732d2f", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: input.policyHash, fullReviewPolicyHash: fullReviewPolicyHash(configured), comparisonPolicyHash: comparisonReviewPolicyHash(configured),
    initialStateHash: reviewHash(input), models: { first: model({ provider: first.provider, model: first.model }),
      second: configured.secondReview.voters.map(model), fallbacks: (configured.secondReview.fallbacks ?? []).map(model) },
    inputs: [{ candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 4, maxTokens: 400, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 1 } };
  const owned = await tracked(item ? getReplayItemHandlerIdentityPath() : getReplayHandlerIdentityPath());
  try {
    const [privileges] = await tracked(withReplayDatabaseScope(owned.identityPath, () => db.execute<{
      select: boolean; update: boolean;
    }>(sql`SELECT has_table_privilege(current_user,'public.model_capacity_control','SELECT') AS select,
      has_column_privilege(current_user,'public.model_capacity_control','id','UPDATE') AS update`)));
    expect(privileges).toEqual({ select: false, update: false });
    const database = await tracked(openVerifiedReplayHandlerDatabase(owned.identityPath, {}));
    const inputs = [{ candidateId: candidate.id, input }];
    try {
      const initial = item ? await tracked(new ReplayLedger(database).previewItemInitialState(manifest, inputs))
        : await tracked(new ReplayLedger(database).previewInitialState(manifest, inputs));
      manifest.initialStateHash = initial.initialStateHash;
    } finally { await database.close(); }
    const options = { identityPath: owned.identityPath, manifest, inputs, fixture: async () => ({
      result: { ok: true as const, outcome: { decision: "approve" as const, confidence: .99,
        reason: "Deployed task application", evidenceIds: ["product"] }, usage: { inputTokens: 8, outputTokens: 2 } },
      receipt: { inputTokens: 8, outputTokens: 2 } }) };
    const result = await tracked(item ? runCertifiedItemFixtureReviewReplay(options) : runCertifiedFixtureReviewReplay(options));
    const artifact = replayArtifactFromVerified(result.artifact);
    expect(artifact).toMatchObject({ version: item ? 2 : 1, run: { profile: item ? "handlers-v6-item" : "handlers-v5" } });
    expect(artifact.calls).toHaveLength(2);
    expect(result.diagnostics.finalCandidates).toBe(1);
    for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
  } finally {
    await owned.release();
    // The item IDs were issued inside the genuine replay, not guessed permits.
    for (const row of await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId'=${String(candidate.id)}`)
      ownItemKeys.add(String(row.work_key));
  }
}));


it("does not own probe jobs or observations from a rolled-back fixture transaction", () => exercise(async () => {
  await cleanup();
  expect(await whole()).toEqual(baseline);
  const originalNames = [...managedJobs];
  const probes = [0, 1, 2].map(index => `${prefix}rollback-${index}`);
  const observations = probes.map(name => `job:${name}`);
  const savedJobs = new Map<string, Raw>(), savedObservations = new Map<string, Raw>();
  const errors: unknown[] = [];
  let running: ReturnType<typeof runJob<null>> | undefined;
  managedJobs.splice(0, managedJobs.length, ...probes);
  try {
    expect(await admin`SELECT name FROM jobs WHERE name=ANY(${probes})`).toHaveLength(0);
    expect(await admin`SELECT key FROM operations_observations WHERE key=ANY(${observations})`).toHaveLength(0);
    const [conflict] = await admin`INSERT INTO jobs(name) VALUES(${probes[1]}) RETURNING to_jsonb(jobs) value`;
    savedJobs.set(probes[1], conflict.value);
    await expect(prepareManagedJobs()).rejects.toThrow("AI2 fixture managed job appeared");
    // The first job and its placeholder INSERT both preceded the conflict, but
    // neither exists after PostgreSQL has rolled the complete setup TX back.
    expect(await admin`SELECT name FROM jobs WHERE name=${probes[0]}`).toHaveLength(0);
    expect(await admin`SELECT key FROM operations_observations WHERE key=${observations[0]}`).toHaveLength(0);
    expect(await admin`DELETE FROM jobs j WHERE name=${probes[1]}
      AND to_jsonb(j)=${JSON.stringify(conflict.value)}::text::jsonb RETURNING name`).toHaveLength(1);
    savedJobs.delete(probes[1]);
    let actualToken: string | undefined;
    running = tracked(runJob<null>(probes[0], async ctx => {
      expect(ctx.lease).toBeDefined(); actualToken = ctx.lease!.token;
      return { done: true };
    }));
    expect(await running).toMatchObject({ status: "completed", done: true });
    expect(actualToken).toBeTypeOf("string");
    const external = await whole();
    const job = external.jobs.find(row => row.name === probes[0]);
    const observation = external.operations_observations.find(row => row.key === observations[0]);
    expect(job).toMatchObject({ locked_at: null, lease_token: null, runs: 1 });
    expect(observation).toBeDefined();
    savedJobs.set(probes[0], job!); savedObservations.set(observations[0], observation!);
    const cleanupError = await cleanup().then(() => undefined, error => error);
    expect(await whole()).toEqual(external);
    expect(cleanupError).toMatchObject({ message: "AI2 fixture unowned absent job" });
  } catch (error) { errors.push(error); }
  finally {
    try {
      if (running) await running;
      await admin.begin(async tx => {
        for (const [table, values, saved] of [["jobs", probes, savedJobs],
          ["operations_observations", observations, savedObservations]] as const) {
          for (const key of values) {
            const current = await currentRow(table, key, tx);
            if (!current) continue;
            const owned = saved.get(key);
            if (!owned || JSON.stringify(current) !== JSON.stringify(owned))
              throw new Error("AI2 rollback probe acquired an unknown replacement");
            expect(await tx.unsafe(`DELETE FROM "${table}" t WHERE "${keys[table]}"::text=$1
              AND to_jsonb(t)=$2::text::jsonb RETURNING "${keys[table]}"`,
            [key, JSON.stringify(owned)])).toHaveLength(1);
          }
        }
        expect(await whole(tx)).toEqual(baseline);
      });
    } catch (error) { errors.push(error); }
    finally {
      for (const key of probes) createdJobs.delete(key);
      for (const key of observations) createdObservations.delete(key);
      managedJobs.splice(0, managedJobs.length, ...originalNames);
    }
  }
  if (errors.length) throw new AggregateError(errors, "AI2 rollback ownership probe failed");
}));
