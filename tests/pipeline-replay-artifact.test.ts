import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseReplayArtifact, replayArtifactContentHash, replayQualityDatasetHash, reportReplayArtifact,
  loadVerifiedReplayArtifact, replayArtifactFromVerified, reportVerifiedReplayArtifact,
  type ReplayArtifact } from "@/lib/operations/pipeline-replay-artifact";
import { compareReplayArtifacts, compareVerifiedReplayRuns } from "@/lib/operations/pipeline-replay-compare";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import * as readiness from "@/lib/operations/pipeline-replay-readiness";
import type { VerifiedReplayDatabase } from "@/lib/operations/pipeline-replay-database";
import * as dbSchema from "@/lib/db/schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { getTableColumns } from "drizzle-orm";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { classifyReplayInitialCandidates, assertReplayInitialReviewKinds } from "@/lib/operations/pipeline-replay-classification";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";

const authority = vi.hoisted(() => ({ database: {}, readback: vi.fn() }));
vi.mock("@/lib/operations/pipeline-replay-database", () => ({
  assertVerifiedReplayHandlerDatabase(value: unknown) {
    if (value !== authority.database) throw new Error("verified_replay_handler_database_required");
  },
}));
vi.mock("@/lib/operations/pipeline-replay-execution", () => ({ readSealedReplayArtifact: authority.readback }));

const hash = "a".repeat(64);
const at = (ms: number) => new Date(Date.parse("2001-10-01T00:00:00.000Z") + ms).toISOString();
function rawRow(table: Parameters<typeof getTableColumns>[0], values: Record<string, unknown>) {
  return { ...Object.fromEntries(Object.values(getTableColumns(table)).map(column => [column.name, null])), ...values } as
    readiness.ReplayReadinessProjection["tables"]["crawl_candidates"][number];
}
function rawCandidate(id: number) { return rawRow(dbSchema.crawlCandidates, { id, repo: `scope/app-${id}-initial`,
  product_url: `https://scope.example/${id}/initial`, state: "approved", decided_by: "auto", judged_at: at(-86_400_000), updated_at: at(-1) }); }
afterEach(() => vi.restoreAllMocks());
beforeEach(() => authority.readback.mockReset());
function frozen(candidateId: number, salt = "initial") {
  const reference = new Date(at(-86_400_000)), repo = `scope/app-${candidateId}-${salt}`;
  const candidate = { id: candidateId, repo, productUrl: `https://scope.example/${candidateId}/${salt}`, judgedAt: reference } as CrawlCandidate;
  const document = { id: candidateId, repo, productUrl: candidate.productUrl, fetchedAt: reference,
    pageStatus: 200, repoMeta: { description: "A service" }, pageMeta: { title: "App", readmeSample: "" } } as CrawlDocument;
  const input = createReviewInput(candidate, document, structuredClone(DEFAULT_CRAWL_SETTINGS), { scan: null, observations: [] }, reference);
  const frozenInput = JSON.parse(JSON.stringify(input));
  return { candidateId, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    policyHash: input.policyHash, frozenInput, frozenHash: reviewHash(frozenInput) };
}
function seal(value: ReplayArtifact): ReplayArtifact {
  const hashes = readiness.readinessProjectionHashes(value.initial.projection as readiness.ReplayReadinessProjection, value.initial.capturedAt);
  Object.assign(value.initial, hashes); value.manifest.initialStateHash = hashes.initialStateHash;
  value.run.chargedCalls = value.calls.length;
  value.run.chargedTokens = value.calls.reduce((sum, row) => sum + row.tokenUpperBound, 0);
  value.seal = { headSeq: value.journal.length, manifestHash: reviewHash(value.manifest), ...hashes, contentHash: hash };
  const { seal: ignored, ...content } = value; void ignored;
  value.seal.contentHash = replayArtifactContentHash(content); return value;
}
function fixture(): ReplayArtifact {
  const entry = frozen(1), { candidateId, inputHash, sourceRevisionHash } = entry;
  const input = { candidateId, inputHash, sourceRevisionHash };
  return seal({ kind: "pipeline-replay-ledger", version: 1,
    manifest: { version: 1, runId: "fixture-run", revision: "4af0589", mode: "fixtures", cacheMode: "cold",
      referenceTime: at(-86_400_000), startedAt: at(0), endedAt: at(1_800_000), inputPolicyHash: entry.policyHash,
      fullReviewPolicyHash: hash, comparisonPolicyHash: hash, initialStateHash: hash,
      models: { first: { provider: "abcllm", model: "first", canonicalModel: "first" }, second: [], fallbacks: [] },
      inputs: [{ ...input, readyAt: at(0), stratum: "new", reReview: false }],
      limits: { maxCalls: 100, maxTokens: 10_000, maxDurationMs: 1_800_000, concurrency: 1, perCallTokenUpperBound: 100 } },
    run: { runId: "fixture-run", epoch: 1, profile: "handlers-v4", state: "sealed", startedAt: at(0), deadlineAt: at(1_800_000),
      admissionClosedAt: at(1_800_000), writersFencedAt: at(1_800_100), sealedAt: at(1_800_200), chargedCalls: 0, chargedTokens: 0 },
    initial: { capturedAt: at(-1), initialStateHash: hash, comparisonStateHash: hash,
      projection: { version: 1, referenceTime: at(-86_400_000), universe: [entry],
        tables: { crawl_settings: [rawRow(dbSchema.crawlSettings, { id: 1, values: { ...DEFAULT_CRAWL_SETTINGS,
          firstReview: { provider: "abcllm", model: "first" } } })], crawl_candidates: [rawCandidate(1)], crawl_documents: [], crawl_review_attempts: [], second_reviews: [],
          agent_repository_scans: [], agent_repository_observations: [], products: [], crawl_frontier: [], jobs: [], operations_observations: [], capacity_calls: [] } },
      runner: { jobs: ["crawl-agent-review", "second-review"], budgetMs: 110_000 }, quality: null },
    journal: [{ seq: 1, at: at(0), kind: "started", txKey: null, payloadHash: hash }], readiness: { transactions: [], gaps: [] }, calls: [], finals: [],
    seal: { headSeq: 1, manifestHash: hash, initialStateHash: hash, comparisonStateHash: hash, contentHash: hash } });
}
function final(value: ReplayArtifact, options: { candidateId?: number; inputHash?: string; reReview?: boolean; elapsed?: number } = {}) {
  const candidateId = options.candidateId ?? 1, elapsed = options.elapsed ?? 1000;
  let member = value.manifest.inputs.find(row => row.candidateId === candidateId && (!options.inputHash || row.inputHash === options.inputHash));
  if (!member) {
    const entry = frozen(candidateId, options.inputHash);
    const { inputHash, sourceRevisionHash } = entry, input = { candidateId, inputHash, sourceRevisionHash };
    value.manifest.inputs.push({ ...input, readyAt: at(0), stratum: "new", reReview: options.reReview ?? false });
    value.initial.projection.universe.push(entry);
    if (!value.initial.projection.tables.crawl_candidates.some(row => row.id === candidateId))
      value.initial.projection.tables.crawl_candidates.push(rawCandidate(candidateId));
    member = value.manifest.inputs.at(-1)!;
  }
  const { inputHash, sourceRevisionHash } = member, input = { candidateId, inputHash, sourceRevisionHash };
  const id = value.calls.length + 1, seq = value.journal.length + 1;
  value.calls.push({ ...input, callId: `first-${id}`, firstAttemptId: id, stage: "first", provider: "abcllm", model: "first",
    secondReviewId: null, generationKey: null, vote: null, requestHash: hash, tokenUpperBound: 100, state: "settled",
    dispatchedAt: at(0), settledAt: at(elapsed - 1), inputTokens: 10, outputTokens: 5,
    resultOk: true, resultHash: hash, resultDecisionHash: hash, failureClass: null });
  value.finals.push({ ...input, policyHash: value.manifest.inputPolicyHash, seq, at: at(elapsed), firstAttemptId: id, firstCallId: `first-${id}`,
    decision: "approve", secondWitnesses: [] });
  value.journal.push({ seq, at: at(elapsed), kind: "final", txKey: `writer-${id}`, payloadHash: hash });
  value.readiness.transactions.push({ seq, txKey: `writer-${id}`, txStartedAt: at(0), recordedAt: at(elapsed),
    confirmedAt: at(elapsed + 1), changes: [] });
  return seal(value);
}
function quality(value: ReplayArtifact, candidateIds: number[]) {
  const cohort = value.manifest.inputs.filter(row => candidateIds.includes(row.candidateId))
    .map(({ candidateId, inputHash, sourceRevisionHash }) => ({ candidateId, inputHash, sourceRevisionHash }));
  const dataset = { cohort, labels: cohort.map(row => ({ ...row, expected: "approve" as const })) };
  value.initial.quality = { ...dataset, datasetHash: replayQualityDatasetHash(dataset) }; return seal(value);
}
function mockCoverage(coverage: "covered" | "starved" | "missing", value = fixture()) {
  const state = readiness.deriveReplayReadiness(value.initial.projection as readiness.ReplayReadinessProjection, value.run.startedAt);
  vi.spyOn(readiness, "reduceReplayReadinessCoverage").mockReturnValue({ coverage, intervals: [], initial: state, final: state,
    readyAtByInput: value.manifest.inputs.map(({ candidateId, inputHash, sourceRevisionHash }) =>
      ({ candidateId, inputHash, sourceRevisionHash, at: value.run.startedAt })) });
}
function covered(value?: ReplayArtifact) { mockCoverage("covered", value); }
function priorApproval(value: ReplayArtifact) {
  const input = value.initial.projection.universe[0], frozen = input.frozenInput as Record<string, never>;
  const settings = structuredClone(DEFAULT_CRAWL_SETTINGS);
  Object.assign(settings, { enabled: true, reviewMode: "enforce", firstReview: { provider: "abcllm", model: "first" } });
  Object.assign(settings.secondReview, { enabled: true, voters: [{ provider: "abcllm", model: "second" }], fallbacks: [] });
  value.initial.projection.tables.crawl_settings = [rawRow(dbSchema.crawlSettings, { id: 1, values: settings })];
  value.initial.projection.tables.crawl_candidates[0].signals = { agentReviewAttemptId: 99 };
  value.initial.projection.tables.crawl_review_attempts = [rawRow(dbSchema.crawlReviewAttempts, { id: 99, candidate_id: 1,
    kind: "automatic", state: "succeeded", provider: "abcllm", model: "first", input_hash: input.inputHash,
    source_revision_hash: input.sourceRevisionHash, policy_hash: input.policyHash, snapshot: frozen.snapshot, source: frozen.source,
    prompt_version: REVIEW_PROMPT_VERSION, rules_version: REVIEW_RULES_VERSION, started_at: at(-100), completed_at: at(-2),
    valid_until: frozen.validUntil, outcome: { decision: "approve", reason: "A product", evidenceIds: ["product"] } })];
  value.initial.projection.tables.second_reviews = [rawRow(dbSchema.secondReviews, { id: 88, candidate_id: 1,
    repo: value.initial.projection.tables.crawl_candidates[0].repo, first_attempt_id: 99, trigger: "ai_approved", first_decision: "approve",
    first_model: "first", input_hash: input.inputHash, generation_key: secondReviewGeneration(99, input, "ai_approved"),
    provider: "abcllm", model: "second", status: "pending" })];
  return value;
}

it("classifies actual initial completion evidence rather than a caller's re-review flag", () => {
  const value = fixture();
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ candidateId: 1, kind: "new" }]);
  value.initial.projection.tables.crawl_candidates[0].published_slug = "already-public";
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ candidateId: 1, kind: "reReview" }]);
  expect(() => assertReplayInitialReviewKinds(value.initial.projection, value.manifest)).toThrow("replay_review_kind_mismatch");
});

it("keeps an applied approval awaiting AI2 unclassified without guessing the past gate policy", () => {
  const value = priorApproval(fixture());
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "unknown" }]);
  Object.assign(value.initial.projection.tables.second_reviews[0], { status: "agreed", second_decision: "approve", reviewed_at: at(-1) });
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "reReview" }]);
});

it("keeps ambiguous prior outcomes unclassified and never admits caller false as new work", () => {
  const value = priorApproval(fixture()); value.initial.projection.tables.crawl_candidates[0].signals = null;
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "unknown" }]);
  expect(() => assertReplayInitialReviewKinds(value.initial.projection, value.manifest)).not.toThrow();
});

it("recognizes an applied automatic rejection but rejects a caller claiming old work for a known new candidate", () => {
  const value = priorApproval(fixture()); value.initial.projection.tables.crawl_review_attempts[0].outcome =
    { decision: "reject", reason: "Not a product", evidenceIds: ["product"] };
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "reReview" }]);
  const fresh = fixture(); fresh.manifest.inputs[0].reReview = true;
  expect(() => assertReplayInitialReviewKinds(fresh.initial.projection, fresh.manifest)).toThrow("replay_review_kind_mismatch");
});

it.each([
  (value: ReplayArtifact) => { value.initial.projection.tables.crawl_candidates[0].signals = { agentReviewAttemptId: 999 }; },
  (value: ReplayArtifact) => { value.initial.projection.tables.crawl_review_attempts[0].source = {}; },
  (value: ReplayArtifact) => { value.initial.projection.tables.second_reviews[0].candidate_id = 999; },
  (value: ReplayArtifact) => { value.initial.projection.tables.second_reviews[0].generation_key = "old"; },
  (value: ReplayArtifact) => { const first = value.initial.projection.tables.crawl_review_attempts[0];
    value.initial.projection.tables.crawl_review_attempts.push({ ...first, id: 100 });
    value.initial.projection.tables.crawl_candidates[0].signals = null; },
])("keeps incomplete application, source or gate relations unknown rather than inventing new work", mutate => {
  const value = priorApproval(fixture()); mutate(value);
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "unknown" }]);
});

it("requires every independent initial gate slot and treats an additional pending row as a blocker", () => {
  const value = priorApproval(fixture()), vote = value.initial.projection.tables.second_reviews[0];
  Object.assign(vote, { status: "agreed", second_decision: "approve", reviewed_at: at(-1) });
  const settings = value.initial.projection.tables.crawl_settings[0].values as { secondReview: { voters: Array<{provider: string; model: string}> } };
  settings.secondReview.voters.push({ provider: "abcllm", model: "another" });
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "unknown" }]);
  value.initial.projection.tables.second_reviews.push({ ...vote, id: 89, model: "another" });
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "reReview" }]);
  value.initial.projection.tables.second_reviews.push({ ...vote, id: 90, status: "pending", second_decision: null });
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "unknown" }]);
});

it("binds an initial fallback approval to its current independent slot and resolved root", () => {
  const value = priorApproval(fixture()), root = value.initial.projection.tables.second_reviews[0];
  const settings = value.initial.projection.tables.crawl_settings[0].values as { secondReview: { fallbacks: Array<{provider: string; model: string}> } };
  settings.secondReview.fallbacks.push({ provider: "abcllm", model: "fallback" });
  Object.assign(root, { status: "resolved", resolution: "fallback", model: "[MLX] SECOND" });
  value.initial.projection.tables.second_reviews.push({ ...root, id: 89, fallback_for_id: root.id, model: "fallback",
    status: "agreed", resolution: null, second_decision: "approve", reviewed_at: at(-1) });
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "reReview" }]);
  root.status = "failed";
  expect(classifyReplayInitialCandidates(value.initial.projection, value.manifest)).toMatchObject([{ kind: "unknown" }]);
});

it("excludes actual published and unclassified initial candidates even when the manifest claims new work", () => {
  const published = final(fixture()); published.initial.projection.tables.crawl_candidates[0].published_slug = "old-product"; seal(published);
  expect(reportReplayArtifact(published)).toMatchObject({ finalCandidates: 0, reReviewGenerations: 1, classificationComplete: true });
  const unknown = final(priorApproval(fixture())); unknown.initial.projection.tables.crawl_candidates[0].signals = null; seal(unknown);
  expect(reportReplayArtifact(unknown)).toMatchObject({ finalCandidates: 0, unclassifiedGenerations: 1, classificationComplete: false });
  expect(compareReplayArtifacts(unknown, unknown).reasons).toContain("initial_review_classification_unknown");
});

it("rejects caller-declared sealed and verified JSON through the strict artifact schema", () => {
  expect(() => parseReplayArtifact({ kind: "pipeline-replay-ledger", version: 1, sealed: true, verified: true }))
    .toThrow("invalid_replay_artifact");
});

it("rejects fabricated verified handles before inspecting their evidence", () => {
  expect(() => compareVerifiedReplayRuns({ verified: true, sealed: true }, { verified: true, sealed: true }))
    .toThrow("verified_replay_artifact_required");
});

it("parses a deterministic artifact and always reports raw JSON as unverified", () => {
  const value = final(fixture());
  expect(parseReplayArtifact(value)).toEqual(value);
  expect(reportReplayArtifact(value)).toMatchObject({ authenticity: "unverified", mode: "fixtures", budgetEvidence: "unverified", finalCandidates: 1 });
});

it.each([
  (value: ReplayArtifact) => Object.assign(value.run, { verified: true }),
  (value: ReplayArtifact) => Object.assign(value.initial.runner, { callback: "trusted" }),
  (value: ReplayArtifact) => Object.assign(value.calls[0], { hiddenAttempt: 2 }),
  (value: ReplayArtifact) => Object.assign(value.seal, { authenticated: true }),
])("rejects additional nested authentication or evidence fields", mutate => {
  const value = final(fixture()); mutate(value);
  expect(() => parseReplayArtifact(value)).toThrow("invalid_replay_artifact");
});

it("rejects modified content and noncontiguous journals even when the content digest is recomputed", () => {
  const value = final(fixture()); value.calls[0].outputTokens = 6;
  expect(() => parseReplayArtifact(value)).toThrow("invalid_replay_artifact");
  seal(value); value.journal[1].seq = 3; seal(value);
  expect(() => parseReplayArtifact(value)).toThrow("invalid_replay_artifact");
});

it("counts the earliest new final once per candidate while keeping repeat and re-review generations separate", () => {
  const value = final(fixture());
  final(value, { candidateId: 1, inputHash: "c".repeat(64), elapsed: 2000 });
  final(value, { candidateId: 2, reReview: true, elapsed: 3000 });
  value.initial.projection.tables.crawl_candidates.find(row => row.id === 2)!.published_slug = "old-product"; seal(value);
  expect(reportReplayArtifact(value)).toMatchObject({ finalCandidates: 1, finalGenerations: 3, repeatGenerations: 1, reReviewGenerations: 1 });
});

it("rejects duplicate logical finals and mismatched call or charged budget identities", () => {
  const value = final(fixture()); final(value, { elapsed: 2000 });
  expect(() => parseReplayArtifact(value)).toThrow("invalid_replay_artifact");
  const badCall = final(fixture()); badCall.calls[0].firstAttemptId = 99; seal(badCall);
  expect(() => parseReplayArtifact(badCall)).toThrow("invalid_replay_artifact");
  const badBudget = final(fixture()); badBudget.run.chargedTokens++; const { seal: ignored, ...content } = badBudget; void ignored;
  badBudget.seal.contentHash = replayArtifactContentHash(content);
  expect(() => parseReplayArtifact(badBudget)).toThrow("invalid_replay_artifact");
});

it("binds direct AI2 witnesses to their actual model slot and requires a real failed root for fallback", () => {
  const value = final(fixture()), first = value.calls[0], model = { provider: "abcllm" as const, model: "second", canonicalModel: "second" };
  value.manifest.models.second = [model];
  value.manifest.models.fallbacks = [{ ...model, model: "fallback", canonicalModel: "fallback" }];
  const second = { ...first, callId: "second-1", stage: "second" as const, model: "fallback", secondReviewId: 2,
    generationKey: "generation-1", vote: 2 };
  value.calls.push(second);
  value.finals[0].secondWitnesses = [{ secondReviewId: 2, callId: second.callId, rootId: 2, generationKey: "generation-1",
    rootCallId: null, vote: 2, provider: second.provider, model: second.model, slotProvider: model.provider, slotModel: model.model }];
  seal(value);
  expect(() => parseReplayArtifact(value)).toThrow("invalid_replay_artifact");
  second.model = model.model; value.finals[0].secondWitnesses[0].model = model.model; seal(value);
  expect(parseReplayArtifact(value).finals).toHaveLength(1);
  const witness = value.finals[0].secondWitnesses[0];
  Object.assign(second, { callId: "fallback-1", model: "fallback", secondReviewId: 3 });
  Object.assign(witness, { callId: second.callId, model: second.model, secondReviewId: 3, rootCallId: "second-root" }); seal(value);
  expect(() => parseReplayArtifact(value)).toThrow("invalid_replay_artifact");
  value.calls.push({ ...second, callId: "second-root", model: model.model, secondReviewId: 2, resultOk: false,
    resultHash: null, resultDecisionHash: null, failureClass: "technical" }); seal(value);
  expect(parseReplayArtifact(value).finals).toHaveLength(1);
});

it("uses DB admission duration and excludes draining finals after admission closes", () => {
  const value = final(fixture()); value.run.admissionClosedAt = at(500); seal(value);
  expect(reportReplayArtifact(value)).toMatchObject({ durationMs: 500, finalCandidates: 0, calls: { completed: 1 } });
  expect(compareReplayArtifacts(value, value).reasons).toContain("window_under_30_minutes");
});

it("does not count a precommit final whose commit upper bound falls after admission closes", () => {
  const value = final(fixture());
  value.readiness.transactions[0].confirmedAt = at(1_800_010); seal(value);
  expect(reportReplayArtifact(value)).toMatchObject({ finalCandidates: 0, finalGenerations: 0 });
});

it("preserves the DB packet clock lower bound when its journal event is inserted later in the same transaction", () => {
  const value = final(fixture()); value.readiness.transactions[0].recordedAt = at(999); seal(value);
  expect(reportReplayArtifact(value).finalCandidates).toBe(1);
});

it("does not round a commit upper bound one microsecond past admission close into the window", () => {
  const value = final(fixture()); value.run.admissionClosedAt = "2001-10-01T00:00:01.000000Z";
  value.readiness.transactions[0].confirmedAt = "2001-10-01T00:00:01.000001Z"; seal(value);
  expect(reportReplayArtifact(value)).toMatchObject({ finalCandidates: 0, outsideWindowFinals: 1 });
});

it("excludes finals with no commit confirmation instead of treating precommit timestamps as completion", () => {
  const value = final(fixture()); value.readiness.transactions[0].confirmedAt = null; seal(value);
  expect(reportReplayArtifact(value)).toMatchObject({ finalCandidates: 0, unconfirmedFinals: 1 });
  expect(compareReplayArtifacts(value, value).reasons).toContain("final_commit_unconfirmed");
});

it("keeps latency incomplete when readiness is only proven by a later commit upper bound", () => {
  const value = final(fixture()); covered(value);
  const result = readiness.reduceReplayReadinessCoverage(value.initial, value.readiness,
    { from: value.run.startedAt, until: value.run.admissionClosedAt });
  result.readyAtByInput[0].at = at(500);
  expect(reportReplayArtifact(value)).toMatchObject({ latencyEvidenceComplete: false, endToEndMs: { samples: 0, p95: null } });
  expect(compareReplayArtifacts(value, value).reasons).toContain("latency_evidence_missing");
});

it("uses certified initial readiness and the commit upper bound without caller readyAt substitution", () => {
  const value = final(fixture()); value.manifest.inputs[0].readyAt = at(900); seal(value); covered(value);
  expect(reportReplayArtifact(value)).toMatchObject({ latencyEvidenceComplete: true, endToEndMs: { samples: 1, p95: 1001 } });
});

it("accepts a pinned quality subset, while missing cohort labels or either run's result remain incomplete", () => {
  const value = final(fixture()); final(value, { candidateId: 2, elapsed: 2000 }); quality(value, [1]);
  expect(reportReplayArtifact(value).quality).toMatchObject({ complete: true, evaluated: 1, expected: 1 });
  quality(value, [1, 2]); value.initial.quality!.labels.pop();
  value.initial.quality!.datasetHash = replayQualityDatasetHash(value.initial.quality!); seal(value);
  expect(reportReplayArtifact(value).quality).toMatchObject({ complete: false, expected: 2 });
  expect(compareReplayArtifacts(value, value)).toMatchObject({ quality: "incomplete", performance: "incomplete" });
});

it("does not estimate usage or technical failure rates from unknown settlement evidence", () => {
  const value = final(fixture()); value.finals = []; value.journal.pop(); value.readiness.transactions = [];
  Object.assign(value.calls[0], { resultOk: false, resultHash: null, resultDecisionHash: null, failureClass: "unknown", inputTokens: null }); seal(value);
  expect(reportReplayArtifact(value).calls).toMatchObject({ classificationKnown: false, failed: null, cancelled: null,
    technicalFailureRate: null, inputTokens: null, outputTokens: null });
  expect(compareReplayArtifacts(value, value).reasons).toEqual(expect.arrayContaining(["failure_classification_unknown", "token_usage_unknown"]));
});

it.each(["starved", "missing"] as const)("keeps %s readiness evidence ineligible for a performance decision", state => {
  mockCoverage(state);
  const value = quality(final(fixture()), [1]);
  expect(compareReplayArtifacts(value, value)).toMatchObject({ performance: "incomplete", overall: "incomplete" });
  expect(compareReplayArtifacts(value, value).reasons).toContain(state === "starved" ? "queue_starved" : "coverage_missing");
});

it("keeps fixture performance incomplete despite authenticated-looking JSON, full duration and positive coverage", () => {
  covered(); const value = quality(final(fixture()), [1]);
  expect(compareReplayArtifacts(value, value)).toMatchObject({ quality: "passed", performance: "incomplete", overall: "incomplete" });
  expect(compareReplayArtifacts(value, value).reasons).toEqual(expect.arrayContaining(["artifact_provenance_unverified", "fixture_not_model_throughput", "provider_budget_unverified"]));
});

it("allows declared concurrency to differ but preserves the configured runner job order", () => {
  covered(); const value = quality(final(fixture()), [1]), changed = structuredClone(value);
  changed.manifest.limits.concurrency = 2; seal(changed);
  expect(compareReplayArtifacts(value, changed).reasons).not.toContain("conditions_mismatch");
  changed.initial.runner.jobs.reverse(); seal(changed);
  expect(compareReplayArtifacts(value, changed).reasons).toContain("conditions_mismatch");
});

it("mints authentic handles only through the fixed DB readback and preserves raw JSON's unverified status", async () => {
  const value = quality(final(fixture()), [1]); authority.readback.mockResolvedValue(value);
  const handle = await loadVerifiedReplayArtifact(authority.database as VerifiedReplayDatabase, value.run.runId, value);
  expect(authority.readback).toHaveBeenCalledWith(authority.database, value.run.runId);
  expect(reportVerifiedReplayArtifact(handle)).toMatchObject({ authenticity: "verified", finalCandidates: 1 });
  expect(reportReplayArtifact(replayArtifactFromVerified(handle)).authenticity).toBe("unverified");
  expect(compareVerifiedReplayRuns(handle, handle).reasons).not.toContain("artifact_provenance_unverified");
  expect(compareVerifiedReplayRuns(handle, handle)).toMatchObject({ performance: "incomplete", overall: "incomplete" });
  expect(() => compareVerifiedReplayRuns({ ...handle }, handle)).toThrow("verified_replay_artifact_required");
  const copy = replayArtifactFromVerified(handle); copy.finals[0].decision = "reject";
  expect(replayArtifactFromVerified(handle).finals[0].decision).toBe("approve");
  value.finals[0].decision = "reject";
  expect(replayArtifactFromVerified(handle).finals[0].decision).toBe("approve");
});

it("rejects foreign databases, unsealed readback and changed expected artifacts instead of trusting a caller verifier", async () => {
  const value = final(fixture()); authority.readback.mockResolvedValue(value);
  await expect(loadVerifiedReplayArtifact({} as VerifiedReplayDatabase, value.run.runId)).rejects.toThrow("verified_replay_handler_database_required");
  expect(authority.readback).not.toHaveBeenCalled();
  await expect(loadVerifiedReplayArtifact(authority.database as VerifiedReplayDatabase, value.run.runId, () => true))
    .rejects.toThrow("invalid_replay_artifact");
  expect(authority.readback).not.toHaveBeenCalled();
  const changed = structuredClone(value); changed.calls[0].inputTokens = 11; seal(changed);
  await expect(loadVerifiedReplayArtifact(authority.database as VerifiedReplayDatabase, value.run.runId, changed))
    .rejects.toThrow("replay_artifact_database_mismatch");
  await expect(loadVerifiedReplayArtifact(authority.database as VerifiedReplayDatabase, "another-run"))
    .rejects.toThrow("replay_artifact_database_mismatch");
  authority.readback.mockResolvedValue({ ...value, run: { ...value.run, state: "draining" } });
  await expect(loadVerifiedReplayArtifact(authority.database as VerifiedReplayDatabase, value.run.runId)).rejects.toThrow("invalid_replay_artifact");
});
