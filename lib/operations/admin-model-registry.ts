import { and, desc, eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { modelRegistryOverrides, operationsAudit } from "@/lib/db/schema";
import { validateAdminStagePools } from "@/lib/llm/admin-model-pools";
import { DEFAULT_MODEL_DEFINITIONS, modelDefinitionSchema, readModelRegistry, type ModelDefinition, type ModelRegistry } from "@/lib/llm/model-registry";
import { writerSiteActive, DrWriterFencedError } from "./dr/epoch";
import { adminAuditRow } from "./admin-log";
import type { RuntimeSettings } from "./runtime-settings-schema";
import { ensureRuntimeSettings, runtimeSettings } from "./runtime-settings-store";

/**
 * Admin overrides of the code-default model registry (model_registry_overrides, 0148). A saved definition replaces the
 * default of the same key on every app within ~30 s (same reload as the serving contracts). Saving checks the merged
 * registry with the full registry schema, one model per purpose, and the saved stage selections, so a save cannot leave a
 * purpose ambiguous or a stage pointing at a missing or different-adapter model. The merge is validated against the live
 * admin route policy (runtime_settings routes: limits/timeouts/deadlines, PR 1a) — the same registry the workers will read —
 * so a model timeout that breaks the saved deadline ladder is refused here, as a ladder that breaks a saved model is refused there.
 */
export type AdminRegistryOverrideRow = { id: number; key: string; definition: Record<string, unknown>; enabled: boolean; note: string | null;
  updatedBy: string; updatedAt: string };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function listAdminRegistryOverrides(): Promise<AdminRegistryOverrideRow[]> {
  const rows = await db.select().from(modelRegistryOverrides).orderBy(modelRegistryOverrides.key, desc(modelRegistryOverrides.id));
  return rows.map(row => ({ id: row.id, key: row.key, definition: row.definition, enabled: row.enabled, note: row.note, updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString() }));
}

const duplicatedPurposes = (models: readonly ModelDefinition[]) => {
  const seen = new Map<string, number>();
  for (const model of models) for (const purpose of new Set(model.purposes)) seen.set(purpose, (seen.get(purpose) ?? 0) + 1);
  return new Set([...seen].filter(([, count]) => count > 1).map(([purpose]) => purpose));
};

/** The merged registry for these override definitions under the given route policy (default: the live runtime settings), or the reason it is refused. */
export function checkRegistryOverrides(definitions: readonly unknown[], stagePools: unknown,
  routes: RuntimeSettings["routes"] = runtimeSettings().routes): { ok: true; registry: ModelRegistry } | { ok: false; reason: string } {
  const parsed: ModelDefinition[] = [];
  for (const value of definitions) {
    const result = modelDefinitionSchema.safeParse(value);
    if (!result.success) return { ok: false, reason: "model_definition_invalid" };
    parsed.push(result.data);
  }
  const byKey = new Map(parsed.map(model => [model.key, model]));
  if (byKey.size !== parsed.length) return { ok: false, reason: "model_definition_duplicate" };
  const models = [...DEFAULT_MODEL_DEFINITIONS.map(model => byKey.get(model.key) ?? model),
    ...parsed.filter(model => !DEFAULT_MODEL_DEFINITIONS.some(row => row.key === model.key))];
  let registry: ModelRegistry;
  try { registry = readModelRegistry({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models, limits: routes.limits, timeouts: routes.timeouts, deadlines: routes.deadlines }) }); }
  catch { return { ok: false, reason: "model_registry_invalid" }; }
  // A purpose served by two definitions makes every unscoped read of it throw; defaults never do this.
  const baseline = duplicatedPurposes(DEFAULT_MODEL_DEFINITIONS);
  if ([...duplicatedPurposes(registry.models)].some(purpose => !baseline.has(purpose))) return { ok: false, reason: "model_purpose_duplicate" };
  try { validateAdminStagePools(stagePools ?? {}, registry); } catch { return { ok: false, reason: "stage_pools_incompatible" }; }
  return { ok: true, registry };
}

async function enabledDefinitions(tx: Tx) {
  return tx.select().from(modelRegistryOverrides).where(eq(modelRegistryOverrides.enabled, true)).for("update");
}
async function savedStagePools(): Promise<unknown> {
  const { getSettings } = await import("@/lib/crawl/settings");
  return (await getSettings()).stageModelPools ?? {};
}

/** Replace (or add) one definition inside a caller's fenced transaction. The previous row stays as disabled history. */
export async function saveRegistryOverrideTx(tx: Tx, definition: unknown, actor: string, note: string | null, stagePools: unknown): Promise<{ id: number }> {
  const parsed = modelDefinitionSchema.safeParse(definition);
  if (!parsed.success || !actor.trim()) throw new Error("model_definition_invalid");
  const current = await enabledDefinitions(tx), previous = current.find(row => row.key === parsed.data.key);
  const checked = checkRegistryOverrides([...current.filter(row => row.key !== parsed.data.key).map(row => row.definition), parsed.data], stagePools);
  if (!checked.ok) throw new Error(checked.reason);
  if (previous) await tx.update(modelRegistryOverrides).set({ enabled: false, updatedBy: actor, updatedAt: new Date() }).where(eq(modelRegistryOverrides.id, previous.id));
  const [row] = await tx.insert(modelRegistryOverrides).values({ key: parsed.data.key, definition: { ...parsed.data }, enabled: true,
    note: note?.trim() ? note.trim().slice(0, 400) : null, updatedBy: actor }).returning({ id: modelRegistryOverrides.id });
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: "model-registry-override-save", target: parsed.data.key,
    detail: { id: row.id, previousId: previous?.id ?? null, provider: parsed.data.provider, baseUrl: parsed.data.baseUrl, model: parsed.data.model,
      gatewayLabel: parsed.data.gatewayLabel ?? null, note } }));
  return row;
}

export async function saveAdminRegistryOverride(definition: unknown, actor: string, note: string | null = null): Promise<{ id: number }> {
  const stagePools = await savedStagePools();
  // The merge check reads the live route policy (runtime_settings); refresh it so a save validates against the current 판.
  await ensureRuntimeSettings(0);
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    return saveRegistryOverrideTx(tx, definition, actor, note, stagePools);
  }));
}

/** Turn an override off: the code default of that key applies again (an added key disappears, refused while a stage uses it). */
export async function disableAdminRegistryOverride(key: string, actor: string): Promise<boolean> {
  if (!actor.trim()) throw new Error("model_definition_invalid");
  const stagePools = await savedStagePools();
  await ensureRuntimeSettings(0);
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const current = await enabledDefinitions(tx), previous = current.find(row => row.key === key);
    if (!previous) return false;
    const checked = checkRegistryOverrides(current.filter(row => row.key !== key).map(row => row.definition), stagePools);
    if (!checked.ok) throw new Error(checked.reason);
    await tx.update(modelRegistryOverrides).set({ enabled: false, updatedBy: actor, updatedAt: new Date() })
      .where(and(eq(modelRegistryOverrides.id, previous.id), eq(modelRegistryOverrides.enabled, true)));
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: "model-registry-override-disable", target: key, detail: { id: previous.id } }));
    return true;
  }));
}
