/** Offline configuration migration only. Never connects to the DB or any model server. */
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL_DEFINITIONS, readModelRegistry, type ModelRegistry } from "../lib/llm/model-registry";

export function migrateM1TranslationRegistry(input: string): ModelRegistry {
  if (!input.trim()) throw new Error("model_registry_migration_input_required");
  const registry = readModelRegistry({ MODEL_REGISTRY_CONFIG: input });
  const current = registry.models.find(model => model.key === "m1:translation");
  if (!current || current.equipment !== "m1" || current.provider !== "abcllm" || current.gatewayLabel?.toLowerCase() !== "m1")
    throw new Error("model_registry_migration_m1_gateway_required");
  const target = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "m1:translation")!;
  const models = registry.models.map(model => model.key === current.key ? { ...model, model: target.model, family: target.family,
    displayName: target.displayName, purposes: [...new Set([...model.purposes, "product-translate", "reason-translate"])] } : model);
  return readModelRegistry({ MODEL_REGISTRY_CONFIG: JSON.stringify({ ...registry, models,
    selections: { ...registry.selections, "product-translate": current.key, "reason-translate": current.key } }) });
}

// Explicit flag keeps imports side-effect free. stdout is the reviewable candidate JSON, not an applied configuration.
if (process.argv.includes("--print-migration")) {
  try { process.stdout.write(JSON.stringify(migrateM1TranslationRegistry(readFileSync(0, "utf8")), null, 2) + "\n"); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "model_registry_migration_failed") + "\n"); process.exitCode = 1; }
}
