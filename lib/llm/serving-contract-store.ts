import { createHash } from "node:crypto";
import { openSecret, servingContractKeyAad } from "@/lib/security/secret-box";
import { logger } from "@/lib/observability/logger";
import { storedSettingsVersion } from "@/lib/operations/runtime-settings-schema";
import { publishRuntimeSettingsSnapshot, runtimeSettings, runtimeSettingsSnapshotFromStored, setRuntimeSettingsLoader,
  type RuntimeSettingsSnapshot } from "@/lib/operations/runtime-settings-store";
import { overlaidModelDefinitions, setModelRegistryOverlay, setModelRoutePolicyOverlay } from "./model-registry";
// The assignment-table default reader (PR 3b-B) installs itself next to the registry overlays; it reads nothing unless MODEL_ASSIGNMENT_TABLE=1.
import "./stage-assignment-snapshot";

/**
 * Admin-managed serving contracts (model_serving_contracts, 0147) as an in-process snapshot.
 * - Reads are synchronous from the last snapshot; a read older than SERVING_CONTRACT_REFRESH_MS starts one background reload.
 *   Job runs and operator CLIs await ensureServingContracts() first, so a change applies on the next tick without a deploy.
 * - A failed reload keeps the previous snapshot. Nothing here grants capacity; contracts only make a route servable.
 * - API keys are decrypted into memory only; they never enter a contract, hash, log or audit row.
 * - The same reload carries the admin registry overrides (model_registry_overrides, 0148) that readModelRegistry() layers over
 *   the code defaults, and the admin runtime settings document (runtime_settings, 0152: route limits/timeouts/deadlines, translation
 *   batches, tick budgets). The three SELECTs are individually tolerant: a part that cannot be read (for example an Oracle principal
 *   without SELECT on model_serving_contracts) keeps its last good value while the others still load.
 * - The runtime_settings row is published into lib/operations/runtime-settings-store (one 판 for the route-policy overlay, the
 *   translation policy and the tick budgets) and served through its loader, so ensureRuntimeSettings() costs at most this reload.
 * MODEL_SERVING_CONTRACTS_DB=0 is the kill switch back to the env-only startup contracts, the code-default registry and the
 * code-default runtime settings.
 */
export type ServingContractAuth = "gateway" | "none" | "stored";
export type ServingContractTransport = "gateway" | "direct";
export type StoredServingContract = Readonly<{ routeId: string; model: string; contract: unknown; auth: ServingContractAuth; apiKey: string | null;
  transport: ServingContractTransport }>;
/** The runtime_settings row as read (sparse document, its 판 and revision); null before 0152 or when the row could not be read yet. */
export type ServingContractRuntimeRow = Readonly<{ stored: unknown; version: string; revision: number; updatedAt: string }>;
/**
 * An enabled device row (model_capacity_devices, 0153 — /admin/models/devices) whose operator-entered physical limit is set. PR 3b-E: the
 * local-direct readiness check (localModelRouteReady) reads the device table through this snapshot before the env LOCAL_MODEL_PHYSICAL_LIMITS.
 */
export type ServingContractDevice = Readonly<{ deviceId: string; physicalLimit: number }>;
export type ServingContractSnapshot = Readonly<{ token: string; loadedAt: number; rows: readonly StoredServingContract[]; registry: readonly unknown[];
  runtime: ServingContractRuntimeRow | null; devices: readonly ServingContractDevice[] }>;
export const SERVING_CONTRACT_REFRESH_MS = 30_000;

type Row = { route_id: string; model: string; contract: unknown; auth: ServingContractAuth; api_key_ciphertext: string | null; updated_at: string;
  transport?: ServingContractTransport };
type RegistryRow = { key: string; definition: unknown; updated_at: string };
export type RuntimeSettingsRow = { values: unknown; revision: number | string; updated_at: string };
export type DeviceLimitRow = { device_id: string; physical_limit: number | string | null };
type RawParts = { rows: readonly Row[]; registry: readonly RegistryRow[]; runtime: RuntimeSettingsRow | null; devices: readonly DeviceLimitRow[] };
type State = { snapshot: ServingContractSnapshot; loading: Promise<void> | null; override: boolean; raw: RawParts; partErrors: Record<string, string> };
const holder = globalThis as unknown as { __nmvServingContracts?: State };
const EMPTY: ServingContractSnapshot = Object.freeze({ token: "env", loadedAt: 0, rows: Object.freeze([]), registry: Object.freeze([]), runtime: null,
  devices: Object.freeze([]) });
const state = (): State => (holder.__nmvServingContracts ??= { snapshot: EMPTY, loading: null, override: false,
  raw: { rows: [], registry: [], runtime: null, devices: [] }, partErrors: {} });
/** Only a positive safe integer is a physical limit; anything else in the row is ignored (the env fallback then decides). */
function deviceLimits(rows: readonly DeviceLimitRow[]): readonly ServingContractDevice[] {
  return Object.freeze(rows.flatMap(row => {
    const limit = Number(row.physical_limit);
    return row.physical_limit !== null && Number.isSafeInteger(limit) && limit >= 1 ? [Object.freeze({ deviceId: row.device_id, physicalLimit: limit })] : [];
  }));
}

function enabled(): boolean {
  return typeof window === "undefined" && process.env.MODEL_SERVING_CONTRACTS_DB !== "0" && !!process.env.DATABASE_URL && !state().override;
}

export function servingContractSnapshotFromRows(rows: readonly Row[], loadedAt = Date.now(), registryRows: readonly RegistryRow[] = [],
  runtimeRow: RuntimeSettingsRow | null = null, deviceRows: readonly DeviceLimitRow[] = []): ServingContractSnapshot {
  const runtime: ServingContractRuntimeRow | null = runtimeRow
    ? Object.freeze({ stored: runtimeRow.values, version: storedSettingsVersion(runtimeRow.values), revision: Number(runtimeRow.revision), updatedAt: runtimeRow.updated_at })
    : null;
  const devices = deviceLimits(deviceRows);
  // Device limits enter the token only when present, so a snapshot without device rows keeps the token it had before PR 3b-E.
  const token = createHash("sha256").update(JSON.stringify([rows.map(row => [row.route_id, row.model, row.updated_at, row.auth, row.transport ?? "gateway"]),
    registryRows.map(row => [row.key, row.updated_at]), runtime ? [runtime.revision, runtime.updatedAt, runtime.version] : null,
    ...(devices.length ? [devices.map(device => [device.deviceId, device.physicalLimit])] : [])])).digest("hex");
  return Object.freeze({ token, loadedAt, rows: Object.freeze(rows.map(row => Object.freeze({ routeId: row.route_id, model: row.model,
    contract: row.contract, auth: row.auth, transport: row.transport === "direct" ? "direct" as const : "gateway" as const,
    // A key that does not open (no box key, tampered or moved row) stays null; the caller then refuses that route.
    apiKey: row.auth === "stored" && row.api_key_ciphertext ? openSecret(row.api_key_ciphertext, servingContractKeyAad(row.route_id, row.model)) : null }))),
    registry: Object.freeze(registryRows.map(row => row.definition)), runtime, devices });
}

/** One part of the reload; a failure keeps the last good value of that part and is logged once per distinct error (not every 30 s). */
async function reloadPart<T>(current: State, part: string, load: () => Promise<T>, previous: T): Promise<T> {
  try {
    const value = await load();
    if (current.partErrors[part]) { delete current.partErrors[part]; logger.info("serving_contracts.reload_part_recovered", { part }); }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    if (current.partErrors[part] !== message) { current.partErrors[part] = message; logger.warn("serving_contracts.reload_part_failed", { part, error: message }); }
    return previous;
  }
}

export async function refreshServingContracts(): Promise<void> {
  const current = state();
  try {
    const [{ db }, { sql }, { currentReplayDb }] = await Promise.all([import("@/lib/db"), import("drizzle-orm"), import("@/lib/db/replay-scope")]);
    if (currentReplayDb()) return;
    const previous = current.raw;
    const rows = await reloadPart(current, "model_serving_contracts", async () => Array.from(await db.execute<Row>(sql`SELECT route_id, model, contract, auth, api_key_ciphertext, transport,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at
      FROM model_serving_contracts WHERE enabled ORDER BY route_id, model`)), previous.rows);
    const registry = await reloadPart(current, "model_registry_overrides", async () => Array.from(await db.execute<RegistryRow>(sql`SELECT key, definition,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at
      FROM model_registry_overrides WHERE enabled ORDER BY key`)), previous.registry);
    const runtime = await reloadPart(current, "runtime_settings", async () => {
      const [row] = Array.from(await db.execute<RuntimeSettingsRow>(sql`SELECT values, revision,
          to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at
        FROM runtime_settings WHERE id = 1`));
      return row ?? null;
    }, previous.runtime);
    // Device physical limits (0153): only enabled rows with an operator-entered limit; a principal without SELECT keeps the last good list.
    const devices = await reloadPart(current, "model_capacity_devices", async () => Array.from(await db.execute<DeviceLimitRow>(sql`SELECT device_id, physical_limit
      FROM model_capacity_devices WHERE enabled AND physical_limit IS NOT NULL ORDER BY device_id`)), previous.devices);
    current.raw = { rows, registry, runtime, devices };
    current.snapshot = servingContractSnapshotFromRows(rows, Date.now(), registry, runtime, devices);
    const settings = servingRuntimeSettingsSnapshot(current.snapshot);
    if (settings) publishRuntimeSettingsSnapshot(settings);
  } catch {
    // Keep serving the last good snapshot; retry after the normal interval.
    current.snapshot = { ...current.snapshot, loadedAt: Date.now() };
  }
}

/** Synchronous read for resolvers. A stale snapshot triggers one background reload and is still returned. */
export function servingContractSnapshot(): ServingContractSnapshot {
  const current = state();
  if (enabled() && !current.loading && Date.now() - current.snapshot.loadedAt >= SERVING_CONTRACT_REFRESH_MS)
    current.loading = refreshServingContracts().finally(() => { current.loading = null; });
  return current.snapshot;
}

/** Await a snapshot no older than maxAgeMs (job start, operator CLI). Never throws. */
export async function ensureServingContracts(maxAgeMs = SERVING_CONTRACT_REFRESH_MS): Promise<void> {
  const current = state();
  if (!enabled()) return;
  if (current.loading) return current.loading;
  if (Date.now() - current.snapshot.loadedAt < maxAgeMs) return;
  current.loading = refreshServingContracts().finally(() => { current.loading = null; });
  return current.loading;
}

/**
 * The operator-entered physical limit of an enabled device row (model_capacity_devices.physical_limit), or null when the table has none for it
 * (the caller then falls back to env LOCAL_MODEL_PHYSICAL_LIMITS). Synchronous from the last snapshot like every other read here.
 */
export function devicePhysicalLimit(deviceId: string): number | null {
  return servingContractSnapshot().devices.find(device => device.deviceId === deviceId)?.physicalLimit ?? null;
}

/** The stored auth and transport for one contract, or null when no admin row exists (the caller keeps its env default). */
export function servingContractAuth(routeId: string, model: string): { mode: ServingContractAuth; apiKey: string | null; transport: ServingContractTransport } | null {
  const row = servingContractSnapshot().rows.find(entry => entry.routeId === routeId && entry.model === model);
  return row ? { mode: row.auth, apiKey: row.apiKey, transport: row.transport } : null;
}

/**
 * A text route can authenticate a call to its model — the same rule the senders apply (contractBearer in agent-review-gateway):
 * - an admin contract for this route+model with no key (auth none: a keyless engine, usually transport direct) is callable;
 * - one with its own stored key (auth stored) is callable when that key opens (a key that does not open is refused at send time);
 * - otherwise (no admin row, or auth gateway) the abcLLM gateway key ABCLLM_API_KEY must be set.
 * Replaces the old "ABCLLM_API_KEY is set" gate, so removing the gateway key stops nothing that no longer goes through the gateway
 * (PR 3b-C: every text job — reason-translate and crawl-tagline included — gates on this, not on the key).
 * - a local-direct contract (PR 3b-E: direct-openai-chat-v1 under the text route) sends no bearer at all when it has no admin row or
 *   auth gateway (contractBearer returns null for a non-abcllm provider), so the route is callable without the gateway key. The caller
 *   passes the provider its contract module resolved (`<route>ServingProvider(model)`); the default keeps the abcllm rule.
 * The Qwen native path of product-tagline-ko (korean-translation-config, env switch) is outside this gate and stays as is until the
 * route→engine assignment table (PR 3b-B/3b-D) absorbs it.
 */
export function textRouteCallable(routeId: string, model: string, provider: "abcllm" | "local-direct" = "abcllm"): boolean {
  const stored = servingContractAuth(routeId, model);
  if (stored?.mode === "none") return true;
  if (stored?.mode === "stored") return !!stored.apiKey;
  if (provider === "local-direct") return true;
  return !!process.env.ABCLLM_API_KEY?.trim();
}

/** Tests and replay: pin a snapshot and stop DB reloads. Pass null to restore normal loading. */
export function setServingContractSnapshotForTest(rows: readonly (Omit<StoredServingContract, "transport"> & { transport?: ServingContractTransport })[] | null,
  registry: readonly unknown[] = [], devices: readonly ServingContractDevice[] = []): void {
  const current = state();
  current.override = rows !== null;
  const pinned = (rows ?? []).map(row => ({ ...row, transport: row.transport ?? "gateway" as const }));
  current.snapshot = rows === null ? EMPTY
    : { token: createHash("sha256").update(JSON.stringify([pinned, registry, devices])).digest("hex"), loadedAt: Date.now(), rows: pinned, registry, runtime: null,
      devices: Object.freeze([...devices]) };
}

/**
 * The runtime settings snapshot carried by a serving snapshot: the stored document resolved over the code defaults with the overlaid
 * registry's purposes as known routes. Resolved once per distinct snapshot content (token); unreadable keys are logged once then.
 * null when the snapshot carries no row (before 0152, kill switch, replay, or a read that never succeeded).
 */
let resolved: { token: string; snapshot: RuntimeSettingsSnapshot } | null = null;
export function servingRuntimeSettingsSnapshot(snapshot: ServingContractSnapshot): RuntimeSettingsSnapshot | null {
  if (!snapshot.runtime) return null;
  if (resolved?.token !== snapshot.token) {
    const built = runtimeSettingsSnapshotFromStored(snapshot.runtime.stored, snapshot.runtime.revision, snapshot.loadedAt,
      { models: overlaidModelDefinitions(snapshot.registry) });
    if (built.issues.length) logger.warn("runtime_settings.unreadable_keys", { version: built.snapshot.version, revision: built.snapshot.revision, issues: built.issues });
    resolved = { token: snapshot.token, snapshot: built.snapshot };
  }
  return resolved.snapshot.loadedAt === snapshot.loadedAt ? resolved.snapshot : Object.freeze({ ...resolved.snapshot, loadedAt: snapshot.loadedAt });
}

// Registry reads are synchronous, frequent and also happen at import time, so they only read the last snapshot and never start
// a reload (no DB client before the process's own DB entry checks). Jobs, the operator CLI and the admin pages await
// ensureServingContracts() first.
setModelRegistryOverlay(() => enabled() || state().override ? state().snapshot.registry : []);
// Admin route policy (runtime_settings routes) layers the same way; the pinned tick snapshot wins inside withRuntimeSettings.
setModelRoutePolicyOverlay(() => runtimeSettings().routes);
// ensureRuntimeSettings(maxAgeMs) rides the same reload: at most one SELECT trio per interval per process. null keeps the current
// snapshot (kill switch, no row yet or a read that never succeeded); the store then waits one interval before asking again.
setRuntimeSettingsLoader(async maxAgeMs => {
  if (!enabled()) return null;
  await ensureServingContracts(maxAgeMs);
  return servingRuntimeSettingsSnapshot(state().snapshot);
});
