import { expect, it, vi } from "vitest";
const replayBoundary = vi.hoisted(() => ({ active: false, transaction: vi.fn() }));
vi.mock("@/lib/db", async original => ({ ...await original<typeof import("@/lib/db")>(), db: { transaction: replayBoundary.transaction } }));
vi.mock("@/lib/db/replay-scope", async original => ({ ...await original<typeof import("@/lib/db/replay-scope")>(),
  currentReplayDb: () => replayBoundary.active ? {} : undefined }));
import { secondReviewPolicyHash, secondReviewBinding, claimItemSecondReview, renewSecondReviewOwnership,
  assertSecondReviewOwnership, finishSecondReviewOwnership, type Ai2ItemLease } from "@/lib/crawl/second-review-ownership";
import { itemBindingHash, itemWorkKey } from "@/lib/jobs/items/types";
import type { ItemStageGuard } from "@/lib/jobs/items/repository";
import { createReviewInput, reviewPolicyHash, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { secondReviewGeneration, type SecondReviewDomainContext } from "@/lib/crawl/second-review-input";
import type { CrawlCandidate, CrawlDocument, CrawlReviewAttempt, SecondReview } from "@/lib/db/schema";

function settings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm", model: "second-model" }],
      fallbacks: [{ provider: "abcllm", model: "backup-one" }, { provider: "abcllm", model: "backup-two" }] } };
}

function context(published = false): SecondReviewDomainContext {
  const now = new Date(), policy = settings();
  const candidate: CrawlCandidate = { id: 11, repo: "ownership/app", productUrl: "https://ownership.test",
    state: published ? "published" : "approved", reason: "passed", decidedBy: "auto", signals: {},
    publishedSlug: published ? "ownership-app" : null, judgedAt: now, decidedAt: now, updatedAt: now };
  const document: CrawlDocument = { id: 21, repo: candidate.repo, productUrl: candidate.productUrl,
    fetchedAt: now, pageStatus: 200, repoMeta: { description: "A task application", stargazers_count: 12 },
    pageMeta: { title: "Ownership", description: "Create projects and manage tasks", textSample: "Manage projects online" } };
  const input = createReviewInput(candidate, document, policy, { scan: null, observations: [] }, now);
  const first: CrawlReviewAttempt = { id: 31, candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "abcllm", model: "first-model", attemptNumber: 1, reusedFromAttemptId: null,
    outcome: { decision: "approve", confidence: 0.94, reason: "A task application", evidenceIds: ["product"] },
    errorCode: null, inputTokens: null, outputTokens: null, costUsd: null, actor: null, reason: null,
    leaseToken: "historical-first", startedAt: now, completedAt: now, retryAfter: null, validUntil: input.validUntil };
  const row: SecondReview = { id: 41, candidateId: candidate.id, repo: candidate.repo,
    publishedSlug: candidate.publishedSlug, trigger: published ? "sample" : "ai_approved", signals: [],
    firstDecision: "approve", firstConfidence: published ? null : 0.94, firstModel: published ? null : first.model,
    firstAttemptId: published ? null : first.id,
    generationKey: secondReviewGeneration(published ? null : first.id, input, published ? "sample" : "ai_approved"),
    inputHash: published ? "a".repeat(64) : input.inputHash, provider: "abcllm", model: "second-model",
    secondDecision: null, secondConfidence: null, secondReason: null, errorCode: null, errorDetail: null,
    fallbackForId: null, failureCount: 0, status: "pending", resolvedBy: null, resolution: null,
    createdAt: now, reviewedAt: null, resolvedAt: null };
  return { row, candidate, document, settings: policy, input, first: published ? null : first, root: row,
    publishedProductId: published ? 51 : null };
}

it("binds AI2 policy changes that leave the first-review policy unchanged", () => {
  const before = settings(), after = structuredClone(before);
  after.secondReview.agreeAt = 0.87;
  expect(reviewPolicyHash(before)).toBe(reviewPolicyHash(after));
  expect(secondReviewPolicyHash(before)).not.toBe(secondReviewPolicyHash(after));
});

it("preserves fallback priority in the composite policy", () => {
  const before = settings(), after = structuredClone(before);
  after.secondReview.fallbacks!.reverse();
  expect(secondReviewPolicyHash(before)).not.toBe(secondReviewPolicyHash(after));
  expect(secondReviewPolicyHash(before)).toBe(secondReviewPolicyHash(structuredClone(before)));
});

it.each(["enabled", "reviewMode", "firstReview", "voters"] as const)("binds the current %s policy", field => {
  const before = settings(), after = structuredClone(before);
  if (field === "enabled") after.enabled = false;
  if (field === "reviewMode") after.reviewMode = "observe";
  if (field === "firstReview") after.firstReview = { provider: "abcllm", model: "other-first" };
  if (field === "voters") after.secondReview.voters = [{ provider: "abcllm", model: "other-second" }];
  expect(secondReviewPolicyHash(before)).not.toBe(secondReviewPolicyHash(after));
});

it("uses the actual current input and first attempt for an AI2 item binding", () => {
  const ctx = context(), binding = secondReviewBinding(ctx);
  expect(binding).toEqual({ stage: "ai2", secondReviewId: ctx.row.id, candidateId: ctx.candidate.id,
    source: { kind: "first_attempt", firstAttemptId: ctx.first!.id }, inputHash: ctx.input.inputHash,
    sourceRevisionHash: ctx.input.sourceRevisionHash, policyHash: secondReviewPolicyHash(ctx.settings),
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    reviewer: { provider: ctx.row.provider, model: ctx.row.model }, generationKey: ctx.row.generationKey,
    vote: ctx.row.id, fallbackForId: null });
});

it("uses the published slug and actual input rather than the row placeholder", () => {
  const ctx = context(true), binding = secondReviewBinding(ctx);
  expect(binding.source).toEqual({ kind: "published", slug: ctx.row.publishedSlug, productId: ctx.publishedProductId });
  expect(binding.inputHash).toBe(ctx.input.inputHash);
  expect(binding.inputHash).not.toBe(ctx.row.inputHash);
});

it("keeps a fallback on the original primary vote", () => {
  const ctx = context();
  ctx.root = { ...ctx.row, status: "resolved", resolution: "fallback" };
  ctx.row = { ...ctx.row, id: 42, fallbackForId: ctx.root.id, model: "backup-one" };
  expect(secondReviewBinding(ctx)).toMatchObject({ secondReviewId: 42, vote: 41, fallbackForId: 41 });
});

it("refuses nullable legacy reviewer defaults instead of inventing binding authority", () => {
  const ctx = context();
  expect(() => secondReviewBinding({ ...ctx, row: { ...ctx.row, provider: null, model: null } })).toThrow();
});

it("rejects every item API in replay before opening a database transaction", async () => {
  const ctx = context(), binding = secondReviewBinding(ctx);
  const owner = { instanceId: "unit-only", bootId: "00000000-0000-4000-8000-000000000041" };
  const lease: Ai2ItemLease = { stage: "ai2", binding, bindingHash: itemBindingHash(binding), workKey: itemWorkKey(binding),
    owner, token: "00000000-0000-4000-8000-000000000042", stageEpoch: 1, itemEpoch: 1, leaseUntil: new Date() };
  const proof = { binding, rowIdentityHash: "a".repeat(64), ownership: { kind: "item" as const, lease } };
  replayBoundary.transaction.mockClear();
  replayBoundary.active = true;
  try {
    await expect(claimItemSecondReview(ctx.row.id, owner, 1_000)).rejects.toThrow("replay_item_execution_unsupported");
    await expect(renewSecondReviewOwnership(proof, 1_000)).rejects.toThrow("replay_item_execution_unsupported");
    // No transaction is supplied: the boundary must reject before touching it.
    await expect(assertSecondReviewOwnership(undefined!, {} as ItemStageGuard, proof, ctx.row)).rejects.toThrow("replay_item_execution_unsupported");
    await expect(finishSecondReviewOwnership(undefined!, {} as ItemStageGuard, proof)).rejects.toThrow("replay_item_execution_unsupported");
    expect(replayBoundary.transaction).not.toHaveBeenCalled();
  } finally { replayBoundary.active = false; }
});
