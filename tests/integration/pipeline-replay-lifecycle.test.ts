import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, secondReviews } from "@/lib/db/schema";
import { closeSettledSecondReviews } from "@/lib/crawl/second-review";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { fullReviewPolicyHash, comparisonReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { ReplayLedger } from "@/lib/operations/pipeline-replay-ledger";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { recordReplaySecondReviewTransition, withReplayFinalScope } from "@/lib/operations/pipeline-replay-final";
import { withReplayExecutionScope, replayQuiescenceProof, readSealedReplayArtifact } from "@/lib/operations/pipeline-replay-execution";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

let admin: postgres.Sql, release: (() => Promise<void>) | undefined, serial = 0;
const reference = new Date("2001-11-01T00:00:00.000Z");
beforeAll(() => { ensureSchema(); admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} }); });
beforeEach(async () => {
  await resetTables();
  await admin`TRUNCATE second_reviews, crawl_review_attempts, crawl_candidates, crawl_documents,
    crawl_frontier, jobs, crawl_settings, operations_observations RESTART IDENTITY CASCADE`;
});
afterEach(async () => { await release?.(); release = undefined; });
afterAll(async () => { await admin?.end({ timeout: 3 }); });

async function prepare(certified = false, seed?: (candidateId: number, inputHash: string) => Promise<void>,
  beforeProvision?: (admin: postgres.Sql) => Promise<void>, start = true) {
  const settings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), firstReview: { provider: "abcllm" as const, model: "first" } };
  const [candidate] = await db.insert(crawlCandidates).values({ repo: "lifecycle/app", productUrl: "https://lifecycle.example",
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: reference }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo: candidate.repo, productUrl: candidate.productUrl,
    fetchedAt: reference, pageStatus: 200, repoMeta: { description: "An online task tracker" },
    pageMeta: { title: "App", readmeSample: "Online task tracker", readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  await db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings } });
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] }, reference);
  const manifest: CapacityManifest = { version: 1, runId: `lifecycle-${++serial}`, revision: "4af0589", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: input.policyHash, fullReviewPolicyHash: fullReviewPolicyHash(settings), comparisonPolicyHash: comparisonReviewPolicyHash(settings),
    initialStateHash: reviewHash({ candidate, document }), models: { first: { provider: "abcllm", model: "first", canonicalModel: "first" }, second: [], fallbacks: [] },
    inputs: [{ candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 4, maxTokens: 400, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 2 } };
  await seed?.(candidate.id, input.inputHash);
  const identity = await getReplayHandlerIdentityPath({ beforeProvision }); release = identity.release;
  const database = await openVerifiedReplayHandlerDatabase(identity.identityPath, {}), ledger = new ReplayLedger(database);
  const inputs = [{ candidateId: candidate.id, input }];
  if (certified) manifest.initialStateHash = (await ledger.previewInitialState(manifest, inputs)).initialStateHash;
  try {
    const run = certified ? await ledger.prepareCertified(manifest, inputs,
      { runner: { jobs: ["crawl-agent-review"], budgetMs: 110_000 }, quality: null }) : await ledger.prepare(manifest, inputs);
    if (start) await ledger.start(run);
    return { ...identity, database, ledger, run, candidate, input, manifest };
  } catch (error) { await database.close(); throw error; }
}

it("closes new call admission while allowing an already active writer to finish draining", async () => {
  const value = await prepare();
  try {
    await withReplayDatabaseScope(value.identityPath, () => withReplayFinalScope(value.run, async () => {
      await value.ledger.drain(value.run);
      await expect(db.transaction(tx => recordReplaySecondReviewTransition(tx,
        { kind: "hold", candidateIds: [value.candidate.id] }))).resolves.toBeUndefined();
    }));
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'second_review_hold'`).toHaveLength(1);
  } finally { await value.database.close(); }
});


it("seals a certified transaction journal and reads back the same protected digest", async () => {
  const value = await prepare(true);
  try {
    await withReplayExecutionScope(value.run, () => withReplayDatabaseScope(value.identityPath, () =>
      db.update(crawlCandidates).set({ signals: { lifecycle: "committed" } }).where(eq(crawlCandidates.id, value.candidate.id)).then(() => undefined)));
    await value.ledger.closeAdmission(value.run);
    await value.ledger.fenceWriters(value.run);
    await value.ledger.seal(value.run, replayQuiescenceProof(value.run));
    await expect(readSealedReplayArtifact(value.database, value.run.runId)).resolves.toMatchObject({
      run: { state: "sealed" }, readiness: { transactions: [expect.objectContaining({ confirmedAt: expect.any(String),
        changes: [expect.objectContaining({ table_name: "crawl_candidates", operation: "UPDATE" })] })] } });
  } finally { await value.database.close(); }
});


function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function blockedQuery(pattern: string, blockerPid?: number): Promise<number> {
  const query = () => admin`SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid()
    AND query ILIKE ${pattern} AND cardinality(pg_blocking_pids(pid)) > 0
    AND (${blockerPid ?? null}::int IS NULL OR ${blockerPid ?? null} = ANY(pg_blocking_pids(pid)))`;
  await expect.poll(async () => (await query()).length, { timeout: 2_000, interval: 10 }).toBeGreaterThan(0);
  return (await query())[0].pid;
}

it("waits on the actual shared writer fence before fencing an admitted transaction", async () => {
  const value = await prepare(true), entered = barrier<number>(), releaseWriter = barrier();
  let fencing: Promise<void> | undefined;
  const execution = withReplayExecutionScope(value.run, () => withReplayDatabaseScope(value.identityPath, () =>
    db.transaction(async tx => {
      await tx.update(crawlCandidates).set({ signals: { lifecycle: "writer-first" } }).where(eq(crawlCandidates.id, value.candidate.id));
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      entered.resolve(row.pid); await releaseWriter.promise;
    })));
  void execution.catch(() => undefined);
  try {
    const writerPid = await entered.promise;
    await value.ledger.closeAdmission(value.run);
    fencing = value.ledger.fenceWriters(value.run);
    await blockedQuery("%pg_advisory_xact_lock(1485803,4)%", writerPid);
    releaseWriter.resolve();
    await execution; await fencing;
    await value.ledger.seal(value.run, replayQuiescenceProof(value.run));
    const artifact = await readSealedReplayArtifact(value.database, value.run.runId);
    expect(artifact).toMatchObject({ run: { state: "sealed" }, readiness: { transactions: [expect.objectContaining({
      changes: [expect.objectContaining({ new_row: expect.objectContaining({ signals: { lifecycle: "writer-first" } }) })] })] } });
  } finally {
    releaseWriter.resolve(); await Promise.allSettled([execution, ...(fencing ? [fencing] : [])]);
    await value.database.close();
  }
});

it("blocks a later writer before domain locks and rejects its mutation after the exclusive fence commits", async () => {
  const value = await prepare(true);
  const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  let execution: Promise<unknown> | undefined, fencing: Promise<void> | undefined;
  await value.ledger.closeAdmission(value.run);
  const secondRelease = barrier(), secondLocked = barrier<number>();
  const holdingFence = blocker.begin(async tx => {
    await tx`SELECT run_id FROM pipeline_replay.capacity_runs WHERE run_id=${value.run.runId} FOR UPDATE`;
    const [row] = await tx`SELECT pg_backend_pid() AS pid`; secondLocked.resolve(row.pid); await secondRelease.promise;
  });
  try {
    const blockerPid = await secondLocked.promise;
    fencing = value.ledger.fenceWriters(value.run);
    const fencePid = await blockedQuery("%capacity_runs%FOR UPDATE%", blockerPid);
    execution = withReplayExecutionScope(value.run, () => withReplayDatabaseScope(value.identityPath, async () => {
      await expect(db.transaction(tx => tx.update(crawlCandidates).set({ signals: { lifecycle: "late" } })
        .where(eq(crawlCandidates.id, value.candidate.id)))).rejects.toThrow("replay_writers_fenced");
    }));
    await blockedQuery("%pg_advisory_xact_lock_shared(1485803, 4)%", fencePid);
    await admin.begin(async tx => { await tx`SELECT id FROM crawl_candidates WHERE id=${value.candidate.id} FOR UPDATE NOWAIT`; });
    secondRelease.resolve(); await holdingFence; await fencing; await execution;
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_changes`).toHaveLength(0);
    await value.ledger.seal(value.run, replayQuiescenceProof(value.run));
    await expect(readSealedReplayArtifact(value.database, value.run.runId)).resolves.toMatchObject({ readiness: { transactions: [] } });
  } finally {
    secondRelease.resolve(); await Promise.allSettled([holdingFence, ...(execution ? [execution] : []), ...(fencing ? [fencing] : [])]);
    await blocker.end({ timeout: 3 }); await value.database.close();
  }
});


it("journals actual AI2 cleanup before fencing and permits no cleanup mutation afterward", async () => {
  const value = await prepare(true, async (candidateId, inputHash) => {
    await db.insert(secondReviews).values({ candidateId, repo: "lifecycle/app", trigger: "risk", firstDecision: "approve",
      firstConfidence: .99, provider: "abcllm", model: "removed-voter", inputHash });
  });
  try {
    await withReplayExecutionScope(value.run, () => withReplayDatabaseScope(value.identityPath, () =>
      withReplayFinalScope(value.run, async () => {
        expect(await closeSettledSecondReviews(reference)).toBe(1);
        await value.ledger.closeAdmission(value.run); await value.ledger.fenceWriters(value.run);
        const [before] = await admin`SELECT count(*) AS count FROM pipeline_replay.capacity_changes`;
        await expect(closeSettledSecondReviews(reference)).rejects.toThrow();
        expect((await admin`SELECT count(*) AS count FROM pipeline_replay.capacity_changes`)[0]).toEqual(before);
      })));
    expect(await admin`SELECT status,resolution FROM second_reviews`).toEqual([{ status: "resolved", resolution: "model_removed" }]);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind='second_review_cleanup'`).toHaveLength(1);
    await value.ledger.seal(value.run, replayQuiescenceProof(value.run));
    await expect(readSealedReplayArtifact(value.database, value.run.runId)).resolves.toMatchObject({ finals: [], readiness: {
      transactions: expect.arrayContaining([expect.objectContaining({ changes: [expect.objectContaining({ table_name: "second_reviews" })] })]) } });
  } finally { await value.database.close(); }
});

it("keeps indeterminate calls unresolved and rejects both sealing and an overlapping new run", async () => {
  const value = await prepare(true);
  try {
    await withReplayExecutionScope(value.run, async () => {
      await value.ledger.reserve(value.run, { callId: "uncertain-first", candidateId: value.candidate.id, firstAttemptId: 99,
        inputHash: value.input.inputHash, sourceRevisionHash: value.input.sourceRevisionHash, stage: "first", provider: "abcllm",
        model: "first", requestHash: reviewHash({ request: "uncertain" }), tokenUpperBound: 100 });
      await value.ledger.markDispatching(value.run, "uncertain-first");
      await value.ledger.markInFlight(value.run, "uncertain-first");
      await value.ledger.markIndeterminate(value.run, "uncertain-first");
    });
    await expect(value.ledger.fenceWriters(value.run)).rejects.toThrow("replay_calls_unresolved");
    await expect(value.ledger.seal(value.run, replayQuiescenceProof(value.run))).rejects.toThrow("replay_writers_not_fenced");
    await expect(value.ledger.prepareCertified({ ...value.manifest, runId: `${value.run.runId}-overlap` },
      [{ candidateId: value.candidate.id, input: value.input }], { runner: { jobs: ["crawl-agent-review"], budgetMs: 110_000 }, quality: null }))
      .rejects.toThrow("replay_active_run_exists");
    const restarted = new ReplayLedger(value.database);
    await expect(restarted.start(value.run)).rejects.toThrow("replay_run_required");
    expect(await admin`SELECT state FROM pipeline_replay.capacity_calls`).toEqual([{ state: "indeterminate" }]);
    expect(await admin`SELECT state FROM pipeline_replay.capacity_runs`).toEqual([{ state: "draining" }]);
  } finally { await value.database.close(); }
});


it("retains a committed but unacknowledged packet and refuses a quiescence proof or seal", async () => {
  const value = await prepare(true, undefined, async bootstrap => {
    await bootstrap.unsafe(`CREATE FUNCTION pipeline_replay.fail_commit_confirmation() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'actual_commit_confirmation_failed'; END $$`);
    await bootstrap.unsafe(`CREATE TRIGGER fail_commit_confirmation BEFORE INSERT ON pipeline_replay.capacity_commit_confirmations
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.fail_commit_confirmation()`);
  });
  try {
    await expect(withReplayExecutionScope(value.run, () => withReplayDatabaseScope(value.identityPath, async () => {
      await expect(db.update(crawlCandidates).set({ signals: { lifecycle: "commit-ack-unknown" } })
        .where(eq(crawlCandidates.id, value.candidate.id))).rejects.toMatchObject({ cause: { message: "actual_commit_confirmation_failed" } });
    }))).rejects.toThrow("replay_execution_not_quiescent");
    expect(await admin`SELECT signals FROM crawl_candidates WHERE id=${value.candidate.id}`)
      .toEqual([{ signals: { lifecycle: "commit-ack-unknown" } }]);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transactions`).toHaveLength(1);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_commit_confirmations`).toHaveLength(0);
    expect(() => replayQuiescenceProof(value.run)).toThrow("replay_execution_not_quiescent");
    await expect(withReplayExecutionScope(value.run, async () => undefined)).rejects.toThrow("replay_execution_already_started");
    await value.ledger.closeAdmission(value.run); await value.ledger.fenceWriters(value.run);
    await expect(value.ledger.seal(value.run, {} as never)).rejects.toThrow("replay_execution_not_quiescent");
    expect(await admin`SELECT state FROM pipeline_replay.capacity_runs`).toEqual([{ state: "draining" }]);
  } finally { await value.database.close(); }
});

it("revalidates the prepared initial snapshot at start and refuses an intervening mutation", async () => {
  const value = await prepare(true, undefined, undefined, false);
  try {
    await withReplayDatabaseScope(value.identityPath, () => db.update(crawlCandidates)
      .set({ signals: { lifecycle: "changed-before-start" } }).where(eq(crawlCandidates.id, value.candidate.id)).then(() => undefined));
    await expect(value.ledger.start(value.run)).rejects.toThrow("replay_initial_state_mismatch");
    expect(await admin`SELECT state FROM pipeline_replay.capacity_runs`).toEqual([{ state: "prepared" }]);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_calls`).toHaveLength(0);
  } finally { await value.database.close(); }
});


it("rolls back domain changes, raw facts and packet when a deferred transition fails", async () => {
  const value = await prepare(true, undefined, async bootstrap => {
    await bootstrap.unsafe(`CREATE FUNCTION pipeline_replay.fail_deferred_transition() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
      IF NEW.kind='second_review_hold' THEN RAISE EXCEPTION 'actual_deferred_transition_failed'; END IF; RETURN NEW; END $$`);
    await bootstrap.unsafe(`CREATE TRIGGER fail_deferred_transition BEFORE INSERT ON pipeline_replay.capacity_transitions
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.fail_deferred_transition()`);
  });
  try {
    await withReplayExecutionScope(value.run, () => withReplayDatabaseScope(value.identityPath, () =>
      withReplayFinalScope(value.run, async () => {
        await expect(db.transaction(async tx => {
          await tx.update(crawlCandidates).set({ signals: { lifecycle: "must-rollback" } }).where(eq(crawlCandidates.id, value.candidate.id));
          await recordReplaySecondReviewTransition(tx, { kind: "hold", candidateIds: [value.candidate.id] });
        })).rejects.toThrow("actual_deferred_transition_failed");
      })));
    expect(await admin`SELECT signals FROM crawl_candidates WHERE id=${value.candidate.id}`).toEqual([{ signals: null }]);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_changes`).toHaveLength(0);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transactions`).toHaveLength(0);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind='second_review_hold'`).toHaveLength(0);
    await value.ledger.closeAdmission(value.run); await value.ledger.fenceWriters(value.run);
    await value.ledger.seal(value.run, replayQuiescenceProof(value.run));
    await expect(readSealedReplayArtifact(value.database, value.run.runId)).resolves.toMatchObject({ readiness: { transactions: [] } });
  } finally { await value.database.close(); }
});

it("rejects an active certified run mutation through the same restricted generic guard without its authentic scope", async () => {
  const value = await prepare(true);
  try {
    await expect(withReplayDatabaseScope(value.identityPath, () => db.update(crawlCandidates)
      .set({ signals: { lifecycle: "outside-context" } }).where(eq(crawlCandidates.id, value.candidate.id)).then(() => undefined)))
      .rejects.toMatchObject({ cause: { message: "replay_execution_scope_required" } });
    expect(await admin`SELECT signals FROM crawl_candidates WHERE id=${value.candidate.id}`).toEqual([{ signals: null }]);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_changes`).toHaveLength(0);
    await withReplayExecutionScope(value.run, async () => undefined);
    await value.ledger.closeAdmission(value.run); await value.ledger.fenceWriters(value.run);
    await value.ledger.seal(value.run, replayQuiescenceProof(value.run));
  } finally { await value.database.close(); }
});


it("does not erase native ledger pending work after its database commit succeeds but acknowledgment fails", async () => {
  const value = await prepare(true, undefined, async bootstrap => {
    await bootstrap.unsafe(`CREATE FUNCTION pipeline_replay.fail_native_confirmation() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'actual_native_confirmation_failed'; END $$`);
    await bootstrap.unsafe(`CREATE TRIGGER fail_native_confirmation BEFORE INSERT ON pipeline_replay.capacity_commit_confirmations
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.fail_native_confirmation()`);
  });
  try {
    await expect(withReplayExecutionScope(value.run, async () => {
      await expect(value.ledger.reserve(value.run, { callId: "native-ack-unknown", candidateId: value.candidate.id, firstAttemptId: 99,
        inputHash: value.input.inputHash, sourceRevisionHash: value.input.sourceRevisionHash, stage: "first", provider: "abcllm",
        model: "first", requestHash: reviewHash({ request: "native-ack-unknown" }), tokenUpperBound: 100 }))
        .rejects.toThrow("replay_ledger_operation_failed");
    })).rejects.toThrow("replay_execution_not_quiescent");
    expect(await admin`SELECT state FROM pipeline_replay.capacity_calls`).toEqual([{ state: "reserved" }]);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transactions`).toHaveLength(1);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_commit_confirmations`).toHaveLength(0);
    expect(() => replayQuiescenceProof(value.run)).toThrow("replay_execution_not_quiescent");
    await value.ledger.closeAdmission(value.run);
    await expect(value.ledger.fenceWriters(value.run)).rejects.toThrow("replay_calls_unresolved");
  } finally { await value.database.close(); }
});


it("preserves native ledger DB microsecond bounds and seals a cancelled-before-dispatch call", async () => {
  const value = await prepare(true);
  try {
    await withReplayExecutionScope(value.run, async () => {
      await value.ledger.reserve(value.run, { callId: "native-cancelled", candidateId: value.candidate.id, firstAttemptId: 99,
        inputHash: value.input.inputHash, sourceRevisionHash: value.input.sourceRevisionHash, stage: "first", provider: "abcllm",
        model: "first", requestHash: reviewHash({ request: "native-cancelled" }), tokenUpperBound: 100 });
      await value.ledger.cancelBeforeDispatch(value.run, "native-cancelled");
    });
    const bounds = await admin`SELECT t.recorded_at=e.at AND t.tx_started_at<=t.recorded_at AND t.recorded_at<=c.confirmed_at AS valid
      FROM pipeline_replay.capacity_transactions t JOIN pipeline_replay.capacity_transitions e ON e.run_id=t.run_id AND e.seq=t.seq
      JOIN pipeline_replay.capacity_commit_confirmations c ON c.run_id=t.run_id AND c.tx_key=t.tx_key`;
    expect(bounds).toEqual([{ valid: true }, { valid: true }]);
    await value.ledger.closeAdmission(value.run); await value.ledger.fenceWriters(value.run);
    await value.ledger.seal(value.run, replayQuiescenceProof(value.run));
    await expect(readSealedReplayArtifact(value.database, value.run.runId)).resolves.toMatchObject({
      calls: [{ state: "cancelled_before_dispatch" }], run: { chargedCalls: 1, chargedTokens: 100 } });
  } finally { await value.database.close(); }
});

it("rejects a caller new-review flag contradicted by actual initial published state before recording a run", async () => {
  await expect(prepare(true, async candidateId => {
    await db.update(crawlCandidates).set({ state: "published", publishedSlug: "prior-published" }).where(eq(crawlCandidates.id, candidateId));
  })).rejects.toThrow("replay_review_kind_mismatch");
  expect(await admin`SELECT state,published_slug FROM crawl_candidates`).toEqual([{ state: "published", published_slug: "prior-published" }]);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_runs`).toHaveLength(0);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_calls`).toHaveLength(0);
});
