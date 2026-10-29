import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextModelStagesTable } from "@/app/(operator)/admin/models/TextModelStagesTable";
import { ModelRegistryTable } from "@/app/(operator)/admin/models/ModelRegistryTable";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { classificationDefaultConfig, classificationModelOptions, classificationModelProvider } from "@/lib/operations/classification-models";
import { modelConfigSchemaFor } from "@/lib/operations/contracts";

afterEach(() => vi.unstubAllEnvs());

describe("configured operator model identities", () => {
  it("renders equipment keys and changed request/URL/resource settings from the server registry", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: [{ ...DEFAULT_MODEL_DEFINITIONS[2],
      model: "replacement", maxTokens: 2048, concurrency: 3, baseUrl: "https://replacement.example/v1" }] }) };
    const html = renderToStaticMarkup(createElement(ModelRegistryTable, { env }));
    for (const value of ["m1:translation", "[m1] replacement", "https://replacement.example/v1", "2,048", "로드 시 순서를 검증"]) expect(html).toContain(value);
    expect(html).not.toContain("qwen3.8-flash-next");
  });
  it("shows independent Korean tagline and query selections from the same runtime constants", async () => {
    vi.stubEnv("ABCLLM_MODEL", undefined);
    vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
      model.key === "m1:translation" ? { ...model, purposes: [...model.purposes, "product-tagline-ko", "search-query-translate"] } : model),
      selections: { "product-tagline-ko": "m1:translation", "search-query-translate": "m1:translation" } }));
    vi.resetModules();
    const models = await (await import("@/lib/operations/model-env")).currentModelEnv();
    expect(models.translate).toBe("[MLX] gpt-oss-120b");
    expect(models.koreanTagline).toBe("[m1] mlx-community--gemma-4-26b-a4b-it-4bit");
    expect(models.searchQuery).toBe("[m1] mlx-community--gemma-4-26b-a4b-it-4bit");
    const html = renderToStaticMarkup(createElement(TextModelStagesTable, { models }));
    expect(html).toContain("한국어 소개 번역");
    expect(html).toContain("검색 질의 번역");
    expect(html).toContain("[m1] mlx-community--gemma-4-26b-a4b-it-4bit");
  });
  it("keeps default CLI configuration valid when the primary provider changes", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
      model.key === "connect:spark" ? { ...model, model: "claude-primary", provider: "claude-cli" } : model) }) };
    const defaults = classificationDefaultConfig(env);
    expect(defaults.primary).toEqual({ model: "claude-primary", effort: "high" });
    expect(modelConfigSchemaFor(classificationModelOptions(env)).safeParse(defaults).success).toBe(true);
  });
  it("selects the CLI provider from configured metadata when its model alias changes", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
      model.key === "connect:sonnet" ? { ...model, model: "claude-replacement", displayName: "Claude replacement" } : model) }) };
    const options = classificationModelOptions(env), schema = modelConfigSchemaFor(options);
    expect(classificationModelProvider("claude-replacement", env)).toBe("claude-cli");
    expect(options.find(option => option.model === "claude-replacement")?.displayName).toBe("Claude replacement");
    expect(schema.safeParse({ primary: { model: "claude-replacement", effort: "high" }, fallback: null }).success).toBe(true);
    expect(schema.safeParse({ primary: { model: "claude-replacement", effort: "xhigh" }, fallback: null }).success).toBe(false);
    expect(() => classificationModelProvider("sonnet", env)).toThrow("classification_model_not_configured");
  });
});
