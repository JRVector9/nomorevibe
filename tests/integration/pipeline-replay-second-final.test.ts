import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews, type CrawlDocument } from "@/lib/db/schema";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash, reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { runFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";
import { withReviewFixtureTransport, type ReviewFixtureCallback } from "@/lib/crawl/review-fixture-transport";
import { closeSettledSecondReviews, publishedInputHash, recordSecondReview } from "@/lib/crawl/second-review";
import { loadLockedSecondReviewInput, secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { assertReplayDatabaseScopeIdentity, withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import type { JobLease } from "@/lib/jobs/control";
import { ReplayLedger } from "@/lib/operations/pipeline-replay-ledger";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { withReplayFinalScope } from "@/lib/operations/pipeline-replay-final";
import { runJob } from "@/lib/jobs/runner";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { secondReviewCandidates } from "@/lib/crawl/jobs/second-review";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

const reference = new Date("2001-11-01T00:00:00.000Z");
const settings: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce", reviewConcurrency: 2,
  firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true, sampleRate: 0,
    voters: [{ provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }, { provider: "abcllm", model: "independent-two" }],
    fallbacks: [{ provider: "abcllm", model: "qwen3-coder:30b" }] } };
let admin: postgres.Sql, identityPath: string, release: () => Promise<void>, document: CrawlDocument;
let serial = 0;
beforeAll(async () => {
  ensureSchema();
  [document] = await db.insert(crawlDocuments).values({ repo: "second-final/app", productUrl: "https://second-final.example",
    fetchedAt: new Date(+reference - 1_000), pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", homepage: "https://second-final.example", fork: false,
      private: false, archived: false, owner: { type: "User" }, stargazers_count: 10,
      pushed_at: new Date(+reference - 10_000).toISOString() },
    pageMeta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create a project and manage tasks in the application.", readmeSample: "An online task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION },
  }).onConflictDoUpdate({ target: crawlDocuments.repo, set: { fetchedAt: new Date(+reference - 1_000) } }).returning();
  await db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings } });
  ({ identityPath, release } = await getReplayHandlerIdentityPath());
  admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
});
afterAll(async () => { await admin?.end({ timeout: 3 }); await release?.(); });
beforeEach(async () => {
  await admin`TRUNCATE pipeline_replay.capacity_transitions, pipeline_replay.capacity_calls,
    pipeline_replay.capacity_inputs, pipeline_replay.capacity_runs CASCADE`;
  await admin`TRUNCATE second_reviews, crawl_review_attempts, crawl_candidates, crawl_frontier, jobs RESTART IDENTITY CASCADE`;
});

async function prepare() {
  const [candidate] = await db.insert(crawlCandidates).values({ repo: document.repo, productUrl: document.productUrl,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: reference, updatedAt: reference }).returning();
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] }, reference);
  const model = (value: { provider: "abcllm" | "claude-cli" | "grok-cli"; model: string }) => ({ ...value, canonicalModel: canonicalReviewModel(value.model) });
  const manifest: CapacityManifest = { version: 1, runId: `second-final-${++serial}`, revision: "664777d", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: reviewPolicyHash(settings), fullReviewPolicyHash: fullReviewPolicyHash(settings),
    comparisonPolicyHash: comparisonReviewPolicyHash(settings), initialStateHash: reviewHash({ candidate, document }),
    models: { first: model(settings.firstReview!), second: settings.secondReview.voters.map(model), fallbacks: settings.secondReview.fallbacks!.map(model) },
    inputs: [{ candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 8, maxTokens: 800, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 4 } };
  await admin`INSERT INTO jobs (name, requested_version) VALUES ('crawl-agent-review', 1)`;
  return { candidate, manifest, inputs: [{ candidateId: candidate.id, input }] };
}
const approve: ReviewFixtureCallback = async () => ({ result: { ok: true,
  outcome: { decision: "approve", confidence: 0.99, reason: "A deployed task tracker", evidenceIds: ["product"] },
  usage: { inputTokens: 8, outputTokens: 2 } }, receipt: { inputTokens: 8, outputTokens: 2 } });

it("records one final only after every mandatory AI2 slot approves", async () => {
  const value = await prepare();
  const result = await runFixtureReviewReplay({ identityPath, manifest: value.manifest, inputs: value.inputs,
    fixture: async call => {
      if (call.request.stage === "second" && call.request.model === settings.secondReview.voters[1].model) {
        await expect.poll(async () => (await admin`SELECT count(*)::int AS count FROM second_reviews WHERE status = 'agreed'`)[0].count,
          { timeout: 5_000, interval: 10 }).toBe(1);
        expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(0);
      }
      return approve(call);
    } });
  expect(result.jobs.map(row => row.result.status)).toEqual(["completed", "completed"]);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(1);
});

it("binds a successful fallback to its original slot and ignores duplicate completion", async () => {
  const value = await prepare();
  const result = await runFixtureReviewReplay({ identityPath, manifest: value.manifest, inputs: value.inputs,
    jobs: ["crawl-agent-review", "second-review", "second-review"], fixture: async call => {
      if (call.request.stage === "second" && call.request.model === settings.secondReview.voters[1].model)
        return { result: { ok: false, error: "model_unavailable" }, receipt: { inputTokens: 0, outputTokens: 0 } };
      return approve(call);
    } });
  expect(result.jobs.map(row => row.result.status)).toEqual(["completed", "completed", "completed"]);
  const [fallback] = await admin`SELECT * FROM second_reviews WHERE fallback_for_id IS NOT NULL`;
  expect(fallback).toMatchObject({ status: "agreed", model: "qwen3-coder:30b" });
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(1);
  await recordSecondReview(fallback.id, { ok: true, decision: "approve", confidence: .99, reason: "duplicate", model: fallback.model,
    provider: fallback.provider, status: "agreed" });
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(1);
});

it.each(["reject", "needs_review"] as const)("keeps an AI2 %s in human review without a final", async decision => {
  const value = await prepare();
  const result = await runFixtureReviewReplay({ identityPath, manifest: value.manifest, inputs: value.inputs,
    fixture: async call => call.request.stage === "first" ? approve(call) : {
      result: { ok: true, outcome: { decision, confidence: .99, reason: "Requires human confirmation", evidenceIds: ["product"] }, usage: {} },
      receipt: { inputTokens: 8, outputTokens: 2 },
    } });
  expect(result.jobs.every(row => row.result.status === "completed")).toBe(true);
  expect(await admin`SELECT state, reason FROM crawl_candidates WHERE id = ${value.candidate.id}`)
    .toEqual([{ state: "needs_review", reason: "second_review_split" }]);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(0);
});

it("records superseded AI2 results after a human decision without creating a final", async () => {
  const value = await prepare();
  let changed = false;
  const result = await runFixtureReviewReplay({ identityPath, manifest: value.manifest, inputs: value.inputs,
    fixture: async call => {
      if (call.request.stage === "second" && !changed) {
        changed = true;
        await admin`UPDATE crawl_candidates SET state = 'rejected', decided_by = 'admin' WHERE id = ${value.candidate.id}`;
      }
      return approve(call);
    } });
  expect(result.jobs.every(row => row.result.status === "completed")).toBe(true);
  expect(await admin`SELECT state, decided_by FROM crawl_candidates WHERE id = ${value.candidate.id}`)
    .toEqual([{ state: "rejected", decided_by: "admin" }]);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(0);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'second_review_superseded'`).toHaveLength(2);
});

it("persists published sample fallback results and their outbox without a first attempt or final", async () => {
  const value = await prepare(), slug = "published-sample";
  await admin`UPDATE crawl_candidates SET state = 'published', published_slug = ${slug}, decided_at = ${reference}
    WHERE id = ${value.candidate.id}`;
  await admin`INSERT INTO second_reviews (candidate_id, repo, published_slug, trigger, provider, model,
    first_decision, first_confidence, first_model, first_attempt_id, generation_key, input_hash)
    VALUES (${value.candidate.id}, ${value.candidate.repo}, ${slug}, 'sample', 'abcllm', ${settings.secondReview.voters[0].model},
      'approve', NULL, NULL, NULL, ${secondReviewGeneration(null, value.inputs[0].input)}, ${publishedInputHash(slug)})`;
  await admin`INSERT INTO jobs (name, requested_version) VALUES ('second-review', 1)`;
  const result = await runFixtureReviewReplay({ identityPath, manifest: value.manifest, inputs: value.inputs,
    jobs: ["second-review", "second-review"], fixture: async call => {
      expect(call.request.firstAttemptId).toBeNull();
      if (call.request.model === settings.secondReview.voters[0].model)
        return { result: { ok: false, error: "model_unavailable" }, receipt: { inputTokens: 0, outputTokens: 0 } };
      return approve(call);
    } });
  expect(result.jobs.every(row => row.result.status === "completed")).toBe(true);
  expect(await admin`SELECT status, resolution, first_attempt_id FROM second_reviews ORDER BY id`).toEqual([
    { status: "resolved", resolution: "fallback", first_attempt_id: null },
    { status: "agreed", resolution: null, first_attempt_id: null },
  ]);
  const writes = await admin`SELECT payload FROM pipeline_replay.capacity_transitions WHERE kind = 'second_review_review_write' ORDER BY seq`;
  expect(writes).toHaveLength(2);
  expect(writes[0].payload.requests).toEqual([{ job: "second-review", requestedVersion: 2 }]);
  expect(writes[1].payload.requests).toEqual([]);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(0);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_finals`).toHaveLength(0);
  expect(await admin`SELECT 1 FROM crawl_review_attempts`).toHaveLength(0);
});

it("appends actual cleanup in the authentic run scope without rewriting its earlier final", async () => {
  const value = await prepare(), database = await openVerifiedReplayHandlerDatabase(identityPath, {});
  const ledger = new ReplayLedger(database);
  try {
    const run = await ledger.prepare(value.manifest, value.inputs);
    await ledger.start(run);
    await withReplayDatabaseScope(identityPath, () => {
      assertReplayDatabaseScopeIdentity(database);
      return withReviewReplayContext({ referenceTime: reference }, () =>
      withReplayFinalScope(run, () => withReviewFixtureTransport({ ledger, run, inputs: value.inputs, fixture: approve,
        tokenUpperBound: value.manifest.limits.perCallTokenUpperBound,
        fullReviewPolicyHash: value.manifest.fullReviewPolicyHash }, async () => {
        expect((await runJob("crawl-agent-review", reviewCrawlCandidates, { requestedOnly: true })).status).toBe("completed");
        expect((await runJob("second-review", secondReviewCandidates, { requestedOnly: true })).status).toBe("completed");
        const finals = await admin`SELECT * FROM pipeline_replay.capacity_finals`;
        expect(finals).toHaveLength(1);
        const [finalEvent] = await admin`SELECT seq FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`;
        await admin`UPDATE crawl_candidates SET state = 'rejected', decided_by = 'admin' WHERE id = ${value.candidate.id}`;
        expect(await closeSettledSecondReviews()).toBe(2);
        expect(await admin`SELECT * FROM pipeline_replay.capacity_finals`).toEqual(finals);
        const events = await admin`SELECT seq, kind, payload FROM pipeline_replay.capacity_transitions WHERE kind = 'second_review_cleanup' ORDER BY seq`;
        expect(events).toHaveLength(1);
        expect(events[0].payload.secondReviewIds).toHaveLength(2);
        expect(Number(events[0].seq)).toBeGreaterThan(Number(finalEvent.seq));
      })));
    });
    await ledger.drain(run);
  } finally { await database.close(); }
});

it("rejects a foreign first-attempt binding without locking that other candidate's attempt", async () => {
  const value = await prepare(), input = value.inputs[0].input;
  const [foreign] = await db.insert(crawlCandidates).values({ repo: "second-final/foreign", productUrl: "https://foreign.example",
    state: "approved", decidedBy: "auto", judgedAt: reference, updatedAt: reference }).returning();
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: foreign.id, kind: "automatic", state: "succeeded",
    attemptNumber: 1, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: settings.firstReview!.provider, model: settings.firstReview!.model, startedAt: reference, completedAt: reference,
    validUntil: input.validUntil, outcome: { decision: "approve", confidence: .99, reason: "Foreign candidate", evidenceIds: ["product"] },
  }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: value.candidate.id, repo: value.candidate.repo,
    trigger: "ai_approved", provider: settings.secondReview.voters[0].provider, model: settings.secondReview.voters[0].model,
    firstDecision: "approve", firstConfidence: .99, firstModel: first.model, firstAttemptId: first.id,
    generationKey: secondReviewGeneration(first.id, input, "ai_approved"), inputHash: input.inputHash,
  }).returning();
  const loaded = barrier(), releaseLoader = barrier();
  const holding = withReplayDatabaseScope(identityPath, () => withReviewReplayContext({ referenceTime: reference }, () =>
    db.transaction(async tx => {
      expect(await loadLockedSecondReviewInput(row, tx)).toBeNull();
      loaded.resolve();
      await releaseLoader.promise;
    })));
  try {
    await Promise.race([loaded.promise, holding.then(() => { throw new Error("loader_transaction_ended_early"); })]);
    await expect(admin.begin(async tx => {
      await tx`SELECT id FROM crawl_review_attempts WHERE id = ${first.id} FOR UPDATE NOWAIT`;
    })).resolves.toBeUndefined();
  } finally {
    releaseLoader.resolve();
    await holding;
  }
});

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function blockedQuery(pattern: string, blockerPid?: number): Promise<number> {
  const query = async () => await admin`SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid()
    AND query ILIKE ${pattern} AND cardinality(pg_blocking_pids(pid)) > 0
    AND (${blockerPid ?? null}::int IS NULL OR ${blockerPid ?? null} = ANY(pg_blocking_pids(pid)))`;
  await expect.poll(async () => (await query()).length, { timeout: 5_000, interval: 10 }).toBeGreaterThan(0);
  return (await query())[0].pid;
}
async function expectPrefixWait(blockerPid: number): Promise<void> {
  const pid = await blockedQuery("%", blockerPid);
  const [blocked] = await admin`SELECT query FROM pg_stat_activity WHERE pid = ${pid}`;
  expect(blocked.query).toContain("pg_advisory_xact_lock(1485803, 3)");
}

async function runWithHeldSecondLease(value: Awaited<ReturnType<typeof prepare>>, fixture: ReviewFixtureCallback,
  afterSecond: () => Promise<unknown>) {
  const database = await openVerifiedReplayHandlerDatabase(identityPath, {}), ledger = new ReplayLedger(database);
  const run = await ledger.prepare(value.manifest, value.inputs);
  try {
    await ledger.start(run);
    return await withReplayDatabaseScope(identityPath, () => {
      assertReplayDatabaseScopeIdentity(database);
      return withReviewReplayContext({ referenceTime: reference }, () => withReplayFinalScope(run, () =>
        withReviewFixtureTransport({ ledger, run, inputs: value.inputs, fixture,
          tokenUpperBound: value.manifest.limits.perCallTokenUpperBound, fullReviewPolicyHash: value.manifest.fullReviewPolicyHash }, async () => {
          const first = await runJob("crawl-agent-review", reviewCrawlCandidates, { requestedOnly: true });
          const second = await runJob<null>("second-review", async ctx => {
            const outcome = await secondReviewCandidates(ctx);
            await afterSecond();
            return outcome;
          }, { requestedOnly: true });
          return { jobs: [{ result: first }, { result: second }] };
        })));
    });
  } finally {
    try { await ledger.drain(run); } finally { await database.close(); }
  }
}

it("waits before domain locks when cleanup owns an AI2 row and waits for its lease", async () => {
  const value = await prepare(), fixtureReady = barrier(), releaseFixture = barrier();
  const startCleanup = barrier(), releaseJob = barrier(), jobLocked = barrier<number>();
  let lease!: JobLease;
  // Started outside the runner's ALS scope: this opens a second actual restricted connection.
  const cleanup = (async () => {
    await startCleanup.promise;
    return withReplayDatabaseScope(identityPath, () => withReviewReplayContext({ referenceTime: reference }, () =>
      closeSettledSecondReviews(undefined, lease)));
  })();
  const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  const running = runWithHeldSecondLease(value, async call => {
    if (call.request.stage === "second") { fixtureReady.resolve(); await releaseFixture.promise; }
    return approve(call);
  }, () => cleanup);
  let blocking: Promise<unknown> | undefined;
  try {
    await fixtureReady.promise;
    const [job] = await admin`SELECT name, lease_token, requested_version FROM jobs WHERE name = 'second-review'`;
    lease = { name: job.name, token: job.lease_token, requestedVersion: Number(job.requested_version) };
    // Removal cleanup now has a real pending dispatched row to close.
    await admin`UPDATE second_reviews SET model = 'removed-model' WHERE model = ${settings.secondReview.voters[0].model}`;
    blocking = blocker.begin(async tx => {
      const [pid] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT name FROM jobs WHERE name = 'second-review' FOR UPDATE`;
      jobLocked.resolve(pid.pid); await releaseJob.promise;
    });
    const jobPid = await jobLocked.promise;
    startCleanup.resolve();
    const cleanupPid = await blockedQuery("%jobs%for share%", jobPid);
    releaseFixture.resolve();
    await expectPrefixWait(cleanupPid);
    releaseJob.resolve();
    await blocking; await cleanup;
    expect((await running).jobs.every(row => row.result.status === "completed")).toBe(true);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(0);
    expect(await admin`SELECT status, resolution FROM second_reviews WHERE model = 'removed-model'`)
      .toEqual([{ status: "resolved", resolution: "model_removed" }]);
  } finally {
    startCleanup.resolve(); releaseJob.resolve(); releaseFixture.resolve();
    await Promise.allSettled([running, cleanup, ...(blocking ? [blocking] : [])]);
    await blocker.end({ timeout: 3 });
  }
});

it("keeps cleanup behind the writer and retains the committed final after cleanup", async () => {
  const value = await prepare(), lastReady = barrier(), releaseLast = barrier();
  const startCleanup = barrier(), publicationLocked = barrier<number>(), releasePublication = barrier();
  let lease!: JobLease;
  const cleanup = (async () => {
    await startCleanup.promise;
    return withReplayDatabaseScope(identityPath, () => withReviewReplayContext({ referenceTime: reference }, () =>
      closeSettledSecondReviews(undefined, lease)));
  })();
  const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  const running = runWithHeldSecondLease(value, async call => {
    if (call.request.stage === "second" && call.request.model === settings.secondReview.voters[1].model) {
      await expect.poll(async () => (await admin`SELECT count(*)::int AS count FROM second_reviews WHERE status = 'agreed'`)[0].count,
        { timeout: 5_000, interval: 10 }).toBe(1);
      lastReady.resolve(); await releaseLast.promise;
    }
    return approve(call);
  }, () => cleanup);
  let blocking: Promise<unknown> | undefined;
  try {
    await lastReady.promise;
    const [job] = await admin`SELECT name, lease_token, requested_version FROM jobs WHERE name = 'second-review'`;
    lease = { name: job.name, token: job.lease_token, requestedVersion: Number(job.requested_version) };
    // Historical inactive opinion: it cannot satisfy either required slot, but cleanup must close it.
    await admin`INSERT INTO second_reviews (candidate_id, repo, trigger, provider, model, first_decision, first_confidence,
      first_model, first_attempt_id, input_hash, generation_key, status, second_decision)
      SELECT candidate_id, repo, trigger, provider, 'removed-model', first_decision, first_confidence,
        first_model, first_attempt_id, input_hash, generation_key, 'agreed', 'approve' FROM second_reviews ORDER BY id LIMIT 1`;
    blocking = blocker.begin(async tx => {
      const [pid] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT name FROM jobs WHERE name = 'crawl-publish' FOR UPDATE`;
      publicationLocked.resolve(pid.pid); await releasePublication.promise;
    });
    const publicationPid = await publicationLocked.promise;
    releaseLast.resolve();
    const writerPid = await blockedQuery("%insert into%jobs%", publicationPid);
    startCleanup.resolve();
    await expectPrefixWait(writerPid);
    releasePublication.resolve();
    await blocking; await cleanup;
    expect((await running).jobs.every(row => row.result.status === "completed")).toBe(true);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(1);
    expect(await admin`SELECT status, resolution FROM second_reviews WHERE model = 'removed-model'`)
      .toEqual([{ status: "resolved", resolution: "model_removed" }]);
  } finally {
    startCleanup.resolve(); releaseLast.resolve(); releasePublication.resolve();
    await Promise.allSettled([running, cleanup, ...(blocking ? [blocking] : [])]);
    await blocker.end({ timeout: 3 });
  }
});
