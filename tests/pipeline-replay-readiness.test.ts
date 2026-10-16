import { expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as dbSchema from "@/lib/db/schema";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { deriveReplayReadiness, applyReplayChanges, reduceReplayReadinessCoverage,
  readinessProjectionHashes, type ReplayReadinessProjection } from "@/lib/operations/pipeline-replay-readiness";

const reference = "2001-11-01T00:00:00.000Z", wall = "2026-10-15T12:00:00.000Z";
function row(table: Parameters<typeof getTableColumns>[0], values: Record<string, unknown>) {
  return { ...Object.fromEntries(Object.values(getTableColumns(table)).map(column => [column.name, null])), ...values } as ReplayReadinessProjection["tables"]["jobs"][number];
}
export function readinessFixture(): ReplayReadinessProjection {
  const candidate = row(dbSchema.crawlCandidates, { id: 1, repo: "ready/app", product_url: "https://ready.example",
    state: "approved", reason: "passed", decided_by: "auto", judged_at: reference, updated_at: reference });
  const document = row(dbSchema.crawlDocuments, { id: 1, repo: "ready/app", product_url: "https://ready.example",
    fetched_at: "2001-10-31T23:59:59.000Z", page_status: 200,
    repo_meta: { description: "A deployed task tracker", homepage: "https://ready.example", fork: false,
      private: false, archived: false, owner: { type: "User" }, stargazers_count: 10 },
    page_meta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create a project and manage tasks in the application.", readmeSample: "An online task tracker", readmeSampleVersion: README_SAMPLE_VERSION } });
  const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce" as const,
    firstReview: { provider: "abcllm" as const, model: "model-one" },
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: false } };
  const typed = <T>(raw: Record<string, unknown>, table: Parameters<typeof getTableColumns>[0]): T => Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [key,
      raw[column.name] === null ? null : column.dataType === "date" ? new Date(String(raw[column.name])) : column.mapFromDriverValue(raw[column.name])])) as T;
  const input = createReviewInput(typed(candidate, dbSchema.crawlCandidates), typed(document, dbSchema.crawlDocuments), settings,
    { scan: null, observations: [] }, new Date(reference));
  const frozenInput = JSON.parse(JSON.stringify(input));
  return { version: 1, referenceTime: reference, universe: [{ candidateId: 1, inputHash: input.inputHash,
    sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, frozenInput, frozenHash: reviewHash(frozenInput) }],
  tables: { crawl_settings: [row(dbSchema.crawlSettings, { id: 1, values: settings })], crawl_candidates: [candidate],
    crawl_documents: [document], crawl_review_attempts: [], second_reviews: [], agent_repository_scans: [],
    agent_repository_observations: [], products: [], crawl_frontier: [], jobs: [row(dbSchema.jobs,
      {name: "crawl-agent-review", requested_version: 1, processed_version: 0})], operations_observations: [], capacity_calls: [] } } as ReplayReadinessProjection;
}

it("counts an actual frozen first-review input using semantic reference rather than the later wall clock", () => {
  const result = deriveReplayReadiness(readinessFixture(), wall);
  expect(result.first.modelReady).toBe(1);
  expect(result.second.modelReady).toBe(0);
});

it("revalidates mutable rows after valid and invalid calls without changing their input", () => {
  const projection = readinessFixture(), job = projection.tables.jobs[0];
  job.locked_at = "2026-10-15 21:00:00.123456+09:00";
  projection.tables.jobs.unshift({ ...job, name: "z-foreign-job" });
  const before = structuredClone(projection), canonical = applyReplayChanges(projection, []);
  expect(canonical.tables.jobs.map(row => row.name)).toEqual(["crawl-agent-review", "z-foreign-job"]);
  expect(canonical.tables.jobs[0].locked_at).toBe("2026-10-15T12:00:00.123456Z");
  expect(projection).toEqual(before);
  const originalHashes = readinessProjectionHashes(projection, wall);

  delete job.requested_version;
  const missing = structuredClone(projection);
  expect(() => applyReplayChanges(projection, [])).toThrow();
  expect(projection).toEqual(missing);
  job.requested_version = 1;
  job.extra_column = true;
  const unknown = structuredClone(projection);
  expect(() => readinessProjectionHashes(projection, wall)).toThrow();
  expect(projection).toEqual(unknown);
  delete job.extra_column;
  expect(readinessProjectionHashes(projection, wall)).toEqual(originalHashes);

  job.requested_version = Number.MAX_SAFE_INTEGER + 1;
  const unsafe = structuredClone(projection);
  expect(() => applyReplayChanges(projection, [])).toThrow("replay_readiness_unsafe_integer");
  expect(projection).toEqual(unsafe);
  job.requested_version = 2;
  const changed = structuredClone(projection);
  expect(applyReplayChanges(projection, []).tables.jobs[0].requested_version).toBe(2);
  expect(readinessProjectionHashes(projection, wall)).not.toEqual(originalHashes);
  expect(projection).toEqual(changed);
});

it("does not bridge an unconfirmed transaction that makes the only candidate ready", () => {
  const projection = readinessFixture(), before = { ...projection.tables.crawl_candidates[0], decided_by: "admin" };
  projection.tables.crawl_candidates[0] = before;
  const initial = { projection, capturedAt: wall, ...readinessProjectionHashes(projection, wall) };
  const result = reduceReplayReadinessCoverage(initial, { transactions: [{ seq: 1, txKey: "tx-one", txStartedAt: wall,
    recordedAt: "2026-10-15T12:00:01.000Z", confirmedAt: null,
    changes: [{ table_name: "crawl_candidates", operation: "UPDATE", ordinal: 1, old_row: before,
      new_row: { ...before, decided_by: "auto" } }] }], gaps: [] },
  { from: wall, until: "2026-10-15T12:00:02.000Z" });
  expect(result.coverage).toBe("missing");
});

it("rejects an OLD fact that does not match the current projection", () => {
  const projection = readinessFixture(), previous = projection.tables.crawl_candidates[0];
  expect(() => applyReplayChanges(projection, [{ table_name: "crawl_candidates", operation: "UPDATE", ordinal: 1,
    old_row: { ...previous, state: "rejected" }, new_row: previous }])).toThrow("replay_readiness_old_mismatch");
});

function attempt(projection: ReplayReadinessProjection, values: Record<string, unknown> = {}) {
  const frozen = projection.universe[0].frozenInput as Record<string, never>;
  return row(dbSchema.crawlReviewAttempts, { id: 1, candidate_id: 1, kind: "automatic", state: "failed",
    input_hash: frozen.inputHash, source_revision_hash: frozen.sourceRevisionHash, policy_hash: frozen.policyHash,
    snapshot: frozen.snapshot, source: frozen.source, prompt_version: "2026-10-06.2", rules_version: "2026-10-06.2",
    provider: "abcllm", model: "model-one", attempt_number: 1, valid_until: frozen.validUntil,
    started_at: wall, error_code: "timeout", ...values }) as ReplayReadinessProjection["tables"]["crawl_review_attempts"][number];
}

it("replays operations observations using their actual key primary key", () => {
  const projection = readinessFixture();
  const next = row(dbSchema.operationsObservations, { key: "ready-proof", value: {}, observed_at: wall });
  const result = applyReplayChanges(projection, [{ table_name: "operations_observations", operation: "INSERT",
    old_row: null, new_row: next, ordinal: 1 }]);
  expect(result.tables.operations_observations).toEqual([next]);
});

it("retains a retry hold until the precise PostgreSQL microsecond boundary", () => {
  const projection = readinessFixture();
  projection.tables.crawl_review_attempts = [attempt(projection, { retry_after: "2026-10-15T12:00:00.000999Z" })];
  expect(deriveReplayReadiness(projection, "2026-10-15T12:00:00.000998Z").first.modelReady).toBe(0);
  expect(deriveReplayReadiness(projection, "2026-10-15T12:00:00.000999Z").first.modelReady).toBe(1);
});

it("preserves microsecond commit upper bounds in the coverage partition", () => {
  const projection = readinessFixture(), previous = projection.tables.crawl_candidates[0];
  const initial = { projection, capturedAt: wall, ...readinessProjectionHashes(projection, wall) };
  const result = reduceReplayReadinessCoverage(initial, { transactions: [{ seq: 1, txKey: "micro-tx", txStartedAt: wall,
    recordedAt: "2026-10-15T12:00:00.000001Z", confirmedAt: "2026-10-15T12:00:00.000999Z",
    changes: [{ table_name: "crawl_candidates", operation: "UPDATE", ordinal: 1, old_row: previous,
      new_row: { ...previous, decided_by: "admin" } }] }], gaps: [] },
  { from: wall, until: "2026-10-15T12:00:01.000Z" });
  expect(result.intervals[0].until).toBe("2026-10-15T12:00:00.000999Z");
  expect(result.coverage).toBe("missing");
});

it("includes the interruption caused by replacing a stale running owner in the claim limit", () => {
  const projection = readinessFixture();
  projection.tables.crawl_review_attempts = [1, 2].map(id => attempt(projection, { id, state: "superseded", error_code: "owner_changed", completed_at: wall }));
  projection.tables.crawl_review_attempts.push(attempt(projection, { id: 3, state: "running", error_code: null, lease_token: "old-owner" }));
  expect(deriveReplayReadiness(projection, wall).first.modelReady).toBe(0);
});

it("does not admit a changed-source running claim owned by the same live job", () => {
  const projection = readinessFixture(), running = attempt(projection, { state: "running", lease_token: "same-owner", error_code: null });
  running.source = { ...(running.source as object), documentId: 99 };
  projection.tables.crawl_review_attempts = [running];
  projection.tables.jobs = [row(dbSchema.jobs, { name: "crawl-agent-review", lease_token: "same-owner", locked_at: wall })] as typeof projection.tables.jobs;
  expect(deriveReplayReadiness(projection, wall).first.modelReady).toBe(0);
});

const initial = (projection: ReplayReadinessProjection) => ({ projection, capturedAt: wall, ...readinessProjectionHashes(projection, wall) });
it("records an actual zero-ready interval before retry expiry without a periodic positive sample", () => {
  const projection = readinessFixture();
  projection.tables.crawl_review_attempts = [attempt(projection, { retry_after: "2026-10-15T12:00:01.000Z" })];
  const result = reduceReplayReadinessCoverage(initial(projection), {transactions: [], gaps: []},
    {from: wall, until: "2026-10-15T12:00:02.000Z"});
  expect(result.coverage).toBe("starved");
  expect(result.intervals.map(row => row.firstReadyLower)).toEqual([0, 1]);
  expect(result.readyAtByInput[0].at).toBe("2026-10-15T12:00:01.000Z");
});

it("expires owner-change history on the wall clock and keeps source validity on the frozen clock", () => {
  const projection = readinessFixture();
  projection.tables.crawl_review_attempts = [1, 2, 3].map(id => attempt(projection, {id, state: "superseded",
    error_code: "owner_changed", completed_at: "2026-10-14T12:00:01.000Z"}));
  expect(deriveReplayReadiness(projection, wall).first.modelReady).toBe(0);
  expect(deriveReplayReadiness(projection, "2026-10-15T12:00:01.000Z").first.modelReady).toBe(1);
});

it("invalidates the old lease-expiry timer when an actual heartbeat extends locked_at", () => {
  const projection = readinessFixture();
  projection.tables.crawl_review_attempts = [attempt(projection, {state: "running", lease_token: "lease", error_code: null})];
  const job = row(dbSchema.jobs, {name: "crawl-agent-review", requested_version: 1, processed_version: 0, lease_token: "lease", locked_at: wall});
  projection.tables.jobs = [job];
  const result = reduceReplayReadinessCoverage(initial(projection), {transactions: [{seq: 7, txKey: "heartbeat",
    txStartedAt: "2026-10-15T12:00:30.000Z", recordedAt: "2026-10-15T12:00:30.000Z", confirmedAt: "2026-10-15T12:00:30.001Z",
    changes: [{table_name: "jobs", operation: "UPDATE", ordinal: 1, old_row: job, new_row: {...job, locked_at: "2026-10-15T12:00:30.000Z"}}]}], gaps: []},
  {from: wall, until: "2026-10-15T12:02:30.000Z"});
  expect(result.intervals.find(row => row.from === "2026-10-15T12:01:30.000001Z")?.firstReadyLower).toBe(0);
  expect(result.readyAtByInput[0].at).toBe("2026-10-15T12:02:00.000001Z");
});

it("preserves restart gaps even when both surrounding states have positive supply", () => {
  const result = reduceReplayReadinessCoverage(initial(readinessFixture()), {transactions: [], gaps: [
    {from: "2026-10-15T12:00:01.000Z", until: "2026-10-15T12:00:02.000Z", reason: "restart"}]},
  {from: wall, until: "2026-10-15T12:00:03.000Z"});
  expect(result.coverage).toBe("missing");
  expect(result.intervals.map(row => row.status)).toEqual(["known", "unknown", "known"]);
  expect(result.readyAtByInput[0].at).toBe(wall);
});

function secondFixture() {
  const projection = readinessFixture(), settings = projection.tables.crawl_settings[0].values as Record<string, never>;
  settings.secondReview = {...settings.secondReview as object, enabled: true,
    voters: [{provider: "abcllm", model: "model-two"}], fallbacks: [{provider: "abcllm", model: "model-three"}]} as never;
  const frozen = projection.universe[0].frozenInput as unknown as Parameters<typeof secondReviewGeneration>[1];
  projection.tables.crawl_review_attempts = [attempt(projection, {state: "succeeded", error_code: null,
    outcome: {decision: "approve", reason: "ready", evidenceIds: ["product"]}})];
  projection.tables.second_reviews = [row(dbSchema.secondReviews, {id: 1, candidate_id: 1, repo: "ready/app", trigger: "ai_approved",
    first_attempt_id: 1, first_decision: "approve", first_model: "model-one", input_hash: frozen.inputHash,
    generation_key: secondReviewGeneration(1, frozen, "ai_approved"), provider: "abcllm", model: "model-two",
    failure_count: 0, status: "pending", signals: [], created_at: wall})];
  projection.tables.jobs.push(row(dbSchema.jobs, {name: "second-review", requested_version: 1, processed_version: 0}));
  return projection;
}
it("counts the actual AI2 generation and rejects human, disabled, wrong-first and stale fallback roots", () => {
  const projection = secondFixture();
  expect(deriveReplayReadiness(projection, wall).second.modelReady).toBe(1);
  const changed = structuredClone(projection); changed.tables.second_reviews[0].first_attempt_id = 99;
  expect(deriveReplayReadiness(changed, wall).second.modelReady).toBe(0);
  changed.tables.second_reviews[0].first_attempt_id = 1; changed.tables.crawl_candidates[0].decided_by = "admin";
  expect(deriveReplayReadiness(changed, wall).second.modelReady).toBe(0);
  const disabled = structuredClone(projection);
  (disabled.tables.crawl_settings[0].values as {secondReview: {enabled: boolean}}).secondReview.enabled = false;
  expect(deriveReplayReadiness(disabled, wall).second.modelReady).toBe(0);
  const fallback = structuredClone(projection), root = fallback.tables.second_reviews[0];
  root.status = "resolved"; root.resolution = "fallback";
  fallback.tables.second_reviews.push({...root, id: 2, model: "model-three", fallback_for_id: 1, status: "pending", resolution: null});
  expect(deriveReplayReadiness(fallback, wall).second.modelReady).toBe(1);
  root.generation_key = "old-generation";
  expect(deriveReplayReadiness(fallback, wall).second.modelReady).toBe(0);
});

it("uses the actual second-review job not_before boundary", () => {
  const projection = secondFixture();
  projection.tables.jobs = [row(dbSchema.jobs, {name: "second-review", requested_version: 1, processed_version: 0, not_before: "2026-10-15T12:00:01.000Z"})];
  expect(deriveReplayReadiness(projection, wall).second.modelReady).toBe(0);
  expect(deriveReplayReadiness(projection, "2026-10-15T12:00:01.000Z").second.modelReady).toBe(1);
});

it("blocks absent or consumed requests and does not assume an initial live owner belongs to this runner", () => {
  const projection = readinessFixture();
  projection.tables.jobs = [];
  expect(deriveReplayReadiness(projection, wall).first.modelReady).toBe(0);
  projection.tables.jobs = [row(dbSchema.jobs, {name: "crawl-agent-review", requested_version: 3, processed_version: 3})];
  expect(deriveReplayReadiness(projection, wall).first.blockedReasons.job_not_requested).toBe(1);
  projection.tables.jobs[0].lease_token = "active-owner"; projection.tables.jobs[0].locked_at = wall;
  expect(deriveReplayReadiness(projection, wall).first.modelReady).toBe(0);
  expect(deriveReplayReadiness(projection, "2026-10-15T12:01:30.000001Z").first.modelReady).toBe(0);
});

it("allows only a current-run job claim proved by actual OLD/NEW changes to continue its tick", () => {
  const projection = readinessFixture(), before = projection.tables.jobs[0];
  before.runs = 0;
  const claimed = {...before, runs: 1, lease_token: "current-owner", locked_at: wall};
  const result = reduceReplayReadinessCoverage(initial(projection), {transactions: [{seq: 1, txKey: "actual-claim", txStartedAt: wall,
    recordedAt: "2026-10-15T12:00:00.000001Z", confirmedAt: "2026-10-15T12:00:00.000002Z",
    changes: [{table_name: "jobs", operation: "UPDATE", ordinal: 1, old_row: before, new_row: claimed}]}], gaps: []},
  {from: wall, until: "2026-10-15T12:00:01.000Z"});
  expect(result.intervals.at(-1)?.firstReadyLower).toBe(1);
});

it("refuses to certify a rounded JSON integer in a complete database row", () => {
  const projection = readinessFixture(); projection.tables.jobs[0].requested_version = Number.MAX_SAFE_INTEGER + 1;
  expect(() => readinessProjectionHashes(projection, wall)).toThrow("replay_readiness_unsafe_integer");
});

function secondCall(projection: ReplayReadinessProjection, overrides: Record<string, unknown> = {}) {
  const identity = projection.universe[0], second = projection.tables.second_reviews[0];
  return {run_id: "unit", call_id: "second-call", candidate_id: identity.candidateId, first_attempt_id: 1,
    input_hash: identity.inputHash, source_revision_hash: identity.sourceRevisionHash, stage: "second", provider: "abcllm", model: "model-two",
    second_review_id: 1, generation_key: second.generation_key, vote: 1, request_hash: "0".repeat(64), token_upper_bound: 100,
    state: "settled", dispatched_at: wall, settled_at: "2026-10-15T12:00:00.000500Z", input_tokens: 1, output_tokens: 1,
    result_ok: false, result_hash: null, result_decision_hash: null, failure_class: "technical", ...overrides} as ReplayReadinessProjection["tables"]["capacity_calls"][number];
}

it("does not treat an AI2 cancellation, whose writer is deliberately skipped, as an unrecorded result", () => {
  const projection = secondFixture();
  projection.tables.capacity_calls = [secondCall(projection, {failure_class: "cancelled"})];
  expect(deriveReplayReadiness(projection, wall).second.modelReady).toBe(1);
});

it("uses actual failure-count transitions for a reopened AI2 retry instead of comparing host and DB result clocks", () => {
  const projection = secondFixture(), original = projection.tables.second_reviews[0];
  original.failure_count = 1; original.reviewed_at = "2026-10-15T11:00:00.000Z";
  const failed = {...original, failure_count: 2, status: "failed", reviewed_at: wall, error_code: "timeout"};
  const result = reduceReplayReadinessCoverage(initial(projection), {transactions: [
    {seq: 1, txKey: "settled", txStartedAt: "2026-10-15T12:00:00.000001Z", recordedAt: "2026-10-15T12:00:00.000501Z", confirmedAt: "2026-10-15T12:00:00.000600Z",
      changes: [{table_name: "capacity_calls", operation: "INSERT", ordinal: 1, old_row: null, new_row: secondCall(projection)}]},
    {seq: 2, txKey: "failed-writer", txStartedAt: "2026-10-15T12:00:00.000601Z", recordedAt: "2026-10-15T12:00:00.000701Z", confirmedAt: "2026-10-15T12:00:00.000800Z",
      changes: [{table_name: "second_reviews", operation: "UPDATE", ordinal: 1, old_row: original, new_row: failed}]},
    {seq: 3, txKey: "retry", txStartedAt: "2026-10-15T12:05:00.000001Z", recordedAt: "2026-10-15T12:05:00.000002Z", confirmedAt: "2026-10-15T12:05:00.000003Z",
      changes: [{table_name: "second_reviews", operation: "UPDATE", ordinal: 1, old_row: failed, new_row: {...failed, status: "pending"}}]},
  ], gaps: []}, {from: wall, until: "2026-10-15T12:05:01.000Z"});
  expect(result.intervals.at(-1)?.secondReadyLower).toBe(1);
  expect(result.intervals.find(row => row.from === "2026-10-15T12:00:00.000600Z")?.secondReadyLower).toBe(0);
});

it("refuses an environment-only first reviewer that is absent from the fixed projection", () => {
  const projection = readinessFixture(); delete (projection.tables.crawl_settings[0].values as {firstReview?: unknown}).firstReview;
  expect(() => deriveReplayReadiness(projection, wall)).toThrow("replay_readiness_explicit_first_reviewer_required");
});

it("normalizes only reviewConcurrency and named wall-relative timers in the comparison digest", () => {
  const projection = readinessFixture();
  (projection.tables.crawl_settings[0].values as {reviewConcurrency: number}).reviewConcurrency = 1;
  projection.tables.jobs = [row(dbSchema.jobs, {name: "crawl-agent-review", locked_at: wall, not_before: "2026-10-15T12:00:01.000Z", runs: 0})];
  const hashes = readinessProjectionHashes(projection, wall), concurrency = structuredClone(projection);
  (concurrency.tables.crawl_settings[0].values as {reviewConcurrency: number}).reviewConcurrency = 2;
  expect(readinessProjectionHashes(concurrency, wall).comparisonStateHash).toBe(hashes.comparisonStateHash);
  expect(readinessProjectionHashes(concurrency, wall).initialStateHash).not.toBe(hashes.initialStateHash);
  concurrency.tables.jobs[0].runs = 1;
  expect(readinessProjectionHashes(concurrency, wall).comparisonStateHash).not.toBe(hashes.comparisonStateHash);
  expect(readinessProjectionHashes(projection, "2026-10-15T12:00:00.001Z").comparisonStateHash).not.toBe(hashes.comparisonStateHash);
});
