import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS, configuredModel, modelBaseUrl, modelForPurpose, modelRequestName, readModelRegistry,
  resolveRegistryModel, modelLimits, configuredModelForProvider } from "@/lib/llm/model-registry";

const twins = () => ({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: [
  { ...DEFAULT_MODEL_DEFINITIONS[0], key: "gpu3090:review", equipment: "gpu3090", model: "same-model", gatewayLabel: undefined },
  { ...DEFAULT_MODEL_DEFINITIONS[2], model: "same-model" },
] }) });
describe("model registry equipment identity", () => {
  it("resolves M1 and GPU3090 independently even when the request model is identical", () => {
    const env = twins();
    expect(resolveRegistryModel("[m1] same-model", env)?.key).toBe("m1:translation");
    expect(resolveRegistryModel("gpu3090:review", env)?.equipment).toBe("gpu3090");
    expect(resolveRegistryModel("m1:translation", env)?.equipment).toBe("m1");
    expect(() => resolveRegistryModel("same-model", env)).toThrow("ambiguous_model_identity");
    expect(configuredModel("product-translate", env)).toBe("[m1] same-model");
    expect(resolveRegistryModel("[other] same-model", env)).toBeNull();
  });
  it("preserves the equipment label on legacy overrides and resolves explicit keys", () => {
    const env = twins();
    expect(configuredModel("product-translate", { ...env, PRODUCT_TRANSLATION_MODEL: "[m1] same-model" })).toBe("[m1] same-model");
    expect(configuredModel("product-translate", { ...env, PRODUCT_TRANSLATION_MODEL_KEY: "m1:translation", PRODUCT_TRANSLATION_MODEL: "obsolete" })).toBe("[m1] same-model");
    expect(() => configuredModel("product-translate", { ...env, PRODUCT_TRANSLATION_MODEL: "same-model" })).toThrow("ambiguous_model_identity");
    expect(() => configuredModel("product-translate", { ...env, PRODUCT_TRANSLATION_MODEL_KEY: "gpu3090:review" })).toThrow("invalid_model_key");
  });
  it("replaces model, provider, address and resource configuration without editing consumers", () => {
    const definition = { ...DEFAULT_MODEL_DEFINITIONS[2], model: "replacement", baseUrl: "https://gateway.example/v1",
      maxTokens: 2048, concurrency: 3, timeoutMs: 4321, displayName: "M1 replacement" };
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: [definition] }) };
    expect(modelForPurpose("product-translate", env)).toEqual(definition);
    expect(configuredModel("product-translate", env)).toBe("[m1] replacement");
    expect(modelBaseUrl("product-translate", env)).toBe(definition.baseUrl);
  });
  it("defaults public translation to equipment-qualified M1 Gemma and keeps other text roles independent", () => {
    expect(configuredModel("product-translate", {})).toBe("[m1] gemma4-26b");
    expect(modelForPurpose("reason-translate", {}).key).toBe("mlx:text");
    expect(modelRequestName(modelForPurpose("direct-review", {}))).toBe("qwen3.8-flash-next");
    expect(modelBaseUrl("reason-translate", { ABCLLM_BASE_URL: "https://gateway.example/" })).toBe("https://gateway.example/v1");
  });
  it("applies configured purpose budgets beneath the selected model ceiling", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS,
      limits: { "product-search-profile": { maxTokens: 900, concurrency: 6 } } }) };
    expect(modelLimits("product-search-profile", env)).toEqual({ maxTokens: 900, concurrency: 2 });
    expect(modelLimits("product-search-profile", {})).toEqual({ maxTokens: 500, concurrency: 2 });
    expect(() => modelBaseUrl("relay", {}, "abcllm")).toThrow("model_provider_adapter_mismatch");
    expect(() => configuredModelForProvider("product-intro-check", "codex-cli", {})).toThrow("model_provider_adapter_mismatch");
    expect(() => configuredModelForProvider("product-intro-check", "claude-cli", { INTRO_CHECK_MODEL: "bad model" })).toThrow("invalid_cli_model");
  });
  it("rejects duplicate keys, wrong equipment, credentials, missing selections and malformed JSON", () => {
    for (const models of [[DEFAULT_MODEL_DEFINITIONS[0], DEFAULT_MODEL_DEFINITIONS[0]],
      [{ ...DEFAULT_MODEL_DEFINITIONS[0], equipment: "m1" }], [{ ...DEFAULT_MODEL_DEFINITIONS[0], baseUrl: "https://user:secret@example.com/v1" }]])
      expect(() => readModelRegistry({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models }) })).toThrow("invalid_model_registry");
    expect(() => readModelRegistry({ MODEL_REGISTRY_CONFIG: "broken" })).toThrow("invalid_model_registry");
    expect(() => modelForPurpose("missing", {})).toThrow("model_purpose_not_unique");
  });
});
