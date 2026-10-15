import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs, operationsObservations, secondReviews } from "@/lib/db/schema";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash } from "@/lib/crawl/agent-review-contract";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { recordSecondReview } from "@/lib/crawl/second-review";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { admitLegacySecondReview } from "@/lib/crawl/second-review-ownership";
import { dispatchReviewFixtureCall, withReviewFixtureTransport } from "@/lib/crawl/review-fixture-transport";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { assertReplayDatabaseScopeIdentity, withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { runJob } from "@/lib/jobs/runner";
import { JobLeaseLostError } from "@/lib/jobs/control";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { ReplayLedger, type ReplayRun } from "@/lib/operations/pipeline-replay-ledger";
import { withReplayExecutionScope, replayQuiescenceProof, readSealedReplayArtifact } from "@/lib/operations/pipeline-replay-execution";
import { withReplayFinalScope } from "@/lib/operations/pipeline-replay-final";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = "pr04c-final-wall/", foreignRepo = `pr04c-final-wall-foreign/${randomUUID()}`;
const sentinelName = `pr04c-final-wall-sentinel-${randomUUID().slice(0, 8)}`;
const managedJobs = ["second-review", "crawl-publish"], observationKeys = ["job:second-review"];
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04c-final-wall-admin", statement_timeout: 8_000 } });
const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04c-final-wall-holder", statement_timeout: 8_000 } });
let serial = 0, initialized = false;
let initial: unknown, foreignBaseline: unknown;
let originalSettings: unknown[] = [], originalStages: unknown[] = [];
let originalJobs: { name: string }[] = [], originalObservations: { key: string }[] = [];

function policy(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true, sampleRate: 0,
      voters: [{ provider: "abcllm", model: "second-model" }], fallbacks: [] } };
}
async function wholeSnapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM crawl_candidates c),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM crawl_documents d),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM crawl_review_attempts a),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]'::jsonb) FROM second_reviews v),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage,work_key),'[]'::jsonb) FROM pipeline_item_leases i),
    'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage),'[]'::jsonb) FROM pipeline_stage_modes s),
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM crawl_settings s),
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j),
    'observations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY key),'[]'::jsonb) FROM operations_observations o)) AS value`;
  return row.value;
}
async function cleanRows(repoPattern = `${prefix}%`) {
  const rows = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(like(crawlCandidates.repo, repoPattern));
  await db.delete(secondReviews).where(like(secondReviews.repo, repoPattern));
  if (rows.length) await db.delete(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, rows.map(row => row.id)));
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, repoPattern));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, repoPattern));
}
async function restoreManaged() {
  const absentJobs = managedJobs.filter(name => !originalJobs.some(row => row.name === name));
  if (absentJobs.length) await db.delete(jobs).where(inArray(jobs.name, absentJobs));
  if (originalJobs.length) await admin`UPDATE jobs j SET requested_version=r.requested_version,processed_version=r.processed_version,
    next_scheduled_at=r.next_scheduled_at,not_before=r.not_before,lease_token=r.lease_token,worker_seen_at=r.worker_seen_at,
    cursor=r.cursor,locked_at=r.locked_at,last_run_at=r.last_run_at,last_success_at=r.last_success_at,last_error=r.last_error,
    runs=r.runs,updated_at=r.updated_at FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb) r WHERE j.name=r.name`;
  if (originalSettings.length) await admin`UPDATE crawl_settings s SET values=r.values,updated_by=r.updated_by,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb) r WHERE s.id=r.id`;
  else await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
  const absentObservations = observationKeys.filter(key => !originalObservations.some(row => row.key === key));
  if (absentObservations.length) await db.delete(operationsObservations).where(inArray(operationsObservations.key, absentObservations));
  if (originalObservations.length) await admin`UPDATE operations_observations o SET value=r.value,observed_at=r.observed_at
    FROM jsonb_populate_recordset(NULL::operations_observations,${JSON.stringify(originalObservations)}::text::jsonb) r WHERE o.key=r.key`;
  await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,epoch=r.epoch,
    writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages)}::text::jsonb) r WHERE s.stage=r.stage`;
}
beforeAll(async () => {
  ensureSchema(); initial = await wholeSnapshot();
  originalSettings = [...await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`].map(row => row.row);
  originalJobs = [...await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=ANY(${managedJobs}) ORDER BY name`].map(row => row.row);
  originalObservations = [...await admin`SELECT to_jsonb(o) AS row FROM operations_observations o WHERE key=ANY(${observationKeys}) ORDER BY key`].map(row => row.row);
  originalStages = [...await admin`SELECT to_jsonb(s) AS row FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.row);
  const foreign = await fixture(foreignRepo);
  await admin`UPDATE crawl_candidates SET decided_by='admin',updated_at='2001-02-03 04:05:06.123456'::timestamp WHERE id=${foreign.candidate.id}`;
  await admin`UPDATE second_reviews SET status='resolved',resolution='kept',resolved_by='pr04c-foreign',
    resolved_at='2001-02-03 04:05:06.654321'::timestamp WHERE id=${foreign.vote.id}`;
  await admin`INSERT INTO jobs(name,cursor,not_before,updated_at) VALUES(${sentinelName},'{"foreign":true}'::jsonb,
    '2101-02-03 04:05:06.654321'::timestamp,'2001-02-03 04:05:06.123456'::timestamp)`;
  foreignBaseline = await wholeSnapshot(); initialized = true;
});
beforeEach(async () => {
  await db.insert(crawlSettings).values({ id: 1, values: policy(), updatedBy: "pr04c-final-wall" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: policy(), updatedBy: "pr04c-final-wall" } });
  // Only managed job scheduling state is suspended. The real runner issues its token.
  await db.insert(jobs).values({ name: "second-review" }).onConflictDoUpdate({ target: jobs.name,
    set: { leaseToken: null, lockedAt: null, notBefore: null } });
  await admin`UPDATE pipeline_stage_modes SET mode='legacy',draining_from=NULL,epoch=1,writer_contract_version=0`;
});
afterEach(async () => {
  await cleanRows(); await restoreManaged();
  expect(await wholeSnapshot()).toEqual(foreignBaseline);
});
afterAll(async () => {
  const errors: unknown[] = [];
  const finish = async (load: () => Promise<unknown>) => { try { await load(); } catch (error) { errors.push(error); } };
  if (initialized) {
    await finish(cleanRows); await finish(restoreManaged);
    await finish(async () => { expect(await wholeSnapshot()).toEqual(foreignBaseline); });
  }
  if (initial !== undefined) {
    await finish(() => cleanRows(foreignRepo));
    await finish(async () => { await db.delete(jobs).where(eq(jobs.name, sentinelName)); });
    await finish(async () => { expect(await wholeSnapshot()).toEqual(initial); });
  }
  await finish(() => admin.end({ timeout: 3 })); await finish(() => blocker.end({ timeout: 3 }));
  if (errors.length) throw new AggregateError(errors, "pr04c_final_wall_cleanup_failed");
});

async function fixture(repo = `${prefix}candidate-${++serial}`) {
  const settings = policy(), at = new Date(Date.now() - 2_000);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://pr04c-wall-${randomUUID()}.test`,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: at, decidedAt: at }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl, fetchedAt: at, pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", stargazers_count: 12 }, pageMeta: { title: "Wall app",
      description: "Manage projects", textSample: "Create tasks and projects", readmeSample: "A deployed task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  const input = await loadReviewInput(candidate, document, settings);
  // Historical first verdict is fixture domain data, not a fabricated authority token/call.
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "abcllm", model: "first-model", attemptNumber: 1, validUntil: input.validUntil, completedAt: at,
    outcome: { decision: "approve", confidence: .94, reason: "Working app", evidenceIds: ["product"] } }).returning();
  const [vote] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, trigger: "ai_approved",
    firstDecision: "approve", firstConfidence: .94, firstModel: first.model, firstAttemptId: first.id,
    inputHash: input.inputHash, generationKey: secondReviewGeneration(first.id, input, "ai_approved"),
    provider: "abcllm", model: "second-model" }).returning();
  return { candidate, document, first, vote, input, settings };
}
function latch<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
async function writerSnapshot(run: ReplayRun, id: number) {
  const [row] = await admin`SELECT jsonb_build_object(
    'candidate',(SELECT to_jsonb(c) FROM crawl_candidates c WHERE id=${id}),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM crawl_review_attempts a WHERE candidate_id=${id}),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]'::jsonb) FROM second_reviews v WHERE candidate_id=${id}),
    'outbox',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j WHERE name='crawl-publish'),
    'changes',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY tx_key,ordinal),'[]'::jsonb) FROM pipeline_replay.capacity_changes c WHERE run_id=${run.runId}),
    'packets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY seq),'[]'::jsonb) FROM pipeline_replay.capacity_transactions t WHERE run_id=${run.runId}),
    'confirmations',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY tx_key),'[]'::jsonb) FROM pipeline_replay.capacity_commit_confirmations c WHERE run_id=${run.runId}),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY seq),'[]'::jsonb) FROM pipeline_replay.capacity_transitions e WHERE run_id=${run.runId}),
    'finals',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY seq),'[]'::jsonb) FROM pipeline_replay.capacity_finals f WHERE run_id=${run.runId}),
    'head',(SELECT jsonb_build_object('seq',event_seq,'projection',current_projection) FROM pipeline_replay.capacity_runs WHERE run_id=${run.runId})) AS value`;
  return row.value;
}

async function exercise(expire: boolean) {
  const value = await fixture(), reference = new Date(), input = value.input;
  const manifest: CapacityManifest = { version: 1, runId: `pr04c-wall-${randomUUID()}`, revision: "2fb960a",
    mode: "fixtures", cacheMode: "cold", referenceTime: reference.toISOString(), startedAt: reference.toISOString(),
    endedAt: new Date(+reference + 10_000).toISOString(), inputPolicyHash: input.policyHash,
    fullReviewPolicyHash: fullReviewPolicyHash(value.settings), comparisonPolicyHash: comparisonReviewPolicyHash(value.settings),
    initialStateHash: reviewHash({ candidate: value.candidate, document: value.document }),
    models: { first: { provider: "abcllm", model: "first-model", canonicalModel: "first-model" },
      second: [{ provider: "abcllm", model: "second-model", canonicalModel: "second-model" }], fallbacks: [] },
    inputs: [{ candidateId: value.candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 4, maxTokens: 400, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 1 } };
  const profile = await getReplayHandlerIdentityPath();
  let database: Awaited<ReturnType<typeof openVerifiedReplayHandlerDatabase>> | undefined;
  let run: ReplayRun | undefined, ledger: ReplayLedger | undefined;
  let before: Awaited<ReturnType<typeof writerSnapshot>> | undefined, after: typeof before;
  let writerError: unknown, writerResult: unknown, blockerProof: unknown;
  try {
    database = await openVerifiedReplayHandlerDatabase(profile.identityPath, {}); ledger = new ReplayLedger(database);
    const inputs = [{ candidateId: value.candidate.id, input }];
    manifest.initialStateHash = (await ledger.previewInitialState(manifest, inputs)).initialStateHash;
    run = await ledger.prepareCertified(manifest, inputs, { runner: { jobs: ["second-review"], budgetMs: 110_000 }, quality: null });
    await ledger.start(run);
    const replay = run, authenticDatabase = database;
    const result = await withReplayExecutionScope(replay, () => withReplayDatabaseScope(profile.identityPath, async () => {
      assertReplayDatabaseScopeIdentity(authenticDatabase);
      return withReviewReplayContext({ referenceTime: reference }, () => withReplayFinalScope(replay, () =>
        withReviewFixtureTransport({ ledger: ledger!, run: replay, inputs, fullReviewPolicyHash: manifest.fullReviewPolicyHash,
          tokenUpperBound: 100, fixture: async () => ({ result: { ok: true, outcome: { decision: "approve", confidence: .99,
            reason: "Working deployed application", evidenceIds: ["product"] }, usage: { inputTokens: 8, outputTokens: 2 } },
          receipt: { inputTokens: 8, outputTokens: 2 } }) }, () => runJob<null>("second-review", async ctx => {
          if (!ctx.lease) throw new Error("actual_second_review_job_missing");
          const claim = await admitLegacySecondReview(value.vote.id, ctx.lease);
          if (claim.kind !== "admitted") throw new Error(`actual_second_review_admission_${claim.kind}`);
          const answer = await dispatchReviewFixtureCall({ stage: "second", candidateId: value.candidate.id,
            firstAttemptId: value.first.id, secondReviewId: value.vote.id, generationKey: value.vote.generationKey,
            vote: value.vote.id, provider: "abcllm", model: "second-model" }, input, { signal: ctx.signal });
          if (!answer?.ok) throw new Error("actual_second_review_fixture_success_missing");
          if (expire) {
            // The real claim has already committed. Change only its locked_at,
            // through an actual guarded/journal transaction before the run holder.
            await db.transaction(async tx => { await tx.update(jobs).set({
              lockedAt: sql`clock_timestamp() - ${STALE_LOCK_MS - 500} * interval '1 millisecond'`,
            }).where(eq(jobs.name, ctx.lease!.name)); });
          }
          const entered = latch<number>(), unlock = latch();
          const holding = blocker.begin(async tx => {
            await tx`SELECT run_id FROM pipeline_replay.capacity_runs WHERE run_id=${replay.runId} FOR UPDATE`;
            const [row] = await tx`SELECT pg_backend_pid() AS pid`; entered.resolve(row.pid); await unlock.promise;
          });
          const held = holding.then(() => null, error => error);
          let writing: Promise<void> | undefined;
          try {
            const holderPid = await Promise.race([entered.promise, holding.then(() => { throw new Error("run holder ended before barrier"); })]);
            before = await writerSnapshot(replay, value.candidate.id);
            writing = recordSecondReview({ receipt: claim.receipt, result: { ok: true, ...answer.outcome,
              confidence: answer.outcome.confidence ?? null, provider: "abcllm", model: "second-model" } })
              .then(result => { writerResult = result; }, error => { writerError = error; });
            let waiters: postgres.Row[] = [];
            await expect.poll(async () => {
              waiters = await admin`SELECT a.pid,a.wait_event_type,a.wait_event,a.query,pg_blocking_pids(a.pid) AS blockers
                FROM pg_stat_activity a WHERE a.usename=${authenticDatabase.identity.roleName}
                  AND ${holderPid}=ANY(pg_blocking_pids(a.pid)) AND a.query ILIKE '%capacity_runs%FOR UPDATE%'`;
              return waiters.length;
            }, { timeout: 2_000, interval: 10 }).toBe(1);
            const [healthy] = await admin`SELECT locked_at >= clock_timestamp()-${STALE_LOCK_MS} * interval '1 millisecond' AS healthy
              FROM jobs WHERE name='second-review'`;
            expect(healthy.healthy).toBe(true);
            // The callback's domain/outbox changes are still uncommitted while
            // hooks.after is the actual blocked capacity_runs FOR UPDATE query.
            expect(await writerSnapshot(replay, value.candidate.id)).toEqual(before);
            if (expire) await expect.poll(async () => {
              const [row] = await admin`SELECT locked_at < clock_timestamp()-${STALE_LOCK_MS} * interval '1 millisecond' AS expired
                FROM jobs WHERE name='second-review'`; return row.expired;
            }, { timeout: 5_000, interval: 10 }).toBe(true);
            const [clock] = await admin`SELECT locked_at::text,clock_timestamp()::text AS wall,
              locked_at < clock_timestamp()-${STALE_LOCK_MS} * interval '1 millisecond' AS expired FROM jobs WHERE name='second-review'`;
            blockerProof = { holderPid, waiters, healthyAtWait: healthy.healthy, ...clock };
          } finally {
            unlock.resolve(); const holdingError = await held;
            if (writing) await writing;
            if (holdingError) throw holdingError;
          }
          after = await writerSnapshot(replay, value.candidate.id);
          return { done: true };
        }, { budgetMs: 110_000 }))));
    }));
    await ledger.closeAdmission(replay); await ledger.fenceWriters(replay);
    await ledger.seal(replay, replayQuiescenceProof(replay));
    const artifact = await readSealedReplayArtifact(database, replay.runId);
    console.info("certified-final-wall-evidence", JSON.stringify({ expire, blockerProof, writerResult,
      writerError: writerError instanceof Error ? { name: writerError.name, message: writerError.message,
        code: "code" in writerError ? writerError.code : undefined } : writerError,
      before: { vote: before.votes[0].status, outbox: before.outbox.map((row: { requested_version: number }) => row.requested_version),
        packets: before.packets.length, changes: before.changes.length, events: before.events.length, head: before.head.seq },
      after: { vote: after.votes[0].status, outbox: after.outbox.map((row: { requested_version: number }) => row.requested_version),
        packets: after.packets.length, changes: after.changes.length, events: after.events.length, head: after.head.seq } }));
    return { before, after, writerError, writerResult, blockerProof, result, artifact, candidateId: value.candidate.id };
  } finally {
    try { if (ledger && run) await ledger.drain(run).catch(() => {}); }
    finally { try { await database?.close(); } finally { await profile.release(); } }
  }
}

it("commits a healthy certified AI2 result and publication request after the real deferred run-row wait", async () => {
  const value = await exercise(false);
  expect(value.blockerProof).toMatchObject({ healthyAtWait: true, expired: false });
  expect(value.writerError).toBeUndefined(); expect(value.writerResult).toEqual({ state: "recorded" });
  expect(value.result.status).toBe("completed");
  expect(value.after.votes).toMatchObject([{ status: "agreed", second_decision: "approve" }]);
  expect(value.after.outbox).toMatchObject([{ name: "crawl-publish", requested_version: expect.any(Number) }]);
  expect(value.after.events.some((row: { kind: string }) => row.kind === "review_write")).toBe(true);
  // The actual first verdict predates this run; no fabricated first call/final.
  expect(value.artifact).toMatchObject({ calls: [expect.objectContaining({ stage: "second", state: "settled" })], finals: [] });
});

it("rolls the writer domain, outbox and entire deferred journal back when its genuine job expires during the run-row wait", async () => {
  const value = await exercise(true);
  expect(value.blockerProof).toMatchObject({ healthyAtWait: true, expired: true });
  // A later runner failure is not evidence of rollback: compare the writer's
  // committed rows before runner completion/failure writes can change the job.
  expect(value.after, `actual post-callback blocker proof: ${JSON.stringify(value.blockerProof)}`).toEqual(value.before);
  expect(value.writerError).toBeInstanceOf(JobLeaseLostError);
  expect(value.writerResult).toBeUndefined();
  expect(value.result).toMatchObject({ status: "failed", error: "job_lease_lost" });
});
