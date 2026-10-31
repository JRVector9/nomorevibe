import { logger } from "@/lib/observability/logger";
import { assignmentFlag, assignmentTableEnabled, type AssignmentFlag } from "./assignment-flag";
import type { AssignmentStage, ModelAssignmentRow } from "./capacity-helpers";
import { modelRequestName, readModelRegistry, setModelAssignmentDefaultsOverlay, type ModelDefinition } from "./model-registry";
import { ASSIGNMENT_PURPOSE_STAGES, assignmentSourceFor, stageTableRows, type AssignmentSource } from "./stage-assignments";

/**
 * 배정 표 live 행의 프로세스 스냅숏(PR 3b-B). 고르기 함수(firstReviewers·2차 투표자·단계 풀·등록부 기본값)는 동기라 DB 를 직접 읽지 못한다 —
 * serving-contract-store 와 같은 규칙으로 마지막 스냅숏을 읽고, 오래됐으면(30초) 뒤에서 한 번 다시 읽는다. 비동기 길목(1차 고르기·2차 올리기)은
 * `ensureStageAssignments()` 로 먼저 기다린다.
 *
 * - 스위치(PR 3b-E: runtime_settings 토글 `assignments.tableReads`, env MODEL_ASSIGNMENT_TABLE 은 강제 — lib/llm/assignment-flag.ts)는 같은 30초 주기로
 *   함께 새로 읽는다(`ensureRuntimeSettings`, serving-contract-store 의 reload 를 탄다). 꺼졌으면 배정 표 SELECT 는 없고 언제나 null 이다 → 모든 단계가 예전 설정.
 * - 한 번도 읽지 못했으면 null(→ legacy). 읽기에 실패하면 마지막으로 읽은 행을 그대로 쓴다(서로 다른 오류마다 한 번 남긴다).
 * - replay DB 범위에서는 읽지 않는다(replay 는 인증된 고정 설정만 쓴다).
 * - 읽는 행: role 'primary' · mode 'live'(모든 단계). 도우미 행은 감시자 관문이 따로 연다.
 */
export const STAGE_ASSIGNMENT_REFRESH_MS = 30_000;

type State = { rows: readonly ModelAssignmentRow[]; loaded: boolean; loadedAt: number; loading: Promise<void> | null; pinned: boolean;
  error: string | null; replay: (() => unknown) | null; noted: Set<string>; source: AssignmentFlag["source"] | null };
const holder = globalThis as unknown as { __nmvStageAssignments?: State };
const state = (): State => (holder.__nmvStageAssignments ??= { rows: Object.freeze([]), loaded: false, loadedAt: 0, loading: null, pinned: false,
  error: null, replay: null, noted: new Set(), source: null });

const inReplay = (current: State) => current.replay?.() != null;
/** 이 프로세스가 DB 를 읽을 수 있나(서버·DATABASE_URL·replay 아님·시험 고정 아님). 스위치와 무관하다 — 토글 자체를 여기서 새로 읽는다. */
function readable(current: State): boolean {
  return typeof window === "undefined" && !current.pinned && !!process.env.DATABASE_URL && !inReplay(current);
}

/** 토글(runtime_settings)을 같은 주기로 새로 읽고, 켜졌으면 live 행을 읽는다. 꺼졌으면 SELECT 없이 끝난다(행은 비운다). 던지지 않는다. */
async function reload(current: State, maxAgeMs = STAGE_ASSIGNMENT_REFRESH_MS): Promise<void> {
  try {
    const [{ readModelAssignments }, { currentReplayDb }, { ensureRuntimeSettings }] = await Promise.all([import("./capacity-helpers-repository"),
      import("@/lib/db/replay-scope"), import("@/lib/operations/runtime-settings-store")]);
    current.replay = currentReplayDb;
    if (currentReplayDb()) return;
    await ensureRuntimeSettings(maxAgeMs);
    const flag = assignmentFlag();
    if (current.source !== flag.source) {
      if (current.source !== null) logger.info("stage_assignments.flag_source_changed", { from: current.source, to: flag.source, enabled: flag.enabled });
      current.source = flag.source;
    }
    if (!flag.enabled) { current.rows = Object.freeze([]); current.loaded = false; return; }
    const rows = await readModelAssignments({ mode: "live" });
    current.rows = Object.freeze(rows.map(row => Object.freeze({ ...row })));
    current.loaded = true;
    if (current.error) { current.error = null; logger.info("stage_assignments.reload_recovered", {}); }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    if (current.error !== message) { current.error = message; logger.warn("stage_assignments.reload_failed", { error: message }); }
  } finally {
    current.loadedAt = Date.now();
  }
}

/**
 * 지금 스냅숏의 live 배정 표 행(모든 단계), 또는 null(스위치 꺼짐·아직 못 읽음·replay). 오래됐으면 뒤에서 한 번 다시 읽는다(이번 값은 그대로 돌려준다).
 */
export function liveAssignmentRows(options: Readonly<{ reload?: boolean }> = {}): readonly ModelAssignmentRow[] | null {
  if (!assignmentTableEnabled()) return null;
  const current = state();
  if (inReplay(current)) return null;
  if (options.reload !== false && readable(current) && !current.loading && Date.now() - current.loadedAt >= STAGE_ASSIGNMENT_REFRESH_MS)
    current.loading = reload(current).finally(() => { current.loading = null; });
  return current.loaded ? current.rows : null;
}

/**
 * maxAgeMs 보다 새 스냅숏(토글 + 행)을 기다린다(비동기 길목). DB 를 읽을 수 없는 프로세스(DATABASE_URL 없음·replay·시험 고정)면 곧 돌아온다. 던지지 않는다.
 * 스위치가 꺼져 있어도 토글은 새로 읽는다 — 운영자가 켜면 다음 길목(30초 안)부터 표를 읽는다(재시작 없음).
 */
export async function ensureStageAssignments(maxAgeMs = STAGE_ASSIGNMENT_REFRESH_MS): Promise<void> {
  const current = state();
  if (!readable(current)) return;
  if (current.loading) return current.loading;
  if (current.loadedAt > 0 && (current.loaded || !assignmentTableEnabled()) && Date.now() - current.loadedAt < maxAgeMs) return;
  current.loading = reload(current, maxAgeMs).finally(() => { current.loading = null; });
  return current.loading;
}

/**
 * 비동기 길목의 관문(1차 고르기·2차 올리기·정리·결과 기록): 토글·스냅숏을 새로 받고 —
 * - 토글을 아직 읽지 못했는데(`unread`) 이 프로세스가 DB 에서 설정을 읽는 프로세스면(serving-contract-store 의 DB 읽기 스위치가 켜짐)
 *   `ModelCapacityDeferredError('assignments_unavailable')`: 운영자가 켠 토글을 모른 채 예전 설정으로 고르지 않는다.
 * - 스위치가 켜졌는데 표를 한 번도 읽지 못했으면 같은 미룸 — 어느 모델이 맞는지 모르는 채로 예전 설정으로 고르거나 정리하지 않는다.
 * 스위치가 꺼졌거나(강제·토글) replay·DB 읽기 스위치 꺼짐(MODEL_SERVING_CONTRACTS_DB=0)이면 곧 돌아온다.
 */
export async function requireStageAssignments(): Promise<void> {
  const current = state();
  if (inReplay(current)) return;
  await ensureStageAssignments();
  if (inReplay(current)) return;
  const flag = assignmentFlag();
  if (flag.source === "unread") {
    if (!readable(current)) return;
    const { servingContractsDbEnabled } = await import("./serving-contract-store");
    if (!servingContractsDbEnabled()) return;
    noteAssignmentOnce("assignment_toggle_unread");
    const { ModelCapacityDeferredError } = await import("./capacity-deferred");
    throw new ModelCapacityDeferredError("assignments_unavailable");
  }
  if (!flag.enabled) return;
  if (!current.loaded) {
    const { ModelCapacityDeferredError } = await import("./capacity-deferred");
    throw new ModelCapacityDeferredError("assignments_unavailable");
  }
}

/** 지금 스위치와 출처(관리자 배너·pipeline-control 스냅숏). `assignmentFlag()` 와 같다 — 한 함수를 읽어 어긋나지 않는다. */
export function assignmentReadFlag(): AssignmentFlag {
  return assignmentFlag();
}

/** 한 단계의 출처(admin 화면·pipeline-control 스냅숏이 보인다). 'table' 이면 그 단계 고르기가 배정 표를 쓴다. */
export function assignmentSource(stage: AssignmentStage): AssignmentSource {
  return assignmentSourceFor(stage, assignmentTableEnabled(), liveAssignmentRows());
}

/**
 * 출처가 'table' 인 단계의 쓸 수 있는 행(rank → assignment_id 순), 아니면 null. 스위치가 켜졌는데 쓸 행이 없으면 프로세스마다 한 번
 * `assignment_table_empty:<stage>` 를 남긴다.
 */
export function stageAssignmentRows(stage: AssignmentStage, options: Readonly<{ reload?: boolean }> = {}): readonly ModelAssignmentRow[] | null {
  const rows = liveAssignmentRows(options);
  const source = assignmentSourceFor(stage, assignmentTableEnabled(), rows);
  if (source === "legacy_empty_table") noteAssignmentOnce(`assignment_table_empty:${stage}`);
  return source === "table" && rows ? stageTableRows(stage, rows) : null;
}

/** 프로세스마다 한 번만 남기는 배정 표 경고(같은 코드는 다시 남기지 않는다). */
export function noteAssignmentOnce(code: string, fields: Record<string, unknown> = {}): void {
  const current = state();
  if (current.noted.has(code)) return;
  current.noted.add(code);
  logger.warn("stage_assignments.fallback", { code, ...fields });
}

/** 시험: 스냅숏을 고정한다(rows = 그 행들로 읽은 것처럼, null = 고정을 풀고 처음 상태로). 한 번 남긴 경고도 지운다. */
export function setStageAssignmentsForTest(rows: readonly ModelAssignmentRow[] | null): void {
  const current = state();
  current.pinned = rows !== null;
  current.rows = Object.freeze([...(rows ?? [])]);
  current.loaded = rows !== null;
  current.loadedAt = rows === null ? 0 : Date.now();
  current.error = null;
  current.source = null;
  current.noted.clear();
}

/**
 * 등록부 기본값(PR 3b-B): MODEL_PURPOSE_ENV 용도가 배정 단계에 대응하고 그 단계의 출처가 'table' 이면 첫 행(rank → assignment_id)의 등록부 key.
 * 그 행의 wire 모델이 등록부의 요청 이름(modelRequestName)과 다르면 쓰지 않는다(장부 route 와 다른 이름을 보내지 않는다).
 */
export function assignedPurposeDefault(purpose: string, models: readonly ModelDefinition[]): ModelDefinition | null {
  const stage = ASSIGNMENT_PURPOSE_STAGES[purpose];
  if (!stage) return null;
  // 등록부 읽기는 import 시점에도 일어난다 — 다시 읽기를 시작하지 않는다(DB client 를 프로세스의 DB 진입 확인보다 먼저 만들지 않는다).
  // 스냅숏은 잡 길목(withStoredAdminStagePools 의 ensureStageAssignments)과 고르기 함수가 채운다.
  for (const row of stageAssignmentRows(stage, { reload: false }) ?? []) {
    const model = models.find(entry => entry.key === row.registryKey);
    if (model && modelRequestName(model) === row.model) return model;
    noteAssignmentOnce(`assignment_row_unusable:${row.assignmentId}`, { stage, reason: model ? "wire_model_mismatch" : "registry_key_unknown" });
  }
  return null;
}

// 등록부의 기본 순서에 끼운다(스위치가 꺼졌으면 언제나 null — 오늘 순서 그대로). 등록부 읽기는 동기이고 자주 불린다: 마지막 스냅숏만 본다.
setModelAssignmentDefaultsOverlay((purpose, env) => {
  if (!assignmentTableEnabled() || !ASSIGNMENT_PURPOSE_STAGES[purpose]) return null;
  try { return assignedPurposeDefault(purpose, readModelRegistry(env).models)?.key ?? null; } catch { return null; }
});
