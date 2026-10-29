import { modelForPurpose, type ModelEnvironment } from "@/lib/llm/model-registry";

export type ClassificationModelOption = { model: string; provider: "claude-cli" | "codex-cli"; displayName: string };
export function classificationModelOptions(env: ModelEnvironment = process.env): ClassificationModelOption[] {
  const options = ["classify-primary", "classify-fallback", "classify-claude"].map(purpose => {
    const definition = modelForPurpose(purpose, env);
    if (!["claude-cli", "codex-cli"].includes(definition.provider) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(definition.model))
      throw new Error("classification_model_adapter_mismatch");
    if (purpose === "classify-claude" && definition.provider !== "claude-cli") throw new Error("classification_model_adapter_mismatch");
    return { model: definition.model, provider: definition.provider as ClassificationModelOption["provider"], displayName: definition.displayName };
  });
  // A model name can never silently switch the executable/provider chosen for it.
  for (const option of options) if (options.some(other => other.model === option.model && other.provider !== option.provider))
    throw new Error("ambiguous_classification_provider");
  return options.filter((option, index) => options.findIndex(other => other.model === option.model) === index);
}
export function knownClassificationProvider(model: string, options: readonly ClassificationModelOption[] = classificationModelOptions()): ClassificationModelOption["provider"] | null {
  return options.find(option => option.model === model)?.provider ?? null;
}
export function classificationModelProvider(model: string, env: ModelEnvironment = process.env): ClassificationModelOption["provider"] {
  const option = classificationModelOptions(env).find(option => option.model === model);
  if (!option) throw new Error("classification_model_not_configured");
  return option.provider;
}
export function classificationDefaultConfig(env: ModelEnvironment = process.env) {
  const primary = modelForPurpose("classify-primary", env), options = classificationModelOptions(env);
  const preferred = modelForPurpose("classify-claude", env);
  const fallback = preferred.model !== primary.model ? preferred : options.find(option => option.model !== primary.model);
  return { primary: { model: primary.model, effort: primary.provider === "claude-cli" ? "high" as const : "xhigh" as const },
    fallback: fallback ? { model: fallback.model, effort: "high" as const } : null };
}
