import { logger } from "@/lib/observability/logger";
import { openSecret } from "@/lib/security/secret-box";

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
 */
export const AI_TASK_MODELS_REFRESH_MS = 30_000;

export type AiTaskConnectionSnapshot = Readonly<{
  id: string; label: string; kind: "api" | "cli"; baseUrl: string | null; cliTool: string | null; deviceId: string; enabled: boolean;
  models: readonly Readonly<{ id: string; maxModelLen: number | null }>[] | null; contextTokens: number | null;
  /** 연 키(메모리 안에서만). 키가 없거나 열리지 않으면 null */
  apiKey: string | null;
  /** 암호문이 있는데 열리지 않았다 */
  keyUnreadable: boolean;
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
  device_id: string; connection_enabled: boolean; models: unknown; connection_options: unknown };

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
    return Object.freeze({ task: row.task, slot: Number(row.slot), rank: Number(row.rank), model: row.model, enabled: row.enabled === true,
      options: Object.freeze({ ...objectOf(row.options) }),
      connection: Object.freeze({ id: row.connection_id, label: row.label, kind: row.kind === "cli" ? "cli" as const : "api" as const, baseUrl: row.base_url,
        cliTool: row.cli_tool, deviceId: row.device_id, enabled: row.connection_enabled === true, models: models && Object.freeze(models),
        contextTokens: typeof contextTokens === "number" ? contextTokens : null, apiKey, keyUnreadable: !!row.api_key_ciphertext && apiKey === null }) });
  });
}

async function reload(current: State): Promise<void> {
  try {
    const [{ db }, { sql }, { currentReplayDb }] = await Promise.all([import("@/lib/db"), import("drizzle-orm"), import("@/lib/db/replay-scope")]);
    if (currentReplayDb()) return;
    const rows = Array.from(await db.execute<RawRow>(sql`SELECT t.task, t.slot, t.rank, t.model, t.enabled, t.options,
        c.id AS connection_id, c.label, c.kind, c.base_url, c.api_key_ciphertext, c.cli_tool, c.device_id, c.enabled AS connection_enabled,
        c.models, c.options AS connection_options
      FROM ai_task_models t JOIN ai_connections c ON c.id = t.connection_id
      ORDER BY t.task, t.slot, t.rank`));
    current.rows = Object.freeze(aiTaskModelSnapshotRows(rows));
    current.loaded = true;
    if (current.error) { current.error = null; logger.info("ai_task_models.reload_recovered", {}); }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    if (current.error !== message) { current.error = message; logger.warn("ai_task_models.reload_failed", { error: message }); }
  } finally {
    current.loadedAt = Date.now();
  }
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
