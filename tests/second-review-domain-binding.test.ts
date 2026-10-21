import { expect, it } from "vitest";
import type { CrawlCandidate, CrawlDocument, CrawlReviewAttempt, SecondReview } from "@/lib/db/schema";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { publishedInputHash } from "@/lib/crawl/second-review";
import { secondReviewGeneration, secondReviewInputMatches } from "@/lib/crawl/second-review-input";

const now = new Date("2026-10-16T03:00:00.000Z");

function fixture(published = false) {
  const settings: CrawlSettings = {
    ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" },
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true,
      voters: [{ provider: "abcllm", model: "second-model" }],
      fallbacks: [{ provider: "abcllm", model: "backup-model" }] },
  };
  const candidate: CrawlCandidate = { id: 11, repo: "domain-binding/app", productUrl: "https://domain-binding.test",
    state: published ? "published" : "approved", reason: "passed", decidedBy: "auto", signals: {},
    publishedSlug: published ? "domain-binding-app" : null, judgedAt: now, decidedAt: now, updatedAt: now };
  const document: CrawlDocument = { id: 31, repo: candidate.repo, productUrl: candidate.productUrl,
    fetchedAt: new Date(+now - 1_000), pageStatus: 200,
    repoMeta: { description: "A deployed application", stargazers_count: 12, fork: false, archived: false,
      pushed_at: new Date(+now - 60_000).toISOString(), owner: { type: "User" } },
    pageMeta: { title: "Domain Binding", description: "Manage projects and tasks in the application",
      textSample: "Create projects and manage tasks in the application.", repositoryKeys: [candidate.repo] } };
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] }, now);
  const first: CrawlReviewAttempt = { id: 101, candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "abcllm", model: "first-model", attemptNumber: 1, reusedFromAttemptId: null,
    outcome: { decision: "approve", confidence: 0.94, reason: "A deployed application", evidenceIds: ["product"] },
    errorCode: null, inputTokens: 10, outputTokens: 5, costUsd: null, actor: null, reason: null,
    leaseToken: "historical-first-token", startedAt: new Date(+now - 500), completedAt: now,
    retryAfter: null, validUntil: input.validUntil };
  const row: SecondReview = { id: 201, candidateId: candidate.id, repo: candidate.repo,
    publishedSlug: candidate.publishedSlug, trigger: published ? "sample" : "ai_approved", signals: [],
    firstDecision: "approve", firstConfidence: published ? null : first.outcome!.confidence!,
    firstModel: published ? null : first.model, firstAttemptId: published ? null : first.id,
    generationKey: secondReviewGeneration(published ? null : first.id, input, published ? "sample" : "ai_approved"),
    inputHash: published ? publishedInputHash(candidate.publishedSlug!) : input.inputHash,
    provider: "abcllm", model: "second-model", secondDecision: null, secondConfidence: null, secondReason: null, autoOpinion: null,
    errorCode: null, errorDetail: null, fallbackForId: null, failureCount: 0, status: "pending",
    resolvedBy: null, resolution: null, createdAt: now, reviewedAt: null, resolvedAt: null };
  return { row, current: { candidate, document, settings, input, first: published ? null : first } };
}

function fallbackFixture() {
  const value = fixture();
  const root: SecondReview = { ...value.row, status: "resolved", resolution: "fallback", failureCount: 1,
    errorCode: "timeout", reviewedAt: now, resolvedAt: now };
  const row: SecondReview = { ...value.row, id: 202, model: "backup-model", fallbackForId: root.id, failureCount: 1 };
  return { row, current: { ...value.current, root } };
}

it("accepts the actual first verdict and current primary vote", () => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches(row, current, now)).toBe(true);
});

it("accepts a fallback bound to its actual resolved primary root", () => {
  const { row, current } = fallbackFixture();
  expect(secondReviewInputMatches(row, current, now)).toBe(true);
});

it("accepts a published sample with no first attempt and a slug placeholder distinct from actual input", () => {
  const { row, current } = fixture(true);
  expect(row.inputHash).not.toBe(current.input.inputHash);
  expect(secondReviewInputMatches(row, current, now)).toBe(true);
});

it.each([undefined, null])("normalizes missing historical first confidence (%s) to the row's null", confidence => {
  const { row, current } = fixture();
  // Persisted JSON can contain an old null even though new validated outcomes omit it.
  const first = { ...current.first!, outcome: { ...current.first!.outcome!, confidence } as CrawlReviewAttempt["outcome"] };
  expect(secondReviewInputMatches({ ...row, firstConfidence: null }, { ...current, first }, now)).toBe(true);
});

it("accepts a published risk finding with no first attempt", () => {
  const { row, current } = fixture(true);
  expect(secondReviewInputMatches({ ...row, trigger: "risk" }, current, now)).toBe(true);
});

it.each([
  ["ai_decided", "reject"], ["ai_held", "needs_review"],
] as const)("preserves a normal %s first verdict", (trigger, decision) => {
  const { row, current } = fixture();
  const first = { ...current.first!, outcome: { ...current.first!.outcome!, decision } };
  expect(secondReviewInputMatches({ ...row, trigger, firstDecision: decision,
    generationKey: secondReviewGeneration(first.id, current.input, trigger) },
  { ...current, candidate: { ...current.candidate, state: "needs_review" }, first }, now)).toBe(true);
});

it("rejects a resolved fallback root whose ID is not the child's actual primary slot", () => {
  const { row, current } = fallbackFixture();
  expect(secondReviewInputMatches(row, { ...current, root: { ...current.root, id: current.root.id + 1 } }, now)).toBe(false);
});

it("rejects a first confidence different from the actual first verdict", () => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches({ ...row, firstConfidence: 0.51 }, current, now)).toBe(false);
});

it.each([null, ""])("rejects an unpublished first verdict with no identifiable model (%s)", model => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches({ ...row, firstModel: model },
    { ...current, first: { ...current.first!, model } }, now)).toBe(false);
});

it("rejects a vote attached to a different candidate ID despite an identical repository", () => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches({ ...row, candidateId: current.candidate.id + 1 }, current, now)).toBe(false);
});

it.each([
  ["repository", { repo: "other/root" }],
  ["first attempt", { firstAttemptId: 999 }],
  ["trigger", { trigger: "ai_decided" }],
  ["published slug", { publishedSlug: "other-published-generation" }],
  ["first decision", { firstDecision: "reject" }],
  ["first confidence", { firstConfidence: 0.51 }],
  ["first model", { firstModel: "another-first-model" }],
] satisfies [string, Partial<SecondReview>][])("rejects a fallback root with a different %s", (_name, patch) => {
  const { row, current } = fallbackFixture();
  expect(secondReviewInputMatches(row, { ...current, root: { ...current.root, ...patch } }, now)).toBe(false);
});

it.each([
  ["candidate", { candidateId: 999 }],
  ["generation", { generationKey: "a".repeat(64) }],
  ["input", { inputHash: "b".repeat(64) }],
  ["unsettled status", { status: "pending" }],
  ["different resolution", { resolution: "superseded" }],
  ["non-primary root", { fallbackForId: 999 }],
] satisfies [string, Partial<SecondReview>][])("keeps rejecting a fallback root with a different %s", (_name, patch) => {
  const { row, current } = fallbackFixture();
  expect(secondReviewInputMatches(row, { ...current, root: { ...current.root, ...patch } }, now)).toBe(false);
});

it("rejects a first attempt belonging to another candidate", () => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches(row, { ...current, first: { ...current.first!, candidateId: 999 } }, now)).toBe(false);
});

it("rejects a row input hash different from the actual first input", () => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches({ ...row, inputHash: "c".repeat(64) }, current, now)).toBe(false);
});

it("rejects a source document for another repository even when its product URL matches", () => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches(row, { ...current, document: { ...current.document, repo: "other/document" } }, now)).toBe(false);
});

it.each([
  ["actual first ID", { id: 999 }],
  ["first state", { state: "running" }],
  ["first kind", { kind: "admin_override" }],
  ["first provider", { provider: "rules" }],
  ["base policy", { policyHash: "d".repeat(64) }],
  ["prompt", { promptVersion: "old-prompt" }],
  ["rules", { rulesVersion: "old-rules" }],
  ["first model", { model: "different-first" }],
  ["first outcome", { outcome: { decision: "reject", confidence: 0.94, reason: "Different first decision", evidenceIds: ["product"] } }],
] satisfies [string, Partial<CrawlReviewAttempt>][])("keeps rejecting a different %s", (_name, patch) => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches(row, { ...current, first: { ...current.first!, ...patch } }, now)).toBe(false);
});

it("rejects a new actual document revision rather than accepting a matching semantic input alone", () => {
  const { row, current } = fixture();
  const document = { ...current.document, fetchedAt: new Date(+current.document.fetchedAt + 500) };
  const input = createReviewInput(current.candidate, document, current.settings, { scan: null, observations: [] }, now);
  expect(input.inputHash).toBe(current.input.inputHash);
  expect(input.sourceRevisionHash).not.toBe(current.input.sourceRevisionHash);
  expect(secondReviewInputMatches({ ...row, generationKey: secondReviewGeneration(row.firstAttemptId, input, row.trigger) },
    { ...current, document, input }, now)).toBe(false);
});

it("rejects new semantic input generated from the actual document", () => {
  const { row, current } = fixture();
  const document = { ...current.document, pageMeta: { ...current.document.pageMeta, description: "An unrelated news archive" } };
  const input = createReviewInput(current.candidate, document, current.settings, { scan: null, observations: [] }, now);
  expect(input.inputHash).not.toBe(current.input.inputHash);
  expect(secondReviewInputMatches({ ...row, generationKey: secondReviewGeneration(row.firstAttemptId, input, row.trigger) },
    { ...current, document, input }, now)).toBe(false);
});

it("rejects a published sample that unexpectedly binds a first attempt", () => {
  const { row, current } = fixture(true);
  const firstAttemptId = 101;
  expect(secondReviewInputMatches({ ...row, firstAttemptId,
    generationKey: secondReviewGeneration(firstAttemptId, current.input, row.trigger) }, current, now)).toBe(false);
});

it("rejects an approval-gate trigger attached to a published sampling row", () => {
  const { row, current } = fixture(true);
  expect(secondReviewInputMatches({ ...row, trigger: "ai_approved",
    generationKey: secondReviewGeneration(null, current.input, "ai_approved") }, current, now)).toBe(false);
});

it("rejects a sampling trigger attached to an unpublished first verdict", () => {
  const { row, current } = fixture();
  expect(secondReviewInputMatches({ ...row, trigger: "sample",
    generationKey: secondReviewGeneration(row.firstAttemptId, current.input, "sample") },
  { ...current, candidate: { ...current.candidate, state: "needs_review" } }, now)).toBe(false);
});

it("keeps rejecting a changed published slug", () => {
  const { row, current } = fixture(true);
  expect(secondReviewInputMatches({ ...row, publishedSlug: "another-product" }, current, now)).toBe(false);
});

it("keeps primary aliases of the first model out of independent voting", () => {
  const { row, current } = fixture();
  const settings = { ...current.settings, secondReview: { ...current.settings.secondReview,
    voters: [{ provider: "abcllm" as const, model: "[MLX] FIRST-MODEL" }] } };
  expect(secondReviewInputMatches({ ...row, model: "[MLX] FIRST-MODEL" }, { ...current, settings }, now)).toBe(false);
});

it("preserves same-first fallback input admission as a reference-only opinion", () => {
  const { row, current } = fallbackFixture();
  const settings = { ...current.settings, secondReview: { ...current.settings.secondReview,
    fallbacks: [{ provider: "abcllm" as const, model: "[MLX] FIRST-MODEL" }] } };
  expect(secondReviewInputMatches({ ...row, model: "[MLX] FIRST-MODEL" }, { ...current, settings }, now)).toBe(true);
});
