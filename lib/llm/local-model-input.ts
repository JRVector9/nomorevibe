import type { ReviewInput } from "@/lib/crawl/agent-review-contract";
import type { AssistCapacityInput } from "@/lib/domain/llm-assist/model-input";
import type { IntroCorrectionCapacityInput } from "@/lib/domain/products/intro-assist-runtime";
export type LocalModelInput = ReviewInput | AssistCapacityInput | IntroCorrectionCapacityInput;
export function isAssistCapacityInput(value: LocalModelInput): value is AssistCapacityInput | IntroCorrectionCapacityInput {
  return "kind" in value && ["llm_assist", "llm_assist_correction"].includes(value.kind);
}
