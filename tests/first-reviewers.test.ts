import { expect, it } from "vitest";
import { firstReviewers, hasFirstReviewer, selectFirstReviewer, firstReviewDeferralIsLocal, firstReviewPoolPosition } from "@/lib/crawl/first-reviewers";
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
