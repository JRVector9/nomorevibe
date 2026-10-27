import { expect, it } from "vitest";
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { firstReviewers } from "@/lib/crawl/first-reviewers";
import { combineVerdicts, combineVotes } from "@/lib/crawl/second-review";
import { applyReviewRoutingPreset, GPU_SECOND_REVIEWER, SUPA_FIRST_REVIEWER } from "@/lib/crawl/review-routing-preset";

it("replaces the AI1 pool and AI2 fallback pool while keeping existing operational policy", () => {
  const current = crawlSettingsSchema.parse({
    ...structuredClone(DEFAULT_CRAWL_SETTINGS),
    enabled: true,
    reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
    firstReviewAdditional: [SUPA_FIRST_REVIEWER],
    reviewConcurrency: 3,
    humanReview: { enabled: true, generation: 12 },
    secondReview: {
      ...DEFAULT_CRAWL_SETTINGS.secondReview,
      sampleRate: 0.17,
      includeAiHeld: true,
      agreeAt: 0.91,
      fallbacks: [SUPA_FIRST_REVIEWER],
    },
  });
  const before = structuredClone(current);
  const next = applyReviewRoutingPreset(current);
  expect(crawlSettingsSchema.parse(next)).toEqual(next);
  expect(firstReviewers(next)).toEqual([SUPA_FIRST_REVIEWER]);
  expect(next.secondReview.voters).toEqual([GPU_SECOND_REVIEWER]);
  expect(next.secondReview.fallbacks).toEqual([]);
  expect({ ...next, firstReview: current.firstReview, firstReviewAdditional: current.firstReviewAdditional,
    secondReview: current.secondReview }).toEqual(current);
  expect({ ...next.secondReview, voters: current.secondReview.voters, fallbacks: current.secondReview.fallbacks })
    .toEqual(current.secondReview);
  expect(current).toEqual(before);
});

it("does not enable collection, AI2 or human automation when selecting a model preset", () => {
  const current = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), secondReview: {
    ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false,
  } };
  const next = applyReviewRoutingPreset(current);
  expect(next.enabled).toBe(false);
  expect(next.reviewMode).toBe("off");
  expect(next.secondReview.enabled).toBe(false);
  expect(next.humanReview).toEqual({ enabled: false, generation: 0 });
});

it("counts GPU as independent but keeps a same-Supa fallback in human review", () => {
  const first = { ...SUPA_FIRST_REVIEWER, decision: "approve", confidence: 0.99 };
  const gpu = { ...GPU_SECOND_REVIEWER, decision: "approve", confidence: 0.99 };
  const supa = { ...SUPA_FIRST_REVIEWER, decision: "approve", confidence: 0.99 };
  expect(combineVerdicts(first, gpu, 0.85, false)).toBe("agreed");
  expect(combineVerdicts(first, supa, 0.85, false)).toBe("needs_human");
  expect(combineVotes(first, [supa], { agreeAt: 0.85, published: false, pending: 0, firstModel: first.model }).status)
    .toBe("needs_human");
});
