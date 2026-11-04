import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS, configuredModel, modelBaseUrl, modelForPurpose, modelRequestName, readModelRegistry,
  resolveRegistryModel, modelLimits, configuredModelForProvider, modelDeadlineLadder, modelTimeoutMs, modelRequestBudget, modelCallTimeoutMs, modelCallMaxTokens,
  setModelRoutePolicyOverlay, MODEL_PURPOSE_ENV } from "@/lib/llm/model-registry";

const twins = () => ({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: [
  { ...DEFAULT_MODEL_DEFINITIONS[0], key: "gpu3090:review", equipment: "gpu3090", model: "same-model", gatewayLabel: undefined },
  { ...DEFAULT_MODEL_DEFINITIONS[2], model: "same-model", gatewayLabel: "m1" },
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
  it("ignores the retired abcLLM model selectors and keeps the registry route", () => {
    const env = twins();
    // reason-translate no longer reads ABCLLM_MODEL / ABCLLM_MODEL_KEY: labels and explicit keys do not move it.
    for (const ignored of [{ ABCLLM_MODEL: "[m1] same-model" }, { ABCLLM_MODEL_KEY: "m1:translation", ABCLLM_MODEL: "obsolete" },
      { ABCLLM_MODEL: "same-model" }, { ABCLLM_MODEL_KEY: "gpu3090:review" }, { ABCLLM_MODEL_KEY: "missing:key" }])
      expect(configuredModel("reason-translate", { ...env, ...ignored })).toBe("[m1] same-model");
    expect(configuredModel("direct-review", { ...env, AUDIT_SECOND_OPINION_MODEL: "same-model" })).toBe("same-model");
  });
  it("ignores ABCLLM_MODEL, ABCLLM_PROFILE_MODEL and their *_KEY selectors for every purpose that used them", () => {
    for (const purpose of ["product-search-profile", "reason-translate", "product-tagline-ko", "search-query-translate"] as const) {
      expect(MODEL_PURPOSE_ENV[purpose]).toBeNull();
      const expected = configuredModel(purpose, {});
      for (const ignored of [{ ABCLLM_MODEL: "retired-model" }, { ABCLLM_MODEL_KEY: "missing:key" },
        { ABCLLM_PROFILE_MODEL: "retired-profile" }, { ABCLLM_PROFILE_MODEL_KEY: "missing:key" }])
        expect(configuredModel(purpose, ignored)).toBe(expected);
    }
  });
  it("selects product-translate and crawl-tagline from the registry alone and ignores their removed env names", () => {
    const env = twins();
    // No process env for these purposes since the abcLLM gateway removal (2026-10-31): a stale gateway alias cannot pick the model.
    expect(MODEL_PURPOSE_ENV["product-translate"]).toBeNull();
    expect(MODEL_PURPOSE_ENV["crawl-tagline"]).toBeNull();
    for (const ignored of [{ PRODUCT_TRANSLATION_MODEL: "[m1] same-model" }, { PRODUCT_TRANSLATION_MODEL: "obsolete" },
      { PRODUCT_TRANSLATION_MODEL: "[other] same-model" }, { PRODUCT_TRANSLATION_MODEL_KEY: "gpu3090:review" },
      { PRODUCT_TRANSLATION_MODEL_KEY: "missing:key", PRODUCT_TRANSLATION_MODEL: "same-model" }])
      expect(configuredModel("product-translate", { ...env, ...ignored })).toBe("[m1] same-model");
    // An explicit choice is a registry selection; a selection must name an entry that serves the purpose.
    const selections = (selected: Record<string, string>) => ({ MODEL_REGISTRY_CONFIG: JSON.stringify({ ...JSON.parse(env.MODEL_REGISTRY_CONFIG), selections: selected }) });
    expect(configuredModel("product-translate", { ...selections({ "product-translate": "m1:translation" }), PRODUCT_TRANSLATION_MODEL_KEY: "gpu3090:review" }))
      .toBe("[m1] same-model");
    expect(() => configuredModel("product-translate", selections({ "product-translate": "gpu3090:review" }))).toThrow("invalid_model_registry");
    for (const ignored of [{}, { ABCLLM_TAGLINE_MODEL: "gpt-oss-120b" }, { ABCLLM_TAGLINE_MODEL_KEY: "mlx:text" }, { ABCLLM_TAGLINE_MODEL: "unregistered-alias" }])
      expect(configuredModel("crawl-tagline", ignored)).toBe("supa");
  });
  it("replaces model, provider, address and resource configuration without editing consumers", () => {
    const definition = { ...DEFAULT_MODEL_DEFINITIONS[2], model: "replacement", baseUrl: "https://gateway.example/v1",
      maxTokens: 2048, concurrency: 3, timeoutMs: 4321, displayName: "M1 replacement" };
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: [definition] }) };
    expect(modelForPurpose("product-translate", env)).toEqual(definition);
    expect(configuredModel("product-translate", env)).toBe("replacement");
    expect(modelBaseUrl("product-translate", env)).toBe(definition.baseUrl);
  });
  it("defaults public translation to the direct M1 Gemma entry and keeps other text roles independent", () => {
    expect(configuredModel("product-translate", {})).toBe("mlx-community--gemma-4-26b-a4b-it-4bit");
    expect(modelForPurpose("reason-translate", {}).key).toBe("m1:translation");
    expect(modelRequestName(modelForPurpose("direct-review", {}))).toBe("qwen3.8-flash-next");
    expect(modelBaseUrl("reason-translate", { ABCLLM_BASE_URL: "https://retired-gateway.example/" })).toBe("https://m1-studio.tail02799e.ts.net/v1");
    expect(modelBaseUrl("direct-review", { AUDIT_SECOND_OPINION_URL: "https://audit.example/" })).toBe("https://audit.example/v1");
    // The retired gateway is not a code default: every abcllm entry names its engine and no entry carries a gateway label.
    for (const model of DEFAULT_MODEL_DEFINITIONS) {
      expect(model.gatewayLabel).toBeUndefined();
      expect(model.baseUrl ?? "").not.toContain("abcllm-api.brut.bot");
    }
    expect(DEFAULT_MODEL_DEFINITIONS.some(model => model.key === "mlx:tagline")).toBe(false);
    expect(configuredModel("crawl-tagline", {})).toBe("supa");
  });
  it("applies configured purpose budgets beneath the selected model ceiling", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS,
      limits: { "product-search-profile": { maxTokens: 900, concurrency: 6 } } }) };
    expect(modelLimits("product-search-profile", env)).toEqual({ maxTokens: 900, concurrency: 2 });
    expect(modelLimits("product-search-profile", {})).toEqual({ maxTokens: 500, concurrency: 2 });
    expect(() => modelBaseUrl("direct-review", {}, "abcllm")).toThrow("model_provider_adapter_mismatch");
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
    // 2026-10-30: M1 mlx-lm 번역 300초·출력 30K 토큰(입력 30K 자는 PRODUCT_TRANSLATION_MAX_SOURCE_CHARS, 묶음 8K 자).
    expect(modelTimeoutMs("product-translate", {})).toBe(300_000);
    expect(modelRequestBudget("product-translate", {})).toEqual({ maxTokens: 30_000, concurrency: 1, timeoutMs: 300_000 });
    const modelEnv = config({ models: DEFAULT_MODEL_DEFINITIONS.map(model => model.key === "supa:review" ? { ...model, timeoutMs: 30_000, maxTokens: 700, deadlineLadder: { engineMs: 20_000, relayMs: null, gatewayMs: 25_000, clientMs: 30_000 } } : model) });
    expect(modelCallTimeoutMs("review-gateway", "supa", modelEnv)).toBe(30_000);
    expect(modelCallMaxTokens("gateway-review", "supa", modelEnv)).toBe(700);
    expect(modelTimeoutMs("relay", {})).toBe(90_000);
    const env = config({ deadlines: { "review-gateway": { engineMs: 20_000, relayMs: 25_000, gatewayMs: 30_000, clientMs: 35_000 } },
      limits: { "gateway-review": { maxTokens: 900, concurrency: 1 } } });
    expect(modelTimeoutMs("review-gateway", env)).toBe(35_000);
    expect(modelRequestBudget("gateway-review", env).maxTokens).toBe(900);
    expect(modelTimeoutMs("product-translate", config({ models: DEFAULT_MODEL_DEFINITIONS.map(model => model.key === "m1:translation" ? { ...model, timeoutMs: 9_000 } : model) }))).toBe(9_000);
  });
  it("keeps the operator classify and screen-review call budgets and lets the registry override them", () => {
    expect(modelTimeoutMs("classify-cli", {})).toBe(35_000);
    expect(modelTimeoutMs("screen-review", {})).toBe(90_000);
    const env = config({ timeouts: { "classify-cli": 20_000, "screen-review": 70_000 } });
    expect(modelTimeoutMs("classify-cli", env)).toBe(20_000);
    expect(modelTimeoutMs("screen-review", env)).toBe(70_000);
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
  it("layers the admin route-policy overlay (runtime_settings limits/timeouts/deadlines) under an empty env; MODEL_REGISTRY_CONFIG stays authoritative", () => {
    setModelRoutePolicyOverlay(() => ({ limits: { "product-search-profile": { maxTokens: 900, concurrency: 6 } }, timeouts: { "crawl-tagline": 46_000 },
      deadlines: { "review-gateway": { engineMs: 50_000, relayMs: null, gatewayMs: 55_000, clientMs: 65_000 } } }));
    try {
      expect(modelLimits("product-search-profile", {})).toEqual({ maxTokens: 900, concurrency: 2 });
      expect(modelRequestBudget("product-search-profile", {})).toEqual({ maxTokens: 900, concurrency: 6 });
      expect(modelTimeoutMs("crawl-tagline", {})).toBe(46_000);
      expect(modelTimeoutMs("review-gateway", {})).toBe(65_000);
      expect(modelDeadlineLadder("review-gateway", {})).toEqual({ engineMs: 50_000, relayMs: null, gatewayMs: 55_000, clientMs: 65_000 });
      // Routes the overlay does not name keep their code defaults
      expect(modelTimeoutMs("product-translate", {})).toBe(300_000);
      expect(modelTimeoutMs("screen-review", {})).toBe(90_000);
      // An explicit env registry bypasses the overlay for that read
      expect(modelTimeoutMs("crawl-tagline", config({}))).toBe(45_000);
      // A policy that fails the merged registry schema keeps the code-default routes instead of throwing
      setModelRoutePolicyOverlay(() => ({ timeouts: { "review-gateway": 20_000 } }));
      expect(modelTimeoutMs("review-gateway", {})).toBe(60_000);
      setModelRoutePolicyOverlay(() => null);
      expect(modelTimeoutMs("crawl-tagline", {})).toBe(45_000);
    } finally { setModelRoutePolicyOverlay(undefined); }
    expect(modelTimeoutMs("crawl-tagline", {})).toBe(45_000);
  });
});
