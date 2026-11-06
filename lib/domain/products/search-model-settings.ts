import { aiConnectionBaseUrl } from "@/lib/operations/admin-ai-tasks";
import {
  aiTaskModelRows, aiTaskModelsReadState, aiTaskModelsSnapshotPinned, ensureAiTaskModels,
  type AiTaskModelSnapshotRow,
} from "@/lib/llm/ai-task-models-snapshot";

/**
 * 검색 모델 설정 해석 — 저장된 「작업 ↔ 모델」 순위가 있으면 그 API 연결을 쓰고, 없으면 기존 환경 변수로 돌아간다.
 * 기본(설정 없음)은 지금처럼 EMBEDDING_URL·RERANK_URL 이고, BGE 동작은 바뀌지 않는다.
 * 저장된 설정이 하나라도 있는데 쓸 수 없으면 환경 변수로 몰래 돌아가지 않는다(실패 폐쇄).
 */
export type SearchModelTask = "product-embedding" | "search-embedding" | "search-rerank";
export type SearchModelSettings = Readonly<{
  source: "environment" | "configured";
  model: string | null;
  baseUrl: string;
  apiKey: string | null;
}>;

export const SEARCH_MODEL_SETTINGS_UNREADABLE = "search_model_settings_unreadable";
export const SEARCH_MODEL_SETTINGS_INVALID = "search_model_settings_invalid";
export const SEARCH_MODEL_TASKS = ["product-embedding", "search-embedding", "search-rerank"] as const;
const EMBEDDING_TASKS: readonly SearchModelTask[] = ["product-embedding", "search-embedding"];
const PROFILE_KEYS = ["version", "connectionVersion", "model", "modelSha256", "dimensions", "preprocessingHash", "parity", "endpoint", "modelName"] as const;
const PARITY_KEYS = ["samples", "minCosine"] as const;

export class SearchModelSettingsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SearchModelSettingsError";
  }
}

function fail(code: string): never { throw new SearchModelSettingsError(code); }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const modelListed = (models: unknown, model: string): boolean =>
  Array.isArray(models) && models.some((entry) => !!entry && typeof entry === "object" && (entry as { id?: unknown }).id === model);
const modelsDbEnabled = (): boolean =>
  typeof window === "undefined" && !!process.env.DATABASE_URL && process.env.MODEL_SERVING_CONTRACTS_DB !== "0";
const snapshotMode = (): boolean => modelsDbEnabled() || aiTaskModelsSnapshotPinned();

/** 저장소 baseUrl 은 `/v1` 까지, 실행 코드는 `/v1` 없이 받아 `/v1/embeddings`·`/v1/rerank` 를 붙인다. */
export function normalizeSearchBaseUrl(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

type ConnectionSettings = Readonly<{ baseUrl: string; model: string; apiKey: string | null; version: number | undefined }>;
function connectionOfRow(row: AiTaskModelSnapshotRow): ConnectionSettings {
  const connection = row.connection;
  if (!connection.enabled || connection.kind !== "api" || connection.keyUnreadable) fail(SEARCH_MODEL_SETTINGS_INVALID);
  if (!modelListed(connection.models, row.model)) fail(SEARCH_MODEL_SETTINGS_INVALID);
  const baseUrl = aiConnectionBaseUrl(connection.baseUrl ?? "");
  if (!baseUrl) fail(SEARCH_MODEL_SETTINGS_INVALID);
  return { baseUrl, model: row.model, apiKey: connection.apiKey, version: (row.connection as { version?: number }).version };
}

async function verifyEmbeddingProfile(raw: unknown, endpoint: string, modelName: string, version: number | undefined): Promise<void> {
  // embedding.ts 가 이 모듈을 읽으므로, 상수는 호출 시점에 동적으로 읽어 초기화 순환을 피한다.
  const {
    EMBEDDING_MODEL, EMBEDDING_MODEL_SHA256, EMBEDDING_DIMENSIONS, EMBEDDING_PREPROCESSING_HASH,
    EMBEDDING_PARITY_MIN_SAMPLES, EMBEDDING_PARITY_MIN_COSINE,
  } = await import("./embedding");
  if (!isRecord(raw) || !hasExactKeys(raw, PROFILE_KEYS)) fail(SEARCH_MODEL_SETTINGS_INVALID);
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || raw.connectionVersion !== version) fail(SEARCH_MODEL_SETTINGS_INVALID);
  if (raw.version !== 1 || raw.model !== EMBEDDING_MODEL || raw.modelSha256 !== EMBEDDING_MODEL_SHA256
    || typeof raw.dimensions !== "number" || raw.dimensions !== EMBEDDING_DIMENSIONS
    || raw.preprocessingHash !== EMBEDDING_PREPROCESSING_HASH
    || raw.endpoint !== endpoint || raw.modelName !== modelName) fail(SEARCH_MODEL_SETTINGS_INVALID);
  const parity = raw.parity;
  if (!isRecord(parity) || !hasExactKeys(parity, PARITY_KEYS)) fail(SEARCH_MODEL_SETTINGS_INVALID);
  if (typeof parity.samples !== "number" || !Number.isInteger(parity.samples) || parity.samples < EMBEDDING_PARITY_MIN_SAMPLES
    || typeof parity.minCosine !== "number" || !Number.isFinite(parity.minCosine) || parity.minCosine < EMBEDDING_PARITY_MIN_COSINE)
    fail(SEARCH_MODEL_SETTINGS_INVALID);
}

async function environment(task: SearchModelTask): Promise<SearchModelSettings> {
  const baseUrl = task === "search-rerank" ? process.env.RERANK_URL : process.env.EMBEDDING_URL;
  let model: string | null = null;
  if (task !== "search-rerank") model = (await import("./embedding")).EMBEDDING_MODEL;
  return { source: "environment", model, baseUrl: normalizeSearchBaseUrl(baseUrl), apiKey: null };
}

async function snapshotRows(): Promise<readonly AiTaskModelSnapshotRow[]> {
  await ensureAiTaskModels(30_000);
  const state = aiTaskModelsReadState();
  const mode = snapshotMode();
  if (mode && (!state.loaded || state.error)) fail(SEARCH_MODEL_SETTINGS_UNREADABLE);
  return mode ? aiTaskModelRows() : [];
}

export async function resolveSearchModelSettingsFromRows(
  task: SearchModelTask,
  rows: readonly AiTaskModelSnapshotRow[],
): Promise<SearchModelSettings> {
  if (task === "search-rerank") {
    const own = rows.filter((row) => row.task === task);
    if (own.length === 0) return environment(task);
    if (own.length !== 1) fail(SEARCH_MODEL_SETTINGS_INVALID);
    const row = own[0]!;
    if (row.rank !== 1 || row.slot !== 1 || !row.enabled) fail(SEARCH_MODEL_SETTINGS_INVALID);
    const connection = connectionOfRow(row);
    return { source: "configured", model: connection.model, baseUrl: normalizeSearchBaseUrl(connection.baseUrl), apiKey: connection.apiKey };
  }

  const product = rows.filter((row) => row.task === EMBEDDING_TASKS[0]);
  const search = rows.filter((row) => row.task === EMBEDDING_TASKS[1]);
  if (product.length === 0 && search.length === 0) return environment(task);
  if (product.length !== 1 || search.length !== 1) fail(SEARCH_MODEL_SETTINGS_INVALID);
  const first = product[0]!;
  const second = search[0]!;
  for (const row of [first, second]) {
    if (row.rank !== 1 || row.slot !== 1 || !row.enabled) fail(SEARCH_MODEL_SETTINGS_INVALID);
  }
  if (first.connection.id !== second.connection.id || first.model !== second.model) fail(SEARCH_MODEL_SETTINGS_INVALID);
  if (JSON.stringify(first.options) !== JSON.stringify(second.options)) fail(SEARCH_MODEL_SETTINGS_INVALID);
  const firstConnection = connectionOfRow(first);
  const secondConnection = connectionOfRow(second);
  if (firstConnection.version !== secondConnection.version) fail(SEARCH_MODEL_SETTINGS_INVALID);
  if (firstConnection.baseUrl !== secondConnection.baseUrl || firstConnection.model !== secondConnection.model) fail(SEARCH_MODEL_SETTINGS_INVALID);
  const firstProfile = first.options.searchEmbeddingProfile;
  const secondProfile = second.options.searchEmbeddingProfile;
  if (firstProfile === undefined || JSON.stringify(firstProfile) !== JSON.stringify(secondProfile)) fail(SEARCH_MODEL_SETTINGS_INVALID);
  await verifyEmbeddingProfile(firstProfile, firstConnection.baseUrl, firstConnection.model, firstConnection.version);
  return { source: "configured", model: firstConnection.model, baseUrl: normalizeSearchBaseUrl(firstConnection.baseUrl), apiKey: firstConnection.apiKey };
}

export async function resolveSearchModelSettings(task: SearchModelTask): Promise<SearchModelSettings> {
  return resolveSearchModelSettingsFromRows(task, await snapshotRows());
}
