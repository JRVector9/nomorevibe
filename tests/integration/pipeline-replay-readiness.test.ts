import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, agentRepositoryScans, type CrawlCandidate, type CrawlDocument } from "@/lib/db/schema";
import { createReviewInput, reviewHash, reviewPolicyHash, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { reviewCandidatePredicate, listReviewCandidates, loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { findRepositoryProduct } from "@/lib/domain/products/repository-identity";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { captureReplayReadinessProjection, deriveReplayReadiness, readinessProjectionHashes, applyReplayChanges,
  type ReplayInitialReadinessSnapshot, type ReplayReadinessChange } from "@/lib/operations/pipeline-replay-readiness";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { getReplayIdentityPath } from "./replay-setup";
import { runJob } from "@/lib/jobs/runner";

const reference = new Date("2001-11-01T00:00:00.000Z");
const settings: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce", reviewConcurrency: 1,
  firstReview: { provider: "abcllm", model: "model-one" }, secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: false } };
let admin: postgres.Sql, release: (() => Promise<void>) | undefined;
let candidates: CrawlCandidate[], documents: CrawlDocument[], inputs: Array<{candidateId: number; input: ReviewInput}>;
let manifest: CapacityManifest;
const frozen = () => inputs.map(({candidateId, input}) => {
  const serialized = JSON.parse(JSON.stringify(input));
  return { candidateId, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    frozen: serialized, frozenHash: reviewHash(serialized) };
});
async function snapshot(): Promise<ReplayInitialReadinessSnapshot> {
  return admin.begin(async tx => captureReplayReadinessProjection(tx, manifest, frozen())) as Promise<ReplayInitialReadinessSnapshot>;
}
beforeAll(async () => {
  ensureSchema();
  admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
  await resetTables();
  await admin`TRUNCATE second_reviews, crawl_review_attempts, crawl_candidates, crawl_documents,
    crawl_frontier, jobs, crawl_settings, operations_observations RESTART IDENTITY CASCADE`;
  await db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({target: crawlSettings.id, set: { values: settings }});
  documents = await db.insert(crawlDocuments).values(Array.from({length: 101}, (_, i) => ({ repo: `readiness/app-${i}`,
    productUrl: `https://ready-${i}.example`, fetchedAt: new Date(+reference - 1000), pageStatus: 200,
    repoMeta: {description: "A deployed task tracker", homepage: `https://ready-${i}.example`, fork: false, private: false,
      archived: false, owner: {type: "User"}, stargazers_count: 10},
    pageMeta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create a project and manage tasks in the application.", readmeSample: "An online task tracker", readmeSampleVersion: README_SAMPLE_VERSION }
  }))).returning();
  candidates = await db.insert(crawlCandidates).values(documents.map(document => ({repo: document.repo, productUrl: document.productUrl,
    state: "approved" as const, reason: "passed" as const, decidedBy: "auto" as const, judgedAt: reference, updatedAt: reference}))).returning();
  await admin`INSERT INTO jobs (name,requested_version) VALUES ('crawl-agent-review',1)`;
  inputs = candidates.map((candidate, i) => ({ candidateId: candidate.id,
    input: createReviewInput(candidate, documents[i], settings, {scan: null, observations: []}, reference) }));
  const identity = { ...settings.firstReview!, canonicalModel: canonicalReviewModel(settings.firstReview!.model) };
  manifest = {version: 1, runId: "readiness-101", revision: "4af0589", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: reviewPolicyHash(settings), fullReviewPolicyHash: fullReviewPolicyHash(settings), comparisonPolicyHash: comparisonReviewPolicyHash(settings),
    initialStateHash: "0".repeat(64), models: {first: identity, second: [], fallbacks: []},
    inputs: inputs.map(({candidateId, input}) => ({candidateId, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false})),
    limits: {maxCalls: 200, maxTokens: 20_000, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 1}};
  const owned = await getReplayIdentityPath(); release = owned.release;
  await admin.unsafe(await readFile("scripts/sql/pipeline-replay-ledger.sql", "utf8"));
});
afterAll(async () => { await admin?.end({timeout: 3}); await release?.(); });

it("captures the uncapped 101-input universe and agrees with the actual shared SQL predicate", async () => {
  const initial = await snapshot();
  const selected = await withReviewReplayContext({referenceTime: reference}, async () => ({
    uncapped: await db.select({id: crawlCandidates.id}).from(crawlCandidates).where(reviewCandidatePredicate(settings, {readyOnly: true})),
    limited: await listReviewCandidates(settings, 100),
  }));
  expect(selected.limited).toHaveLength(100);
  expect(initial.projection.universe).toHaveLength(101);
  const actual = deriveReplayReadiness(initial.projection, initial.capturedAt);
  expect(actual.first.eligible).toBe(selected.uncapped.length);
  expect(actual.first.modelReady).toBe(101);
  expect(actual.work.some(row => row.candidateId === candidates[100].id && row.modelReady)).toBe(true);
  expect(initial.initialStateHash).toBe(readinessProjectionHashes(initial.projection, initial.capturedAt).initialStateHash);
});

it("distinguishes human, same-source success, semantic reuse, retry, running and exhausted actual rows", async () => {
  const [clock] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`;
  const attempt = (index: number, values: Record<string, unknown> = {}) => {
    const input = inputs[index].input;
    return {candidateId: candidates[index].id, kind: "automatic" as const, state: "failed" as const,
      inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, snapshot: input.snapshot,
      source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
      provider: "abcllm", model: "model-one", attemptNumber: 1, validUntil: input.validUntil, ...values};
  };
  await db.update(crawlCandidates).set({decidedBy: "admin"}).where(eq(crawlCandidates.id, candidates[0].id));
  const oldSource = {...inputs[2].input.source, documentId: documents[2].id + 1000};
  await db.insert(crawlReviewAttempts).values([
    attempt(1, {state: "succeeded", outcome: {decision: "approve", reason: "actual approval", evidenceIds: ["product"]}}),
    attempt(2, {state: "succeeded", source: oldSource, sourceRevisionHash: reviewHash(oldSource), outcome: {decision: "approve", reason: "semantic reuse", evidenceIds: ["product"]}}),
    attempt(3, {retryAfter: new Date(Date.now() + 60_000)}),
    attempt(4, {state: "running", leaseToken: "ready-owner"}),
    ...Array.from({length: 3}, () => attempt(5, {errorCode: "timeout"})),
  ]);
  await admin`UPDATE jobs SET lease_token='ready-owner',locked_at=clock_timestamp() WHERE name='crawl-agent-review'`;
  const initial = await snapshot(), actual = deriveReplayReadiness(initial.projection, initial.capturedAt);
  const selected = await withReviewReplayContext({referenceTime: reference}, () => db.select({id: crawlCandidates.id})
    .from(crawlCandidates).where(reviewCandidatePredicate(settings, {readyOnly: true})));
  expect(actual.first.eligible).toBe(selected.length);
  const reason = (index: number) => actual.work.find(row => row.stage === "first" && row.candidateId === candidates[index].id)!.blockedReasons;
  expect(reason(0)).toContain("human"); expect(reason(1)).toContain("already_succeeded"); expect(reason(2)).toContain("reuse");
  expect(reason(3)).toContain("retry_wait"); expect(reason(4)).toContain("running"); expect(reason(5)).toContain("attempts_exhausted");
  expect(actual.first.modelReady).toBe(0);
  expect(actual.first.blockedReasons.job_locked).toBe(101);
  expect(Date.parse(initial.capturedAt)).toBeGreaterThanOrEqual(Date.parse(clock.now));
});

it("captures an actual operations observation INSERT/UPDATE/DELETE without a synthetic id", async () => {
  const initial = await snapshot();
  await admin`INSERT INTO operations_observations (key,value) VALUES ('readiness-journal-proof','{}'::jsonb) ON CONFLICT(key) DO NOTHING`;
  const [row] = await admin`SELECT to_jsonb(t) AS value FROM operations_observations t WHERE key='readiness-journal-proof'`;
  const change = {table_name: "operations_observations", operation: "INSERT", ordinal: 1, old_row: null, new_row: row.value} as ReplayReadinessChange;
  const updated = applyReplayChanges(initial.projection, [change]);
  expect(updated.tables.operations_observations.some(item => item.key === "readiness-journal-proof")).toBe(true);
  expect(() => applyReplayChanges(initial.projection, [{...change, old_row: row.value, operation: "DELETE", new_row: null}])).toThrow("replay_readiness_old_mismatch");
  await admin`DELETE FROM operations_observations WHERE key='readiness-journal-proof'`;
});

it("rejects a forged frozen snapshot and includes otherwise unrelated source rows in the exact digest", async () => {
  const forged = frozen(); forged[0].frozenHash = "0".repeat(64);
  await expect(admin.begin(async tx => captureReplayReadinessProjection(tx, manifest, forged))).rejects.toThrow("replay_readiness_frozen_mismatch");
  const before = await snapshot();
  await admin`INSERT INTO crawl_documents (repo,repo_meta,fetched_at) VALUES ('outside/universe','{}'::jsonb,${reference.toISOString()})`;
  const after = await snapshot();
  expect(after.initialStateHash).not.toBe(before.initialStateHash);
  expect(after.projection.tables.crawl_documents.length).toBe(before.projection.tables.crawl_documents.length + 1);
});

it("matches the actual product repository identity SQL including case, scheme, www, git suffix and homepage", async () => {
  const candidate = candidates[10];
  for (const [i, repoUrl] of ["http://WWW.GitHub.com/READINESS/APP-10.git///", "https://github.com/readiness/app-10", "https://github.com/unrelated/app"].entries()) {
    const url = i === 2 ? candidate.productUrl! : `https://existing-${i}.example`;
    await admin`INSERT INTO products (slug,url,name,tagline,description,category,repo_url,verify_token,edit_token_hash)
      VALUES ('readiness-identity',${url},'Identity','A task tracker','A task tracker','Developer Tools',${repoUrl},'readiness-token',${"0".repeat(64)})`;
    try {
      const existing = await findRepositoryProduct(candidate.repo, candidate.productUrl);
      expect(existing).toBeDefined();
      const initial = await snapshot(), actual = deriveReplayReadiness(initial.projection, initial.capturedAt);
      expect(actual.work.find(row => row.stage === "first" && row.candidateId === candidate.id)?.blockedReasons).toContain("rules");
      expect(initial.projection.tables.products.some(row => row.slug === "readiness-identity")).toBe(true);
    } finally { await admin`DELETE FROM products WHERE slug='readiness-identity'`; }
  }
});

it("uses started_at then id for the exact same latest scan as the actual input loader", async () => {
  const candidate = candidates[11], document = documents[11];
  const common = {repositoryKey: candidate.repo, githubRepositoryId: BigInt(991), detectorVersion: settings.agentEvidence.detectorVersion,
    scope: "", scopeHash: "0".repeat(64), state: "complete" as const, completedAt: new Date(+reference - 1000)};
  await db.insert(agentRepositoryScans).values([
    {...common, commitSha: "a".repeat(40), startedAt: new Date(+reference - 2000)},
    {...common, commitSha: "b".repeat(40), startedAt: new Date(+reference - 3000)},
    {...common, commitSha: "c".repeat(40), startedAt: new Date(+reference - 2000)},
  ]);
  try {
    const input = await withReviewReplayContext({referenceTime: reference}, () => loadReviewInput(candidate, document, settings));
    expect(input.source.scanSha).toBe("c".repeat(40));
    const serialized = JSON.parse(JSON.stringify(input));
    const one = {...manifest, inputs: [{...manifest.inputs[11], inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash}]};
    const initial = await admin.begin(async tx => captureReplayReadinessProjection(tx, one,
      [{candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
        frozen: serialized, frozenHash: reviewHash(serialized)}]));
    expect(deriveReplayReadiness(initial.projection, initial.capturedAt).first.eligible).toBe(1);
  } finally { await db.delete(agentRepositoryScans).where(eq(agentRepositoryScans.repositoryKey, candidate.repo)); }
});

it("rejects a source fetched one real PostgreSQL microsecond after the frozen reference", async () => {
  const candidate = candidates[12], original = documents[12];
  await admin`UPDATE crawl_documents SET fetched_at=${reference.toISOString()}::timestamp + interval '1 microsecond' WHERE id=${original.id}`;
  try {
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.id, original.id));
    const input = createReviewInput(candidate, document, settings, {scan: null, observations: []}, reference);
    const serialized = JSON.parse(JSON.stringify(input));
    const one = {...manifest, inputs: [{...manifest.inputs[12], inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash}]};
    const selected = await withReviewReplayContext({referenceTime: reference}, () => db.select({id: crawlCandidates.id})
      .from(crawlCandidates).where(reviewCandidatePredicate(settings, {readyOnly: true})));
    expect(selected.some(row => row.id === candidate.id)).toBe(false);
    await expect(admin.begin(async tx => captureReplayReadinessProjection(tx, one,
      [{candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
        frozen: serialized, frozenHash: reviewHash(serialized)}]))).rejects.toThrow("replay_readiness_current_input_mismatch");
  } finally { await admin`UPDATE crawl_documents SET fetched_at=${original.fetchedAt.toISOString()} WHERE id=${original.id}`; }
});

it("does not certify a nonempty candidate queue after the actual requested-only job request is consumed", async () => {
  const [prior] = await admin`SELECT * FROM jobs WHERE name='crawl-agent-review'`;
  await admin`UPDATE jobs SET requested_version=processed_version,lease_token=NULL,locked_at=NULL WHERE name='crawl-agent-review'`;
  try {
    const initial = await snapshot(), ready = deriveReplayReadiness(initial.projection, initial.capturedAt);
    expect(ready.first.eligible).toBeGreaterThan(0);
    expect(ready.first.modelReady).toBe(0);
    expect(ready.first.blockedReasons.job_not_requested).toBe(101);
  } finally { await admin`UPDATE jobs SET requested_version=${prior.requested_version},lease_token=${prior.lease_token},locked_at=${prior.locked_at} WHERE name='crawl-agent-review'`; }
});

it("rejects a database configuration whose first reviewer would be read from the host environment", async () => {
  const implicit = {...settings}; delete implicit.firstReview;
  await db.update(crawlSettings).set({values: implicit}).where(eq(crawlSettings.id, 1));
  try { await expect(snapshot()).rejects.toThrow("replay_readiness_explicit_first_reviewer_required"); }
  finally { await db.update(crawlSettings).set({values: settings}).where(eq(crawlSettings.id, 1)); }
});

it("agrees with actual requested-only runJob when a different initial owner still holds a healthy lease", async () => {
  await admin`UPDATE jobs SET requested_version=greatest(processed_version,1)+1, lease_token='foreign-owner',
    locked_at=clock_timestamp() WHERE name='crawl-agent-review'`;
  let invoked = false;
  const result = await runJob("crawl-agent-review", async () => { invoked = true; return {done: true}; }, {requestedOnly: true});
  expect(result.status).toBe("skipped"); expect(invoked).toBe(false);
  const initial = await snapshot(), actual = deriveReplayReadiness(initial.projection, initial.capturedAt);
  expect(actual.first.eligible).toBeGreaterThan(0); expect(actual.first.modelReady).toBe(0);
  expect(actual.first.blockedReasons.job_locked).toBe(101);
});
