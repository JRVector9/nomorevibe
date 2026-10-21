import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs, products, secondReviews } from "@/lib/db/schema";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { closeSettledSecondReviews, enqueueSecondReviews, publishedInputHash, reopenOrphanedGateHolds, retryFailedSecondReviews } from "@/lib/crawl/second-review";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { withLegacySecondReviewJob } from "./second-review-receipt-fixtures";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = "pr04b2-locks/", slugPrefix = "pr04b2-locks-";
const sentinelName = `pr04b2-locks-unrelated-${randomUUID()}`;
const foreignRepo = `pr04b2-locks-foreign/${randomUUID()}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04b2-locks-admin", statement_timeout: 8_000 } });
const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04b2-locks-holder", statement_timeout: 8_000 } });
let sequence = 0, initialized = false;
let baseline: unknown, initialBaseline: unknown, sentinel: unknown, seededSettings = false;
let originalCandidates: unknown[] = [], originalVotes: unknown[] = [], originalSettings: unknown[] = [];
let originalJobs: unknown[] = [], originalStages: unknown[] = [], originalObservation: unknown[] = [];

function settings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      sampleRate: 0,
      voters: [{ provider: "abcllm", model: "second-model" }],
      fallbacks: [{ provider: "abcllm", model: "backup-model" }] } };
}
async function snapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM crawl_candidates c),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM crawl_documents d),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM crawl_review_attempts a),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]'::jsonb) FROM second_reviews v),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage,work_key),'[]'::jsonb) FROM pipeline_item_leases i),
    'products',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM products p),
    'purges',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM cdn_purges p),
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM crawl_settings s),
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j),
    'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage),'[]'::jsonb) FROM pipeline_stage_modes s),
    'observations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY key),'[]'::jsonb) FROM operations_observations o)) AS value`;
  return row.value;
}
async function cleanOwnRows() {
  await admin`DROP TRIGGER IF EXISTS pr04b2_locks_hold_failure ON crawl_candidates`;
  await admin`DROP FUNCTION IF EXISTS pr04b2_locks_hold_failure()`;
  await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE 'pr04b2-locks/%')`;
  await db.delete(secondReviews).where(like(secondReviews.repo, `${prefix}%`));
  const ids = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  if (ids.length) await db.delete(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, ids.map(row => row.id)));
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
  await db.delete(products).where(like(products.slug, `${slugPrefix}%`));
  await db.delete(cdnPurges).where(like(cdnPurges.slug, `${slugPrefix}%`));
}
async function restore() {
  await admin`UPDATE crawl_candidates c SET decided_by=r.decided_by
    FROM jsonb_populate_recordset(NULL::crawl_candidates,${JSON.stringify(originalCandidates)}::text::jsonb) r WHERE c.id=r.id`;
  await admin`UPDATE second_reviews v SET status=r.status,resolution=r.resolution
    FROM jsonb_populate_recordset(NULL::second_reviews,${JSON.stringify(originalVotes)}::text::jsonb) r WHERE v.id=r.id`;
  if (originalSettings.length) await admin`UPDATE crawl_settings s SET values=r.values,updated_by=r.updated_by,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb) r WHERE s.id=r.id`;
  else await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
  if (originalJobs.length) await admin`UPDATE jobs j SET requested_version=r.requested_version,processed_version=r.processed_version,
    next_scheduled_at=r.next_scheduled_at,not_before=r.not_before,lease_token=r.lease_token,worker_seen_at=r.worker_seen_at,
    cursor=r.cursor,locked_at=r.locked_at,last_run_at=r.last_run_at,last_success_at=r.last_success_at,last_error=r.last_error,
    runs=r.runs,updated_at=r.updated_at FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb) r WHERE j.name=r.name`;
  else await db.delete(jobs).where(eq(jobs.name, "second-review"));
  if (originalObservation.length) await admin`UPDATE operations_observations o SET value=r.value,observed_at=r.observed_at
    FROM jsonb_populate_recordset(NULL::operations_observations,${JSON.stringify(originalObservation)}::text::jsonb) r WHERE o.key=r.key`;
  else await admin`DELETE FROM operations_observations WHERE key='job:second-review'`;
  await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,epoch=r.epoch,
    writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages)}::text::jsonb) r WHERE s.stage=r.stage`;
}
beforeAll(async () => {
  ensureSchema();
  initialBaseline = await snapshot();
  const [saved] = await admin`SELECT id FROM crawl_settings WHERE id=1`;
  if (!saved) {
    await admin`INSERT INTO crawl_settings(id,values,updated_by,updated_at)
      VALUES(1,${JSON.stringify(settings())}::text::jsonb,'pr04b2-locks-foreign','2001-02-03 04:05:06.123456'::timestamp)`;
    seededSettings = true;
  }
  // Seed a real, unrelated universe before taking the restorable foreign snapshot.
  // These are historical fixture rows, never authority receipts or job tokens.
  const foreign = await fixture("needs_review", foreignRepo);
  await admin`UPDATE crawl_candidates SET updated_at='2001-02-03 04:05:06.234567'::timestamp WHERE id=${foreign.candidate.id}`;
  await admin`UPDATE second_reviews SET created_at='2001-02-03 04:05:06.345678'::timestamp WHERE id=${foreign.vote.id}`;
  originalCandidates = [...await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c ORDER BY id`].map(row => row.row);
  originalVotes = [...await admin`SELECT to_jsonb(v) AS row FROM second_reviews v ORDER BY id`].map(row => row.row);
  originalSettings = [...await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`].map(row => row.row);
  originalJobs = [...await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name='second-review'`].map(row => row.row);
  originalStages = [...await admin`SELECT to_jsonb(s) AS row FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.row);
  originalObservation = [...await admin`SELECT to_jsonb(o) AS row FROM operations_observations o WHERE key='job:second-review'`].map(row => row.row);
  baseline = await snapshot(); initialized = true;
  // Global selectors get a quiet foreign universe without deleting historical rows.
  await admin`UPDATE crawl_candidates SET decided_by=NULL WHERE decided_by='auto'`;
  await admin`UPDATE second_reviews SET status='resolved',resolution='kept'`;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
    VALUES(${sentinelName},17,9,'{"unrelated":true}'::jsonb,'2101-01-01 00:00:00.654321'::timestamp,
      '2001-02-03 04:05:06.123456'::timestamp)`;
  [{ row: sentinel }] = await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${sentinelName}`;
});
beforeEach(async () => {
  await cleanOwnRows();
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: "pr04b2-locks" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings(), updatedBy: "pr04b2-locks" } });
  await admin`INSERT INTO jobs(name) VALUES('second-review') ON CONFLICT(name) DO UPDATE
    SET lease_token=NULL,locked_at=NULL,not_before=NULL,cursor=NULL,requested_version=0,processed_version=0`;
  await admin`UPDATE pipeline_stage_modes SET mode='legacy',draining_from=NULL,writer_contract_version=0`;
});
afterEach(async () => {
  const [row] = await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${sentinelName}`;
  expect(row.row).toEqual(sentinel);
});
afterAll(async () => {
  const errors: unknown[] = [];
  const cleanup = async (task: () => Promise<unknown>) => {
    try { await task(); } catch (error) { errors.push(error); }
  };
  if (initialized) {
    await cleanup(cleanOwnRows);
    await cleanup(restore);
    await cleanup(async () => { await admin`DELETE FROM jobs WHERE name=${sentinelName}`; });
    await cleanup(async () => {
      expect(await snapshot()).toEqual(baseline);
      expect(await db.select().from(secondReviews).where(like(secondReviews.repo, `${prefix}%`))).toEqual([]);
    });
  }
  if (initialBaseline !== undefined) {
    await cleanup(async () => { await db.delete(secondReviews).where(eq(secondReviews.repo, foreignRepo)); });
    await cleanup(async () => { await admin`DELETE FROM crawl_review_attempts WHERE candidate_id IN
      (SELECT id FROM crawl_candidates WHERE repo=${foreignRepo})`; });
    await cleanup(async () => { await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, foreignRepo)); });
    await cleanup(async () => { await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, foreignRepo)); });
    if (seededSettings) await cleanup(async () => { await db.delete(crawlSettings).where(eq(crawlSettings.id, 1)); });
    await cleanup(async () => { expect(await snapshot()).toEqual(initialBaseline); });
  }
  await cleanup(async () => { await admin.end({ timeout: 3 }); });
  await cleanup(async () => { await blocker.end({ timeout: 3 }); });
  if (errors.length) throw new AggregateError(errors, "second_review_controller_fixture_cleanup_failed");
});

async function fixture(state: "approved" | "rejected" | "needs_review" = "approved", repo = `${prefix}candidate-${++sequence}`) {
  const now = new Date();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://pr04b2-${sequence}.test`,
    state, reason: state === "approved" ? "passed" : state === "rejected" ? "not_a_product" : "ambiguous",
    decidedBy: "auto", judgedAt: now, decidedAt: now }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl, fetchedAt: now,
    pageStatus: 200, repoMeta: { description: "A project management app", stargazers_count: 12 },
    pageMeta: { title: "Project app", description: "Manage projects", textSample: "Create tasks and projects" } }).returning();
  const input = await loadReviewInput(candidate, document, settings());
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "abcllm", model: "first-model", attemptNumber: 1, validUntil: input.validUntil, completedAt: now,
    outcome: { decision: "approve", confidence: .94, reason: "Working application", evidenceIds: ["product"] } }).returning();
  const [vote] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, trigger: "ai_approved",
    firstDecision: "approve", firstConfidence: .94, firstModel: "first-model", firstAttemptId: first.id,
    generationKey: secondReviewGeneration(first.id, input, "ai_approved"), inputHash: input.inputHash,
    provider: "abcllm", model: "second-model" }).returning();
  return { candidate, document, first, vote, input };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function runBlocked<T>(hold: (tx: postgres.TransactionSql) => Promise<void>, run: () => Promise<T>,
  inspect: (state: "blocked" | "completed", holderPid: number) => Promise<void>) {
  const locked = latch(), release = latch(); let holderPid = 0;
  const holding = blocker.begin(async tx => {
    [{ pid: holderPid }] = await tx`SELECT pg_backend_pid() AS pid`;
    await hold(tx); locked.resolve(); await release.promise;
  });
  const holdingResult = holding.then(() => null, error => error);
  let result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> | undefined;
  try {
    await Promise.race([locked.promise, holding.then(() => { throw new Error("holder ended before barrier"); })]);
    let completed = false;
    result = run().then(value => { completed = true; return { ok: true as const, value }; },
      error => { completed = true; return { ok: false as const, error }; });
    let state: "blocked" | "completed" | undefined;
    for (let count = 0; count < 1_000; count++) {
      if (completed) { state = "completed"; break; }
      const rows = await admin`SELECT pid FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`;
      if (rows.length) { state = "blocked"; break; }
    }
    if (!state) throw new Error("actual writer neither completed nor reached database blocker");
    if (state === "completed") {
      const completedResult = await result;
      if (!completedResult.ok) throw completedResult.error;
    }
    await inspect(state, holderPid);
  } finally {
    release.resolve();
    const error = await holdingResult;
    if (result) await result;
    if (error) throw error;
  }
  const outcome = await result!;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

it("retries a due failed vote with an actual second-review job", async () => {
  const f = await fixture();
  await db.update(secondReviews).set({ status: "failed", failureCount: 1, errorCode: "timeout",
    reviewedAt: new Date(Date.now() - 3_600_001) }).where(eq(secondReviews.id, f.vote.id));
  await withLegacySecondReviewJob(lease => retryFailedSecondReviews(new Date(), lease));
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, f.vote.id)))[0].status).toBe("pending");
});

it("waits at the stage prefix before retry takes a domain row lock", async () => {
  const f = await fixture();
  await db.update(secondReviews).set({ status: "failed", failureCount: 1, errorCode: "timeout",
    reviewedAt: new Date(Date.now() - 3_600_001) }).where(eq(secondReviews.id, f.vote.id));
  await runBlocked(tx => tx`SELECT stage FROM pipeline_stage_modes WHERE stage='ai1' FOR UPDATE`.then(() => {}),
    () => withLegacySecondReviewJob(lease => retryFailedSecondReviews(new Date(), lease)), async state => {
      expect(state).toBe("blocked");
      await admin.begin(async tx => {
        await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM second_reviews WHERE id=${f.vote.id} FOR UPDATE NOWAIT`;
      });
    });
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, f.vote.id)))[0].status).toBe("pending");
});

it("closes a genuinely settled candidate and reports its actual changed row", async () => {
  const f = await fixture("rejected");
  expect(await withLegacySecondReviewJob(lease => closeSettledSecondReviews(new Date(), lease))).toBe(1);
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, f.vote.id)))[0])
    .toMatchObject({ status: "resolved", resolution: "decided_elsewhere" });
});

it("rechecks a settled hint after waiting and preserves a newer human terminal vote", async () => {
  const f = await fixture("rejected"); let human: unknown;
  const count = await runBlocked(async tx => {
    await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE`;
    await tx`SELECT id FROM second_reviews WHERE id=${f.vote.id} FOR UPDATE`;
    await tx`UPDATE crawl_candidates SET state='approved',reason='passed' WHERE id=${f.candidate.id}`;
    await tx`UPDATE second_reviews SET status='resolved',resolution='kept',resolved_by='pr04b2-human',
      resolved_at='2026-10-16 01:02:03.123456'::timestamp WHERE id=${f.vote.id}`;
    [{ row: human }] = await tx`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE id=${f.vote.id}`;
  }, () => withLegacySecondReviewJob(lease => closeSettledSecondReviews(new Date(), lease)), async state => {
    expect(state).toBe("blocked");
  });
  const [current] = await admin`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE id=${f.vote.id}`;
  expect(current.row).toEqual(human);
  expect(count).toBe(0);
});

it("queues only the current configured first approval once", async () => {
  const f = await fixture();
  await db.delete(secondReviews).where(eq(secondReviews.id, f.vote.id));
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(1);
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(0);
  expect(await db.select().from(secondReviews).where(eq(secondReviews.candidateId, f.candidate.id)))
    .toMatchObject([{ firstAttemptId: f.first.id, model: "second-model", status: "pending" }]);
});

it("rechecks the latest configured first after waiting before queuing an old approval", async () => {
  const f = await fixture();
  await db.delete(secondReviews).where(eq(secondReviews.id, f.vote.id));
  const count = await runBlocked(async tx => {
    await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE`;
    await tx`INSERT INTO crawl_review_attempts(candidate_id,kind,state,input_hash,source_revision_hash,policy_hash,
      snapshot,source,prompt_version,rules_version,provider,model,attempt_number,outcome,valid_until,completed_at)
      SELECT candidate_id,kind,state,input_hash,source_revision_hash,policy_hash,snapshot,source,prompt_version,rules_version,
        provider,model,2,'{"decision":"reject","confidence":0.95,"reason":"New current verdict","evidenceIds":["product"]}'::jsonb,
        valid_until,clock_timestamp() FROM crawl_review_attempts WHERE id=${f.first.id}`;
  }, () => withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease)), async state => {
    expect(state).toBe("blocked");
  });
  expect(count).toBe(0);
  expect(await db.select().from(secondReviews).where(eq(secondReviews.candidateId, f.candidate.id))).toEqual([]);
});

it("rechecks current source after waiting instead of queuing a stale input", async () => {
  const f = await fixture();
  await db.delete(secondReviews).where(eq(secondReviews.id, f.vote.id));
  const count = await runBlocked(async tx => {
    await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE`;
    await tx`SELECT id FROM crawl_documents WHERE id=${f.document.id} FOR UPDATE`;
    await tx`UPDATE crawl_documents SET page_meta='{"title":"A changed product","description":"Different current source","textSample":"New evidence"}'::jsonb
      WHERE id=${f.document.id}`;
  }, () => withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease)), async state => {
    expect(state).toBe("blocked");
  });
  expect(count).toBe(0);
  expect(await db.select().from(secondReviews).where(eq(secondReviews.candidateId, f.candidate.id))).toEqual([]);
});

it("keeps a voter restored in current settings while cleanup waited", async () => {
  const f = await fixture(), removed = settings();
  removed.secondReview.voters = [{ provider: "abcllm", model: "replacement-model" }];
  await db.update(crawlSettings).set({ values: removed }).where(eq(crawlSettings.id, 1));
  const count = await runBlocked(async tx => {
    await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE`;
    await tx`SELECT id FROM crawl_settings WHERE id=1 FOR UPDATE`;
    await tx`SELECT id FROM second_reviews WHERE id=${f.vote.id} FOR UPDATE`;
    await tx`UPDATE crawl_settings SET values=${JSON.stringify(settings())}::text::jsonb WHERE id=1`;
  }, () => withLegacySecondReviewJob(lease => closeSettledSecondReviews(new Date(), lease)), async state => {
    expect(state).toBe("blocked");
  });
  expect(count).toBe(0);
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, f.vote.id)))[0])
    .toMatchObject({ status: "pending", resolution: null });
});

it("does not reopen from stale enforce settings when current policy is observe", async () => {
  const f = await fixture();
  await db.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split" }).where(eq(crawlCandidates.id, f.candidate.id));
  await db.update(secondReviews).set({ status: "resolved", resolution: "model_removed" }).where(eq(secondReviews.id, f.vote.id));
  await db.update(crawlSettings).set({ values: { ...settings(), reviewMode: "observe" } }).where(eq(crawlSettings.id, 1));
  const count = await withLegacySecondReviewJob(lease => reopenOrphanedGateHolds(settings(), new Date(), lease));
  expect(count).toBe(0);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, f.candidate.id)))[0])
    .toMatchObject({ state: "needs_review", reason: "second_review_split" });
});

it("rolls an orphan root back if the same candidate human hold fails", async () => {
  const f = await fixture();
  await db.update(secondReviews).set({ status: "resolved", resolution: "fallback", failureCount: 1 })
    .where(eq(secondReviews.id, f.vote.id));
  await db.insert(secondReviews).values({ candidateId: f.candidate.id, repo: f.candidate.repo, trigger: "ai_approved",
    firstDecision: "approve", firstConfidence: .94, firstModel: "first-model", firstAttemptId: f.first.id,
    generationKey: f.vote.generationKey, inputHash: f.input.inputHash, provider: "abcllm", model: "removed-backup",
    fallbackForId: f.vote.id, status: "resolved", resolution: "model_removed", failureCount: 2 });
  const [before] = await admin`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE id=${f.vote.id}`;
  await admin.unsafe(`CREATE FUNCTION pr04b2_locks_hold_failure() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN IF NEW.id=${f.candidate.id} AND NEW.reason=''second_review_split'' THEN RAISE EXCEPTION ''pr04b2_hold_failure''; END IF; RETURN NEW; END'`);
  await admin`CREATE TRIGGER pr04b2_locks_hold_failure BEFORE UPDATE ON crawl_candidates FOR EACH ROW
    EXECUTE FUNCTION pr04b2_locks_hold_failure()`;
  await expect(withLegacySecondReviewJob(lease => closeSettledSecondReviews(new Date(), lease)))
    .rejects.toMatchObject({ cause: { message: "pr04b2_hold_failure" } });
  const [after] = await admin`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE id=${f.vote.id}`;
  expect(after.row).toEqual(before.row);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, f.candidate.id)))[0].state).toBe("approved");
});

it("preserves exact retry windows and the maximum three failures", async () => {
  const now = new Date(), cases = [
    { code: "timeout", age: 300_001, failures: 1, expected: "pending" },
    { code: "gateway_error", age: 300_000, failures: 1, expected: "failed" },
    { code: "rate_limited", age: 299_999, failures: 1, expected: "failed" },
    { code: "auth", age: 3_600_001, failures: 2, expected: "pending" },
    { code: "auth", age: 3_600_000, failures: 2, expected: "failed" },
    { code: "timeout", age: 3_600_001, failures: 3, expected: "failed" },
  ];
  const ids: number[] = [];
  for (const value of cases) {
    const f = await fixture(); ids.push(f.vote.id);
    await db.update(secondReviews).set({ status: "failed", errorCode: value.code, failureCount: value.failures,
      reviewedAt: new Date(now.getTime() - value.age) }).where(eq(secondReviews.id, f.vote.id));
  }
  await withLegacySecondReviewJob(lease => retryFailedSecondReviews(now, lease));
  const rows = await db.select().from(secondReviews).where(inArray(secondReviews.id, ids)).orderBy(secondReviews.id);
  expect(rows.map(row => row.status)).toEqual(cases.map(value => value.expected));
  expect(rows.map(row => row.failureCount)).toEqual(cases.map(value => value.failures));
});

it("rechecks retry status after the actual vote lock wait", async () => {
  const f = await fixture();
  await db.update(secondReviews).set({ status: "failed", errorCode: "timeout", failureCount: 1,
    reviewedAt: new Date(Date.now() - 3_600_001) }).where(eq(secondReviews.id, f.vote.id));
  let human: unknown;
  await runBlocked(async tx => {
    await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE`;
    await tx`SELECT id FROM second_reviews WHERE id=${f.vote.id} FOR UPDATE`;
    await tx`UPDATE second_reviews SET status='resolved',resolution='kept',resolved_by='pr04b2-human',
      resolved_at='2026-10-16 01:02:03.654321'::timestamp WHERE id=${f.vote.id}`;
    [{ row: human }] = await tx`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE id=${f.vote.id}`;
  }, () => withLegacySecondReviewJob(lease => retryFailedSecondReviews(new Date(), lease)), async state => {
    expect(state).toBe("blocked");
  });
  const [current] = await admin`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE id=${f.vote.id}`;
  expect(current.row).toEqual(human);
});

it.each(["fetch", "ai2"] as const)("takes the %s stage prefix before retry locks domain rows", async stage => {
  const f = await fixture();
  await db.update(secondReviews).set({ status: "failed", failureCount: 1, errorCode: "timeout",
    reviewedAt: new Date(Date.now() - 3_600_001) }).where(eq(secondReviews.id, f.vote.id));
  await runBlocked(tx => tx`SELECT stage FROM pipeline_stage_modes WHERE stage=${stage} FOR UPDATE`.then(() => {}),
    () => withLegacySecondReviewJob(lease => retryFailedSecondReviews(new Date(), lease)), async state => {
      expect(state).toBe("blocked");
      await admin.begin(async tx => {
        await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM second_reviews WHERE id=${f.vote.id} FOR UPDATE NOWAIT`;
      });
    });
});

it.each(["enqueue", "close", "reopen"] as const)("takes S3 before %s domain locks", async action => {
  const f = await fixture(action === "close" ? "rejected" : "approved");
  if (action === "enqueue") await db.delete(secondReviews).where(eq(secondReviews.id, f.vote.id));
  if (action === "reopen") {
    await db.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split" }).where(eq(crawlCandidates.id, f.candidate.id));
    await db.update(secondReviews).set({ status: "resolved", resolution: "model_removed" }).where(eq(secondReviews.id, f.vote.id));
  }
  await runBlocked(tx => tx`SELECT stage FROM pipeline_stage_modes WHERE stage='ai1' FOR UPDATE`.then(() => {}),
    () => withLegacySecondReviewJob(lease => action === "enqueue" ? enqueueSecondReviews(settings(), new Date(), lease)
      : action === "close" ? closeSettledSecondReviews(new Date(), lease) : reopenOrphanedGateHolds(settings(), new Date(), lease)),
    async state => {
      expect(state).toBe("blocked");
      await admin.begin(async tx => {
        await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM crawl_documents WHERE id=${f.document.id} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM second_reviews WHERE id=${f.vote.id} FOR UPDATE NOWAIT`;
      });
    });
});

it.each(["legacy", "items", "draining"] as const)("preserves semantic controller behavior in %s mode", async mode => {
  await admin`UPDATE pipeline_stage_modes SET mode=${mode},draining_from=${mode === "draining" ? "items" : null},
    writer_contract_version=${mode === "legacy" ? 0 : 1}`;
  const queued = await fixture();
  await db.delete(secondReviews).where(eq(secondReviews.id, queued.vote.id));
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(1);
  const retry = await fixture();
  await db.update(secondReviews).set({ status: "failed", failureCount: 1, errorCode: "timeout",
    reviewedAt: new Date(Date.now() - 3_600_001) }).where(eq(secondReviews.id, retry.vote.id));
  await withLegacySecondReviewJob(lease => retryFailedSecondReviews(new Date(), lease));
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, retry.vote.id)))[0].status).toBe("pending");
  const closed = await fixture("rejected");
  expect(await withLegacySecondReviewJob(lease => closeSettledSecondReviews(new Date(), lease))).toBe(1);
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, closed.vote.id)))[0].resolution).toBe("decided_elsewhere");
  const held = await fixture();
  await db.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split" }).where(eq(crawlCandidates.id, held.candidate.id));
  await db.update(secondReviews).set({ status: "resolved", resolution: "model_removed" }).where(eq(secondReviews.id, held.vote.id));
  expect(await withLegacySecondReviewJob(lease => reopenOrphanedGateHolds(settings(), new Date(), lease))).toBe(1);
});

it("keeps the enqueue fifty-candidate bound and reaches the next candidate", async () => {
  const ids: number[] = [];
  for (let index = 0; index < 51; index++) {
    const f = await fixture(); ids.push(f.candidate.id);
  }
  await db.delete(secondReviews).where(inArray(secondReviews.candidateId, ids));
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(50);
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(1);
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(0);
  expect(await db.select().from(secondReviews).where(inArray(secondReviews.candidateId, ids))).toHaveLength(51);
});

it("keeps reopen limit twenty-five, signals, history, and active or human holds", async () => {
  const orphanIds: number[] = [], allIds: number[] = [];
  for (let index = 0; index < 29; index++) {
    const f = await fixture(); allIds.push(f.candidate.id);
    await db.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split",
      signals: { stoppedAt: { rule: "2차 심사", detail: "Removed vote" }, retained: "keep" },
      decidedBy: index === 27 ? "admin" : "auto" }).where(eq(crawlCandidates.id, f.candidate.id));
    if (index !== 26 && index !== 28) await db.update(secondReviews).set({ status: "resolved", resolution: "model_removed" })
      .where(eq(secondReviews.id, f.vote.id));
    if (index === 28) await db.delete(secondReviews).where(eq(secondReviews.id, f.vote.id));
    if (index < 26) orphanIds.push(f.candidate.id);
  }
  const now = new Date();
  expect(await withLegacySecondReviewJob(lease => reopenOrphanedGateHolds(settings(), now, lease))).toBe(25);
  expect(await withLegacySecondReviewJob(lease => reopenOrphanedGateHolds(settings(), now, lease))).toBe(1);
  expect(await withLegacySecondReviewJob(lease => reopenOrphanedGateHolds(settings(), now, lease))).toBe(0);
  const reopened = await db.select().from(crawlCandidates).where(inArray(crawlCandidates.id, orphanIds));
  expect(reopened.every(row => row.state === "approved" && row.reason === "passed")).toBe(true);
  for (const row of reopened) {
    expect(row.signals).toMatchObject({ retained: "keep", gateReopenedAt: now.toISOString() });
    expect(row.signals).not.toHaveProperty("stoppedAt");
  }
  expect((await db.select().from(crawlCandidates).where(inArray(crawlCandidates.id, allIds.slice(26)))).map(row => row.state))
    .toEqual(["needs_review", "needs_review", "needs_review"]);
  expect(await db.select().from(secondReviews).where(inArray(secondReviews.candidateId, orphanIds))).toHaveLength(26);
});

it.each([1, 25])("reopens an unlocked orphan beyond %i locked earlier eligible candidates", async lockedCount => {
  const candidates = [];
  for (let index = 0; index <= lockedCount; index++) candidates.push(await fixture());
  const ids = candidates.map(row => row.candidate.id), lockedIds = ids.slice(0, lockedCount), laterId = ids[lockedCount];
  expect(lockedIds.every(id => id < laterId)).toBe(true);
  await admin`UPDATE crawl_candidates SET state='needs_review',reason='second_review_split',
    updated_at='2026-10-16 01:02:03.123456'::timestamp WHERE id IN ${admin(ids)}`;
  await db.update(secondReviews).set({ status: "resolved", resolution: "model_removed" })
    .where(inArray(secondReviews.candidateId, ids));
  const original = await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id IN ${admin(lockedIds)} ORDER BY id`;
  const opinions = await admin`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE candidate_id IN ${admin(ids)} ORDER BY id`;
  const count = await runBlocked(
    tx => tx`SELECT id FROM crawl_candidates WHERE id IN ${tx(lockedIds)} ORDER BY id FOR UPDATE`.then(() => {}),
    () => withLegacySecondReviewJob(lease => reopenOrphanedGateHolds(settings(), new Date(), lease)),
    async (state, holderPid) => {
      const waiters = await admin`SELECT a.wait_event_type,a.wait_event,a.query,pg_blocking_pids(a.pid) AS blockers
        FROM pg_stat_activity a WHERE ${holderPid}=ANY(pg_blocking_pids(a.pid))`;
      const stillHeld = await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id IN ${admin(lockedIds)} ORDER BY id`;
      const [later] = await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${laterId}`;
      expect(stillHeld).toEqual(original);
      expect(await admin`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE candidate_id IN ${admin(ids)} ORDER BY id`)
        .toEqual(opinions);
      if (state === "blocked") {
        expect(waiters.length).toBeGreaterThan(0);
        expect(waiters.some(row => row.query.includes("crawl_candidates"))).toBe(true);
      }
      expect(state, `actual blocker proof: ${JSON.stringify({ waiters, lockedCandidateCount: stillHeld.length, readyCandidate: later.row })}`)
        .toBe("completed");
      expect(later.row).toMatchObject({ state: "approved", reason: "passed" });
    });
  expect(count).toBe(1);
});

it("filters settled rows before the thousand-row bound and keeps completed historical opinions", async () => {
  const held = await fixture();
  await db.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split" }).where(eq(crawlCandidates.id, held.candidate.id));
  await db.delete(secondReviews).where(eq(secondReviews.id, held.vote.id));
  await db.insert(secondReviews).values(Array.from({ length: 1_000 }, (_, index) => ({
    candidateId: held.candidate.id, repo: held.candidate.repo, trigger: "ai_approved" as const,
    firstDecision: "approve", firstConfidence: .94, firstModel: "first-model", firstAttemptId: held.first.id,
    inputHash: `waiting-${index}`, generationKey: `waiting-${index}`, provider: "abcllm" as const, model: "second-model",
    status: "needs_human" as const, secondDecision: "reject" })));
  const closed = await fixture("rejected");
  await db.update(secondReviews).set({ status: "agreed", secondDecision: "approve" }).where(eq(secondReviews.id, closed.vote.id));
  expect(await withLegacySecondReviewJob(lease => closeSettledSecondReviews(new Date(), lease))).toBe(1);
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, closed.vote.id)))[0].resolution).toBe("decided_elsewhere");
  expect((await db.select().from(secondReviews).where(eq(secondReviews.candidateId, held.candidate.id)))
    .every(row => row.status === "needs_human" && row.secondDecision === "reject")).toBe(true);
});

async function publishedFixture() {
  const f = await fixture(), slug = `${slugPrefix}${sequence}`;
  await db.delete(secondReviews).where(eq(secondReviews.id, f.vote.id));
  const [product] = await db.insert(products).values({ slug, url: f.candidate.productUrl!, repoUrl: `https://github.com/${f.candidate.repo}`,
    name: "the quick way to plan all of your week with friends", tagline: "Manage projects", description: "Deployed app", category: "Dev",
    source: "crawler", status: "seeded", verifyToken: randomUUID(), editTokenHash: "a".repeat(64) }).returning();
  // 자동 결정은 decided_at 을 적지 않는다 — 공개 시각은 제품 행이 생긴 때다
  await db.update(crawlCandidates).set({ state: "published", publishedSlug: slug, decidedAt: null }).where(eq(crawlCandidates.id, f.candidate.id));
  await db.update(crawlDocuments).set({ pageMeta: { title: product.name, description: "Manage projects", textSample: "Create tasks" } })
    .where(eq(crawlDocuments.id, f.document.id));
  return { ...f, product };
}

it("queues published risk without a first receipt and preserves the twenty-five-product quota", async () => {
  const ids: number[] = [];
  for (let index = 0; index < 26; index++) ids.push((await publishedFixture()).candidate.id);
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(25);
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(1);
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(0);
  const rows = await db.select().from(secondReviews).where(inArray(secondReviews.candidateId, ids));
  expect(rows).toHaveLength(26);
  expect(rows.every(row => row.trigger === "risk" && row.firstAttemptId === null && row.firstConfidence === null)).toBe(true);
  expect(rows.every(row => row.inputHash === publishedInputHash(row.publishedSlug!))).toBe(true);
});

it("waits for the actual published product before domain locks and skips a deleted generation", async () => {
  const f = await publishedFixture();
  // Exact own corruption fixture: product disappears but the candidate pointer remains.
  // The public delete API detaches that pointer and would exercise only the old slug filter.
  const count = await runBlocked(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`product-lifecycle:${f.product.slug}`}))`;
    await tx`SELECT id FROM products WHERE id=${f.product.id} FOR UPDATE`;
    await tx`DELETE FROM products WHERE id=${f.product.id}`;
  }, () => withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease)), async state => {
    expect(state).toBe("blocked");
    await admin.begin(async tx => { await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE NOWAIT`; });
  });
  expect(count).toBe(0);
  expect(await db.select().from(secondReviews).where(eq(secondReviews.candidateId, f.candidate.id))).toEqual([]);
});

it("does not let fifty old confident hints starve a later current first verdict", async () => {
  for (let index = 0; index < 50; index++) {
    const f = await fixture("needs_review");
    await db.delete(secondReviews).where(eq(secondReviews.id, f.vote.id));
    await admin`INSERT INTO crawl_review_attempts(candidate_id,kind,state,input_hash,source_revision_hash,policy_hash,
      snapshot,source,prompt_version,rules_version,provider,model,attempt_number,outcome,valid_until,completed_at)
      SELECT candidate_id,kind,state,input_hash,source_revision_hash,policy_hash,snapshot,source,prompt_version,rules_version,
        provider,model,2,'{"decision":"reject","reason":"Latest has no confidence","evidenceIds":["product"]}'::jsonb,
        valid_until,clock_timestamp() FROM crawl_review_attempts WHERE id=${f.first.id}`;
  }
  const ready = await fixture("needs_review");
  await db.delete(secondReviews).where(eq(secondReviews.id, ready.vote.id));
  expect(await withLegacySecondReviewJob(lease => enqueueSecondReviews(settings(), new Date(), lease))).toBe(1);
  expect(await db.select().from(secondReviews).where(like(secondReviews.repo, `${prefix}%`)))
    .toMatchObject([{ candidateId: ready.candidate.id, firstAttemptId: ready.first.id, trigger: "ai_decided", status: "pending" }]);
});

it.each(["human", "published"] as const)("does not lock an unrelated %s opinion before closing an actually settled vote", async kind => {
  let unrelated: Awaited<ReturnType<typeof fixture>>, unrelatedVoteId: number;
  if (kind === "human") {
    unrelated = await fixture(); unrelatedVoteId = unrelated.vote.id;
    await db.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split" })
      .where(eq(crawlCandidates.id, unrelated.candidate.id));
    await db.update(secondReviews).set({ status: "needs_human", secondDecision: "reject", secondConfidence: .96 })
      .where(eq(secondReviews.id, unrelatedVoteId));
  } else {
    const published = await publishedFixture(); unrelated = published;
    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, published.candidate.id));
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.id, published.document.id));
    const input = await loadReviewInput(candidate, document, settings());
    const [vote] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo: candidate.repo,
      trigger: "risk", publishedSlug: published.product.slug, firstDecision: "approve", firstConfidence: null,
      firstAttemptId: null, generationKey: secondReviewGeneration(null, input), inputHash: publishedInputHash(published.product.slug),
      provider: "abcllm", model: "second-model", status: "agreed", secondDecision: "approve", secondConfidence: .96 }).returning();
    unrelatedVoteId = vote.id;
  }
  const [before] = await admin`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE id=${unrelatedVoteId}`;
  const settled = await fixture("rejected");
  const count = await runBlocked(async tx => {
    await tx`SELECT id FROM crawl_candidates WHERE id=${unrelated.candidate.id} FOR UPDATE`;
  }, () => withLegacySecondReviewJob(lease => closeSettledSecondReviews(new Date(), lease)), async state => {
    expect(state).toBe("completed");
  });
  expect(count).toBe(1);
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, settled.vote.id)))[0].resolution).toBe("decided_elsewhere");
  const [after] = await admin`SELECT to_jsonb(v) AS row FROM second_reviews v WHERE id=${unrelatedVoteId}`;
  expect(after.row).toEqual(before.row);
});
