import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@/lib/observability/logger";
import { openSecret, secretBoxReady } from "@/lib/security/secret-box";

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
  models: readonly Readonly<{ id: string; maxModelLen: number | null }>[] | null; contextTokens: number | null;
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

type State = { rows: readonly AiTaskModelSnapshotRow[]; loaded: boolean; loadedAt: number; loading: Promise<void> | null; pinned: boolean; error: string | null };
const holder = globalThis as unknown as { __nmvAiTaskModels?: State };
const state = (): State => (holder.__nmvAiTaskModels ??= { rows: Object.freeze([]), loaded: false, loadedAt: 0, loading: null, pinned: false, error: null });

function readable(current: State): boolean {
  return typeof window === "undefined" && !current.pinned && !!process.env.DATABASE_URL && process.env.MODEL_SERVING_CONTRACTS_DB !== "0";
}

type RawRow = { task: string; slot: number | string; rank: number | string; model: string; enabled: boolean; options: unknown;
  connection_id: string; label: string; kind: string; base_url: string | null; api_key_ciphertext: string | null; cli_tool: string | null;
  device_id: string; connection_enabled: boolean; models: unknown; connection_options: unknown; connection_version?: number | string };

const aad = (id: string) => `ai_connections\n${id}`;
const objectOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** DB 행 → 스냅숏 행(키를 연다). 시험·읽기가 같이 쓴다. */
export function aiTaskModelSnapshotRows(rows: readonly RawRow[]): AiTaskModelSnapshotRow[] {
  return rows.map(row => {
    const apiKey = row.api_key_ciphertext ? openSecret(row.api_key_ciphertext, aad(row.connection_id)) : null;
    const models = Array.isArray(row.models) ? row.models.flatMap(entry => {
      const value = objectOf(entry);
      return typeof value.id === "string" ? [Object.freeze({ id: value.id, maxModelLen: typeof value.maxModelLen === "number" ? value.maxModelLen : null })] : [];
    }) : null;
    const contextTokens = objectOf(row.connection_options).contextTokens;
    const version = row.connection_version !== undefined && row.connection_version !== null && `${row.connection_version}`.trim() !== ""
      && Number.isSafeInteger(Number(row.connection_version)) ? Number(row.connection_version) : null;
    return Object.freeze({ task: row.task, slot: Number(row.slot), rank: Number(row.rank), model: row.model, enabled: row.enabled === true,
      options: Object.freeze({ ...objectOf(row.options) }),
      connection: Object.freeze({ id: row.connection_id, label: row.label, kind: row.kind === "cli" ? "cli" as const : "api" as const, baseUrl: row.base_url,
        cliTool: row.cli_tool, deviceId: row.device_id, enabled: row.connection_enabled === true, models: models && Object.freeze(models),
        contextTokens: typeof contextTokens === "number" ? contextTokens : null, ...(version !== null ? { version } : {}),
        apiKey, keyUnreadable: !!row.api_key_ciphertext && apiKey === null }) });
  });
}

async function reload(current: State): Promise<void> {
  try {
    const [{ db }, { sql }, { currentReplayDb }] = await Promise.all([import("@/lib/db"), import("drizzle-orm"), import("@/lib/db/replay-scope")]);
    if (currentReplayDb()) return;
    const query = sql`SELECT t.task, t.slot, t.rank, t.model, t.enabled, t.options,
        c.id AS connection_id, c.label, c.kind, c.base_url, c.api_key_ciphertext, c.cli_tool, c.device_id, c.enabled AS connection_enabled,
        c.models, c.options AS connection_options, c.version AS connection_version
      FROM ai_task_models t JOIN ai_connections c ON c.id = t.connection_id
      ORDER BY t.task, t.slot, t.rank`;
    const rows = Array.from(readOnlyScope.getStore() ? await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      return tx.execute<RawRow>(query);
    }, { accessMode: "read only" }) : await db.execute<RawRow>(query));
    current.rows = Object.freeze(aiTaskModelSnapshotRows(rows));
    current.loaded = true;
    if (current.error) { current.error = null; logger.info("ai_task_models.reload_recovered", {}); }
    scheduleKeyFill(current);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    if (current.error !== message) { current.error = message; logger.warn("ai_task_models.reload_failed", { error: message }); }
  } finally {
    current.loadedAt = Date.now();
  }
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
  if (options.reload !== false && readable(current) && !current.loading && Date.now() - current.loadedAt >= AI_TASK_MODELS_REFRESH_MS)
    current.loading = reload(current).finally(() => { current.loading = null; });
  return current.rows;
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
  current.loaded = rows !== null;
  current.loadedAt = rows === null ? 0 : Date.now();
  current.error = null;
}

/** An explicit existing unit/replay fixture, not a database read failure. */
export function aiTaskModelsSnapshotPinned(): boolean { return state().pinned; }
