import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { expect, it } from "vitest";
import { firstReviewers, firstReviewerKey, hasFirstReviewer, selectFirstReviewer, firstReviewDeferralIsLocal, firstReviewPoolPosition, firstReviewCandidates } from "@/lib/crawl/first-reviewers";
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { secondReviewPolicyHash } from "@/lib/crawl/second-review-ownership";
import { resolveModelSlots } from "@/lib/operations/stage-registry";

const primary = { provider: "abcllm" as const, model: "primary-review-model" };
const extra = { provider: "abcllm" as const, model: "extra-review-model" };
const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: primary };
const expanded = { ...settings, firstReviewAdditional: [extra] };

it("adds bounded workers without replacing the primary or changing input/AI2 policy generations", () => {
  expect(firstReviewers(settings)).toEqual([primary]);
  expect(firstReviewers(expanded)).toEqual([primary, extra]);
  expect(firstReviewers({}, primary)).toEqual([primary]);
  expect(reviewPolicyHash(expanded)).toBe(reviewPolicyHash(settings));
  expect(secondReviewPolicyHash(expanded)).toBe(secondReviewPolicyHash(settings));
  expect(resolveModelSlots(expanded, {}).filter(slot => slot.stage === "first").map(slot => slot.model))
    .toEqual([primary.model, extra.model]);
  expect(resolveModelSlots(expanded, {}).find(slot => slot.stage === "audit")?.model).toBe(primary.model);
});

it("validates at most two extras and rejects aliases of the same underlying model", () => {
  expect(crawlSettingsSchema.safeParse(expanded).success).toBe(true);
  expect(crawlSettingsSchema.safeParse({ ...expanded, firstReviewAdditional: [extra, extra, extra] }).success).toBe(false);
  expect(crawlSettingsSchema.safeParse({ ...settings, firstReviewAdditional: [{ ...primary, model: "[supa] " + primary.model }] }).success).toBe(false);
  expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, firstReviewAdditional: [extra] }).success).toBe(false);
});

it("assigns untouched candidates stably and pins previous attempts even when pool order differs", () => {
  expect([1, 2, 3, 4].map(id => selectFirstReviewer([primary, extra], id))).toEqual([primary, extra, primary, extra]);
  expect(selectFirstReviewer([primary, extra], 1, [extra])).toEqual(extra);
  expect(selectFirstReviewer([extra, primary], 1, [primary])).toEqual(primary);
  expect(hasFirstReviewer([primary, extra], extra)).toBe(true);
});

it("protects active/indeterminate intents of removed or unreadable models without reassignment", () => {
  expect(selectFirstReviewer([primary, extra], 1, [primary], [extra])).toEqual(extra);
  expect(selectFirstReviewer([primary], 1, [primary], [extra])).toBeNull();
  expect(selectFirstReviewer([primary, extra], 1, [], [{ provider: null, model: null }])).toBeNull();
  expect(selectFirstReviewer([primary, extra], 1, [], [primary, extra])).toBeNull();
});

it("moves only never-sent candidates off a blocked model and never unpins sent or retried work", () => {
  const third = { provider: "abcllm" as const, model: "third-review-model" };
  const blocked = new Set([firstReviewerKey(extra)]);
  const untouched = { blocked, untouched: true };
  // Candidate 2 would go to `extra`; it rotates to the next unblocked model.
  expect(selectFirstReviewer([primary, extra, third], 2, [], [], untouched)).toEqual(third);
  expect(selectFirstReviewer([primary, extra], 2, [], [], untouched)).toEqual(primary);
  // Unblocked fixed slots are unchanged.
  expect([1, 3].map(id => selectFirstReviewer([primary, extra], id, [], [], untouched))).toEqual([primary, primary]);
  // Already sent (active intent incl. indeterminate) or retried candidates stay pinned to the blocked model.
  expect(selectFirstReviewer([primary, extra], 2, [], [extra], untouched)).toEqual(extra);
  expect(selectFirstReviewer([primary, extra], 2, [extra], [], untouched)).toEqual(extra);
  // An attempt anywhere in history (caller's untouched=false) keeps the fixed slot.
  expect(selectFirstReviewer([primary, extra], 2, [], [], { blocked, untouched: false })).toEqual(extra);
  // When every model is blocked, keep the fixed slot and wait instead of overloading another.
  expect(selectFirstReviewer([primary, extra], 2, [], [], { blocked: new Set([firstReviewerKey(primary), firstReviewerKey(extra)]), untouched: true }))
    .toEqual(extra);
});

it("claim-time re-check keeps a rerouted never-sent candidate and still refuses a pinned one", () => {
  // The claim re-check treats every pool model except the claimed one as "avoid".
  const others = (claimed: typeof primary) => new Set([primary, extra].filter(row => row.model !== claimed.model).map(firstReviewerKey));
  expect(selectFirstReviewer([primary, extra], 2, [], [], { blocked: others(primary), untouched: true })).toEqual(primary);
  expect(selectFirstReviewer([primary, extra], 2, [], [], { blocked: others(extra), untouched: true })).toEqual(extra);
  // A candidate with an attempt or an active intent on `extra` cannot be claimed for `primary`.
  expect(selectFirstReviewer([primary, extra], 2, [extra], [], { blocked: others(primary), untouched: false })).toEqual(extra);
  expect(selectFirstReviewer([primary, extra], 2, [], [extra], { blocked: others(primary), untouched: false })).toEqual(extra);
});

it("keeps global draining/policy/owner refusals global while allowing another model past a local capacity wait", () => {
  for (const reason of ["draining", "disabled", "policy_changed", "owner_unavailable"] as const)
    expect(firstReviewDeferralIsLocal(reason)).toBe(false);
  for (const reason of ["capacity", "queue_full", "unmapped", "provider_contract_unavailable"] as const)
    expect(firstReviewDeferralIsLocal(reason)).toBe(true);
});

it("accepts only bounded, lossless keyset timestamps and ignores malformed cursor metadata", () => {
  const position = { id: 12, reviewed: false, updatedAt: "2026-10-27 00:00:00.123456", ceiling: 20 };
  expect(firstReviewPoolPosition(position)).toEqual(position);
  expect(firstReviewPoolPosition({ ...position, id: 21 })).toBeNull();
  expect(firstReviewPoolPosition({ ...position, updatedAt: "invalid" })).toBeNull();
});


it("does not move retries from removed or unreadable models to an available pool member", () => {
  const avoid = { blocked: new Set([firstReviewerKey(extra)]), untouched: true };
  expect(selectFirstReviewer([primary], 2, [extra], [], avoid)).toBeNull();
  expect(selectFirstReviewer([primary, extra], 2, [{ provider: null, model: null }], [], avoid)).toBeNull();
  expect(selectFirstReviewer([primary, extra], 2, [{ ...extra, model: "removed" }, primary], [], avoid)).toBeNull();
});

it("configures candidate suggestions while preserving the stored pool and all retry assignment rules", () => {
  const defaults = firstReviewCandidates({});
  expect(defaults.map(row => row.model)).toEqual(["[supa] Qwen3.8-27B-NVFP4", "[MLX] gpt-oss-120b", "sonnet", "opus", "grok-4.7"]);
  const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS,
    candidates: { "first-review": ["connect:opus"] } }) };
  expect(firstReviewCandidates(env)).toEqual([{ provider: "claude-cli", model: "opus" }]);
  expect(firstReviewers(expanded)).toEqual([primary, extra]);
  expect(selectFirstReviewer([primary, extra], 1, [extra])).toEqual(extra);
});
