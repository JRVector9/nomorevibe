import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, type CrawlDocument } from "@/lib/db/schema";
import { createReviewInput, reviewHash, reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { fullReviewPolicyHash, comparisonReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { runFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";
import type { ReviewFixtureCallback } from "@/lib/crawl/review-fixture-transport";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
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
let document: CrawlDocument, writerFailure: CrawlDocument;
let serial = 0;

beforeAll(async () => {
  ensureSchema();
  await db.delete(crawlDocuments).where(sql`${crawlDocuments.repo} like 'atomic-replay/%'`);
  [document, , writerFailure] = await db.insert(crawlDocuments).values([false, true, false].map((isFork, index) => ({
    repo: index === 2 ? "atomic-replay/writer-failure" : isFork ? "atomic-replay/fork" : "atomic-replay/app", productUrl: isFork ? "https://fork.runtime.example" : "https://app.runtime.example",
    fetchedAt: new Date(+reference - 1_000), pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", homepage: "https://app.runtime.example", fork: isFork,
      private: false, archived: false, owner: { type: "User" }, stargazers_count: 10,
      pushed_at: new Date(+reference - 10_000).toISOString() },
    pageMeta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create a project and manage tasks in the application.", readmeSample: "An online task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION },
  }))).returning();
  await db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings } });
  ({ identityPath, release } = await getReplayHandlerIdentityPath({ beforeProvision: async session => {
    await session.unsafe(`CREATE FUNCTION pipeline_replay.test_reject_final() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN IF NEW.kind = 'final' AND NEW.run_id LIKE '%-fail' THEN
        RAISE EXCEPTION 'test_final_insert_failure'; END IF; RETURN NEW; END $$`);
    await session.unsafe(`CREATE TRIGGER test_reject_final BEFORE INSERT ON pipeline_replay.capacity_transitions
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.test_reject_final()`);
    await session.unsafe(`CREATE FUNCTION pipeline_replay.test_reject_candidate_write() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN IF NEW.repo = 'atomic-replay/writer-failure' AND NEW.signals ? 'agentReviewAttemptId' THEN
        RAISE EXCEPTION 'test_candidate_writer_failure'; END IF; RETURN NEW; END $$`);
    await session.unsafe(`CREATE TRIGGER test_reject_candidate_write BEFORE UPDATE ON public.crawl_candidates
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.test_reject_candidate_write()`);
  } }));
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
  const manifest: CapacityManifest = { version: 1, runId: `atomic-final-${++serial}`, revision: "9601e3b", mode: "fixtures", cacheMode: "cold",
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

async function finalCount(runId: string): Promise<number> {
  const [row] = await admin`SELECT count(*)::int AS count FROM pipeline_replay.capacity_transitions
    WHERE run_id = ${runId} AND kind = 'final'`;
  return row.count;
}

it("records exactly one final in the actual last mandatory review writer transaction", async () => {
  const value = await prepare();
  const result = await run(value);
  expect(result.jobs.map(job => job.result.status)).toEqual(["completed", "completed"]);
  expect(await finalCount(value.manifest.runId)).toBe(1);
  const [row] = await admin`SELECT * FROM pipeline_replay.capacity_finals WHERE run_id = ${value.manifest.runId}`;
  expect(Number(row.candidate_id)).toBe(value.candidate.id);
  expect(row.input_hash).toBe(value.input.inputHash);
  expect(row.source_revision_hash).toBe(value.input.sourceRevisionHash);
  expect(row.policy_hash).toBe(value.input.policyHash);
  expect(row.decision).toBe("approve");
  const writes = await admin`SELECT payload FROM pipeline_replay.capacity_transitions
    WHERE run_id = ${value.manifest.runId} AND kind = 'review_write' ORDER BY seq`;
  expect(writes.map(event => event.payload.requests)).toEqual([
    [{ job: "second-review", requestedVersion: 1 }],
    [{ job: "crawl-publish", requestedVersion: 1 }],
  ]);
});

it("rolls back the AI2 result and publication request when final event insertion fails", async () => {
  const value = await prepare();
  value.manifest.runId += "-fail";
  const result = await run(value);
  expect(result.jobs.map(job => job.result.status)).toEqual(["completed", "failed"]);
  const [second] = await admin`SELECT status, reviewed_at, second_decision FROM second_reviews`;
  expect(second).toMatchObject({ status: "pending", reviewed_at: null, second_decision: null });
  expect(await admin`SELECT name FROM jobs WHERE name = 'crawl-publish'`).toHaveLength(0);
  expect(await finalCount(value.manifest.runId)).toBe(0);
  expect(await admin`SELECT * FROM pipeline_replay.capacity_finals WHERE run_id = ${value.manifest.runId}`).toHaveLength(0);
  // The external call was already settled before the writer started and remains charged.
  expect(await admin`SELECT call_id FROM pipeline_replay.capacity_calls WHERE run_id = ${value.manifest.runId} AND state = 'settled'`).toHaveLength(2);
});

it("keeps result and writer events absent when an actual candidate writer fails", async () => {
  const value = await prepare(writerFailure);
  const result = await runFixtureReviewReplay({ identityPath, manifest: value.manifest, inputs: value.inputs,
    jobs: ["crawl-agent-review"], fixture: approve });
  expect(result.jobs.map(job => job.result.status)).toEqual(["failed"]);
  const [attempt] = await admin`SELECT state, outcome, completed_at FROM crawl_review_attempts`;
  expect(attempt).toMatchObject({ state: "running", outcome: null, completed_at: null });
  const [candidate] = await admin`SELECT signals FROM crawl_candidates WHERE id = ${value.candidate.id}`;
  expect(candidate.signals?.agentReviewAttemptId).toBeUndefined();
  expect(await admin`SELECT * FROM pipeline_replay.capacity_transitions
    WHERE run_id = ${value.manifest.runId} AND kind IN ('review_write','final')`).toHaveLength(0);
  expect(await admin`SELECT * FROM pipeline_replay.capacity_finals WHERE run_id = ${value.manifest.runId}`).toHaveLength(0);
  expect(await admin`SELECT call_id FROM pipeline_replay.capacity_calls WHERE state = 'settled'`).toHaveLength(1);
});
