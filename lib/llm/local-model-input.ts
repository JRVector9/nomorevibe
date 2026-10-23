import type { ReviewInput } from "@/lib/crawl/agent-review-contract";
import type { AssistCapacityInput } from "@/lib/domain/llm-assist/model-input";
export type LocalModelInput = ReviewInput | AssistCapacityInput;
export function isAssistCapacityInput(value: LocalModelInput): value is AssistCapacityInput {
  return "kind" in value && value.kind === "llm_assist";
}
