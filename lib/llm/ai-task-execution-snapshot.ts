import { aiTask } from "./ai-tasks";
import { aiTaskModelSnapshotRows, aiTaskModelsSnapshotPinned } from "./ai-task-models-snapshot";
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { AI_TASK_POOL_MEMBER_SLOTS_MAX, type AiTaskExecutionConfig, type AiTaskPoolMember } from "./ai-task-execution-config";
import { logger } from "@/lib/observability/logger";

const REFRESH_MS = 30_000;
type State = { configs: ReadonlyMap<string, AiTaskExecutionConfig>; loaded: boolean; loadedAt: number;
  error: string | null; loading: Promise<void> | null; pinned: boolean };
const holder = globalThis as unknown as { __nmvAiTaskExecution?: State };
const state = (): State => holder.__nmvAiTaskExecution ??= { configs: new Map(), loaded: false, loadedAt: 0, error: null, loading: null, pinned: false };
const keyOf = (task: string, slot: number) => `${task}#${slot}`;
// Match rank/contract snapshot opt-out. An explicit disabled read is not a successful no-row read.
const readable = () => typeof window === 'undefined' && !!process.env.DATABASE_URL && process.env.MODEL_SERVING_CONTRACTS_DB !== '0';
type Raw = { task: string; slot: number; mode: string; revision: number; updated_at: string;
  member_id: string | null; position: number | null; connection_id: string | null; model: string | null;
  options: unknown; canonical_model: string | null; device_id: string | null; engine_key: string | null;
  label: string | null; kind: string | null; base_url: string | null; api_key_ciphertext: string | null;
  cli_tool: string | null; connection_device_id: string | null; connection_enabled: boolean | null;
  models: unknown; connection_options: unknown; max_slots: number | string | null; reserve_ranks: boolean | string | null };
/** 0179 칸(구성원 칸 수) — 없거나 NULL 이면 정하지 않음. 범위 밖이면 스냅숏을 버린다(지어낸 값으로 돌지 않는다). */
function maxSlotsOf(value: Raw["max_slots"]): number | null {
  if (value === null || value === undefined) return null;
  const slots = Number(value);
  if (!Number.isInteger(slots) || slots < 1 || slots > AI_TASK_POOL_MEMBER_SLOTS_MAX) throw new Error("invalid_task_pool_member_snapshot");
  return slots;
}

async function reload(current: State): Promise<void> {
  try {
    const [{ db, onPrimary }, { sql }, { currentReplayDb }] = await Promise.all([import("@/lib/db"), import("drizzle-orm"), import("@/lib/db/replay-scope")]);
    if (currentReplayDb()) return;
    const rows = await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      return Array.from(await tx.execute<Raw>(sql`SELECT e.task,e.slot,e.mode,e.revision,
        to_char(e.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
        m.member_id,m.position,m.connection_id,m.model,m.options,m.canonical_model,m.device_id,m.engine_key,
        c.label,c.kind,c.base_url,c.api_key_ciphertext,c.cli_tool,c.device_id AS connection_device_id,
        c.enabled AS connection_enabled,c.models,c.options AS connection_options,
        to_jsonb(m)->>'max_slots' AS max_slots,to_jsonb(e)->>'reserve_ranks' AS reserve_ranks
        FROM ai_task_execution_configs e LEFT JOIN ai_task_pool_members m ON m.task=e.task AND m.slot=e.slot
        LEFT JOIN ai_connections c ON c.id=m.connection_id ORDER BY e.task,e.slot,m.position`));
    }, { accessMode: "read only", isolationLevel: "repeatable read" }));
    const grouped = new Map<string, Raw[]>();
    for (const row of rows) { const key = keyOf(row.task, Number(row.slot)); grouped.set(key, [...(grouped.get(key) ?? []), row]); }
    const configs = new Map<string, AiTaskExecutionConfig>();
    for (const [key, group] of grouped) {
      const first = group[0], task = aiTask(first.task), slot = Number(first.slot), revision = Number(first.revision);
      if (!task || slot < 1 || slot > task.slots || !Number.isSafeInteger(revision) || revision < 1
        || !["fallback", "workload_pool"].includes(first.mode)) throw new Error("invalid_task_execution_snapshot");
      const members: AiTaskPoolMember[] = group.filter(row => row.member_id !== null).map(row => {
        if (!row.member_id || !row.connection_id || !row.model || !row.canonical_model || !row.device_id || !row.engine_key
          || !row.label || !row.kind || !row.connection_device_id || !Number.isInteger(Number(row.position)))
          throw new Error("invalid_task_pool_member_snapshot");
        const [bound] = aiTaskModelSnapshotRows([{ task: row.task, slot, rank: 1, model: row.model, enabled: true, options: row.options,
          connection_id: row.connection_id, label: row.label, kind: row.kind, base_url: row.base_url, api_key_ciphertext: row.api_key_ciphertext,
          cli_tool: row.cli_tool, device_id: row.connection_device_id, connection_enabled: row.connection_enabled === true,
          models: row.models, connection_options: row.connection_options }]);
        return Object.freeze({ memberId: row.member_id, position: Number(row.position), connectionId: row.connection_id,
          model: row.model, options: bound.options, canonicalModel: row.canonical_model, deviceId: row.device_id,
          engineKey: row.engine_key, maxSlots: maxSlotsOf(row.max_slots), connection: bound.connection });
      });
      if (first.mode === "workload_pool" && (members.length < 1 || members.length > 4
        || members.some((member, index) => member.position !== index + 1))) throw new Error("invalid_task_pool_membership");
      configs.set(key, Object.freeze({ task: first.task, slot, mode: first.mode as AiTaskExecutionConfig["mode"], revision,
        updatedAt: first.updated_at, members: Object.freeze(members), reserveRanks: first.reserve_ranks === true || first.reserve_ranks === "true" }));
    }
    current.configs = configs; current.loaded = true; current.error = null;
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "task_execution_read_failed";
    if (current.error !== code) logger.warn("ai_task_execution.reload_failed", { code });
    current.error = code; // Keep the last good snapshot. Never invent fallback on a failed read.
  } finally { current.loadedAt = Date.now(); }
}

/** Explicit old rank fixtures pin fallback configuration; this never applies in production. */
function pinnedLegacyFixture(): boolean { return process.env.NODE_ENV === "test" && aiTaskModelsSnapshotPinned() && !state().pinned; }
export async function ensureAiTaskExecutionConfigs(maxAgeMs = REFRESH_MS): Promise<void> {
  const current = state();
  if (current.pinned || pinnedLegacyFixture() || !readable()) return;
  if (current.loading) return current.loading;
  if (current.loadedAt && Date.now() - current.loadedAt < (current.loaded ? maxAgeMs : Math.min(maxAgeMs, 5_000))) return;
  current.loading = reload(current).finally(() => { current.loading = null; });
  return current.loading;
}
/** Call ensure first. No-row in a successfully read snapshot is the only implicit fallback. */
export function readAiTaskExecutionConfig(taskId: string, slot = 1): AiTaskExecutionConfig {
  const task = aiTask(taskId), current = state();
  if (!task || !Number.isInteger(slot) || slot < 1 || slot > task.slots) throw new Error("invalid_task_execution_slot");
  if (!current.loaded && !pinnedLegacyFixture()) throw new ModelCapacityDeferredError("assignments_unavailable");
  if (!current.pinned && !pinnedLegacyFixture() && readable() && !current.loading && Date.now() - current.loadedAt >= REFRESH_MS)
    current.loading = reload(current).finally(() => { current.loading = null; });
  const known = !pinnedLegacyFixture() ? current.configs.get(keyOf(taskId, slot)) : undefined;
  if (!known && current.error && !pinnedLegacyFixture()) throw new ModelCapacityDeferredError("assignments_unavailable");
  return known ?? Object.freeze({ task: taskId, slot, mode: "fallback", revision: null,
    updatedAt: null, members: Object.freeze([]), reserveRanks: false });
}
export function aiTaskExecutionReadState(): Readonly<{ loaded: boolean; loadedAt: number; error: string | null }> {
  const current = state(); return { loaded: current.loaded || pinnedLegacyFixture(), loadedAt: current.loadedAt, error: current.error };
}
export function setAiTaskExecutionConfigsForTest(configs: readonly AiTaskExecutionConfig[] | null): void {
  const current = state(); current.pinned = configs !== null; current.loaded = configs !== null;
  current.configs = new Map((configs ?? []).map(config => [keyOf(config.task, config.slot), config]));
  current.loadedAt = configs === null ? 0 : Date.now(); current.error = null;
}
