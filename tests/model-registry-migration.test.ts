import { expect, it } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { migrateM1TranslationRegistry } from "@/scripts/migrate-model-registry-m1";
it("migrates only M1 model metadata and translation selection, preserving addresses and all existing resource policies", () => {
  const original = { version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model => model.key === "m1:translation"
    ? { ...model, model: "old-model", family: "old-family", baseUrl: "https://m1-fixture.example/v1", timeoutMs: 19_000, maxTokens: 700, concurrency: 1 } : model),
    limits: { "product-translate": { maxTokens: 600, concurrency: 1 } }, candidates: { "first-review": ["mlx:text", "supa:review"] } };
  const migrated = migrateM1TranslationRegistry(JSON.stringify(original));
  expect(migrated.models.filter(model => model.key !== "m1:translation")).toEqual(original.models.filter(model => model.key !== "m1:translation"));
  expect(migrated.models.find(model => model.key === "m1:translation")).toMatchObject({ model: "mlx-community--gemma-4-26b-a4b-it-4bit",
    baseUrl: "https://m1-fixture.example/v1", timeoutMs: 19_000, maxTokens: 700, concurrency: 1 });
  expect(migrated.selections["product-translate"]).toBe("m1:translation");
  expect(migrated.selections["reason-translate"]).toBe("m1:translation");
  expect(migrated.limits).toEqual(original.limits);
  expect(migrated.candidates).toEqual(original.candidates);
});
it("requires explicit existing input and a configured M1 gateway address", () => {
  expect(() => migrateM1TranslationRegistry("")).toThrow("model_registry_migration_input_required");
  expect(() => migrateM1TranslationRegistry(JSON.stringify({ version: 1, models: [DEFAULT_MODEL_DEFINITIONS[0]] }))).toThrow("model_registry_migration_m1_gateway_required");
  expect(() => migrateM1TranslationRegistry(JSON.stringify({ version: 1, models: [{ ...DEFAULT_MODEL_DEFINITIONS[2], baseUrl: null }] }))).toThrow("model_base_url_required");
});
