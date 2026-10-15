import { expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createReviewInput, reviewHash, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { secondReviewBinding } from "@/lib/crawl/second-review-ownership";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { ReplayCombinedState } from "@/lib/operations/pipeline-replay-combined-capture";
import { assessReplayAi2Target } from "@/lib/operations/pipeline-replay-ai2-target";

const reference = "2001-11-01T00:00:00.000Z", wall = "2026-10-16T01:02:03.123456Z", targetId = 21;
type RawRow = ReplayCombinedState["domain"]["tables"]["jobs"][number];
function row(table: Parameters<typeof getTableColumns>[0], values: Record<string, unknown>): RawRow {
  return { ...Object.fromEntries(Object.values(getTableColumns(table)).map(column => [column.name, null])), ...values } as RawRow;
}
function hydrate<T>(raw: RawRow, table: Parameters<typeof getTableColumns>[0]): T {
  return Object.fromEntries(Object.entries(getTableColumns(table)).map(([key, column]) => [key,
    raw[column.name] === null ? null : column.dataType === "date" ? new Date(String(raw[column.name]))
      : column.mapFromDriverValue(raw[column.name])])) as T;
}
function fixture() {
  const candidate = row(schema.crawlCandidates, { id: 1, repo: "target/app", product_url: "https://target.example",
    state: "approved", reason: "passed", decided_by: "auto", judged_at: reference, updated_at: reference });
  const document = row(schema.crawlDocuments, { id: 1, repo: "target/app", product_url: "https://target.example",
    fetched_at: "2001-10-31T23:59:59.000Z", page_status: 200,
    repo_meta: { description: "A deployed task tracker", homepage: "https://target.example", fork: false,
      private: false, archived: false, owner: { type: "User" }, stargazers_count: 10 },
    page_meta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create a project and manage tasks in the application.", readmeSample: "An online task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION } });
  const settings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce" as const,
    firstReview: { provider: "abcllm" as const, model: "model-one" },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm" as const, model: "model-two" }] } };
  const typedCandidate = hydrate<schema.CrawlCandidate>(candidate, schema.crawlCandidates);
  const typedDocument = hydrate<schema.CrawlDocument>(document, schema.crawlDocuments);
  const input = createReviewInput(typedCandidate, typedDocument, settings, { scan: null, observations: [] }, new Date(reference));
  const frozenInput = JSON.parse(JSON.stringify(input));
  const first = row(schema.crawlReviewAttempts, { id: 11, candidate_id: 1, kind: "automatic", state: "succeeded",
    input_hash: input.inputHash, source_revision_hash: input.sourceRevisionHash, policy_hash: input.policyHash,
    snapshot: frozenInput.snapshot, source: frozenInput.source, provider: "abcllm", model: "model-one",
    prompt_version: REVIEW_PROMPT_VERSION, rules_version: REVIEW_RULES_VERSION, outcome: { decision: "approve", confidence: 0.95 },
    attempt_number: 1, valid_until: input.validUntil.toISOString(), started_at: reference, completed_at: reference });
  const second = row(schema.secondReviews, { id: targetId, candidate_id: 1, repo: "target/app", trigger: "ai_approved",
    first_attempt_id: 11, first_decision: "approve", first_confidence: 0.95, first_model: "model-one",
    input_hash: input.inputHash, generation_key: secondReviewGeneration(11, input, "ai_approved"),
    provider: "abcllm", model: "model-two", failure_count: 0, status: "pending", created_at: reference });
  const state: ReplayCombinedState = { kind: "pipeline-replay-combined-state", version: 1, domain: {
    version: 1, referenceTime: reference, universe: [{ candidateId: 1, inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, frozenInput, frozenHash: reviewHash(frozenInput) }],
    tables: { crawl_settings: [row(schema.crawlSettings, { id: 1, values: settings })], crawl_candidates: [candidate],
      crawl_documents: [document], crawl_review_attempts: [first], second_reviews: [second], agent_repository_scans: [],
      agent_repository_observations: [], products: [], crawl_frontier: [], jobs: [], operations_observations: [], capacity_calls: [] },
  }, items: { kind: "pipeline-replay-item-state", version: 1, tables: {
    pipeline_stage_modes: (["fetch", "ai1", "ai2"] as const).map(stage => ({ stage, mode: "items", draining_from: null,
      epoch: 1, writer_contract_version: 1, updated_at: wall })), pipeline_item_leases: [],
  } } };
  const binding = secondReviewBinding({ row: hydrate<schema.SecondReview>(second, schema.secondReviews),
    candidate: typedCandidate, document: typedDocument, settings, input,
    first: hydrate<schema.CrawlReviewAttempt>(first, schema.crawlReviewAttempts),
    root: hydrate<schema.SecondReview>(second, schema.secondReviews), publishedProductId: null });
  return { state, binding };
}

it("assesses a current valid target using the existing full composite binding without mutating input", () => {
  const { state, binding } = fixture(), before = structuredClone(state);
  expect(assessReplayAi2Target(state, targetId, wall))
    .toEqual({ kind: "eligible", targetId, binding, inputMembership: "included" });
  expect(state).toEqual(before);
});

it("keeps a valid target outside the frozen universe eligible and returns an independent binding", () => {
  const { state, binding } = fixture(); state.domain.universe = [];
  const result = assessReplayAi2Target(state, targetId, wall);
  expect(result).toEqual({ kind: "eligible", targetId, binding, inputMembership: "outside" });
  if (result.kind !== "eligible") throw new Error("expected eligible fixture");
  result.binding.reviewer.model = "changed-copy";
  expect(state.domain.tables.second_reviews[0].model).toBe("model-two");
});

it("requires AI2 items contract while preserving the other stages as independent inputs", () => {
  for (const [mode, contract] of [["legacy", 1], ["items", 0], ["draining", 1]] as const) {
    const { state } = fixture(), stage = state.items.tables.pipeline_stage_modes.find(row => row.stage === "ai2")!;
    stage.mode = mode; stage.writer_contract_version = contract; stage.draining_from = mode === "draining" ? "items" : null;
    expect(assessReplayAi2Target(state, targetId, wall)).toEqual({ kind: "ineligible", targetId, reason: "stage_inactive" });
  }
});

it("returns not_pending for absent or terminal targets after strict state validation", () => {
  const { state } = fixture();
  expect(assessReplayAi2Target(state, targetId + 1, wall)).toEqual({ kind: "ineligible", targetId: targetId + 1, reason: "not_pending" });
  state.domain.tables.second_reviews[0].status = "resolved";
  expect(assessReplayAi2Target(state, targetId, wall)).toEqual({ kind: "ineligible", targetId, reason: "not_pending" });
});

it("rejects malformed combined state, unsafe IDs and invalid UTC wall samples", () => {
  const { state } = fixture();
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])
    expect(() => assessReplayAi2Target(state, id, wall)).toThrow();
  for (const time of ["2026-02-30T01:02:03.123Z", "2026-10-16T01:02:03.12Z", "2026-10-16T01:02:03.123+00:00", "invalid"])
    expect(() => assessReplayAi2Target(state, targetId, time)).toThrow();
  const extra = structuredClone(state); Object.assign(extra, { ready: true });
  expect(() => assessReplayAi2Target(extra, targetId, wall)).toThrow();
});

it("rejects conflicting ambient semantic clocks and keeps the same-reference scope usable", async () => {
  const { state } = fixture(); state.domain.tables.second_reviews = [];
  await withReviewReplayContext({ referenceTime: new Date("2002-11-01T00:00:00.000Z") }, async () => {
    expect(() => assessReplayAi2Target(state, targetId, wall)).toThrow("replay_clock_scope_conflict");
  });
  await withReviewReplayContext({ referenceTime: new Date(reference) }, async () => {
    expect(assessReplayAi2Target(state, targetId, wall)).toEqual({ kind: "ineligible", targetId, reason: "not_pending" });
  });
});
