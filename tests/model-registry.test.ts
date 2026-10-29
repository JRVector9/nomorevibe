import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS, configuredModel, modelBaseUrl, modelForPurpose, modelRequestName, readModelRegistry,
  resolveRegistryModel, modelLimits, configuredModelForProvider, modelDeadlineLadder, modelTimeoutMs, modelRequestBudget, modelCallTimeoutMs, modelCallMaxTokens } from "@/lib/llm/model-registry";

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
    expect(configuredModel("product-translate", {})).toBe("[m1] mlx-community--gemma-4-26b-a4b-it-4bit");
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
    for (const overrides of [{ selections: { "product-translate": "missing:key" } },
      { candidates: { "first-review": ["missing:key"] } }, { candidates: { "first-review": ["mlx:text", "mlx:text"] } }])
      expect(() => readModelRegistry({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS, ...overrides }) })).toThrow("invalid_model_registry");
    expect(() => readModelRegistry({ MODEL_REGISTRY_CONFIG: "broken" })).toThrow("invalid_model_registry");
    expect(() => modelForPurpose("missing", {})).toThrow("model_purpose_not_unique");
  });
});

describe("registry deadline and request policies", () => {
  const config = (overrides: object) => ({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS, ...overrides }) });
  it("preserves PR711 review and translation budgets and makes each override observable", () => {
    expect(modelDeadlineLadder("review-gateway", {})).toEqual({ engineMs: 50_000, relayMs: null, gatewayMs: 55_000, clientMs: 60_000 });
    expect(modelTimeoutMs("product-translate", {})).toBe(40_000);
    const modelEnv = config({ models: DEFAULT_MODEL_DEFINITIONS.map(model => model.key === "supa:review" ? { ...model, timeoutMs: 30_000, maxTokens: 700, deadlineLadder: { engineMs: 20_000, relayMs: null, gatewayMs: 25_000, clientMs: 30_000 } } : model) });
    expect(modelCallTimeoutMs("review-gateway", "[supa] Qwen3.8-27B-NVFP4", modelEnv)).toBe(30_000);
    expect(modelCallMaxTokens("gateway-review", "[supa] Qwen3.8-27B-NVFP4", modelEnv)).toBe(700);
    expect(modelTimeoutMs("relay", {})).toBe(90_000);
    const env = config({ deadlines: { "review-gateway": { engineMs: 20_000, relayMs: 25_000, gatewayMs: 30_000, clientMs: 35_000 } },
      limits: { "gateway-review": { maxTokens: 900, concurrency: 1 } } });
    expect(modelTimeoutMs("review-gateway", env)).toBe(35_000);
    expect(modelRequestBudget("gateway-review", env).maxTokens).toBe(900);
    expect(modelTimeoutMs("product-translate", config({ models: DEFAULT_MODEL_DEFINITIONS.map(model => model.key === "m1:translation" ? { ...model, timeoutMs: 9_000 } : model) }))).toBe(9_000);
  });
  it("rejects all three inverted or insufficiently separated edges at registry load", () => {
    for (const ladder of [
      { engineMs: 25_000, relayMs: 25_000, gatewayMs: 30_000, clientMs: 35_000 },
      { engineMs: 20_000, relayMs: 30_000, gatewayMs: 30_000, clientMs: 35_000 },
      { engineMs: 20_000, relayMs: 25_000, gatewayMs: 30_000, clientMs: 30_001 },
    ]) expect(() => readModelRegistry(config({ deadlines: { "review-gateway": ladder } }))).toThrow("deadline_order_inverted");
    expect(() => readModelRegistry(config({ models: DEFAULT_MODEL_DEFINITIONS.map(model => model.key === "supa:review" ? { ...model, timeoutMs: 30_000 } : model) }))).toThrow("model_role_deadline_order_inverted");
    expect(() => readModelRegistry(config({ timeouts: { "review-gateway": 20_000 } }))).toThrow("model_timeout_ladder_mismatch");
    expect(() => readModelRegistry(config({ models: [{ ...DEFAULT_MODEL_DEFINITIONS[0],
      deadlineLadder: { engineMs: 50_000, relayMs: null, gatewayMs: 55_000, clientMs: 59_000 } }] }))).toThrow("model_timeout_ladder_mismatch");
  });
  it("rejects missing M1 addresses explicitly without inventing an equipment host", () => {
    expect(() => readModelRegistry(config({ models: [{ ...DEFAULT_MODEL_DEFINITIONS[2], baseUrl: null }] }))).toThrow("model_base_url_required");
  });
});
