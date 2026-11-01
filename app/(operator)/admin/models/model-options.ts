import { firstReviewCandidates } from "@/lib/crawl/first-reviewers";
import { modelForPurpose, modelRequestName, readModelRegistry } from "@/lib/llm/model-registry";
import type { ModelOption } from "../settings/ModelRows";

/** Suggestions are identities, not a claim that a backend or its capacity contract is ready. */
export function reviewModelOptions(gatewayModels: readonly string[] | null, direct: boolean): ModelOption[] {
  const directModel = modelForPurpose("ai2-direct");
  return [
    ...(direct ? [{ provider: "local-direct", model: directModel.key, label: directModel.displayName }] : []),
    ...[...new Set([...(direct ? [modelRequestName(modelForPurpose("ai1-preset")), modelRequestName(modelForPurpose("product-search-profile"))] : firstReviewCandidates().filter(row => row.provider === "abcllm").map(row => row.model)), ...(gatewayModels ?? [])])]
      .map(model => ({ provider: "abcllm", model, label: `직접 연결 · ${model}` })),
    ...readModelRegistry().models.filter(model => (model.provider === "claude-cli" || model.provider === "grok-cli") && (direct || firstReviewCandidates().some(row => row.provider === model.provider && row.model === modelRequestName(model))))
      .map(model => ({ provider: model.provider, model: model.model, label: model.displayName })),
  ];
}
