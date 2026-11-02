import { createHash } from "node:crypto";
import { openSecret, servingContractKeyAad } from "@/lib/security/secret-box";
import { logger } from "@/lib/observability/logger";
import { storedSettingsVersion } from "@/lib/operations/runtime-settings-schema";
import { publishRuntimeSettingsSnapshot, runtimeSettings, runtimeSettingsSnapshotFromStored, setRuntimeSettingsLoader,
  type RuntimeSettingsSnapshot } from "@/lib/operations/runtime-settings-store";
import { overlaidModelDefinitions, setModelRegistryOverlay, setModelRoutePolicyOverlay } from "./model-registry";
import { activeTextTaskRank } from "./ai-task-rank-scope";
import { aiTaskModelRows, type AiTaskConnectionSnapshot } from "./ai-task-models-snapshot";
// The assignment-table default reader (PR 3b-B) installs itself next to the registry overlays; it reads nothing unless the runtime_settings
// toggle assignments.tableReads is on (or MODEL_ASSIGNMENT_TABLE=1 forces it — PR 3b-E, lib/llm/assignment-flag.ts).
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
 * MODEL_SERVING_CONTRACTS_DB=0 is the kill switch to no contracts (every contract route defers), the code-default registry and the
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
/**
 * Whether this process reads the admin tables (contracts, registry overrides, runtime_settings) from the DB at all: server side, no kill switch
 * (MODEL_SERVING_CONTRACTS_DB=0), DATABASE_URL set, not pinned by a test. The assignment-table gate (PR 3b-E) defers on an unread toggle only here —
 * an env-only process keeps the code defaults (legacy selection) without deferring.
 */
export function servingContractsDbEnabled(): boolean { return enabled(); }

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

/** The stored auth and transport for one contract, or null when no admin row exists. */
export function servingContractAuth(routeId: string, model: string): { mode: ServingContractAuth; apiKey: string | null; transport: ServingContractTransport } | null {
  const row = servingContractSnapshot().rows.find(entry => entry.routeId === routeId && entry.model === model);
  return row ? { mode: row.auth, apiKey: row.apiKey, transport: row.transport } : null;
}

/** Why a route cannot call its model; see textRouteAccess. */
export type TextRouteBlock = "no_direct_contract" | "gateway_auth" | "stored_key_unreadable" | "connection_key_missing";
/** Operator-facing detail for each block (job degraded detail, status lines). */
export const TEXT_ROUTE_BLOCK_DETAIL: Readonly<Record<TextRouteBlock, string>> = {
  no_direct_contract: "이 경로·모델의 직접 연결 계약(관리자 엔진 연결, transport direct)이 없습니다",
  gateway_auth: "직접 연결 계약의 인증이 게이트웨이 키로 되어 있습니다 — 게이트웨이는 제거됐으니 키 없음 또는 저장한 키로 다시 저장하세요",
  stored_key_unreadable: "직접 연결 계약에 저장한 키를 열 수 없습니다(암호 상자 키 확인)",
  connection_key_missing: "이 서버의 계약은 키를 쓰는데 「작업 ↔ 모델」 연결에 키가 없습니다 — 연결에 키를 넣으세요(같은 주소의 계약 키가 하나뿐이면 자동으로 채웁니다)",
};
/** The access decision: blocked with a reason, or open with the bearer to send (null = no Authorization header). */
export type TextRouteAccess = Readonly<{ block: TextRouteBlock; bearer?: undefined } | { block: null; bearer: string | null }>;

const contractProvider = (contract: unknown): string | null =>
  contract && typeof contract === "object" && typeof (contract as { provider?: unknown }).provider === "string" ? (contract as { provider: string }).provider : null;

/**
 * The one rule for "may this route call this model, and with which bearer" — the gate the text jobs check before a tick (textRouteBlock /
 * textRouteCallable) and the bearer the senders attach (contractBearer in agent-review-gateway) are this same decision, so the two never
 * disagree. The abcLLM gateway was removed on 2026-10-30 and no process env key is consulted; what opens a route:
 * - an engine connected directly — an admin contract (model_serving_contracts) of this route+model with transport direct — with no key
 *   (auth none) or its own stored key (auth stored, when that key opens). Gateway auth on such a row never opens it (gateway_auth); a
 *   stored key that does not open is refused here, not at send time (stored_key_unreadable);
 * - a local-direct contract (PR 3b-C: AI1·AI2, PR 3b-E: the seven text routes, direct-openai-chat-v1, the engine's own name on the wire)
 *   is direct by definition, whatever the row's transport flag says, and sends no key unless its row stores one. `provider` is the parsed
 *   contract's provider when the caller holds it (text jobs pass `<route>ServingProvider(model)`); without it the row's contract JSON decides.
 * Anything else — no row, a gateway-transport abcllm row — is no_direct_contract. The Qwen native path of product-tagline-ko
 * (korean-translation-config, env switch) is outside this gate until the route→engine assignment table (PR 3b-B/3b-D) absorbs it.
 */
export function textRouteAccess(routeId: string, model: string, provider?: string): TextRouteAccess {
  const row = servingContractSnapshot().rows.find(entry => entry.routeId === routeId && entry.model === model);
  const access = servingContractRowAccess(row, provider);
  // 「작업 ↔ 모델」 순위로 부르는 중이면(PR B) 보내는 키는 그 연결(ai_connections)의 키다 — 계약 행의 키가 아니다. 계약이 닫힌 까닭(계약 없음·
  // 게이트웨이 인증)은 그대로 막는다. 계약 행의 키가 열리지 않는 것은 상관없다(연결의 키를 보낸다).
  const rank = activeTextTaskRank(routeId);
  if (rank && rank.identity === model) {
    if (access.block && access.block !== "stored_key_unreadable") return access;
    // 키가 필요한 서버(계약 auth stored)에 키 없는 연결로 보내지 않는다 — 묶기(bindTextTaskRank)가 먼저 막지만 보내는 길도 같은 규칙이다
    if (row?.auth === "stored" && rank.bearer === null) return { block: "connection_key_missing" };
    return { block: null, bearer: rank.bearer };
  }
  // 심사 두 경로(PR C1): 계약이 가리키는 엔진 주소의 연결이 그 작업의 순위에 있으면 그 연결의 키를 보낸다(순위 범위 없이 — 1차·2차의 모든 길이 같은 키를 쓴다)
  const connection = reviewRankConnection(routeId, row);
  if (!connection) return access;
  if (access.block && access.block !== "stored_key_unreadable") return access;
  if (connection.keyUnreadable) return { block: "stored_key_unreadable" };
  // 키가 필요한 서버(계약 auth stored)인데 연결에 키가 없다 — 키 없이 보내 401 로 결과를 모르게 만들지 않는다(2026-11-02). 키 없이 도는 서버(auth none)는 그대로다
  if (row?.auth === "stored" && connection.apiKey === null) return { block: "connection_key_missing" };
  return { block: null, bearer: connection.apiKey };
}

/** 심사 경로 → 그 경로를 쓰는 「작업 ↔ 모델」 작업(lib/llm/ai-tasks.ts). */
const REVIEW_ROUTE_TASKS: Readonly<Record<string, string>> = Object.freeze({ "crawl-agent-review": "first-review", "second-review": "second-review" });
/**
 * 심사 계약 행이 가리키는 연결(PR C1): 그 작업의 켜진 순위 중 연결 주소 = 계약 끝점의 `origin/v1`, 순위 모델 = 계약의 엔진 모델(engineModel 또는 model)인 API 연결.
 * 연결 주소는 하나뿐이라(ai_connections_base_url_idx) 많아야 연결 하나다. 순위 스냅숏을 읽지 못한 프로세스(replay·DB 없음)는 null — 계약 행의 규칙 그대로다.
 */
function reviewRankConnection(routeId: string, row: StoredServingContract | undefined): AiTaskConnectionSnapshot | null {
  const task = REVIEW_ROUTE_TASKS[routeId];
  if (!task || !row || !row.contract || typeof row.contract !== "object") return null;
  const contract = row.contract as Record<string, unknown>;
  const field = (name: string) => typeof contract[name] === "string" && contract[name] ? contract[name] as string : null;
  let base: string | null = null;
  try {
    const url = new URL(field("endpoint") ?? "");
    base = url.pathname === "/v1/chat/completions" ? `${url.origin}/v1` : null;
  } catch { base = null; }
  if (!base) return null;
  const wire = field("provider") === "local-direct" ? field("model") : field("engineModel") ?? field("model");
  return aiTaskModelRows().find(rank => rank.task === task && rank.enabled && rank.connection.enabled && rank.connection.kind === "api"
    && rank.connection.baseUrl === base && rank.model === wire)?.connection ?? null;
}
/**
 * textRouteAccess for one already-found row (or none) — the same rule without the snapshot lookup. The admin models page's automatic
 * connection check (lib/operations/admin-models-direct-probe.ts) decides with this which contract rows it may list and with which bearer.
 */
export function servingContractRowAccess(row: StoredServingContract | undefined, provider?: string): TextRouteAccess {
  const localDirect = provider === "local-direct" || (row ? contractProvider(row.contract) === "local-direct" : false);
  if (!localDirect && row?.transport !== "direct") return { block: "no_direct_contract" };
  if (!row || row.auth === "gateway") return localDirect ? { block: null, bearer: null } : { block: "gateway_auth" };
  if (row.auth === "none") return { block: null, bearer: null };
  return row.apiKey ? { block: null, bearer: row.apiKey } : { block: "stored_key_unreadable" };
}
/** Why a text route cannot call its model, or null when it can (textRouteAccess). */
export function textRouteBlock(routeId: string, model: string, provider?: string): TextRouteBlock | null {
  return textRouteAccess(routeId, model, provider).block;
}
export function textRouteCallable(routeId: string, model: string, provider?: string): boolean {
  return textRouteBlock(routeId, model, provider) === null;
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
