import { createHash } from "node:crypto";
import { openSecret, servingContractKeyAad } from "@/lib/security/secret-box";

/**
 * Admin-managed serving contracts (model_serving_contracts, 0147) as an in-process snapshot.
 * - Reads are synchronous from the last snapshot; a read older than SERVING_CONTRACT_REFRESH_MS starts one background reload.
 *   Job runs and operator CLIs await ensureServingContracts() first, so a change applies on the next tick without a deploy.
 * - A failed reload keeps the previous snapshot. Nothing here grants capacity; contracts only make a route servable.
 * - API keys are decrypted into memory only; they never enter a contract, hash, log or audit row.
 * MODEL_SERVING_CONTRACTS_DB=0 is the kill switch back to the env-only startup contracts.
 */
export type ServingContractAuth = "gateway" | "none" | "stored";
export type StoredServingContract = Readonly<{ routeId: string; model: string; contract: unknown; auth: ServingContractAuth; apiKey: string | null }>;
export type ServingContractSnapshot = Readonly<{ token: string; loadedAt: number; rows: readonly StoredServingContract[] }>;
export const SERVING_CONTRACT_REFRESH_MS = 30_000;

type State = { snapshot: ServingContractSnapshot; loading: Promise<void> | null; override: boolean };
const holder = globalThis as unknown as { __nmvServingContracts?: State };
const state = (): State => (holder.__nmvServingContracts ??= { snapshot: { token: "env", loadedAt: 0, rows: [] }, loading: null, override: false });

function enabled(): boolean {
  return typeof window === "undefined" && process.env.MODEL_SERVING_CONTRACTS_DB !== "0" && !!process.env.DATABASE_URL && !state().override;
}

type Row = { route_id: string; model: string; contract: unknown; auth: ServingContractAuth; api_key_ciphertext: string | null; updated_at: string };
export function servingContractSnapshotFromRows(rows: readonly Row[], loadedAt = Date.now()): ServingContractSnapshot {
  const token = createHash("sha256").update(JSON.stringify(rows.map(row => [row.route_id, row.model, row.updated_at, row.auth]))).digest("hex");
  return Object.freeze({ token, loadedAt, rows: Object.freeze(rows.map(row => Object.freeze({ routeId: row.route_id, model: row.model,
    contract: row.contract, auth: row.auth,
    // A key that does not open (no box key, tampered or moved row) stays null; the caller then refuses that route.
    apiKey: row.auth === "stored" && row.api_key_ciphertext ? openSecret(row.api_key_ciphertext, servingContractKeyAad(row.route_id, row.model)) : null }))) });
}

export async function refreshServingContracts(): Promise<void> {
  const current = state();
  try {
    const [{ db }, { sql }, { currentReplayDb }] = await Promise.all([import("@/lib/db"), import("drizzle-orm"), import("@/lib/db/replay-scope")]);
    if (currentReplayDb()) return;
    const rows = await db.execute<Row>(sql`SELECT route_id, model, contract, auth, api_key_ciphertext,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at
      FROM model_serving_contracts WHERE enabled ORDER BY route_id, model`);
    current.snapshot = servingContractSnapshotFromRows(Array.from(rows));
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

/** The stored auth for one contract, or null when no admin row exists (the caller keeps its env default). */
export function servingContractAuth(routeId: string, model: string): { mode: ServingContractAuth; apiKey: string | null } | null {
  const row = servingContractSnapshot().rows.find(entry => entry.routeId === routeId && entry.model === model);
  return row ? { mode: row.auth, apiKey: row.apiKey } : null;
}

/** Tests and replay: pin a snapshot and stop DB reloads. Pass null to restore normal loading. */
export function setServingContractSnapshotForTest(rows: readonly StoredServingContract[] | null): void {
  const current = state();
  current.override = rows !== null;
  current.snapshot = rows === null ? { token: "env", loadedAt: 0, rows: [] }
    : { token: createHash("sha256").update(JSON.stringify(rows)).digest("hex"), loadedAt: Date.now(), rows };
}
