import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs,
  operationsObservations, secondReviews } from "@/lib/db/schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash, reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { closeSettledSecondReviews, enqueueSecondReviews, reopenOrphanedGateHolds,
  retryFailedSecondReviews, recordSecondReview } from "@/lib/crawl/second-review";
import { claimItemSecondReview } from "@/lib/crawl/second-review-ownership";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { runJob } from "@/lib/jobs/runner";
import { JobLeaseLostError, type JobLease } from "@/lib/jobs/control";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { ReplayLedger, type ReplayRun } from "@/lib/operations/pipeline-replay-ledger";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { withReplayFinalScope } from "@/lib/operations/pipeline-replay-final";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

const prefix = "pr04b2-authority/";
const managedJobs = ["second-review", "crawl-agent-review", "crawl-publish"];
const observationKeys = managedJobs.map(name => `job:${name}`);
const sentinelName = `pr04b2-authority-unrelated-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04b2-authority-admin", statement_timeout: 8_000 } });
let sequence = 0, initialized = false;
let originalSettings: unknown[] = [], originalJobs: { name: string }[] = [], originalObservations: { key: string }[] = [];
let originalStages: unknown[] = [], originalCandidates: unknown[] = [], originalVotes: unknown[] = [];
let baseline: unknown, withSentinel: unknown;

function policy(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true, sampleRate: 0,
      voters: [{ provider: "abcllm", model: "second-model" }], fallbacks: [] } };
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

async function restoreSharedRows() {
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
  const absentObservations = observationKeys.filter(key => !originalObservations.some(row => row.key === key));
  if (absentObservations.length) await db.delete(operationsObservations).where(inArray(operationsObservations.key, absentObservations));
  if (originalObservations.length) await admin`UPDATE operations_observations o SET value=r.value,observed_at=r.observed_at
    FROM jsonb_populate_recordset(NULL::operations_observations,${JSON.stringify(originalObservations)}::text::jsonb) r WHERE o.key=r.key`;
  if (originalStages.length) await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,
    epoch=r.epoch,writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages)}::text::jsonb) r WHERE s.stage=r.stage`;
}

async function restoreForeignDemand() {
  if (originalCandidates.length) await admin`UPDATE crawl_candidates c SET decided_by=r.decided_by
    FROM jsonb_populate_recordset(NULL::crawl_candidates,${JSON.stringify(originalCandidates)}::text::jsonb) r WHERE c.id=r.id`;
  if (originalVotes.length) await admin`UPDATE second_reviews s SET status=r.status,resolution=r.resolution
    FROM jsonb_populate_recordset(NULL::second_reviews,${JSON.stringify(originalVotes)}::text::jsonb) r WHERE s.id=r.id`;
}

async function cleanup() {
  await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE 'pr04b2-authority/%')`;
  await db.delete(secondReviews).where(like(secondReviews.repo, `${prefix}%`));
  const ids = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  if (ids.length) await db.delete(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, ids.map(row => row.id)));
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
}

beforeAll(async () => {
  ensureSchema();
  originalSettings = [...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s WHERE id=1`].map(row => row.value);
  originalJobs = [...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=ANY(${managedJobs}) ORDER BY name`].map(row => row.value);
  originalObservations = [...await admin`SELECT to_jsonb(o) AS value FROM operations_observations o WHERE key=ANY(${observationKeys}) ORDER BY key`].map(row => row.value);
  originalStages = [...await admin`SELECT to_jsonb(s) AS value FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.value);
  originalCandidates = [...await admin`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`].map(row => row.value);
  originalVotes = [...await admin`SELECT to_jsonb(s) AS value FROM second_reviews s ORDER BY id`].map(row => row.value);
  baseline = await wholeSnapshot();
  initialized = true;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
    VALUES(${sentinelName},13,5,'{"untouched":true}'::jsonb,'2101-01-01 00:00:00.654321'::timestamp,
      '2001-02-03 04:05:06.123456'::timestamp)`;
  withSentinel = await wholeSnapshot();
});
beforeEach(async () => {
  await cleanup();
  await restoreSharedRows();
  await restoreForeignDemand();
  // Global controller selectors must never treat another file's rows as ours.
  // Restore only these demand columns and verify every original raw row later.
  if (originalCandidates.length) await admin`UPDATE crawl_candidates c SET decided_by=NULL
    FROM jsonb_populate_recordset(NULL::crawl_candidates,${JSON.stringify(originalCandidates)}::text::jsonb) r WHERE c.id=r.id`;
  if (originalVotes.length) await admin`UPDATE second_reviews s SET status='resolved',resolution='pr04b2-authority-suspended'
    FROM jsonb_populate_recordset(NULL::second_reviews,${JSON.stringify(originalVotes)}::text::jsonb) r WHERE s.id=r.id`;
  await db.insert(crawlSettings).values({ id: 1, values: policy(), updatedBy: "pr04b2-authority" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: policy(), updatedBy: "pr04b2-authority" } });
  await admin`UPDATE jobs SET lease_token=NULL,locked_at=NULL,not_before=NULL WHERE name=ANY(${managedJobs})`;
  await admin`UPDATE pipeline_stage_modes SET mode='legacy',draining_from=NULL,writer_contract_version=0`;
});
afterEach(async () => {
  await cleanup();
  await restoreSharedRows();
  await restoreForeignDemand();
  expect(await wholeSnapshot()).toEqual(withSentinel);
});
afterAll(async () => {
  const errors: unknown[] = [];
  const finish = async (task: () => Promise<unknown>) => { try { await task(); } catch (error) { errors.push(error); } };
  if (initialized) {
    await finish(cleanup);
    await finish(restoreSharedRows);
    await finish(restoreForeignDemand);
    await finish(async () => { await db.delete(jobs).where(eq(jobs.name, sentinelName)); });
    await finish(async () => { expect(await wholeSnapshot()).toEqual(baseline); });
  }
  await finish(() => admin.end({ timeout: 3 }));
  if (errors.length) throw new AggregateError(errors, "pr04b2_authority_cleanup_failed");
});

async function failedVote() {
  const settings = policy(), repo = `${prefix}app-${++sequence}`, now = new Date(Date.now() - 2_000);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://pr04b2-authority-${sequence}.test`,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: now, decidedAt: now }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl, fetchedAt: now,
    pageStatus: 200, repoMeta: { description: "A deployed task application", stargazers_count: 12 },
    pageMeta: { title: "Authority", description: "Manage projects online", textSample: "A project management application",
      readmeSample: "A deployed project management application", readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  const input = await loadReviewInput(candidate, document, settings);
  // Historical verdict is domain fixture data. Worker/item authority is always
  // issued by the actual runner/admission API, never an inserted token.
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "abcllm", model: "first-model", attemptNumber: 1,
    outcome: { decision: "approve", confidence: .94, reason: "Application", evidenceIds: ["product"] },
    validUntil: input.validUntil, completedAt: now }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, trigger: "ai_approved",
    firstDecision: "approve", firstConfidence: .94, firstModel: first.model, firstAttemptId: first.id,
    inputHash: input.inputHash, generationKey: secondReviewGeneration(first.id, input, "ai_approved"),
    provider: "abcllm", model: "second-model", status: "failed", failureCount: 1, errorCode: "timeout",
    reviewedAt: new Date(Date.now() - 2 * 3600_000) }).returning();
  return { candidate, document, first, input, row };
}

async function voteSnapshot(id: number) {
  const [row] = await admin`SELECT to_jsonb(s) AS value FROM second_reviews s WHERE id=${id}`;
  return row.value;
}
async function withJob(name: "second-review" | "crawl-agent-review", load: (job: JobLease) => Promise<unknown>) {
  let failure: unknown;
  const result = await runJob<null>(name, async ctx => {
    if (!ctx.lease) throw new Error("actual_worker_lease_missing");
    try { await load(ctx.lease); } catch (error) { failure = error; throw error; }
    return { done: true };
  });
  if (failure) throw failure;
  expect(result.status).toBe("completed");
}

it("retries an eligible vote under the actual second-review worker lease", async () => {
  const { row } = await failedVote();
  await withJob("second-review", job => retryFailedSecondReviews(new Date(), job));
  const [after] = await db.select().from(secondReviews).where(eq(secondReviews.id, row.id));
  expect(after).toMatchObject({ status: "pending", failureCount: 1, errorCode: "timeout" });
});

it("rejects the old optional-lease retry call before any actual vote mutation", async () => {
  const { row } = await failedVote(), before = await voteSnapshot(row.id);
  const error = await captureError(() => Reflect.apply(retryFailedSecondReviews, undefined, [new Date(), undefined]));
  expect(await voteSnapshot(row.id)).toEqual(before);
  expect(error).toBeInstanceOf(JobLeaseLostError);
});

it("rejects another live job's genuine lease before any actual vote mutation", async () => {
  const { row } = await failedVote(), before = await voteSnapshot(row.id);
  let error: unknown;
  await withJob("crawl-agent-review", async job => {
    error = await captureError(() => Reflect.apply(retryFailedSecondReviews, undefined, [new Date(), job]));
  });
  expect(await voteSnapshot(row.id)).toEqual(before);
  expect(error).toBeInstanceOf(JobLeaseLostError);
});


type Controller = "enqueue" | "cleanup" | "reopen" | "retry";
const controllers: Controller[] = ["enqueue", "cleanup", "reopen", "retry"];
function invoke(kind: Controller, lease: JobLease) {
  if (kind === "enqueue") return enqueueSecondReviews(policy(), undefined, lease);
  if (kind === "cleanup") return closeSettledSecondReviews(undefined, lease);
  if (kind === "reopen") return reopenOrphanedGateHolds(policy(), undefined, lease);
  return retryFailedSecondReviews(undefined, lease);
}
function oldOptionalCall(kind: Controller, lease?: JobLease): Promise<unknown> {
  if (kind === "enqueue") return Reflect.apply(enqueueSecondReviews, undefined, [policy(), undefined, lease]);
  if (kind === "cleanup") return Reflect.apply(closeSettledSecondReviews, undefined, [undefined, lease]);
  if (kind === "reopen") return Reflect.apply(reopenOrphanedGateHolds, undefined, [policy(), undefined, lease]);
  return Reflect.apply(retryFailedSecondReviews, undefined, [undefined, lease]);
}
async function captureError(load: () => Promise<unknown>) {
  try { await load(); return null; } catch (error) { return error; }
}
async function candidateSnapshot(id: number) {
  const [row] = await admin`SELECT jsonb_build_object(
    'candidate',(SELECT to_jsonb(c) FROM crawl_candidates c WHERE id=${id}),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM second_reviews s WHERE candidate_id=${id}),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY work_key),'[]'::jsonb) FROM pipeline_item_leases i
      WHERE stage='ai2' AND binding->>'candidateId'=${String(id)})) AS value`;
  return row.value;
}
async function controllerFixture(kind: Controller) {
  const value = await failedVote();
  if (kind === "enqueue") await db.delete(secondReviews).where(eq(secondReviews.id, value.row.id));
  if (kind === "cleanup") await db.update(secondReviews).set({ model: "retired-model" }).where(eq(secondReviews.id, value.row.id));
  if (kind === "reopen") {
    await db.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split" }).where(eq(crawlCandidates.id, value.candidate.id));
    await db.update(secondReviews).set({ status: "resolved", resolution: "model_removed", model: "retired-model" }).where(eq(secondReviews.id, value.row.id));
  }
  return value;
}
async function expectControllerEffect(kind: Controller, candidateId: number) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidateId));
  const votes = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, candidateId));
  if (kind === "enqueue") expect(votes.some(row => row.status === "pending" && row.trigger === "ai_approved")).toBe(true);
  if (kind === "cleanup") expect(votes.some(row => row.resolution === "model_removed")).toBe(true);
  if (kind === "reopen") expect(candidate).toMatchObject({ state: "approved", reason: "passed" });
  if (kind === "retry") expect(votes.some(row => row.status === "pending" && row.failureCount === 1)).toBe(true);
}
for (const kind of controllers) {
  it(`${kind}: performs the ordinary semantic transition under a genuine second-review job`, async () => {
    const { candidate } = await controllerFixture(kind), before = await candidateSnapshot(candidate.id);
    await withJob("second-review", job => invoke(kind, job));
    expect(await candidateSnapshot(candidate.id)).not.toEqual(before);
    await expectControllerEffect(kind, candidate.id);
  });
  it(`${kind}: rejects missing authority even with no matching rows`, async () => {
    const before = await wholeSnapshot();
    expect(await captureError(() => oldOptionalCall(kind))).toBeInstanceOf(JobLeaseLostError);
    expect(await wholeSnapshot()).toEqual(before);
  });
  it(`${kind}: rejects a genuine other job even with no matching rows`, async () => {
    await withJob("crawl-agent-review", async job => {
      const before = await wholeSnapshot();
      expect(await captureError(() => oldOptionalCall(kind, job))).toBeInstanceOf(JobLeaseLostError);
      expect(await wholeSnapshot()).toEqual(before);
    });
  });
}

function barrier<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function signal<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`barrier_timeout:${label}`)), 5_000);
  })]); } finally { clearTimeout(timer); }
}
async function until(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`barrier_timeout:${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function jobSnapshot() {
  const [row] = await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name='second-review'`;
  return row?.value;
}

for (const kind of controllers) {
  it(`${kind}: preserves a genuine replacement job and rolls back the old owner's transition`, async () => {
    const { candidate } = await controllerFixture(kind), before = await candidateSnapshot(candidate.id);
    const oldStarted = barrier<JobLease>(), oldGo = barrier(), oldChecked = barrier(), oldFinish = barrier();
    const newStarted = barrier<JobLease>(), newFinish = barrier();
    let oldError: unknown, replacement: ReturnType<typeof runJob<null>> | undefined;
    const original = runJob<null>("second-review", async ctx => {
      if (!ctx.lease) throw new Error("actual_worker_lease_missing");
      oldStarted.resolve(ctx.lease);
      await oldGo.promise;
      oldError = await captureError(() => invoke(kind, ctx.lease!));
      oldChecked.resolve();
      await oldFinish.promise;
      return { done: true };
    });
    try {
      const old = await signal(oldStarted.promise, "original job started");
      // Simulate missed job heartbeats, then let the actual runner mint the new
      // authority. This is not item release or evidence of external termination.
      await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '91 seconds'
        WHERE name='second-review' AND lease_token=${old.token}`;
      replacement = runJob<null>("second-review", async ctx => {
        if (!ctx.lease) throw new Error("actual_worker_lease_missing");
        newStarted.resolve(ctx.lease); await newFinish.promise; return { done: true };
      });
      const current = await signal(newStarted.promise, "replacement job started");
      expect(current.token).not.toBe(old.token);
      const replaced = await jobSnapshot();
      oldGo.resolve();
      await signal(oldChecked.promise, "old controller rejected");
      expect(oldError).toBeInstanceOf(JobLeaseLostError);
      expect(await candidateSnapshot(candidate.id)).toEqual(before);
      expect(await jobSnapshot()).toEqual(replaced);
      oldFinish.resolve();
      expect(await original).toMatchObject({ status: "failed", error: "job_lease_lost" });
      expect(await jobSnapshot()).toEqual(replaced);
    } finally {
      oldGo.resolve(); oldFinish.resolve(); newFinish.resolve();
      await Promise.allSettled([original, ...(replacement ? [replacement] : [])]);
    }
    expect(await replacement).toMatchObject({ status: "completed" });
  });

  it(`${kind}: checks DB wall time after an actual job-row lock wait`, async () => {
    const { candidate } = await controllerFixture(kind), before = await candidateSnapshot(candidate.id);
    const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
      connection: { application_name: `pr04b2-authority-${kind}-job-blocker`, statement_timeout: 8_000 } });
    const locked = barrier<number>(), release = barrier();
    let holding: Promise<unknown> | undefined, write: Promise<unknown> | undefined, error: unknown;
    try {
      const result = await runJob<null>("second-review", async ctx => {
        if (!ctx.lease) throw new Error("actual_worker_lease_missing");
        await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '89 seconds' WHERE name='second-review'`;
        holding = blocker.begin(async tx => {
          await tx`SELECT name FROM jobs WHERE name='second-review' FOR UPDATE`;
          const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
          locked.resolve(backend.pid); await release.promise;
        });
        try {
          const pid = await signal(locked.promise, "job blocker acquired");
          write = captureError(() => invoke(kind, ctx.lease!));
          await until(async () => {
            const [row] = await admin`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE ${pid}=ANY(pg_blocking_pids(pid)) AND query ILIKE '%jobs%') AS blocked`;
            return row.blocked;
          }, "actual controller blocked on job row");
          await until(async () => {
            const [row] = await admin`SELECT locked_at < clock_timestamp()-interval '90 seconds' AS expired
              FROM jobs WHERE name='second-review'`;
            return row.expired;
          }, "job expired by DB wall clock");
        } finally { release.resolve(); await holding; }
        error = await write;
        return { done: true };
      });
      expect(error).toBeInstanceOf(JobLeaseLostError);
      expect(result).toMatchObject({ status: "failed", error: "job_lease_lost" });
      expect(await candidateSnapshot(candidate.id)).toEqual(before);
    } finally {
      release.resolve(); await Promise.allSettled([...(holding ? [holding] : []), ...(write ? [write] : [])]);
      await blocker.end({ timeout: 3 });
    }
  });
}

for (const kind of controllers) {
  it(`${kind}: preserves a healthy original item of another generation until actual settlement`, async () => {
    const original = await failedVote();
    await db.update(secondReviews).set({ status: "pending" }).where(eq(secondReviews.id, original.row.id));
    await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai2'`;
    const claimed = await claimItemSecondReview(original.row.id,
      { instanceId: "pr04b2-original-owner", bootId: "00000000-0000-4000-8000-000000000499" }, 60_000);
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("actual_original_claim_required");
    // A semantic invalidation can retire the vote while external work remains
    // unsettled. Preserve its immutable identity and durable original item.
    await db.update(secondReviews).set({ status: "resolved", resolution: "superseded" }).where(eq(secondReviews.id, original.row.id));
    const [document] = await db.update(crawlDocuments).set({ fetchedAt: new Date(),
      pageMeta: { title: "Current application", description: "New source generation", textSample: "An updated project management application" } })
      .where(eq(crawlDocuments.id, original.document.id)).returning();
    const input = await loadReviewInput(original.candidate, document, policy());
    const [first] = await db.insert(crawlReviewAttempts).values({ ...original.first, id: undefined,
      inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
      snapshot: input.snapshot, source: input.source, validUntil: input.validUntil, attemptNumber: 2 }).returning();
    expect(first.id).not.toBe(original.first.id);
    expect(input.sourceRevisionHash).not.toBe(original.input.sourceRevisionHash);
    if (kind !== "enqueue") {
      await db.insert(secondReviews).values({ candidateId: original.candidate.id, repo: original.candidate.repo,
        trigger: "ai_approved", firstDecision: "approve", firstConfidence: .94, firstModel: first.model,
        firstAttemptId: first.id, inputHash: input.inputHash, generationKey: secondReviewGeneration(first.id, input, "ai_approved"),
        provider: "abcllm", model: kind === "cleanup" || kind === "reopen" ? "retired-model" : "second-model",
        status: kind === "reopen" ? "resolved" : "failed", resolution: kind === "reopen" ? "model_removed" : null,
        failureCount: 1, errorCode: "timeout", reviewedAt: new Date(Date.now() - 2 * 3600_000) });
    }
    if (kind === "reopen") await db.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split" })
      .where(eq(crawlCandidates.id, original.candidate.id));
    // Semantic controllers run in draining too; that does not revoke a live
    // original owner or certify the completion of its external call.
    await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items' WHERE stage='ai2'`;
    const busy = await candidateSnapshot(original.candidate.id);
    await withJob("second-review", job => invoke(kind, job));
    expect(await candidateSnapshot(original.candidate.id)).toEqual(busy);
    expect(await recordSecondReview({ receipt: claimed.receipt,
      result: { ok: true, provider: "abcllm", model: "second-model", decision: "approve", confidence: .95, reason: "Settled old call" } }))
      .toEqual({ state: "not_pending" });
    const [settled] = await admin`SELECT token,owner_instance_id,owner_boot_id,lease_until FROM pipeline_item_leases
      WHERE stage='ai2' AND work_key=${`ai2:${original.row.id}`}`;
    expect(settled).toEqual({ token: null, owner_instance_id: null, owner_boot_id: null, lease_until: null });
    const afterSettlement = await candidateSnapshot(original.candidate.id);
    expect(afterSettlement.candidate).toEqual(busy.candidate);
    expect(afterSettlement.votes).toEqual(busy.votes);
    await withJob("second-review", job => invoke(kind, job));
    await expectControllerEffect(kind, original.candidate.id);
  });
}

it("keeps a due failed vote unchanged when its actual document source has changed", async () => {
  const { row, document, candidate } = await failedVote();
  await db.update(crawlDocuments).set({ fetchedAt: new Date(), pageMeta: { title: "Changed after first review" } })
    .where(eq(crawlDocuments.id, document.id));
  const before = await candidateSnapshot(candidate.id);
  await withJob("second-review", job => retryFailedSecondReviews(undefined, job));
  expect(await candidateSnapshot(candidate.id)).toEqual(before);
  expect((await voteSnapshot(row.id)).status).toBe("failed");
});

async function withReplayController<T>(value: Awaited<ReturnType<typeof failedVote>>,
  load: (run: ReplayRun) => Promise<T>, beforeProvision?: (sql: postgres.Sql) => Promise<void>): Promise<T> {
  const reference = new Date(), settings = policy();
  const reviewer = (model: NonNullable<CrawlSettings["firstReview"]>) =>
    ({ ...model, canonicalModel: canonicalReviewModel(model.model) });
  const manifest: CapacityManifest = { version: 1, runId: `pr04b2-authority-${randomUUID()}`, revision: "0536116",
    mode: "fixtures", cacheMode: "cold", referenceTime: reference.toISOString(), startedAt: reference.toISOString(),
    endedAt: new Date(+reference + 10_000).toISOString(), inputPolicyHash: reviewPolicyHash(settings),
    fullReviewPolicyHash: fullReviewPolicyHash(settings), comparisonPolicyHash: comparisonReviewPolicyHash(settings),
    initialStateHash: reviewHash({ candidate: value.candidate, document: value.document }),
    models: { first: reviewer(settings.firstReview!), second: settings.secondReview.voters.map(reviewer), fallbacks: [] },
    inputs: [{ candidateId: value.candidate.id, inputHash: value.input.inputHash,
      sourceRevisionHash: value.input.sourceRevisionHash, readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 8, maxTokens: 800, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 4 } };
  const profile = await getReplayHandlerIdentityPath({ beforeProvision });
  let database: Awaited<ReturnType<typeof openVerifiedReplayHandlerDatabase>> | undefined;
  let ledger: ReplayLedger | undefined, run: ReplayRun | undefined;
  try {
    database = await openVerifiedReplayHandlerDatabase(profile.identityPath, {});
    ledger = new ReplayLedger(database);
    run = await ledger.prepare(manifest, [{ candidateId: value.candidate.id, input: value.input }]);
    await ledger.start(run);
    return await withReplayDatabaseScope(profile.identityPath, () =>
      withReviewReplayContext({ referenceTime: reference }, () => withReplayFinalScope(run!, () => load(run!))));
  } finally {
    try { if (run && ledger) await ledger.drain(run); }
    finally { try { await database?.close(); } finally { await profile.release(); } }
  }
}

for (const kind of controllers) {
  it(`${kind}: rolls domain changes back when the actual replay transition INSERT fails`, async () => {
    const value = await controllerFixture(kind), before = await candidateSnapshot(value.candidate.id);
    try {
      await withReplayController(value, async run => {
        await withJob("second-review", async job => {
          const error = await captureError(() => invoke(kind, job));
          expect(error).toMatchObject({ cause: { message: "pr04b2_authority_transition_failed" } });
          expect(await candidateSnapshot(value.candidate.id)).toEqual(before);
          expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions
            WHERE run_id=${run.runId} AND kind=${`second_review_${kind}`}`).toEqual([]);
        });
      }, async sql => {
        await sql`CREATE FUNCTION pr04b2_authority_transition_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.kind LIKE 'second_review_%' THEN RAISE EXCEPTION 'pr04b2_authority_transition_failed'; END IF; RETURN NEW; END $$`;
        await sql`CREATE TRIGGER pr04b2_authority_transition_failure BEFORE INSERT ON pipeline_replay.capacity_transitions
          FOR EACH ROW EXECUTE FUNCTION pr04b2_authority_transition_failure()`;
      });
    } finally {
      // The profile release owns its private ledger schema/trigger. Its public
      // trigger function is ours alone and is removed even if assertions fail.
      await admin`DROP FUNCTION IF EXISTS pr04b2_authority_transition_failure()`;
    }
  });
}

it("rejects an expired genuine job even when every controller has no matching rows", async () => {
  let errors: unknown[] = [];
  const result = await runJob<null>("second-review", async ctx => {
    if (!ctx.lease) throw new Error("actual_worker_lease_missing");
    await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '91 seconds' WHERE name='second-review'`;
    const before = await wholeSnapshot();
    errors = await Promise.all(controllers.map(kind => captureError(() => invoke(kind, ctx.lease!))));
    expect(await wholeSnapshot()).toEqual(before);
    return { done: true };
  });
  expect(errors).toHaveLength(4);
  errors.forEach(error => expect(error).toBeInstanceOf(JobLeaseLostError));
  expect(result).toMatchObject({ status: "failed", error: "job_lease_lost" });
});

it("rolls a retry back when its actual nondeferred recorder wait outlives the job", async () => {
  const value = await controllerFixture("retry"), before = await candidateSnapshot(value.candidate.id);
  const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04b2-authority-run-blocker", statement_timeout: 8_000 } });
  const locked = barrier<number>(), release = barrier();
  let holding: Promise<unknown> | undefined, writing: Promise<unknown> | undefined, error: unknown;
  try {
    await withReplayController(value, async run => {
      holding = blocker.begin(async tx => {
        await tx`SELECT run_id FROM pipeline_replay.capacity_runs WHERE run_id=${run.runId} FOR UPDATE`;
        const [row] = await tx`SELECT pg_backend_pid() AS pid`;
        locked.resolve(row.pid); await release.promise;
      });
      try {
        const pid = await signal(locked.promise, "run blocker acquired");
        const result = await runJob<null>("second-review", async ctx => {
          if (!ctx.lease) throw new Error("actual_worker_lease_missing");
          await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '89 seconds' WHERE name='second-review'`;
          writing = captureError(() => retryFailedSecondReviews(undefined, ctx.lease!));
          try {
            await until(async () => {
              const [row] = await admin`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                WHERE ${pid}=ANY(pg_blocking_pids(pid)) AND query ILIKE '%capacity_runs%') AS blocked`;
              return row.blocked;
            }, "actual retry recorder blocked on run row");
            await until(async () => {
              const [row] = await admin`SELECT locked_at < clock_timestamp()-interval '90 seconds' AS expired
                FROM jobs WHERE name='second-review'`;
              return row.expired;
            }, "job expired during actual recorder wait");
          } finally { release.resolve(); await holding; }
          error = await writing;
          return { done: true };
        });
        expect(error).toBeInstanceOf(JobLeaseLostError);
        expect(result).toMatchObject({ status: "failed", error: "job_lease_lost" });
        expect(await candidateSnapshot(value.candidate.id)).toEqual(before);
        expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions
          WHERE run_id=${run.runId} AND kind='second_review_retry'`).toEqual([]);
      } finally { release.resolve(); await Promise.allSettled([...(holding ? [holding] : []), ...(writing ? [writing] : [])]); }
    });
  } finally {
    release.resolve(); await Promise.allSettled([...(holding ? [holding] : []), ...(writing ? [writing] : [])]);
    await blocker.end({ timeout: 3 });
  }
});
