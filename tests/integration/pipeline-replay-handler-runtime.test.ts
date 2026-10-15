import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, type CrawlDocument } from "@/lib/db/schema";
import { createReviewInput, reviewHash, reviewPolicyHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { fullReviewPolicyHash, comparisonReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { runFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";
import type { ReviewFixtureCallback } from "@/lib/crawl/review-fixture-transport";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { runJob } from "@/lib/jobs/runner";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { getSettings } from "@/lib/crawl/settings";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";

const reference = new Date("2001-11-01T00:00:00.000Z");
const settings: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce", reviewConcurrency: 2,
  firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true,
    voters: [{ provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }],
    fallbacks: [{ provider: "abcllm", model: "qwen3-coder:30b" }], sampleRate: 0 } };
let admin: postgres.Sql, identityPath: string, release: () => Promise<void>;
let document: CrawlDocument, fork: CrawlDocument;
let serial = 0;

beforeAll(async () => {
  ensureSchema();
  await db.delete(crawlDocuments).where(sql`${crawlDocuments.repo} like 'runtime-replay/%'`);
  [document, fork] = await db.insert(crawlDocuments).values([false, true].map(isFork => ({
    repo: isFork ? "runtime-replay/fork" : "runtime-replay/app", productUrl: isFork ? "https://fork.runtime.example" : "https://app.runtime.example",
    fetchedAt: new Date(+reference - 1_000), pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", homepage: "https://app.runtime.example", fork: isFork,
      private: false, archived: false, owner: { type: "User" }, stargazers_count: 10,
      pushed_at: new Date(+reference - 10_000).toISOString() },
    pageMeta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create a project and manage tasks in the application.", readmeSample: "An online task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION },
  }))).returning();
  await db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings } });
  ({ identityPath, release } = await getReplayHandlerIdentityPath());
  admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
});
afterAll(async () => { await admin?.end({ timeout: 3 }); await release?.(); });
beforeEach(async () => {
  await admin`TRUNCATE pipeline_replay.capacity_finals, pipeline_replay.capacity_transitions, pipeline_replay.capacity_calls,
    pipeline_replay.capacity_inputs, pipeline_replay.capacity_runs`;
  await admin`TRUNCATE second_reviews, crawl_review_attempts, crawl_candidates, crawl_frontier, jobs RESTART IDENTITY CASCADE`;
});

async function prepare(source = document) {
  const [candidate] = await db.insert(crawlCandidates).values({ repo: source.repo, productUrl: source.productUrl,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: reference, updatedAt: reference }).returning();
  const input = createReviewInput(candidate, source, settings, { scan: null, observations: [] }, reference);
  await withReplayDatabaseScope(identityPath, () => withReviewReplayContext({ referenceTime: reference }, async () => {
    const [current] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id));
    const [stored] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.id, source.id));
    expect(await loadReviewInput(current, stored, await getSettings())).toEqual(input);
  }));
  const model = (value: { provider: "abcllm" | "claude-cli" | "grok-cli"; model: string }) => ({ ...value, canonicalModel: canonicalReviewModel(value.model) });
  const manifest: CapacityManifest = { version: 1, runId: `actual-handler-${++serial}`, revision: "9601e3b", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: reviewPolicyHash(settings), fullReviewPolicyHash: fullReviewPolicyHash(settings),
    comparisonPolicyHash: comparisonReviewPolicyHash(settings), initialStateHash: reviewHash({ candidate, document: source }),
    models: { first: model(settings.firstReview!), second: settings.secondReview.voters.map(model), fallbacks: settings.secondReview.fallbacks!.map(model) },
    inputs: [{ candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 8, maxTokens: 800, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 4 } };
  await admin`INSERT INTO jobs (name, requested_version) VALUES ('crawl-agent-review', 1)`;
  return { candidate, input, manifest, inputs: [{ candidateId: candidate.id, input }] };
}
const approve: ReviewFixtureCallback = async () => ({ result: { ok: true,
  outcome: { decision: "approve", confidence: 0.99, reason: "A deployed task tracker", evidenceIds: ["product"] },
  usage: { inputTokens: 8, outputTokens: 2 } }, receipt: { inputTokens: 8, outputTokens: 2 } });
async function run(value: Awaited<ReturnType<typeof prepare>>, fixture: ReviewFixtureCallback = approve) {
  return runFixtureReviewReplay({ identityPath, manifest: value.manifest, inputs: value.inputs, fixture });
}

it("executes actual AI1 and AI2 with settled calls and preserves publication as an isolated request", async () => {
  const value = await prepare();
  const productsBefore = await admin`SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY id)::text, '[]')) AS digest FROM products p`;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("external_fetch_canary"); });
  const globalDb = globalThis as { db?: unknown; readDb?: unknown; pgClient?: unknown };
  const original = { db: globalDb.db, readDb: globalDb.readDb, pgClient: globalDb.pgClient };
  const poison = new Proxy({}, { get() { throw new Error("global_database_canary"); } });
  Object.assign(globalDb, { db: poison, readDb: poison, pgClient: poison });
  const calls: Array<{ stage: string; firstAttemptId: number | null; input: ReviewInput }> = [];
  try {
    const result = await run(value, async call => {
      calls.push({ stage: call.request.stage, firstAttemptId: call.request.firstAttemptId, input: call.input });
      const [stored] = await admin`SELECT state FROM pipeline_replay.capacity_calls WHERE run_id = ${value.manifest.runId} AND call_id = ${call.request.callId}`;
      expect(stored.state).toBe("in_flight");
      return approve(call);
    });
    expect(result.jobs.map(row => row.result.status)).toEqual(["completed", "completed"]);
    expect(result.diagnostics).toMatchObject({ state: "draining", activeCalls: 0, chargedCalls: 2,
      authenticity: "unverified", finalThroughput: null });
    expect(fetch).not.toHaveBeenCalled();
  } finally { Object.assign(globalDb, original); fetch.mockRestore(); }
  expect(calls.map(row => row.stage)).toEqual(["first", "second"]);
  expect(calls[0].firstAttemptId).toBe(calls[1].firstAttemptId);
  expect(calls[1].input.inputHash).toBe(value.input.inputHash);
  const [attempt] = await admin`SELECT * FROM crawl_review_attempts`;
  const [second] = await admin`SELECT * FROM second_reviews`;
  expect(attempt).toMatchObject({ state: "succeeded", model: settings.firstReview!.model });
  expect(second).toMatchObject({ status: "agreed", trigger: "ai_approved", first_attempt_id: attempt.id,
    second_decision: "approve", model: settings.secondReview.voters[0].model });
  const [secondCall] = await admin`SELECT * FROM pipeline_replay.capacity_calls WHERE stage = 'second'`;
  expect(secondCall).toMatchObject({ second_review_id: String(second.id), generation_key: second.generation_key, vote: String(second.id) });
  const [publication] = await admin`SELECT * FROM jobs WHERE name = 'crawl-publish'`;
  expect(Number(publication.requested_version)).toBeGreaterThan(0);
  expect(publication.runs).toBe(0);
  expect(publication.lease_token).toBeNull();
  expect(await admin`SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY id)::text, '[]')) AS digest FROM products p`).toEqual(productsBefore);
});

it("keeps an actual disagreement in human review and never requests publication", async () => {
  const value = await prepare();
  const result = await run(value, async call => call.request.stage === "first" ? approve(call) : {
    result: { ok: true, outcome: { decision: "reject", confidence: 0.99, reason: "Human confirmation required", evidenceIds: ["product"] }, usage: {} },
    receipt: { inputTokens: 8, outputTokens: 2 },
  });
  expect(result.jobs.every(row => row.result.status === "completed")).toBe(true);
  const [candidate] = await admin`SELECT state, reason FROM crawl_candidates WHERE id = ${value.candidate.id}`;
  expect(candidate).toEqual({ state: "needs_review", reason: "second_review_split" });
  expect((await admin`SELECT status FROM second_reviews`)[0].status).toBe("needs_human");
  expect(await admin`SELECT 1 FROM jobs WHERE name = 'crawl-publish'`).toHaveLength(0);
});

it("preserves actual first-review retry backoff on the wall clock without inventing a result", async () => {
  const value = await prepare(), startedAt = Date.now();
  const result = await run(value, async () => ({ result: { ok: false, error: "auth" }, receipt: { inputTokens: 0, outputTokens: 0 } }));
  expect(result.diagnostics).toMatchObject({ chargedCalls: 1, activeCalls: 0 });
  const [attempt] = await admin`SELECT state, error_code, extract(epoch FROM retry_after AT TIME ZONE 'UTC') * 1000 AS retry_ms, outcome FROM crawl_review_attempts`;
  expect(attempt).toMatchObject({ state: "failed", error_code: "auth", outcome: null });
  expect(Number(attempt.retry_ms)).toBeGreaterThan(startedAt + 50_000);
  expect(await admin`SELECT 1 FROM second_reviews`).toHaveLength(0);
  expect(await admin`SELECT 1 FROM jobs WHERE name = 'crawl-publish'`).toHaveLength(0);
});

it("runs the existing hard rule rejection without spending a fixture/model call", async () => {
  const value = await prepare(fork), fixture = vi.fn(approve);
  const result = await run(value, fixture);
  expect(result.diagnostics).toMatchObject({ chargedCalls: 0, activeCalls: 0 });
  expect(fixture).not.toHaveBeenCalled();
  expect((await admin`SELECT state, provider FROM crawl_review_attempts`)[0]).toEqual({ state: "succeeded", provider: "rules" });
  expect((await admin`SELECT state FROM crawl_candidates WHERE id = ${value.candidate.id}`)[0].state).toBe("rejected");
});

it("records actual primary failure and independent fallback with the same original vote slot", async () => {
  const value = await prepare();
  const stages: string[] = [];
  const result = await runFixtureReviewReplay({ identityPath, manifest: value.manifest, inputs: value.inputs,
    jobs: ["crawl-agent-review", "second-review", "second-review"], fixture: async call => {
      stages.push(`${call.request.stage}:${call.request.model}`);
      if (call.request.stage === "second" && call.request.model === settings.secondReview.voters[0].model)
        return { result: { ok: false, error: "model_unavailable" }, receipt: { inputTokens: 0, outputTokens: 0 } };
      return approve(call);
    } });
  expect(result.jobs.map(row => row.result.status)).toEqual(["completed", "completed", "completed"]);
  expect(result.diagnostics).toMatchObject({ chargedCalls: 3, activeCalls: 0 });
  expect(stages).toEqual([`first:${settings.firstReview!.model}`, `second:${settings.secondReview.voters[0].model}`, "second:qwen3-coder:30b"]);
  const [root, fallback] = await admin`SELECT * FROM second_reviews ORDER BY id`;
  expect(root).toMatchObject({ status: "resolved", resolution: "fallback", error_code: "model_unavailable", failure_count: 1 });
  expect(fallback).toMatchObject({ status: "agreed", fallback_for_id: root.id, generation_key: root.generation_key });
  const calls = await admin`SELECT second_review_id, generation_key, vote FROM pipeline_replay.capacity_calls WHERE stage = 'second' ORDER BY second_review_id`;
  expect(calls).toEqual([{ second_review_id: String(root.id), generation_key: root.generation_key, vote: String(root.id) },
    { second_review_id: String(fallback.id), generation_key: root.generation_key, vote: String(root.id) }]);
  expect((await admin`SELECT runs FROM jobs WHERE name = 'crawl-publish'`)[0].runs).toBe(0);
});

it("retains source refresh in the ordinary outbox while continuing ready review work", async () => {
  const value = await prepare();
  await admin`INSERT INTO crawl_candidates (repo, product_url, state, reason, decided_by, judged_at)
    VALUES ('runtime-replay/missing-source', 'https://missing.runtime.example', 'approved', 'passed', 'auto', ${reference})`;
  const result = await run(value);
  expect(result.jobs.map(row => row.result.status)).toEqual(["completed", "completed"]);
  expect((await admin`SELECT repo, state FROM crawl_frontier WHERE repo = 'runtime-replay/missing-source'`)[0])
    .toEqual({ repo: "runtime-replay/missing-source", state: "pending" });
  const [fetch] = await admin`SELECT requested_version, runs, lease_token FROM jobs WHERE name = 'crawl-fetch'`;
  expect(Number(fetch.requested_version)).toBeGreaterThan(0);
  expect(fetch.runs).toBe(0); expect(fetch.lease_token).toBeNull();
});

it("rejects fetch, rule-judge and publication jobs before a real DB claim", async () => {
  const handler = vi.fn(async () => ({ done: true }));
  await withReplayDatabaseScope(identityPath, async () => {
    for (const name of ["crawl-fetch", "crawl-judge", "crawl-publish"])
      await expect(runJob(name, handler)).rejects.toThrow("replay_job_not_allowed");
  });
  expect(handler).not.toHaveBeenCalled();
  expect(await admin`SELECT 1 FROM jobs`).toHaveLength(0);
});

it("drains a never-returning fixture at the real run deadline and leaves uncertainty visible", async () => {
  const value = await prepare();
  value.manifest.limits.maxDurationMs = 2_000;
  value.manifest.endedAt = new Date(+reference + 1_000).toISOString();
  const fixture = vi.fn<ReviewFixtureCallback>(async () => new Promise(() => {}));
  const result = await run(value, fixture);
  expect(fixture).toHaveBeenCalledTimes(1);
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].result.status).toBe("failed");
  expect(result.diagnostics).toMatchObject({ state: "draining", chargedCalls: 1, activeCalls: 1,
    authenticity: "unverified", finalThroughput: null });
  expect((await admin`SELECT state FROM pipeline_replay.capacity_calls`)[0].state).toBe("indeterminate");
  expect((await admin`SELECT locked_at, lease_token FROM jobs WHERE name = 'crawl-agent-review'`)[0])
    .toEqual({ locked_at: null, lease_token: null });
  const [connections] = await admin`SELECT count(*)::int AS count FROM pg_stat_activity a
    JOIN pg_roles r ON r.oid = a.usesysid WHERE r.rolname LIKE 'nomorevibe_replay_%'`;
  expect(connections.count).toBe(0);
});
