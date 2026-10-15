import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings } from "@/lib/db/schema";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { ReplayLedger } from "@/lib/operations/pipeline-replay-ledger";
import { runCertifiedFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";
import { replayArtifactFromVerified, loadVerifiedReplayArtifact, reportReplayArtifact, replayArtifactContentHash } from "@/lib/operations/pipeline-replay-artifact";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { withReplayExecutionScope, replayQuiescenceProof } from "@/lib/operations/pipeline-replay-execution";
import { runJob } from "@/lib/jobs/runner";
import { sql } from "drizzle-orm";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

const reference = new Date("2001-11-01T00:00:00.000Z");
let admin: postgres.Sql, release: (() => Promise<void>) | undefined, serial = 0;
beforeAll(() => { ensureSchema(); admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} }); });
beforeEach(async () => {
  await resetTables();
  await admin`TRUNCATE second_reviews, crawl_review_attempts, crawl_candidates, crawl_documents,
    crawl_frontier, jobs, crawl_settings, operations_observations RESTART IDENTITY CASCADE`;
});
afterEach(async () => {
  await release?.(); release = undefined;
  await admin`UPDATE pipeline_stage_modes SET mode='legacy', draining_from=NULL, epoch=1, writer_contract_version=0`;
});
afterAll(async () => { await admin?.end({ timeout: 3 }); });

async function prepare(stageMode?: "items" | "draining") {
  const settings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce" as const,
    firstReview: { provider: "abcllm" as const, model: "fixture-first" },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm" as const, model: "fixture-second" }], fallbacks: [], sampleRate: 0 } };
  const [candidate] = await db.insert(crawlCandidates).values({ repo: "coverage-runtime/app", productUrl: "https://coverage-runtime.example",
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: reference, updatedAt: reference }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo: candidate.repo, productUrl: candidate.productUrl,
    fetchedAt: new Date(+reference - 1_000), pageStatus: 200,
    repoMeta: { description: "An online task tracker", homepage: candidate.productUrl, fork: false, private: false, archived: false,
      owner: { type: "User" }, stargazers_count: 10, pushed_at: new Date(+reference - 10_000).toISOString() },
    pageMeta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create projects and manage tasks in the application.", readmeSample: "An online task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  await db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings } });
  await admin`INSERT INTO jobs (name, requested_version) VALUES ('crawl-agent-review', 1)`;
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] }, reference);
  const model = (value: { provider: "abcllm"; model: string }) => ({ ...value, canonicalModel: canonicalReviewModel(value.model) });
  const manifest: CapacityManifest = { version: 1, runId: `coverage-runtime-${++serial}`, revision: "4af0589", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: input.policyHash, fullReviewPolicyHash: fullReviewPolicyHash(settings), comparisonPolicyHash: comparisonReviewPolicyHash(settings),
    initialStateHash: reviewHash({ candidate, document }), models: { first: model(settings.firstReview), second: settings.secondReview.voters.map(model), fallbacks: [] },
    inputs: [{ candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 8, maxTokens: 800, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 2 } };
  if (stageMode) await admin`UPDATE pipeline_stage_modes SET mode=${stageMode},
    draining_from=${stageMode === "draining" ? "legacy" : null}, writer_contract_version=1 WHERE stage='ai1'`;
  const owned = await getReplayHandlerIdentityPath(); release = owned.release;
  const database = await openVerifiedReplayHandlerDatabase(owned.identityPath, {});
  const inputs = [{ candidateId: candidate.id, input }];
  try { manifest.initialStateHash = (await new ReplayLedger(database).previewInitialState(manifest, inputs)).initialStateHash; }
  finally { await database.close(); }
  return { ...owned, manifest, inputs, candidate };
}

it.each(["items", "draining"] as const)("rejects untracked %s stage state before certified execution", async mode => {
  const value = await prepare(mode);
  const fixture = vi.fn();
  await expect(runCertifiedFixtureReviewReplay({ ...value, fixture })).rejects.toThrow("unsupported_replay_stage_state");
  expect(fixture).not.toHaveBeenCalled();
  const [runs] = await admin`SELECT count(*)::int AS count FROM pipeline_replay.capacity_runs`;
  expect(runs.count).toBe(0);
});

it("seals actual two-stage fixture work only after all writers finish and authenticates the complete DB readback", async () => {
  const value = await prepare();
  const signal = AbortSignal.timeout(30_000);
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external_fetch_canary"));
  let result: Awaited<ReturnType<typeof runCertifiedFixtureReviewReplay>>;
  try {
    result = await runCertifiedFixtureReviewReplay({ ...value, signal, fixture: async () => ({ result: { ok: true,
      outcome: { decision: "approve", confidence: .99, reason: "An online task tracker", evidenceIds: ["product"] },
      usage: { inputTokens: 8, outputTokens: 2 } }, receipt: { inputTokens: 8, outputTokens: 2 } }) });
    expect(external).not.toHaveBeenCalled();
  } finally { external.mockRestore(); }
  expect(result!.jobs.map(row => row.result.status)).toEqual(["completed", "completed"]);
  expect(result!.diagnostics).toMatchObject({ authenticity: "verified", evidence: "sealed_replay_ledger", finalCandidates: 1, mode: "fixtures" });
  const artifact = replayArtifactFromVerified(result!.artifact);
  expect(artifact.run.state).toBe("sealed");
  expect(artifact.calls).toHaveLength(2);
  expect(artifact.finals).toHaveLength(1);
  expect(artifact.readiness.transactions.length).toBeGreaterThan(0);
  expect(artifact.readiness.transactions.every(row => row.confirmedAt !== null)).toBe(true);
  expect(reportReplayArtifact(artifact).authenticity).toBe("unverified");
  const [publication] = await admin`SELECT runs, lease_token FROM jobs WHERE name = 'crawl-publish'`;
  expect(publication).toEqual({ runs: 0, lease_token: null });
  const before = await admin`SELECT count(*) AS count FROM pipeline_replay.capacity_changes`;
  await expect(withReplayDatabaseScope(value.identityPath, () => db.execute(sql`UPDATE jobs SET runs = runs + 1`)))
    .rejects.toMatchObject({ cause: { message: "replay_execution_scope_required" } });
  expect(await admin`SELECT count(*) AS count FROM pipeline_replay.capacity_changes`).toEqual(before);
  const database = await openVerifiedReplayHandlerDatabase(value.identityPath, {});
  try {
    const changed = structuredClone(artifact); changed.run.epoch++;
    const { seal: ignored, ...content } = changed; void ignored;
    changed.seal.contentHash = replayArtifactContentHash(content);
    await expect(loadVerifiedReplayArtifact(database, value.manifest.runId, changed)).rejects.toThrow("replay_artifact_database_mismatch");
  } finally { await database.close(); }
  const directory = await mkdtemp(join(tmpdir(), "replay-coverage-export-")), output = join(directory, "sealed.json");
  const cli = async (...args: string[]) => {
    const pending = promisify(execFile)(process.execPath,
      ["--import", "tsx", "scripts/measure-pipeline-replay.ts", ...args],
      { maxBuffer: 2 * 1024 * 1024, timeout: 10_000, signal });
    // Abort can reject before the child closes its DB sockets. Teardown must wait.
    const closed = new Promise<void>(resolve => pending.child.once("close", () => resolve()));
    try { return await pending; } finally { await closed; }
  };
  try {
    expect(JSON.parse((await cli("export", value.identityPath, value.manifest.runId, output)).stdout).exported).toBe(true);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(output, "utf8");
    expect(JSON.parse(bytes)).toEqual(artifact);
    expect(JSON.parse((await cli("report", output)).stdout).authenticity).toBe("unverified");
    expect(JSON.parse((await cli("verify", value.identityPath, value.manifest.runId)).stdout).authenticity).toBe("verified");
    const comparison = JSON.parse((await cli("compare-db", value.identityPath, value.manifest.runId, value.identityPath, value.manifest.runId)).stdout);
    expect(comparison.performance).toBe("incomplete");
    expect(comparison.reasons).toContain("fixture_not_model_throughput");
    await expect(cli("export", value.identityPath, value.manifest.runId, output)).rejects.toMatchObject({
      code: 1, killed: false, signal: null, stderr: "capacity_operation_failed\n",
    });
    expect(await readFile(output, "utf8")).toBe(bytes);
  } finally { await rm(directory, { recursive: true }); }
}, 45_000);

it("rejects a caller initial-state digest before any review call or durable run exists", async () => {
  const value = await prepare(), fixture = vi.fn();
  value.manifest.initialStateHash = "e".repeat(64);
  await expect(runCertifiedFixtureReviewReplay({ ...value, fixture })).rejects.toThrow("replay_initial_state_mismatch");
  expect(fixture).not.toHaveBeenCalled();
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_runs`).toHaveLength(0);
});

it("rejects a new runJob tick after admission closes while allowing an existing writer to drain", async () => {
  const value = await prepare(), database = await openVerifiedReplayHandlerDatabase(value.identityPath, {});
  const ledger = new ReplayLedger(database), handler = vi.fn(async () => ({ done: true }));
  const run = await ledger.prepareCertified(value.manifest, value.inputs,
    { runner: { jobs: ["crawl-agent-review"], budgetMs: 110_000 }, quality: null });
  try {
    await ledger.start(run);
    await withReplayExecutionScope(run, () => withReplayDatabaseScope(value.identityPath, async () => {
      await ledger.closeAdmission(run);
      await expect(runJob("crawl-agent-review", handler, { requestedOnly: true })).rejects.toThrow("replay_job_admission_closed");
      expect(handler).not.toHaveBeenCalled();
      await db.execute(sql`UPDATE crawl_candidates SET signals = '{"draining":true}'::jsonb WHERE id=${value.candidate.id}`);
    }));
    const [job] = await admin`SELECT runs,lease_token,processed_version FROM jobs WHERE name='crawl-agent-review'`;
    expect(job).toEqual({ runs: 0, lease_token: null, processed_version: "0" });
    await ledger.fenceWriters(run); await ledger.seal(run, replayQuiescenceProof(run));
  } finally { await database.close(); }
});

it("waits for the real runJob heartbeat commit before issuing quiescence and rejects its late descendants", async () => {
  const value = await prepare(), database = await openVerifiedReplayHandlerDatabase(value.identityPath, {});
  const ledger = new ReplayLedger(database), blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  const run = await ledger.prepareCertified(value.manifest, value.inputs,
    { runner: { jobs: ["crawl-agent-review"], budgetMs: 110_000 }, quality: null });
  await ledger.start(run);
  let entered!: () => void, resumeHandler!: () => void, unlock!: () => void, locked!: () => void, releaseLate!: () => void;
  const handlerEntered = new Promise<void>(resolve => { entered = resolve; });
  const handlerWait = new Promise<void>(resolve => { resumeHandler = resolve; });
  const lockWait = new Promise<void>(resolve => { unlock = resolve; });
  const lockEntered = new Promise<void>(resolve => { locked = resolve; });
  const lateWait = new Promise<void>(resolve => { releaseLate = resolve; });
  let completed = false, late!: Promise<unknown>, lock: Promise<unknown> | undefined;
  const execution = withReplayExecutionScope(run, () => withReplayDatabaseScope(value.identityPath, () =>
    runJob("crawl-agent-review", async () => {
      late = lateWait.then(() => db.execute(sql`UPDATE jobs SET runs = runs + 1 WHERE name = 'crawl-agent-review'`));
      void late.catch(() => {});
      entered(); await handlerWait; return { done: true };
    }, { requestedOnly: true, budgetMs: 110_000 })));
  void execution.catch(() => {});
  void execution.then(() => { completed = true; }, () => { completed = true; });
  try {
    await handlerEntered;
    lock = blocker.begin(async tx => {
      await tx`SELECT name FROM jobs WHERE name = 'crawl-agent-review' FOR UPDATE`;
      locked(); await lockWait;
    });
    await lockEntered;
    await vi.waitFor(async () => {
      const [waiting] = await admin`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename=${database.identity.roleName}
        AND wait_event_type='Lock' AND query LIKE '%worker_seen_at%') AS yes`;
      expect(waiting.yes).toBe(true);
    }, { timeout: 18_000, interval: 20 });
    resumeHandler();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(completed).toBe(false);
    expect(() => replayQuiescenceProof(run)).toThrow("replay_execution_not_quiescent");
    unlock(); await lock;
    expect(await execution).toMatchObject({ status: "completed" });
    await ledger.drain(run); await ledger.fenceWriters(run); await ledger.seal(run, replayQuiescenceProof(run));
    const [heartbeat] = await admin`SELECT count(*)::int AS count FROM pipeline_replay.capacity_changes
      WHERE run_id=${run.runId} AND table_name='jobs' AND operation='UPDATE'
        AND new_row->>'worker_seen_at' IS NOT NULL AND old_row->>'worker_seen_at' IS NULL`;
    expect(heartbeat.count).toBe(1);
    const before = await admin`SELECT count(*) AS count FROM pipeline_replay.capacity_changes`;
    releaseLate();
    await expect(late).rejects.toThrow("replay_database_scope_closed");
    expect(await admin`SELECT count(*) AS count FROM pipeline_replay.capacity_changes`).toEqual(before);
  } finally {
    resumeHandler(); unlock(); releaseLate();
    await Promise.allSettled([execution, ...(lock ? [lock] : []), ...(late ? [late] : [])]);
    await blocker.end({ timeout: 3 }); await database.close();
  }
}, 35_000);
