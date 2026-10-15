import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assertReplayDatabaseScopeIdentity, withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, type CrawlDocument } from "@/lib/db/schema";
import { createReviewInput, reviewHash, reviewPolicyHash, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION,
  type ReviewOutcome } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { runFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";
import { ReplayLedger } from "@/lib/operations/pipeline-replay-ledger";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { withReplayFinalScope } from "@/lib/operations/pipeline-replay-final";
import { withReviewFixtureTransport, type ReviewFixtureCallback } from "@/lib/crawl/review-fixture-transport";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { runJob, type JobContext } from "@/lib/jobs/runner";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

const reference = new Date("2001-11-01T00:00:00.000Z");
const baseSettings: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce", reviewConcurrency: 1,
  firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true,
    voters: [{ provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }], fallbacks: [], sampleRate: 0 } };
const outcome = (decision: ReviewOutcome["decision"]): ReviewOutcome => ({ decision, confidence: 0.99,
  reason: "A deployed task tracker", evidenceIds: ["product"] });
const answer = (decision: ReviewOutcome["decision"]): ReviewFixtureCallback => async () => ({ result: { ok: true,
  outcome: outcome(decision), usage: { inputTokens: 8, outputTokens: 2 } }, receipt: { inputTokens: 8, outputTokens: 2 } });
let admin: postgres.Sql, document: CrawlDocument, fork: CrawlDocument;
let release: (() => Promise<void>) | undefined, serial = 0;

beforeAll(async () => {
  ensureSchema();
  admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  await admin`DELETE FROM crawl_documents WHERE repo LIKE 'first-final/%'`;
  [document, fork] = await db.insert(crawlDocuments).values([false, true].map(isFork => ({
    repo: isFork ? "first-final/fork" : "first-final/app", productUrl: isFork ? "https://fork.final.example" : "https://app.final.example",
    fetchedAt: new Date(+reference - 1_000), pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", homepage: "https://app.final.example", fork: isFork,
      private: false, archived: false, owner: { type: "User" }, stargazers_count: 10,
      pushed_at: new Date(+reference - 10_000).toISOString() },
    pageMeta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create a project and manage tasks in the application.", readmeSample: "An online task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION },
  }))).returning();
});
beforeEach(async () => {
  await admin`TRUNCATE second_reviews, crawl_review_attempts, crawl_candidates, crawl_frontier, jobs RESTART IDENTITY CASCADE`;
});
afterEach(async () => { await release?.(); release = undefined; });
afterAll(async () => { await admin?.end({ timeout: 3 }); });

async function prepare(options: { settings?: CrawlSettings; source?: CrawlDocument; reused?: "same" | "source";
  beforeProvision?: (session: postgres.Sql) => Promise<void> } = {}) {
  const settings = options.settings ?? structuredClone(baseSettings), source = options.source ?? document;
  await db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings } });
  const [candidate] = await db.insert(crawlCandidates).values({ repo: source.repo, productUrl: source.productUrl,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: reference, updatedAt: reference }).returning();
  const input = createReviewInput(candidate, source, settings, { scan: null, observations: [] }, reference);
  const previousSource = options.reused === "source" ? { ...input.source, documentId: source.id + 100 } : input.source;
  if (options.reused) await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: reviewHash(previousSource),
    policyHash: input.policyHash, snapshot: input.snapshot, source: previousSource,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: settings.firstReview!.provider, model: settings.firstReview!.model, attemptNumber: 1,
    outcome: outcome("approve"), validUntil: input.validUntil, completedAt: reference });
  const model = (value: { provider: "abcllm" | "claude-cli" | "grok-cli"; model: string }) => ({ ...value, canonicalModel: canonicalReviewModel(value.model) });
  const manifest: CapacityManifest = { version: 1, runId: `first-final-${++serial}`, revision: "664777d", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: reviewPolicyHash(settings), fullReviewPolicyHash: fullReviewPolicyHash(settings),
    comparisonPolicyHash: comparisonReviewPolicyHash(settings), initialStateHash: reviewHash({ candidate, document: source }),
    models: { first: model(settings.firstReview!), second: settings.secondReview.voters.map(model), fallbacks: [] },
    inputs: [{ candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 4, maxTokens: 400, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 2 } };
  const identity = await getReplayHandlerIdentityPath({ beforeProvision: options.beforeProvision });
  release = identity.release;
  await admin`INSERT INTO jobs (name, requested_version) VALUES ('crawl-agent-review', 1)`;
  return { candidate, input, manifest, settings, identityPath: identity.identityPath, inputs: [{ candidateId: candidate.id, input }] };
}
async function run(value: Awaited<ReturnType<typeof prepare>>, fixture = answer("approve")) {
  return runFixtureReviewReplay({ identityPath: value.identityPath, manifest: value.manifest, inputs: value.inputs,
    jobs: ["crawl-agent-review"], fixture });
}
async function finals() {
  const [table] = await admin`SELECT to_regclass('pipeline_replay.capacity_finals') AS name`;
  return table.name ? admin`SELECT * FROM pipeline_replay.capacity_finals` : [];
}
async function runWithRepeatedWriter(value: Awaited<ReturnType<typeof prepare>>, fixture: ReviewFixtureCallback,
  repeat: (context: JobContext<null>) => Promise<void>) {
  const database = await openVerifiedReplayHandlerDatabase(value.identityPath, {});
  const ledger = new ReplayLedger(database), replay = await ledger.prepare(value.manifest, value.inputs);
  try {
    await ledger.start(replay);
    return await withReplayDatabaseScope(value.identityPath, async () => {
      assertReplayDatabaseScopeIdentity(database);
      return withReviewReplayContext({ referenceTime: reference }, () => withReplayFinalScope(replay, () =>
        withReviewFixtureTransport({ ledger, run: replay, fixture, inputs: value.inputs,
          fullReviewPolicyHash: value.manifest.fullReviewPolicyHash, tokenUpperBound: 100 }, () =>
          runJob<null>("crawl-agent-review", async ctx => {
            const result = await reviewCrawlCandidates(ctx);
            await repeat(ctx);
            return result;
          }, { requestedOnly: true, budgetMs: 110_000 }))));
    });
  } finally { await ledger.drain(replay); await database.close(); }
}

it("records a new model rejection in the actual AI1 writer transaction", async () => {
  const value = await prepare();
  const result = await run(value, answer("reject"));
  expect(result.jobs[0].result.status).toBe("completed");
  expect((await admin`SELECT state FROM crawl_candidates`)[0].state).toBe("rejected");
  expect((await admin`SELECT state FROM pipeline_replay.capacity_calls`)[0].state).toBe("settled");
  expect(await finals()).toHaveLength(1);
});

it("records a gate-free approval after the ordinary publication request", async () => {
  const settings = structuredClone(baseSettings); settings.secondReview.enabled = false;
  const value = await prepare({ settings });
  const result = await run(value);
  expect(result.jobs[0].result.status).toBe("completed");
  expect((await admin`SELECT state, signals FROM crawl_candidates`)[0]).toMatchObject({ state: "approved",
    signals: { agentReviewAttemptId: 1 } });
  expect((await admin`SELECT runs FROM jobs WHERE name = 'crawl-publish'`)[0].runs).toBe(0);
  expect(await finals()).toHaveLength(1);
});

it("keeps a required AI2 approval out of the AI1 final count", async () => {
  const value = await prepare();
  const result = await run(value);
  expect(result.jobs[0].result.status).toBe("completed");
  expect(Number((await admin`SELECT requested_version FROM jobs WHERE name = 'second-review'`)[0].requested_version)).toBeGreaterThan(0);
  expect(await finals()).toHaveLength(0);
});

it.each(["same", "source"] as const)("excludes %s-input successful reuse from new final throughput", async reused => {
  const value = await prepare({ reused }), fixture = vi.fn(answer("approve"));
  const result = await run(value, fixture);
  expect(result.jobs[0].result.status).toBe("completed");
  expect(fixture).not.toHaveBeenCalled();
  if (reused === "source") expect((await admin`SELECT reused_from_attempt_id FROM crawl_review_attempts ORDER BY id DESC LIMIT 1`)[0].reused_from_attempt_id).toBe(1);
  expect(await finals()).toHaveLength(0);
});

it("excludes a hard rule rejection without calling a model", async () => {
  const value = await prepare({ source: fork }), fixture = vi.fn(answer("approve"));
  const result = await run(value, fixture);
  expect(result.jobs[0].result.status).toBe("completed");
  expect(fixture).not.toHaveBeenCalled();
  expect((await admin`SELECT state, provider FROM crawl_review_attempts`)[0]).toEqual({ state: "succeeded", provider: "rules" });
  expect(await finals()).toHaveLength(0);
});

it("excludes observe-mode model results", async () => {
  const settings = structuredClone(baseSettings); settings.reviewMode = "observe";
  const value = await prepare({ settings });
  const result = await run(value, answer("reject"));
  expect(result.jobs[0].result.status).toBe("completed");
  expect((await admin`SELECT state FROM crawl_review_attempts`)[0].state).toBe("succeeded");
  expect((await admin`SELECT state FROM crawl_candidates`)[0].state).toBe("approved");
  expect(await finals()).toHaveLength(0);
});

it("excludes a model hold from final throughput", async () => {
  const value = await prepare();
  const result = await run(value, answer("needs_review"));
  expect(result.jobs[0].result.status).toBe("completed");
  expect((await admin`SELECT state FROM crawl_candidates`)[0].state).toBe("needs_review");
  expect(await finals()).toHaveLength(0);
});

it.each(["human", "input"] as const)("excludes an in-flight %s change", async change => {
  const value = await prepare();
  const result = await run(value, async call => {
    if (change === "human") await admin`UPDATE crawl_candidates SET decided_by = 'admin', state = 'rejected' WHERE id = ${value.candidate.id}`;
    else await admin`UPDATE crawl_candidates SET product_url = 'https://changed.final.example' WHERE id = ${value.candidate.id}`;
    return answer("approve")(call);
  });
  expect(result.jobs[0].result.status).toBe("completed");
  expect((await admin`SELECT state FROM crawl_review_attempts`)[0].state).toBe("superseded");
  expect(await finals()).toHaveLength(0);
  const [transition] = await admin`SELECT payload FROM pipeline_replay.capacity_transitions WHERE kind = 'first_review_superseded'`;
  expect(transition?.payload).toMatchObject({ candidateId: value.candidate.id, firstAttemptId: 1, requests: [] });
});

it("records a model failure without inventing a final decision", async () => {
  const value = await prepare();
  const result = await run(value, async () => ({ result: { ok: false, error: "auth" }, receipt: { inputTokens: 0, outputTokens: 0 } }));
  expect(result.jobs[0].result.status).toBe("completed");
  expect((await admin`SELECT state FROM crawl_review_attempts`)[0].state).toBe("failed");
  expect(await finals()).toHaveLength(0);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'review_write'`).toHaveLength(1);
});

it("rolls back the AI1 result and publication request when final recording fails", async () => {
  const settings = structuredClone(baseSettings); settings.secondReview.enabled = false;
  const value = await prepare({ settings, beforeProvision: async session => {
    await session`CREATE FUNCTION pipeline_replay.fail_first_final() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'first_final_recorder_failure'; END $$`;
    await session`REVOKE ALL ON FUNCTION pipeline_replay.fail_first_final() FROM PUBLIC`;
    await session`CREATE TRIGGER first_final_failure BEFORE INSERT ON pipeline_replay.capacity_finals
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.fail_first_final()`;
  } });
  const result = await run(value);
  expect(result.jobs[0].result.status).toBe("failed");
  expect((await admin`SELECT state, completed_at FROM crawl_review_attempts`)[0]).toEqual({ state: "running", completed_at: null });
  expect((await admin`SELECT state, signals FROM crawl_candidates`)[0]).toEqual({ state: "approved", signals: null });
  expect(await admin`SELECT 1 FROM jobs WHERE name = 'crawl-publish'`).toHaveLength(0);
  expect(await finals()).toHaveLength(0);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind IN ('review_write', 'final')`).toHaveLength(0);
  expect((await admin`SELECT state FROM pipeline_replay.capacity_calls`)[0].state).toBe("settled");
});

it("rolls back prepared writer events when the candidate update fails", async () => {
  const value = await prepare({ beforeProvision: async session => {
    await session`CREATE FUNCTION pipeline_replay.fail_first_result() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'first_final_writer_failure'; END $$`;
    await session`REVOKE ALL ON FUNCTION pipeline_replay.fail_first_result() FROM PUBLIC`;
    await session`CREATE TRIGGER first_result_failure BEFORE UPDATE ON public.crawl_candidates
      FOR EACH ROW WHEN (NEW.signals ? 'agentReviewAttemptId') EXECUTE FUNCTION pipeline_replay.fail_first_result()`;
  } });
  const result = await run(value, answer("reject"));
  expect(result.jobs[0].result.status).toBe("failed");
  expect((await admin`SELECT state, completed_at FROM crawl_review_attempts`)[0]).toEqual({ state: "running", completed_at: null });
  expect((await admin`SELECT state, signals FROM crawl_candidates`)[0]).toEqual({ state: "approved", signals: null });
  expect(await admin`SELECT 1 FROM jobs WHERE name = 'second-review'`).toHaveLength(0);
  expect(await finals()).toHaveLength(0);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind IN ('review_write', 'final')`).toHaveLength(0);
});

it("keeps a duplicate successful AI1 writer and its outbox idempotent", async () => {
  const settings = structuredClone(baseSettings); settings.secondReview.enabled = false;
  const value = await prepare({ settings });
  const result = await runWithRepeatedWriter(value, answer("approve"), async ctx => {
    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, value.candidate.id));
    const [attempt] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id));
    const input = await loadReviewInput(candidate, document, settings);
    expect(await recordAgentReview({ candidate, document, settings, input, attempt, lease: ctx.lease! }))
      .toEqual({ applied: true, state: "succeeded" });
  });
  expect(result.status).toBe("completed");
  expect(await finals()).toHaveLength(1);
  expect(Number((await admin`SELECT requested_version FROM jobs WHERE name = 'crawl-publish'`)[0].requested_version)).toBe(1);
  expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions WHERE kind = 'final'`).toHaveLength(1);
});

it("rejects a forged approval after the actual settled call failed", async () => {
  const settings = structuredClone(baseSettings); settings.secondReview.enabled = false;
  const value = await prepare({ settings });
  const result = await runWithRepeatedWriter(value, async () => ({ result: { ok: false, error: "auth" },
    receipt: { inputTokens: 0, outputTokens: 0 } }), async ctx => {
    // Simulate a caller forging a fresh result for the same owned attempt after its failed call.
    await admin`UPDATE crawl_review_attempts SET state = 'running', error_code = NULL, completed_at = NULL WHERE candidate_id = ${value.candidate.id}`;
    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, value.candidate.id));
    const [attempt] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id));
    const input = await loadReviewInput(candidate, document, settings);
    await expect(recordAgentReview({ candidate, document, settings, input, attempt, lease: ctx.lease!, outcome: outcome("approve") }))
      .rejects.toThrow("replay_final_result_mismatch");
  });
  expect(result.status).toBe("completed");
  expect((await admin`SELECT state, signals FROM crawl_candidates`)[0]).toEqual({ state: "approved", signals: null });
  expect((await admin`SELECT state FROM crawl_review_attempts`)[0].state).toBe("running");
  expect(await admin`SELECT 1 FROM jobs WHERE name = 'crawl-publish'`).toHaveLength(0);
  expect(await finals()).toHaveLength(0);
});
