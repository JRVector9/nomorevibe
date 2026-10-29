import { createHash } from "node:crypto";
import { openSecret, servingContractKeyAad } from "@/lib/security/secret-box";
import { setModelRegistryOverlay } from "./model-registry";

/**
 * Admin-managed serving contracts (model_serving_contracts, 0147) as an in-process snapshot.
 * - Reads are synchronous from the last snapshot; a read older than SERVING_CONTRACT_REFRESH_MS starts one background reload.
 *   Job runs and operator CLIs await ensureServingContracts() first, so a change applies on the next tick without a deploy.
 * - A failed reload keeps the previous snapshot. Nothing here grants capacity; contracts only make a route servable.
 * - API keys are decrypted into memory only; they never enter a contract, hash, log or audit row.
 * - The same reload carries the admin registry overrides (model_registry_overrides, 0148) that readModelRegistry() layers over
 *   the code defaults.
 * MODEL_SERVING_CONTRACTS_DB=0 is the kill switch back to the env-only startup contracts and the code-default registry.
 */
export type ServingContractAuth = "gateway" | "none" | "stored";
export type ServingContractTransport = "gateway" | "direct";
export type StoredServingContract = Readonly<{ routeId: string; model: string; contract: unknown; auth: ServingContractAuth; apiKey: string | null;
  transport: ServingContractTransport }>;
export type ServingContractSnapshot = Readonly<{ token: string; loadedAt: number; rows: readonly StoredServingContract[]; registry: readonly unknown[] }>;
export const SERVING_CONTRACT_REFRESH_MS = 30_000;

type State = { snapshot: ServingContractSnapshot; loading: Promise<void> | null; override: boolean };
const holder = globalThis as unknown as { __nmvServingContracts?: State };
const EMPTY: ServingContractSnapshot = Object.freeze({ token: "env", loadedAt: 0, rows: Object.freeze([]), registry: Object.freeze([]) });
const state = (): State => (holder.__nmvServingContracts ??= { snapshot: EMPTY, loading: null, override: false });

function enabled(): boolean {
  return typeof window === "undefined" && process.env.MODEL_SERVING_CONTRACTS_DB !== "0" && !!process.env.DATABASE_URL && !state().override;
}

type Row = { route_id: string; model: string; contract: unknown; auth: ServingContractAuth; api_key_ciphertext: string | null; updated_at: string;
  transport?: ServingContractTransport };
type RegistryRow = { key: string; definition: unknown; updated_at: string };
export function servingContractSnapshotFromRows(rows: readonly Row[], loadedAt = Date.now(), registryRows: readonly RegistryRow[] = []): ServingContractSnapshot {
  const token = createHash("sha256").update(JSON.stringify([rows.map(row => [row.route_id, row.model, row.updated_at, row.auth, row.transport ?? "gateway"]),
    registryRows.map(row => [row.key, row.updated_at])])).digest("hex");
  return Object.freeze({ token, loadedAt, rows: Object.freeze(rows.map(row => Object.freeze({ routeId: row.route_id, model: row.model,
    contract: row.contract, auth: row.auth, transport: row.transport === "direct" ? "direct" as const : "gateway" as const,
    // A key that does not open (no box key, tampered or moved row) stays null; the caller then refuses that route.
    apiKey: row.auth === "stored" && row.api_key_ciphertext ? openSecret(row.api_key_ciphertext, servingContractKeyAad(row.route_id, row.model)) : null }))),
    registry: Object.freeze(registryRows.map(row => row.definition)) });
}

export async function refreshServingContracts(): Promise<void> {
  const current = state();
  try {
    const [{ db }, { sql }, { currentReplayDb }] = await Promise.all([import("@/lib/db"), import("drizzle-orm"), import("@/lib/db/replay-scope")]);
    if (currentReplayDb()) return;
    const rows = await db.execute<Row>(sql`SELECT route_id, model, contract, auth, api_key_ciphertext, transport,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at
      FROM model_serving_contracts WHERE enabled ORDER BY route_id, model`);
    const registry = await db.execute<RegistryRow>(sql`SELECT key, definition,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at
      FROM model_registry_overrides WHERE enabled ORDER BY key`);
    current.snapshot = servingContractSnapshotFromRows(Array.from(rows), Date.now(), Array.from(registry));
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

/** The stored auth and transport for one contract, or null when no admin row exists (the caller keeps its env default). */
export function servingContractAuth(routeId: string, model: string): { mode: ServingContractAuth; apiKey: string | null; transport: ServingContractTransport } | null {
  const row = servingContractSnapshot().rows.find(entry => entry.routeId === routeId && entry.model === model);
  return row ? { mode: row.auth, apiKey: row.apiKey, transport: row.transport } : null;
}

/** Tests and replay: pin a snapshot and stop DB reloads. Pass null to restore normal loading. */
export function setServingContractSnapshotForTest(rows: readonly (Omit<StoredServingContract, "transport"> & { transport?: ServingContractTransport })[] | null,
  registry: readonly unknown[] = []): void {
  const current = state();
  current.override = rows !== null;
  const pinned = (rows ?? []).map(row => ({ ...row, transport: row.transport ?? "gateway" as const }));
  current.snapshot = rows === null ? EMPTY
    : { token: createHash("sha256").update(JSON.stringify([pinned, registry])).digest("hex"), loadedAt: Date.now(), rows: pinned, registry };
}

// Registry reads are synchronous, frequent and also happen at import time, so they only read the last snapshot and never start
// a reload (no DB client before the process's own DB entry checks). Jobs, the operator CLI and the admin pages await
// ensureServingContracts() first.
setModelRegistryOverlay(() => enabled() || state().override ? state().snapshot.registry : []);
