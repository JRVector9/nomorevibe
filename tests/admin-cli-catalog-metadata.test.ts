import { describe, expect, it } from "vitest";
import { cliCatalogMetadata, cliCatalogMetadataFromSnapshot } from "@/lib/llm/cli-catalog-metadata";
import { aiConnectionInputFromForm } from "@/lib/operations/admin-ai-tasks";

const observedAt = "2026-11-05T00:00:00.000Z";
describe("existing CLI catalog metadata", () => {
  it("binds compact variant lists to the stored model order and omits provider configuration", () => {
    const models = ["opencode/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash"];
    const value = { modelsHash: "model-order-hash", observedAt, variantLists: [["low", "high", "max"], []], apiKey: "must-not-leave-server" };
    const restored = cliCatalogMetadataFromSnapshot(value, models, "1.19.5", "model-order-hash");
    expect(restored).toEqual({ cliVersion: "1.19.5", observedAt, models: [
      { id: models[0], label: models[0], variants: ["low", "high", "max"], maxModelLen: null },
      { id: models[1], label: models[1], variants: [], maxModelLen: null },
    ] });
    expect(cliCatalogMetadataFromSnapshot(value, models, "1.19.5", "different-model-order-hash")).toBeNull();
    expect(cliCatalogMetadataFromSnapshot(value, models.slice(1), "1.19.5", "model-order-hash")).toBeNull();
    expect(cliCatalogMetadata({ ...restored, models: [{ ...restored!.models[0], variants: ["bad variant"] }] })).toBeNull();
  });
  it("allows the actual OpenCode catalog up to512 models while keeping other CLI tools limited to32", () => {
    const form = (tool: string, count: number) => {
      const data = new FormData();
      for (const [key, value] of Object.entries({ kind: "cli", label: "M3", cliTool: tool,
        cliModels: Array.from({ length: count }, (_, index) => `provider/model-${index}`).join(" ") })) data.set(key, value);
      return aiConnectionInputFromForm(data);
    };
    expect(form("opencode", 111).input?.cliModels).toHaveLength(111);
    expect(form("opencode", 512).issues).toEqual([]);
    expect(form("opencode", 513).issues).toContain("ai_connection_invalid:cliModels");
    expect(form("claude", 33).issues).toContain("ai_connection_invalid:cliModels");
  });
});
