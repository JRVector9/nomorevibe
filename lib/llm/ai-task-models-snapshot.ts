import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@/lib/observability/logger";
import { openSecret, secretBoxReady } from "@/lib/security/secret-box";
import { cliCatalogMetadata, cliCatalogMetadataFromSnapshot, type CliCatalogMetadata } from "./cli-catalog-metadata";
import { cliEngineEndpoint } from "./cli-engine-config";
import { setCliEngineModelOverlay, type ModelDefinition } from "./model-registry";

/**
 * 「작업 ↔ 모델」 순위(ai_task_models)와 그 연결(ai_connections, 0162)의 프로세스 스냅숏(2026-11-02, PR B).
 *
 * serving-contract-store·stage-assignment-snapshot 과 같은 규칙: 고르기는 동기라 마지막 스냅숏을 읽고, 30초보다 오래됐으면 뒤에서 한 번 다시 읽는다.
 * 잡 틱·웹 요청의 비동기 길목은 `ensureAiTaskModels()` 로 먼저 기다린다. 읽기에 실패하면 마지막으로 읽은 행을 그대로 쓴다(서로 다른 오류마다 한 번 남긴다).
 * 한 번도 읽지 못했으면 `loaded: false` — 고르는 쪽은 「순위 없음」과 가르어 `task_models_unreadable` 로 보인다(조용히 기본값으로 부르지 않는다).
 *
 * 키는 연결 행의 secret-box 암호문(AAD `ai_connections\n<id>`, PR A 와 같다)을 이 프로세스 메모리에서만 연다 — 스냅숏 밖(로그·관측·화면)으로 나가지 않는다.
 * 열리지 않는 키(box key 없음·바뀜·옮긴 행)는 null 과 keyUnreadable 로 남는다 — 그 순위는 쓸 수 없다(`stored_key_unreadable`).
 * DB 를 읽지 않는 프로세스: 브라우저·DATABASE_URL 없음·MODEL_SERVING_CONTRACTS_DB=0(계약과 같은 끄기 스위치)·replay·시험 고정.
 *
 * 다시 읽은 순위에 키 없는 켜진 API 연결이 있고 이 프로세스에 상자 키가 있으면 같은 주소의 계약 키로 그 연결의 키를 채운다(lib/operations/ai-connection-key-fill.ts,
 * 프로세스마다 5분에 한 번 이하·조건부 갱신). 배포 뒤 사람이 화면을 열지 않아도 순위를 읽는 워커가 스스로 고친다. 채웠으면 다음 읽기에서 바로 다시 읽는다.
 */
export const AI_TASK_MODELS_REFRESH_MS = 30_000;

const readOnlyScope = new AsyncLocalStorage<true>();
/** Monitoring/query readers may initialize and refresh ranks without starting credential-repair writes.
 * Async descendants (including synchronous getters' background reloads) inherit this scope.
 * Normal worker/admin initialization keeps the existing key-fill behavior.
 */
export function withReadOnlyAiTaskModels<T>(run: () => T): T { return readOnlyScope.run(true, run); }

export type AiTaskConnectionSnapshot = Readonly<{
  id: string; label: string; kind: "api" | "cli"; baseUrl: string | null; cliTool: string | null; deviceId: string; enabled: boolean;
  models: readonly Readonly<{ id: string; maxModelLen: number | null; vision?: boolean }>[] | null; contextTokens: number | null;
  /** 실제 행에 노출된 CLI 모델 id(없으면 생략) */
  cliModels?: readonly string[];
  /** 검증된 CLI 카탈로그 버전(없으면 null) */
  cliVersion?: string | null;
  /** 검증된 CLI 카탈로그(없으면 null) */
  cliCatalog?: CliCatalogMetadata | null;
  /** 이 연결에 실제로 배정된 동시성 슬롯(없으면 0) */
  capacitySlots?: number;
  /** 연 키(메모리 안에서만). 키가 없거나 열리지 않으면 null */
  apiKey: string | null;
  /** 암호문이 있는데 열리지 않았다 */
  keyUnreadable: boolean;
  /** 연결 행 버전(있으면 정확히 일치해야 한다). 예전 시험 고정에는 없다. */
  version?: number;
}>;
export type AiTaskModelSnapshotRow = Readonly<{
  task: string; slot: number; rank: number; model: string; enabled: boolean; options: Readonly<Record<string, unknown>>;
  connection: AiTaskConnectionSnapshot;
}>;

type HydratedCliCatalog = Readonly<{
  version: number | null;
  catalog: CliCatalogMetadata;
  models: readonly Readonly<{ id: string; maxModelLen: number | null; vision?: boolean }>[];
  cliVersion: string;
  observedAt: number;
  hydratedAt: number;
}>;

type State = {
  rows: readonly AiTaskModelSnapshotRow[];
  cliConnections: readonly AiTaskConnectionSnapshot[];
  loaded: boolean;
  loadedAt: number;
  loading: Promise<void> | null;
  pinned: boolean;
  error: string | null;
  cliLoaded: boolean;
  cliError: string | null;
  hydratedCliCatalogs: Map<string, HydratedCliCatalog>;
};
const holder = globalThis as unknown as { __nmvAiTaskModels?: State };
const state = (): State => (holder.__nmvAiTaskModels ??= {
  rows: Object.freeze([]), cliConnections: Object.freeze([]), loaded: false, loadedAt: 0, loading: null, pinned: false,
  error: null, cliLoaded: false, cliError: null, hydratedCliCatalogs: new Map<string, HydratedCliCatalog>(),
});

function readable(current: State): boolean {
  return typeof window === "undefined" && !current.pinned && !!process.env.DATABASE_URL && process.env.MODEL_SERVING_CONTRACTS_DB !== "0";
}

type RawConnection = {
  connection_id: string; label: string; kind: string; base_url: string | null; api_key_ciphertext: string | null; cli_tool: string | null;
  device_id: string; connection_enabled: boolean; models: unknown; connection_options: unknown; connection_version?: number | string;
  cli_models?: unknown; capacity_slots?: number | string;
};
type RawRow = RawConnection & { task: string; slot: number | string; rank: number | string; model: string; enabled: boolean; options: unknown };

const safeInteger = (value: unknown): number | null => {
  if (value === undefined || value === null || `${value}`.trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};
const positiveInteger = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const sha256Json = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CLI_EFFORT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function modelEntries(value: unknown): readonly Readonly<{ id: string; maxModelLen: number | null; vision?: boolean }>[] | null {
  if (!Array.isArray(value)) return null;
  return Object.freeze(value.flatMap(entry => {
    const model = objectOf(entry);
    return typeof model.id === "string" ? [Object.freeze({ id: model.id,
      maxModelLen: typeof model.maxModelLen === "number" ? model.maxModelLen : null,
      ...(typeof model.vision === "boolean" ? { vision: model.vision } : {}) })] : [];
  }));
}

function catalogModelEntries(catalog: CliCatalogMetadata | null): readonly Readonly<{ id: string; maxModelLen: number | null; vision?: boolean }>[] | null {
  if (!catalog) return null;
  const entries = (catalog as unknown as { models?: readonly unknown[] }).models;
  if (!Array.isArray(entries)) return null;
  return Object.freeze(entries.flatMap(entry => {
    const model = objectOf(entry);
    return typeof model.id === "string" ? [Object.freeze({ id: model.id,
      maxModelLen: typeof model.maxModelLen === "number" ? model.maxModelLen : null,
      ...(typeof model.vision === "boolean" ? { vision: model.vision } : {}) })] : [];
  }));
}

type CatalogModelDefinition = Readonly<{
  id: string; label: string; variants: readonly string[]; maxModelLen: number | null; vision?: boolean;
}>;

function catalogModelsForDefinitions(catalog: CliCatalogMetadata | null): readonly CatalogModelDefinition[] {
  if (!catalog) return Object.freeze([]);
  const entries = (catalog as unknown as { models?: readonly unknown[] }).models;
  if (!Array.isArray(entries)) return Object.freeze([]);
  return Object.freeze(entries.flatMap(entry => {
    const model = objectOf(entry);
    if (typeof model.id !== "string") return [];
    return [Object.freeze({
      id: model.id,
      label: typeof model.label === "string" ? model.label : model.id,
      variants: Object.freeze(Array.isArray(model.variants) ? model.variants.filter((variant): variant is string => typeof variant === "string") : []),
      maxModelLen: typeof model.maxModelLen === "number" ? model.maxModelLen : null,
      ...(typeof model.vision === "boolean" ? { vision: model.vision } : {}),
    })];
  }));
}

function connectionSnapshotFromRaw(row: RawConnection, hydrated?: HydratedCliCatalog): AiTaskConnectionSnapshot {
  const options = objectOf(row.connection_options);
  const cliModels = Array.isArray(row.cli_models) ? Object.freeze(row.cli_models.filter((entry): entry is string => typeof entry === "string")) : undefined;
  const optionCliVersion = typeof options.cliVersion === "string" ? options.cliVersion : null;
  const catalog = hydrated?.catalog ?? (cliModels
    ? cliCatalogMetadataFromSnapshot(options.cliHostCatalog, cliModels, optionCliVersion, sha256Json(cliModels))
    : null);
  const models = row.kind === "cli" ? (hydrated?.models ?? catalogModelEntries(catalog)) : modelEntries(row.models);
  const contextTokens = typeof options.contextTokens === "number" ? options.contextTokens : null;
  const version = safeInteger(row.connection_version);
  const apiKey = row.api_key_ciphertext ? openSecret(row.api_key_ciphertext, aad(row.connection_id)) : null;
  return Object.freeze({
    id: row.connection_id, label: row.label, kind: row.kind === "cli" ? "cli" as const : "api" as const, baseUrl: row.base_url,
    cliTool: row.cli_tool, deviceId: row.device_id, enabled: row.connection_enabled === true, models, contextTokens,
    ...(cliModels ? { cliModels } : {}), cliVersion: hydrated?.cliVersion ?? catalog?.cliVersion ?? optionCliVersion, cliCatalog: catalog,
    capacitySlots: safeInteger(row.capacity_slots) ?? 0, apiKey, keyUnreadable: !!row.api_key_ciphertext && apiKey === null,
    ...(version !== null ? { version } : {}),
  });
}

function cacheObservedFresh(cached: HydratedCliCatalog): boolean {
  return Number.isFinite(cached.observedAt) && Date.now() < cached.observedAt + 60_000;
}
function hydrationFresh(cached: HydratedCliCatalog, connection: AiTaskConnectionSnapshot, maxAgeMs: number): boolean {
  return cached.version === (connection.version ?? null) && cacheObservedFresh(cached)
    && Date.now() - cached.hydratedAt < Math.max(0, maxAgeMs);
}
function inventoryConnectionSnapshot(current: State, row: RawConnection): AiTaskConnectionSnapshot {
  const version = safeInteger(row.connection_version);
  const cached = current.hydratedCliCatalogs.get(row.connection_id);
  const usable = cached && cached.version === version && cacheObservedFresh(cached) ? cached : undefined;
  if (cached && !usable) current.hydratedCliCatalogs.delete(row.connection_id);
  return connectionSnapshotFromRaw(row, usable);
}
function withHydratedCatalog(connection: AiTaskConnectionSnapshot, hydrated: HydratedCliCatalog): AiTaskConnectionSnapshot {
  return Object.freeze({ ...connection, models: hydrated.models, cliVersion: hydrated.cliVersion, cliCatalog: hydrated.catalog });
}
function rowWithHydratedCatalog(current: State, row: AiTaskModelSnapshotRow): AiTaskModelSnapshotRow {
  const cached = current.hydratedCliCatalogs.get(row.connection.id);
  if (!cached) return row;
  if (cached.version !== (row.connection.version ?? null) || !cacheObservedFresh(cached)) {
    current.hydratedCliCatalogs.delete(row.connection.id);
    return row;
  }
  return Object.freeze({ ...row, connection: withHydratedCatalog(row.connection, cached) });
}
function applyHydratedConnection(current: State, connectionId: string, hydrated: HydratedCliCatalog): void {
  current.cliConnections = Object.freeze(current.cliConnections.map(connection =>
    connection.id === connectionId ? withHydratedCatalog(connection, hydrated) : connection));
  current.rows = Object.freeze(current.rows.map(row =>
    row.connection.id === connectionId ? Object.freeze({ ...row, connection: withHydratedCatalog(row.connection, hydrated) }) : row));
}
function pinnedCliEngineConnections(rows: readonly AiTaskModelSnapshotRow[]): readonly AiTaskConnectionSnapshot[] {
  const seen = new Set<string>();
  const connections: AiTaskConnectionSnapshot[] = [];
  for (const row of rows) {
    const connection = row.connection;
    if (connection.kind !== "cli" || connection.cliTool !== "opencode" || seen.has(connection.id)) continue;
    seen.add(connection.id);
    connections.push(connection);
  }
  return Object.freeze(connections);
}

const aad = (id: string) => `ai_connections\n${id}`;
const objectOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** DB 행 → 스냅숏 행(키를 연다). 시험·읽기가 같이 쓴다. */
export function aiTaskModelSnapshotRows(rows: readonly RawRow[]): AiTaskModelSnapshotRow[] {
  return rows.map(row => Object.freeze({
    task: row.task, slot: Number(row.slot), rank: Number(row.rank), model: row.model, enabled: row.enabled === true,
    options: Object.freeze({ ...objectOf(row.options) }), connection: connectionSnapshotFromRaw(row),
  }));
}

async function reload(current: State): Promise<void> {
  let failure: unknown = null;
  let rankSucceeded = false;
  try {
    const [{ db }, { sql }, { currentReplayDb }] = await Promise.all([import("@/lib/db"), import("drizzle-orm"), import("@/lib/db/replay-scope")]);
    if (currentReplayDb()) return;
    const run = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> => {
      if (readOnlyScope.getStore()) {
        return Array.from(await db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
          return tx.execute<T>(query);
        }, { accessMode: "read only" })) as unknown as T[];
      }
      return Array.from(await db.execute<T>(query)) as unknown as T[];
    };
    try {
      const rows = await run<RawRow>(sql`SELECT t.task, t.slot, t.rank, t.model, t.enabled, t.options,
          c.id AS connection_id, c.label, c.kind, c.base_url, c.api_key_ciphertext, c.cli_tool, c.device_id, c.enabled AS connection_enabled,
          c.models, c.options AS connection_options, c.version AS connection_version, c.cli_models, c.capacity_slots
        FROM ai_task_models t JOIN ai_connections c ON c.id = t.connection_id
        ORDER BY t.task, t.slot, t.rank`);
      current.rows = Object.freeze(aiTaskModelSnapshotRows(rows).map(row => rowWithHydratedCatalog(current, row)));
      current.loaded = true;
      rankSucceeded = true;
    } catch (error) {
      if (failure === null) failure = error;
    }
    try {
      const rows = await run<RawConnection>(sql`SELECT c.id AS connection_id, c.label, c.kind, c.base_url, c.api_key_ciphertext, c.cli_tool, c.device_id,
          c.enabled AS connection_enabled, c.models, c.options AS connection_options, c.version AS connection_version, c.cli_models, c.capacity_slots
        FROM ai_connections c
        WHERE c.kind = 'cli' AND c.cli_tool = 'opencode'
        ORDER BY c.id`);
      current.cliConnections = Object.freeze(rows.map(row => inventoryConnectionSnapshot(current, row)));
      current.cliLoaded = true;
      current.cliError = null;
    } catch (error) {
      current.cliError = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      if (failure === null) failure = error;
    }
    if (rankSucceeded) scheduleKeyFill(current);
    if (failure !== null) throw failure;
    if (current.error) { current.error = null; logger.info("ai_task_models.reload_recovered", {}); }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    if (current.error !== message) { current.error = message; logger.warn("ai_task_models.reload_failed", { error: message }); }
  } finally {
    current.loadedAt = Date.now();
  }
}

function maybeScheduleReload(current: State, options: Readonly<{ reload?: boolean }> = {}): void {
  if (options.reload !== false && readable(current) && !current.loading && Date.now() - current.loadedAt >= AI_TASK_MODELS_REFRESH_MS)
    current.loading = reload(current).finally(() => { current.loading = null; });
}

/** 키 없는 켜진 API 연결이 순위에 있다(키를 열지 못한 것은 아니다) — 같은 주소의 계약 키로 채울 수 있는지 볼 만하다. */
export function aiTaskKeylessApiConnection(rows: readonly AiTaskModelSnapshotRow[]): boolean {
  return rows.some(row => row.connection.kind === "api" && row.connection.enabled && row.connection.apiKey === null && !row.connection.keyUnreadable);
}
/** 뒤에서(기다리지 않고) 키 채우기를 한 번 부른다. 상자 키가 없거나 키 없는 API 연결이 없으면 아무것도 하지 않는다(DB·모듈을 읽지 않는다). */
function scheduleKeyFill(current: State): void {
  if (readOnlyScope.getStore() || !secretBoxReady() || !aiTaskKeylessApiConnection(current.rows)) return;
  void import("@/lib/operations/ai-connection-key-fill").then(module => module.maybeFillConnectionKeys())
    .then(result => { if (result?.filled.length) current.loadedAt = 0; })
    .catch(() => { /* maybeFillConnectionKeys 는 던지지 않는다 — 모듈 읽기 실패만 여기로 온다 */ });
}

/** 지금 스냅숏의 행(모든 작업). 오래됐으면 뒤에서 한 번 다시 읽는다(이번 값은 그대로 돌려준다). */
export function aiTaskModelRows(options: Readonly<{ reload?: boolean }> = {}): readonly AiTaskModelSnapshotRow[] {
  const current = state();
  maybeScheduleReload(current, options);
  return current.rows;
}

/** 이 프로세스가 읽은 CLI(opencode) 연결 목록. 순위 JOIN 과 무관한 실제 ai_connections 행에서 채운다. */
export function aiTaskCliEngineConnections(options: Readonly<{ reload?: boolean }> = {}): readonly AiTaskConnectionSnapshot[] {
  const current = state();
  if (current.pinned) return pinnedCliEngineConnections(current.rows);
  maybeScheduleReload(current, options);
  return current.cliConnections;
}

/** 스냅숏을 한 번이라도 읽었나·마지막 읽기 오류(화면·미룸 사유). DB 를 읽지 않는 프로세스는 loaded false 다(시험 고정이면 true). */
export function aiTaskModelsReadState(): Readonly<{ loaded: boolean; loadedAt: number; error: string | null; readable: boolean }> {
  const current = state();
  return { loaded: current.loaded, loadedAt: current.loadedAt, error: current.error, readable: readable(current) || current.pinned };
}

/** maxAgeMs 보다 새 스냅숏을 기다린다(잡 틱·웹 요청의 길목). 던지지 않는다. */
export async function ensureAiTaskModels(maxAgeMs = AI_TASK_MODELS_REFRESH_MS): Promise<void> {
  const current = state();
  if (!readable(current)) return;
  if (current.loading) return current.loading;
  // 읽지 못한 동안(표 없음·권한 없음)은 5초에 한 번만 다시 묻는다 — 웹 요청마다 DB 를 두드리지 않게
  if (current.loadedAt > 0 && Date.now() - current.loadedAt < (current.loaded ? maxAgeMs : Math.min(maxAgeMs, 5_000))) return;
  current.loading = reload(current).finally(() => { current.loading = null; });
  return current.loading;
}

/** 시험: 스냅숏을 고정한다(rows = 그 행들로 읽은 것처럼, null = 고정을 풀고 처음 상태로). */
export function setAiTaskModelsForTest(rows: readonly AiTaskModelSnapshotRow[] | null): void {
  const current = state();
  current.pinned = rows !== null;
  current.rows = Object.freeze([...(rows ?? [])]);
  current.cliConnections = Object.freeze([]);
  current.loaded = rows !== null;
  current.loadedAt = rows === null ? 0 : Date.now();
  current.error = null;
  current.cliLoaded = false;
  current.cliError = null;
  if (rows === null) current.hydratedCliCatalogs.clear();
}

type CodedCliCatalogError = Error & { code: string };
function codedCliCatalogError(code: string): CodedCliCatalogError {
  const error = new Error(code) as CodedCliCatalogError;
  error.code = code;
  return error;
}

/** Explicit narrow warm for legacy CLI selection UI/worker. Only this path may read authenticated CLI host metadata. */
export async function ensureAiTaskCliEngineCatalogs(connectionIds?: readonly string[], maxAgeMs = 60_000): Promise<void> {
  const current = state();
  if (current.pinned || !readable(current)) return;
  await ensureAiTaskModels();
  const wanted = connectionIds && connectionIds.length > 0 ? new Set(connectionIds) : null;
  const connections = current.cliConnections.filter(connection =>
    connection.enabled && connection.kind === "cli" && connection.cliTool === "opencode" && connection.apiKey !== null && !connection.keyUnreadable
    && !!connection.baseUrl && (!wanted || wanted.has(connection.id)));
  if (!connections.length) return;
  const [{ readCliHostCatalog }, { cliHostTargetFromConnection }] = await Promise.all([
    import("@/lib/operations/cli-host-client"),
    import("@/lib/operations/cli-host-target"),
  ]);
  let failed = false;
  for (const connection of connections) {
    const cached = current.hydratedCliCatalogs.get(connection.id);
    if (cached && hydrationFresh(cached, connection, maxAgeMs)) continue;
    try {
      const target = cliHostTargetFromConnection(connection);
      const result = await readCliHostCatalog(target);
      const catalog = cliCatalogMetadata(result);
      if (!catalog) throw codedCliCatalogError("cli_catalog_invalid");
      const hydrated: HydratedCliCatalog = Object.freeze({
        version: connection.version ?? null,
        catalog,
        models: Object.freeze(catalogModelEntries(catalog) ?? []),
        cliVersion: catalog.cliVersion,
        observedAt: Date.parse(catalog.observedAt),
        hydratedAt: Date.now(),
      });
      current.hydratedCliCatalogs.set(connection.id, hydrated);
      applyHydratedConnection(current, connection.id, hydrated);
    } catch {
      failed = true;
      current.cliError = "cli_catalog_hydration_failed";
    }
  }
  if (failed) throw codedCliCatalogError("cli_catalog_hydration_failed");
  current.cliError = null;
  current.cliLoaded = true;
}

function normalizedCliBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(cliEngineEndpoint(baseUrl));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|chat|completions)$/i, "");
    if (!url.pathname || url.pathname === "/") url.pathname = "/v1";
    return url.toString();
  } catch {
    return null;
  }
}

function cliDefinitionKey(connection: AiTaskConnectionSnapshot, modelId: string, effort: string, providerKind: string): string {
  const hash = createHash("sha256").update(`${connection.id}\n${modelId}\n${effort}\n${providerKind}`).digest("hex").slice(0, 24);
  return `${connection.deviceId}:cli-${hash}`;
}

function derivedCliDefinitions(): readonly ModelDefinition[] {
  const definitions: ModelDefinition[] = [];
  try {
    // Registry reads also run while modules initialize; only explicit async callers may refresh inventory here.
    for (const connection of aiTaskCliEngineConnections({ reload: false })) {
      if (connection.kind !== "cli" || connection.cliTool !== "opencode" || !connection.enabled || connection.apiKey === null
        || connection.keyUnreadable || !connection.baseUrl || !connection.cliCatalog) continue;
      const baseUrl = normalizedCliBaseUrl(connection.baseUrl);
      if (!baseUrl) continue;
      const byId = new Map(catalogModelsForDefinitions(connection.cliCatalog).map(model => [model.id, model]));
      const capacity = Number(connection.capacitySlots);
      const concurrency = Number.isFinite(capacity) ? Math.min(64, Math.max(1, Math.trunc(capacity))) : 1;
      for (const modelId of connection.cliModels ?? []) {
        const model = byId.get(modelId);
        if (!model) continue;
        const context = positiveInteger(model.maxModelLen);
        if (context === null || context > 1_048_576) continue;
        const deepseek = /deepseek/i.test(model.id);
        const vision = model.vision === true;
        if (!deepseek) continue;
        const localPurposes = ["human-review", "direct-review", "assist-primary", "assist-audit", ...(vision ? ["screen-review"] : [])];
        const efforts = ["default", ...model.variants.filter(variant => variant !== "default" && CLI_EFFORT_RE.test(variant))];
        for (const effort of new Set(efforts)) {
          const cliEngine = { connectionId: connection.id, ...(effort !== "default" ? { reasoningEffort: effort } : {}) };
          definitions.push({
            key: cliDefinitionKey(connection, model.id, effort, "local-direct"),
            equipment: connection.deviceId,
            displayName: `CLI ${connection.label} ${model.label} ${effort}`,
            provider: "local-direct",
            baseUrl,
            model: model.id,
            family: model.id,
            cliEngine,
            timeoutMs: 60_000,
            maxTokens: Math.min(context, 262_144),
            concurrency,
            purposes: localPurposes,
          });
          if (deepseek) {
            definitions.push({
              key: cliDefinitionKey(connection, model.id, effort, "opencode-cli"),
              equipment: connection.deviceId,
              displayName: `CLI ${connection.label} ${model.label} ${effort}`,
              provider: "opencode-cli",
              baseUrl,
              model: model.id,
              family: model.id,
              cliEngine,
              timeoutMs: 60_000,
              maxTokens: Math.min(context, 262_144),
              concurrency,
              purposes: ["product-intro-check", "product-audit"],
            });
          }
        }
      }
    }
    return Object.freeze(definitions);
  } catch {
    return Object.freeze([]);
  }
}

// Install the secret-free CLI inventory reader exactly once for this server module instance.
setCliEngineModelOverlay(() => derivedCliDefinitions());

/** An explicit existing unit/replay fixture, not a database read failure. */
export function aiTaskModelsSnapshotPinned(): boolean { return state().pinned; }
