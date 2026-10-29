import { modelForPurpose, modelRequestName } from "@/lib/llm/model-registry";
import type { CrawlSettings } from "./settings-schema";

export const REVIEW_ROUTING_PRESET_ID = "supa-first-gpu-second";
export const SUPA_FIRST_REVIEWER = {
  provider: "abcllm", model: modelRequestName(modelForPurpose("ai1-preset")),
} as const;
export const GPU_SECOND_REVIEWER = {
  provider: "local-direct", model: modelForPurpose("ai2-direct").key,
} as const;

/**
 * An explicit form choice, never a read-time default or a rollout command.
 * Replace the entire AI1 pool so its old GPT worker cannot keep taking new work.
 * Keep publication gates, human delegation and concurrency. Clear the old AI2
 * fallback pool as part of this explicit choice so GPU failures do not send
 * second review back to the Supa model already used for first review.
 */
export function applyReviewRoutingPreset(current: CrawlSettings): CrawlSettings {
  return {
    ...current,
    firstReview: { ...SUPA_FIRST_REVIEWER },
    firstReviewAdditional: [],
    secondReview: {
      ...current.secondReview,
      voters: [{ ...GPU_SECOND_REVIEWER }],
      fallbacks: [],
    },
  };
}
