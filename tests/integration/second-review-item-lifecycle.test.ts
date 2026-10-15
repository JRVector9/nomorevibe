import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs,
  pipelineStageModes, products, secondReviews } from "@/lib/db/schema";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import type { AgentReviewResult } from "@/lib/crawl/agent-review";
import { executeSecondReviewItem } from "@/lib/crawl/second-review-item-lifecycle";
import { claimItemSecondReview } from "@/lib/crawl/second-review-ownership";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { publishedInputHash } from "@/lib/crawl/second-review";
import { markPublished } from "@/lib/crawl/repository";
import { removeProductAndEvidence } from "@/lib/domain/products/repository";
import { beginStageDrain } from "@/lib/jobs/items/repository";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// Only the existing external adapter functions are replaced. The new dispatch
// helper, claim, observer, heartbeat, result writer and DB all remain actual.
const adapters = vi.hoisted(() => ({ gateway: vi.fn(), cli: vi.fn(), grok: vi.fn() }));
vi.mock("@/lib/crawl/agent-review-gateway", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: adapters.gateway,
}));
vi.mock("@/lib/crawl/agent-review", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: adapters.cli,
}));
vi.mock("@/lib/crawl/agent-review-grok", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-grok")>(), reviewWithGrokCli: adapters.grok,
}));

const prefix = "pr04c1b-lifecycle/", slugPrefix = "pr04c1b-lifecycle-";
const managedJobs = ["second-review", "crawl-publish"];
const owner = { instanceId: "pr04c1b-lifecycle-owner", bootId: "00000000-0000-4000-8000-000000055507" };
const foreign = { instanceId: "pr04c1b-lifecycle-other", bootId: "00000000-0000-4000-8000-000000055508" };
const sentinelName = `pr04c1b-lifecycle-unrelated-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04c1b-lifecycle-admin", statement_timeout: 8_000 } });
type RawRow = Record<string, unknown>;
type Execution = { outcome: Awaited<ReturnType<typeof executeSecondReviewItem>> } | { error: unknown };
let originalSettings: RawRow[] = [], originalJobs: RawRow[] = [], originalStages: RawRow[] = [];
let baseline: unknown, baselineWithSentinel: unknown, sequence = 0, initialized = false;

function policy(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "lifecycle-first" }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm", model: "lifecycle-second" }],
      fallbacks: [{ provider: "abcllm", model: "lifecycle-backup" }] } };
}

async function wholeSnapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM crawl_settings s),
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j),
    'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage),'[]'::jsonb) FROM pipeline_stage_modes s),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage,work_key),'[]'::jsonb) FROM pipeline_item_leases i),
    'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM crawl_candidates c),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM crawl_documents d),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM crawl_review_attempts a),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM second_reviews s),
    'products',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM products p),
    'purges',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM cdn_purges p),
    'observations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY key),'[]'::jsonb) FROM operations_observations o)) AS value`;
  return row.value;
}

async function restoreShared() {
  const absent = managedJobs.filter(name => !originalJobs.some(row => row.name === name));
  if (absent.length) await db.delete(jobs).where(inArray(jobs.name, absent));
  if (originalJobs.length) await admin`UPDATE jobs j SET requested_version=r.requested_version,
    processed_version=r.processed_version,next_scheduled_at=r.next_scheduled_at,not_before=r.not_before,
    lease_token=r.lease_token,worker_seen_at=r.worker_seen_at,cursor=r.cursor,locked_at=r.locked_at,
    last_run_at=r.last_run_at,last_success_at=r.last_success_at,last_error=r.last_error,runs=r.runs,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb) r WHERE j.name=r.name`;
  if (originalSettings.length) await admin`UPDATE crawl_settings s SET values=r.values,updated_by=r.updated_by,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb) r WHERE s.id=r.id`;
  else await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
  await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,epoch=r.epoch,
    writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages)}::text::jsonb) r WHERE s.stage=r.stage`;
}

async function cleanup() {
  const errors: unknown[] = [];
  const step = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
  await step(async () => { await admin`DROP TRIGGER IF EXISTS pr04c1b_lifecycle_outbox_failure ON jobs`; });
  await step(async () => { await admin`DROP FUNCTION IF EXISTS pr04c1b_lifecycle_outbox_failure()`; });
  await step(async () => { await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE 'pr04c1b-lifecycle/%')`; });
  await step(async () => { await db.delete(secondReviews).where(like(secondReviews.repo, `${prefix}%`)); });
  await step(async () => {
    const ids = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
    if (ids.length) await db.delete(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, ids.map(row => row.id)));
  });
  await step(async () => { await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`)); });
  await step(async () => { await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`)); });
  await step(async () => { await db.delete(products).where(like(products.slug, `${slugPrefix}%`)); });
  await step(async () => { await db.delete(cdnPurges).where(like(cdnPurges.slug, `${slugPrefix}%`)); });
  await step(restoreShared);
  if (errors.length) throw new AggregateError(errors, "lifecycle_fixture_cleanup_failed");
}

beforeAll(async () => {
  ensureSchema();
  originalSettings = (await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`).map(row => row.row);
  originalJobs = (await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=ANY(${managedJobs}) ORDER BY name`).map(row => row.row);
  originalStages = (await admin`SELECT to_jsonb(s) AS row FROM pipeline_stage_modes s ORDER BY stage`).map(row => row.row);
  baseline = await wholeSnapshot(); initialized = true;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,last_error,updated_at)
    VALUES(${sentinelName},17,6,'{"unrelated":"preserve"}'::jsonb,'2101-01-01 00:00:00.654321'::timestamp,
      'unrelated history','2001-02-03 04:05:06.123456'::timestamp)`;
  baselineWithSentinel = await wholeSnapshot();
});

beforeEach(async () => {
  await cleanup();
  expect(await wholeSnapshot()).toEqual(baselineWithSentinel);
  adapters.gateway.mockReset(); adapters.cli.mockReset(); adapters.grok.mockReset();
  adapters.gateway.mockResolvedValue(approval());
  adapters.cli.mockRejectedValue(new Error("unexpected_cli_dispatch"));
  adapters.grok.mockRejectedValue(new Error("unexpected_grok_dispatch"));
  await db.insert(crawlSettings).values({ id: 1, values: policy(), updatedBy: "pr04c1b-lifecycle" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: policy(), updatedBy: "pr04c1b-lifecycle" } });
  await db.update(pipelineStageModes).set({ mode: "items", drainingFrom: null, writerContractVersion: 1 })
    .where(eq(pipelineStageModes.stage, "ai2"));
});

afterEach(async () => {
  if (!initialized) return;
  await cleanup();
  expect(await wholeSnapshot()).toEqual(baselineWithSentinel);
});

afterAll(async () => {
  const errors: unknown[] = [];
  try { if (initialized) await cleanup(); } catch (error) { errors.push(error); }
  try { if (initialized) await db.delete(jobs).where(eq(jobs.name, sentinelName)); } catch (error) { errors.push(error); }
  try { if (initialized) expect(await wholeSnapshot()).toEqual(baseline); } catch (error) { errors.push(error); }
  try { await admin.end({ timeout: 3 }); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "lifecycle_final_cleanup_failed");
});

async function fixture() {
  const settings = policy(), repo = `${prefix}app-${++sequence}`, now = new Date(Date.now() - 2_000);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://pr04c1b-lifecycle-${sequence}.test`,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: now, decidedAt: now }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl,
    fetchedAt: now, pageStatus: 200, repoMeta: { description: "A project management application", stargazers_count: 12 },
    pageMeta: { title: "Lifecycle", description: "Create projects and manage tasks", textSample: "Manage tasks online" } }).returning();
  const input = await loadReviewInput(candidate, document, settings);
  // Historical first input is fixture data. All AI2 ownership below is issued
  // by the actual item claim and never by synthetic receipts or token INSERTs.
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "abcllm", model: "lifecycle-first", attemptNumber: 1,
    outcome: { decision: "approve", confidence: .94, reason: "Deployed application", evidenceIds: ["product"] },
    validUntil: input.validUntil, completedAt: now }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, trigger: "ai_approved",
    firstDecision: "approve", firstConfidence: .94, firstModel: first.model, firstAttemptId: first.id,
    generationKey: secondReviewGeneration(first.id, input, "ai_approved"), inputHash: input.inputHash,
    provider: "abcllm", model: "lifecycle-second" }).returning();
  return { candidate, document, first, row, input };
}

function approval(): AgentReviewResult {
  return { ok: true, outcome: { decision: "approve", confidence: .96, reason: "Verified deployed product", evidenceIds: ["product"] }, usage: {} };
}

async function item(id: number) {
  const [row] = await admin`SELECT to_jsonb(i) AS value,
    to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry,
    lease_until>clock_timestamp() AS live FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${id}`}`;
  return row as { value: RawRow; expiry: string | null; live: boolean } | undefined;
}
async function publishVersion() {
  const [row] = await admin`SELECT requested_version::text AS version FROM jobs WHERE name='crawl-publish'`;
  return Number(row?.version ?? 0);
}
async function released(id: number) {
  expect((await item(id))?.value).toMatchObject({ owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null });
}
function identity(row: RawRow) {
  return { stage: row.stage, work_key: row.work_key, binding: row.binding, binding_hash: row.binding_hash,
    owner_instance_id: row.owner_instance_id, owner_boot_id: row.owner_boot_id, token: row.token,
    stage_epoch: row.stage_epoch, item_epoch: row.item_epoch };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("records a short actual item control and atomically releases only its owner", async () => {
  const { row, input } = await fixture(), requested = await publishVersion();
  expect(await executeSecondReviewItem({ secondReviewId: row.id, owner })).toEqual({ state: "recorded" });
  expect(adapters.gateway).toHaveBeenCalledExactlyOnceWith(input, {
    model: "lifecycle-second", timeoutMs: 60_000, signal: expect.any(AbortSignal),
  });
  expect(adapters.cli).not.toHaveBeenCalled(); expect(adapters.grok).not.toHaveBeenCalled();
  expect(await db.select().from(secondReviews).where(eq(secondReviews.id, row.id)))
    .toMatchObject([{ status: "agreed", secondDecision: "approve", failureCount: 0 }]);
  expect(await publishVersion()).toBe(requested + 1);
  await released(row.id);
});

it("renews the same actual owner beyond its original 90-second expiry before settling", async () => {
  const { row } = await fixture(), requested = await publishVersion(), finish = latch();
  let initial: Awaited<ReturnType<typeof item>>, afterExpiry: Awaited<ReturnType<typeof item>>;
  let crossed = false, ended = false, executionResult: Execution | undefined;
  let competition: Awaited<ReturnType<typeof claimItemSecondReview>> | undefined;
  const renewals: string[] = [];
  adapters.gateway.mockImplementation(async (_input, options) => {
    expect(options).toMatchObject({ model: "lifecycle-second", timeoutMs: 60_000 });
    initial = await item(row.id);
    await finish.promise;
    return approval();
  });
  const execution: Promise<Execution> = executeSecondReviewItem({ secondReviewId: row.id, owner })
    .then(outcome => ({ outcome }), error => ({ error })).finally(() => { ended = true; });
  try {
    await expect.poll(() => initial, { timeout: 8_000, interval: 20 }).toBeDefined();
    expect(initial?.live).toBe(true);
    expect(initial?.value).toMatchObject({ owner_instance_id: owner.instanceId, owner_boot_id: owner.bootId,
      token: expect.any(String), item_epoch: 1,
      stage_epoch: originalStages.find(stage => stage.stage === "ai2")!.epoch });
    await expect.poll(async () => {
      const [clock] = await admin`SELECT clock_timestamp()>${initial!.expiry!}::timestamptz AS crossed`;
      const observed = await item(row.id);
      if (observed?.expiry && observed.expiry !== initial!.expiry && !renewals.includes(observed.expiry)) renewals.push(observed.expiry);
      crossed = clock.crossed;
      return crossed;
    }, { timeout: 95_000, interval: 250 }).toBe(true);
    afterExpiry = await item(row.id);
    competition = await claimItemSecondReview(row.id, foreign, 90_000);
    expect(ended).toBe(false);
  } finally {
    finish.resolve(); executionResult = await execution;
  }
  // Preserve actual expiry/identity evidence before feature assertions. The
  // heartbeat0 scaffold reaches this point and fails on real lost ownership.
  console.info("pr04c1b.original_expiry", JSON.stringify({ original: initial, afterExpiry, crossed,
    renewals, competition: competition?.kind, result: executionResult && "outcome" in executionResult
      ? executionResult.outcome : { error: executionResult && "error" in executionResult
        ? (executionResult.error instanceof Error ? executionResult.error.message : String(executionResult.error)) : "missing" } }));
  expect(crossed).toBe(true);
  expect(executionResult).toMatchObject({ outcome: { state: "recorded" } });
  expect(afterExpiry?.live).toBe(true);
  expect(identity(afterExpiry!.value)).toEqual(identity(initial!.value));
  expect(renewals.length).toBeGreaterThan(0);
  expect(competition).toEqual({ kind: "skipped", reason: "running" });
  expect(adapters.gateway).toHaveBeenCalledTimes(1);
  expect(await publishVersion()).toBe(requested + 1);
  await released(row.id);
}, 120_000);

// The original two cases and their core fixture above stay unchanged. Expanded
// cases use these append-only test helpers and actual production authority.
async function domainSnapshot(id: number) {
  const [row] = await admin`SELECT jsonb_build_object(
    'vote',(SELECT to_jsonb(s) FROM second_reviews s WHERE id=${id}),
    'candidate',(SELECT to_jsonb(c) FROM crawl_candidates c JOIN second_reviews s ON s.candidate_id=c.id WHERE s.id=${id}),
    'chain',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM second_reviews s WHERE s.id=${id} OR s.fallback_for_id=${id}),
    'publish',(SELECT to_jsonb(j) FROM jobs j WHERE name='crawl-publish'),
    'reviewJob',(SELECT to_jsonb(j) FROM jobs j WHERE name='second-review')) AS value`;
  return row.value as { vote: RawRow; candidate: RawRow; chain: RawRow[]; publish: RawRow | null; reviewJob: RawRow | null };
}

function heldExecution(id: number, options: { signal?: AbortSignal; result?: AgentReviewResult; reject?: Error } = {}) {
  const finish = latch();
  let initial: Awaited<ReturnType<typeof item>>, signal: AbortSignal | undefined, ended = false;
  adapters.gateway.mockImplementation(async (_input, transportOptions) => {
    signal = transportOptions.signal; initial = await item(id);
    await finish.promise;
    if (options.reject) throw options.reject;
    return options.result ?? approval();
  });
  const execution: Promise<Execution> = executeSecondReviewItem({ secondReviewId: id, owner, signal: options.signal })
    .then(outcome => ({ outcome }), error => ({ error })).finally(() => { ended = true; });
  return { execution, finish: finish.resolve, get initial() { return initial; }, get signal() { return signal; },
    get ended() { return ended; }, started: () => expect.poll(() => initial, { timeout: 8_000, interval: 20 }).toBeDefined() };
}

it("does not claim or dispatch a pre-aborted item", async () => {
  const { row } = await fixture(), controller = new AbortController(), before = await domainSnapshot(row.id);
  controller.abort();
  expect(await executeSecondReviewItem({ secondReviewId: row.id, owner, signal: controller.signal }))
    .toEqual({ state: "skipped", reason: "aborted" });
  expect(adapters.gateway).not.toHaveBeenCalled();
  expect(await item(row.id)).toBeUndefined();
  expect(await domainSnapshot(row.id)).toEqual(before);
});

it.each(["legacy", "draining"] as const)("does not dispatch a new item while stage mode is %s", async mode => {
  const { row } = await fixture(), before = await domainSnapshot(row.id);
  if (mode === "draining") await db.transaction(tx => beginStageDrain(tx, "ai2"));
  else await db.update(pipelineStageModes).set({ mode: "legacy", writerContractVersion: 0 }).where(eq(pipelineStageModes.stage, "ai2"));
  expect(await executeSecondReviewItem({ secondReviewId: row.id, owner })).toEqual({ state: "skipped", reason: "stage_inactive" });
  expect(adapters.gateway).not.toHaveBeenCalled();
  expect(await item(row.id)).toBeUndefined();
  expect(await domainSnapshot(row.id)).toEqual(before);
});

it("preserves a healthy foreign item without dispatch or domain changes", async () => {
  const { row } = await fixture();
  expect((await claimItemSecondReview(row.id, foreign, 90_000)).kind).toBe("claimed");
  const before = await domainSnapshot(row.id), owned = await item(row.id);
  expect(await executeSecondReviewItem({ secondReviewId: row.id, owner })).toEqual({ state: "skipped", reason: "running" });
  expect(await item(row.id)).toEqual(owned);
  expect(await domainSnapshot(row.id)).toEqual(before);
  expect(adapters.gateway).not.toHaveBeenCalled();
});

it("dispatches once when two actual executions compete for the same item", async () => {
  const { row } = await fixture(), requested = await publishVersion(), held = heldExecution(row.id);
  let result: Execution | undefined;
  try {
    await held.started();
    expect(await executeSecondReviewItem({ secondReviewId: row.id, owner: foreign })).toEqual({ state: "skipped", reason: "running" });
    expect(await item(row.id)).toEqual(held.initial);
    expect(held.ended).toBe(false);
    expect(adapters.gateway).toHaveBeenCalledTimes(1);
  } finally { held.finish(); result = await held.execution; }
  expect(result).toEqual({ outcome: { state: "recorded" } });
  expect(await publishVersion()).toBe(requested + 1);
  await released(row.id);
});

it("keeps renewing an aborted caller's owner until an abort-ignoring transport actually settles", async () => {
  const { row } = await fixture(), controller = new AbortController(), held = heldExecution(row.id, { signal: controller.signal });
  let result: Execution | undefined, before: Awaited<ReturnType<typeof domainSnapshot>> | undefined;
  try {
    await held.started(); before = await domainSnapshot(row.id);
    controller.abort();
    expect(held.signal?.aborted).toBe(true);
    await expect.poll(async () => (await item(row.id))?.expiry !== held.initial!.expiry,
      { timeout: 18_000, interval: 25 }).toBe(true);
    const renewed = await item(row.id);
    expect(renewed?.live).toBe(true);
    expect(identity(renewed!.value)).toEqual(identity(held.initial!.value));
    expect(await domainSnapshot(row.id)).toEqual(before);
    expect(held.ended).toBe(false);
    expect(await claimItemSecondReview(row.id, foreign, 90_000)).toEqual({ kind: "skipped", reason: "running" });
  } finally { held.finish(); result = await held.execution; }
  expect(result).toEqual({ outcome: { state: "cancelled" } });
  expect(await domainSnapshot(row.id)).toEqual(before);
  await released(row.id);
});

it("lets an already dispatched owner settle during drain while rejecting new claims", async () => {
  const { row } = await fixture(), requested = await publishVersion(), held = heldExecution(row.id);
  let result: Execution | undefined;
  try {
    await held.started();
    await db.transaction(tx => beginStageDrain(tx, "ai2"));
    expect(await claimItemSecondReview(row.id, foreign, 90_000)).toEqual({ kind: "skipped", reason: "stage_inactive" });
    expect(await item(row.id)).toEqual(held.initial);
    expect(held.ended).toBe(false);
  } finally { held.finish(); result = await held.execution; }
  expect(result).toEqual({ outcome: { state: "recorded" } });
  expect(await publishVersion()).toBe(requested + 1);
  await released(row.id);
});

it.each(["source", "human", "policy", "terminal"] as const)("settles a late result after current %s changes using only its original owner", async change => {
  const { row, candidate, document } = await fixture(), held = heldExecution(row.id);
  let result: Execution | undefined, current: Awaited<ReturnType<typeof domainSnapshot>> | undefined;
  try {
    await held.started();
    if (change === "source") await db.update(crawlDocuments).set({ pageMeta: { title: "Changed product source" } }).where(eq(crawlDocuments.id, document.id));
    if (change === "human") await db.update(crawlCandidates).set({ state: "rejected", reason: "not_a_product", decidedBy: "admin" }).where(eq(crawlCandidates.id, candidate.id));
    if (change === "policy") {
      const changed = policy(); changed.secondReview.agreeAt = .9;
      await db.update(crawlSettings).set({ values: changed }).where(eq(crawlSettings.id, 1));
    }
    if (change === "terminal") await db.update(secondReviews).set({ status: "resolved", resolution: "kept", resolvedBy: "admin", resolvedAt: new Date() }).where(eq(secondReviews.id, row.id));
    current = await domainSnapshot(row.id);
    expect(await item(row.id)).toEqual(held.initial);
    expect(held.ended).toBe(false);
  } finally { held.finish(); result = await held.execution; }
  expect(result).toEqual({ outcome: change === "terminal" ? { state: "not_pending" }
    : { state: "input_changed", reason: change === "policy" ? "binding_changed" : "context_invalid" } });
  const after = await domainSnapshot(row.id);
  expect(after.candidate).toEqual(current!.candidate);
  expect(after.publish).toEqual(current!.publish);
  expect(after.reviewJob).toEqual(current!.reviewJob);
  if (change === "terminal" || change === "policy") expect(after).toEqual(current);
  else expect(after.vote).toMatchObject({ status: "resolved", resolution: "superseded", second_decision: null, failure_count: 0 });
  await released(row.id);
  if (change === "policy") {
    adapters.gateway.mockResolvedValue(approval());
    expect(await executeSecondReviewItem({ secondReviewId: row.id, owner })).toEqual({ state: "recorded" });
    expect((await item(row.id))?.value.item_epoch).toBe(2);
    await released(row.id);
  }
});

it("preserves the original transport exception without writer, fallback, request or release", async () => {
  const { row } = await fixture(), failure = new Error("own_unexpected_transport_rejection"), held = heldExecution(row.id, { reject: failure });
  let result: Execution | undefined, before: Awaited<ReturnType<typeof domainSnapshot>> | undefined;
  try { await held.started(); before = await domainSnapshot(row.id); }
  finally { held.finish(); result = await held.execution; }
  expect(result).toEqual({ error: failure });
  expect(result && "error" in result && result.error).toBe(failure);
  expect(await domainSnapshot(row.id)).toEqual(before);
  expect(await item(row.id)).toEqual(held.initial);
  expect((await item(row.id))?.live).toBe(true);
});

it("rejects the late original writer after an actual expiry takeover without changing the new owner", async () => {
  const { row } = await fixture(), held = heldExecution(row.id);
  let result: Execution | undefined, before: Awaited<ReturnType<typeof domainSnapshot>> | undefined;
  let replacement: Awaited<ReturnType<typeof item>>;
  try {
    await held.started();
    // Fault injection only: the independent long case above proves natural
    // 90-second expiry. A replacement token is always issued by actual claim.
    await admin`UPDATE pipeline_item_leases SET lease_until=clock_timestamp()-interval '1 millisecond'
      WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`;
    const claimed = await claimItemSecondReview(row.id, foreign, 90_000);
    expect(claimed.kind).toBe("claimed");
    replacement = await item(row.id); before = await domainSnapshot(row.id);
    expect(replacement!.value.token).not.toBe(held.initial!.value.token);
    expect(replacement!.value.item_epoch).toBe(2);
    await expect.poll(() => held.signal?.aborted, { timeout: 18_000, interval: 25 }).toBe(true);
    expect(held.ended).toBe(false);
    expect(await item(row.id)).toEqual(replacement);
  } finally { held.finish(); result = await held.execution; }
  expect(result).toMatchObject({ error: { message: "item_lease_lost" } });
  expect(await item(row.id)).toEqual(replacement);
  expect(await domainSnapshot(row.id)).toEqual(before);
});

it("records a structured transport failure through the existing fallback writer exactly once", async () => {
  const { row } = await fixture(), requested = await publishVersion();
  const [before] = await admin`SELECT requested_version::text AS version FROM jobs WHERE name='second-review'`;
  adapters.gateway.mockResolvedValue({ ok: false, error: "timeout" });
  expect(await executeSecondReviewItem({ secondReviewId: row.id, owner })).toEqual({ state: "recorded" });
  const actual = await domainSnapshot(row.id);
  expect(actual.vote).toMatchObject({ status: "resolved", resolution: "fallback", failure_count: 1, error_code: "timeout" });
  expect(actual.chain).toHaveLength(2);
  expect(actual.chain.find(vote => vote.id !== row.id)).toMatchObject({ fallback_for_id: row.id,
    status: "pending", model: "lifecycle-backup", generation_key: row.generationKey });
  expect(Number(actual.reviewJob!.requested_version)).toBe(Number(before?.version ?? 0) + 1);
  expect(await publishVersion()).toBe(requested);
  expect(adapters.gateway).toHaveBeenCalledTimes(1);
  await released(row.id);
});

it("rolls result, request and release back together when the actual outbox write fails", async () => {
  const { row } = await fixture();
  let held: ReturnType<typeof heldExecution> | undefined;
  let result: Execution | undefined, before: Awaited<ReturnType<typeof domainSnapshot>> | undefined;
  try {
    await admin.unsafe(`CREATE FUNCTION pr04c1b_lifecycle_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name='crawl-publish' THEN RAISE EXCEPTION 'own_lifecycle_outbox_failed'; END IF; RETURN NEW; END $$`);
    await admin.unsafe(`CREATE TRIGGER pr04c1b_lifecycle_outbox_failure BEFORE INSERT OR UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION pr04c1b_lifecycle_outbox_failure()`);
    held = heldExecution(row.id);
    await held.started(); before = await domainSnapshot(row.id);
  }
  finally {
    try { if (held) { held.finish(); result = await held.execution; } }
    finally {
      try { await admin`DROP TRIGGER IF EXISTS pr04c1b_lifecycle_outbox_failure ON jobs`; }
      finally { await admin`DROP FUNCTION IF EXISTS pr04c1b_lifecycle_outbox_failure()`; }
    }
  }
  expect(result).toMatchObject({ error: { cause: { message: "own_lifecycle_outbox_failed" } } });
  expect(await domainSnapshot(row.id)).toEqual(before);
  expect(await item(row.id)).toEqual(held!.initial);
});

it("propagates an unexpected actual renewal error only after transport settles without invoking the writer", async () => {
  const { row } = await fixture();
  let held: ReturnType<typeof heldExecution> | undefined;
  let result: Execution | undefined, before: Awaited<ReturnType<typeof domainSnapshot>> | undefined;
  try {
    await admin.unsafe(`CREATE FUNCTION pr04c1b_lifecycle_renew_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.stage='ai2' AND NEW.work_key='ai2:${row.id}' AND OLD.token IS NOT NULL
        AND NEW.token IS NOT DISTINCT FROM OLD.token AND NEW.lease_until>OLD.lease_until
        THEN RAISE EXCEPTION 'own_lifecycle_renew_failed'; END IF; RETURN NEW; END $$`);
    await admin.unsafe(`CREATE TRIGGER pr04c1b_lifecycle_renew_failure BEFORE UPDATE ON pipeline_item_leases
      FOR EACH ROW EXECUTE FUNCTION pr04c1b_lifecycle_renew_failure()`);
    const active = held = heldExecution(row.id);
    await active.started(); before = await domainSnapshot(row.id);
    await expect.poll(() => active.signal?.aborted, { timeout: 18_000, interval: 25 }).toBe(true);
    expect(active.ended).toBe(false);
    expect(await item(row.id)).toEqual(active.initial);
    expect(await domainSnapshot(row.id)).toEqual(before);
  } finally {
    try { if (held) { held.finish(); result = await held.execution; } }
    finally {
      try { await admin`DROP TRIGGER IF EXISTS pr04c1b_lifecycle_renew_failure ON pipeline_item_leases`; }
      finally { await admin`DROP FUNCTION IF EXISTS pr04c1b_lifecycle_renew_failure()`; }
    }
  }
  expect(result).toMatchObject({ error: { cause: { message: "own_lifecycle_renew_failed" } } });
  expect(await domainSnapshot(row.id)).toEqual(before);
  expect(await item(row.id)).toEqual(held!.initial);
});

it("drains an actual blocked renewal before entering the result writer", async () => {
  const { row, candidate } = await fixture(), held = heldExecution(row.id), unlock = latch(), locked = latch();
  const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04c1b-lifecycle-renew-blocker", statement_timeout: 8_000 } });
  let blocking: Promise<unknown> | undefined, blockerPid: number | undefined, result: Execution | undefined;
  let before: Awaited<ReturnType<typeof domainSnapshot>> | undefined;
  const transactionTrace: string[] = [];
  let transactionCount = 0, restoreTransaction: (() => void) | undefined;
  try {
    await held.started(); before = await domainSnapshot(row.id);
    // Observe the initialized Drizzle instance, not the public db Proxy. Every
    // real callback/config/receiver/result/error still passes through unchanged.
    const actualDb = (globalThis as unknown as { db?: typeof db }).db;
    expect(actualDb).toBeDefined();
    const descriptor = Object.getOwnPropertyDescriptor(actualDb!, "transaction");
    const originalTransaction = actualDb!.transaction;
    Object.defineProperty(actualDb!, "transaction", { configurable: true, writable: true,
      value: async function (this: typeof db, ...args: Parameters<typeof originalTransaction>) {
        const number = ++transactionCount;
        transactionTrace.push(`start${number}`);
        try { return await Reflect.apply(originalTransaction, this, args); }
        finally { transactionTrace.push(`end${number}`); }
      } });
    restoreTransaction = () => {
      if (descriptor) Object.defineProperty(actualDb!, "transaction", descriptor);
      else if (!Reflect.deleteProperty(actualDb!, "transaction")) throw new Error("own_transaction_restore_failed");
    };
    blocking = blocker.begin(async raw => {
      const [backend] = await raw`SELECT pg_backend_pid() AS pid`; blockerPid = backend.pid;
      await raw`SELECT id FROM crawl_candidates WHERE id=${candidate.id} FOR UPDATE`;
      locked.resolve(); await unlock.promise;
    });
    void blocking.catch(() => locked.resolve());
    await locked.promise;
    await expect.poll(async () => {
      const [waiting] = await admin`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND ${blockerPid!}::int=ANY(pg_blocking_pids(pid))`;
      return waiting.count;
    }, { timeout: 18_000, interval: 25 }).toBe(1);
    held.finish();
    // Keep the actual backend wait as independent DB evidence. The complete
    // transaction trace below also detects a writer starting before renew ends.
    const [waiting] = await admin`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND ${blockerPid!}::int=ANY(pg_blocking_pids(pid))`;
    expect(waiting.count).toBe(1);
    expect(held.ended).toBe(false);
    expect(await domainSnapshot(row.id)).toEqual(before);
    unlock.resolve(); await blocking;
  } finally {
    unlock.resolve(); held.finish();
    try { if (blocking) await blocking; } finally {
      try { result = await held.execution; } finally {
        try { restoreTransaction?.(); } finally { await blocker.end({ timeout: 3 }); }
      }
    }
  }
  console.info("own_lifecycle_transaction_order", { trace: transactionTrace });
  expect(transactionCount).toBe(2);
  expect(transactionTrace).toEqual(["start1", "end1", "start2", "end2"]);
  expect(result).toEqual({ outcome: { state: "recorded" } });
  await released(row.id);
});

async function publishedFixture() {
  const initial = await fixture();
  const values = { slug: `${slugPrefix}${sequence}`, url: initial.candidate.productUrl!,
    repoUrl: `https://github.com/${initial.candidate.repo}`, name: "Lifecycle published",
    tagline: "Manage projects", description: "A deployed task application", category: "Dev",
    status: "seeded" as const, source: "crawler" as const, verifyToken: randomUUID(), editTokenHash: "a".repeat(64) };
  const [product] = await db.insert(products).values(values).returning();
  await markPublished(initial.candidate.repo, product.slug);
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, initial.candidate.id));
  const input = await loadReviewInput(candidate, initial.document, policy());
  const [row] = await db.update(secondReviews).set({ publishedSlug: product.slug, trigger: "sample",
    firstAttemptId: null, firstModel: null, firstConfidence: null, inputHash: publishedInputHash(product.slug),
    generationKey: secondReviewGeneration(null, input, "sample") }).where(eq(secondReviews.id, initial.row.id)).returning();
  return { ...initial, candidate, row, product, values };
}

it("rejects a late result for a removed and re-created published generation while preserving its replacement", async () => {
  const f = await publishedFixture(), held = heldExecution(f.row.id);
  let result: Execution | undefined, before: Awaited<ReturnType<typeof domainSnapshot>> | undefined;
  let replacement: typeof f.product | undefined;
  try {
    await held.started();
    expect((held.initial!.value.binding as RawRow).source).toEqual({ kind: "published", slug: f.product.slug, productId: f.product.id });
    expect(await removeProductAndEvidence(f.product.id, f.product.slug)).toBe(true);
    [replacement] = await db.insert(products).values(f.values).returning();
    await markPublished(f.candidate.repo, replacement.slug);
    before = await domainSnapshot(f.row.id);
    expect(await item(f.row.id)).toEqual(held.initial);
  } finally { held.finish(); result = await held.execution; }
  expect(result).toEqual({ outcome: { state: "input_changed", reason: "binding_changed" } });
  expect(await domainSnapshot(f.row.id)).toEqual(before);
  expect(await db.select().from(products).where(eq(products.id, replacement!.id))).toEqual([replacement]);
  await released(f.row.id);
  adapters.gateway.mockResolvedValue(approval());
  expect(await executeSecondReviewItem({ secondReviewId: f.row.id, owner })).toEqual({ state: "recorded" });
  expect(((await item(f.row.id))!.value.binding as RawRow).source).toEqual({ kind: "published", slug: replacement!.slug, productId: replacement!.id });
  await released(f.row.id);
});
