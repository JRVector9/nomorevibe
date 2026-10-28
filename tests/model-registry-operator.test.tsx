import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelRegistryTable } from "@/app/(operator)/admin/models/ModelRegistryTable";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { classificationDefaultConfig, classificationModelOptions, classificationModelProvider } from "@/lib/operations/classification-models";
import { modelConfigSchemaFor } from "@/lib/operations/contracts";

describe("configured operator model identities", () => {
  it("renders equipment keys and changed request/URL/resource settings from the server registry", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: [{ ...DEFAULT_MODEL_DEFINITIONS[2],
      model: "replacement", maxTokens: 2048, concurrency: 3, baseUrl: "https://replacement.example/v1" }] }) };
    const html = renderToStaticMarkup(createElement(ModelRegistryTable, { env }));
    for (const value of ["m1:translation", "[m1] replacement", "https://replacement.example/v1", "2,048", "기한 설정 연결"]) expect(html).toContain(value);
    expect(html).not.toContain("qwen3.8-flash-next");
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
