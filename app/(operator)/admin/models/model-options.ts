import { modelForPurpose, modelRequestName, readModelRegistry } from "@/lib/llm/model-registry";
import type { ModelOption } from "../settings/ModelRows";

/** Suggestions are identities, not a claim that a backend or its capacity contract is ready. */
export function reviewModelOptions(gatewayModels: readonly string[] | null, direct: boolean): ModelOption[] {
  const directModel = modelForPurpose("ai2-direct");
  return [
    ...(direct ? [{ provider: "local-direct", model: directModel.key, label: directModel.displayName }] : []),
    ...[...new Set([modelRequestName(modelForPurpose("ai1-preset")), modelRequestName(modelForPurpose("product-search-profile")), ...(gatewayModels ?? [])])]
      .map(model => ({ provider: "abcllm", model, label: `게이트웨이 · ${model}` })),
    ...readModelRegistry().models.filter(model => model.provider === "claude-cli" || model.provider === "grok-cli")
      .map(model => ({ provider: model.provider, model: model.model, label: model.displayName })),
  ];
}
