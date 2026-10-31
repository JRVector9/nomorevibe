import { logger } from "@/lib/observability/logger";
import { assignmentTableEnabled } from "./assignment-flag";
import type { AssignmentStage, ModelAssignmentRow } from "./capacity-helpers";
import { modelRequestName, readModelRegistry, setModelAssignmentDefaultsOverlay, type ModelDefinition } from "./model-registry";
import { ASSIGNMENT_PURPOSE_STAGES, assignmentSourceFor, stageTableRows, type AssignmentSource } from "./stage-assignments";

/**
 * 배정 표 live 행의 프로세스 스냅숏(PR 3b-B). 고르기 함수(firstReviewers·2차 투표자·단계 풀·등록부 기본값)는 동기라 DB 를 직접 읽지 못한다 —
 * serving-contract-store 와 같은 규칙으로 마지막 스냅숏을 읽고, 오래됐으면(30초) 뒤에서 한 번 다시 읽는다. 비동기 길목(1차 고르기·2차 올리기)은
 * `ensureStageAssignments()` 로 먼저 기다린다.
 *
 * - 스위치(MODEL_ASSIGNMENT_TABLE)가 꺼졌으면 아무것도 읽지 않고(SELECT 없음) 언제나 null 이다 → 모든 단계가 예전 설정.
 * - 한 번도 읽지 못했으면 null(→ legacy). 읽기에 실패하면 마지막으로 읽은 행을 그대로 쓴다(서로 다른 오류마다 한 번 남긴다).
 * - replay DB 범위에서는 읽지 않는다(replay 는 인증된 고정 설정만 쓴다).
 * - 읽는 행: role 'primary' · mode 'live'(모든 단계). 도우미 행은 감시자 관문이 따로 연다.
 */
export const STAGE_ASSIGNMENT_REFRESH_MS = 30_000;

type State = { rows: readonly ModelAssignmentRow[]; loaded: boolean; loadedAt: number; loading: Promise<void> | null; pinned: boolean;
  error: string | null; replay: (() => unknown) | null; noted: Set<string> };
const holder = globalThis as unknown as { __nmvStageAssignments?: State };
const state = (): State => (holder.__nmvStageAssignments ??= { rows: Object.freeze([]), loaded: false, loadedAt: 0, loading: null, pinned: false,
  error: null, replay: null, noted: new Set() });

const inReplay = (current: State) => current.replay?.() != null;
function readable(current: State): boolean {
  return typeof window === "undefined" && assignmentTableEnabled() && !current.pinned && !!process.env.DATABASE_URL && !inReplay(current);
}

async function reload(current: State): Promise<void> {
  try {
    const [{ readModelAssignments }, { currentReplayDb }] = await Promise.all([import("./capacity-helpers-repository"), import("@/lib/db/replay-scope")]);
    current.replay = currentReplayDb;
    if (currentReplayDb()) return;
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

/** maxAgeMs 보다 새 스냅숏을 기다린다(비동기 길목). 스위치가 꺼졌으면 곧 돌아온다. 던지지 않는다. */
export async function ensureStageAssignments(maxAgeMs = STAGE_ASSIGNMENT_REFRESH_MS): Promise<void> {
  const current = state();
  if (!readable(current)) return;
  if (current.loading) return current.loading;
  if (current.loaded && Date.now() - current.loadedAt < maxAgeMs) return;
  current.loading = reload(current).finally(() => { current.loading = null; });
  return current.loading;
}

/**
 * 비동기 길목의 관문(1차 고르기·2차 올리기·정리·결과 기록): 스위치가 켜졌으면 새 스냅숏을 기다리고, 그래도 한 번도 읽지 못했으면
 * `ModelCapacityDeferredError('assignments_unavailable')` — 어느 모델이 맞는지 모르는 채로 예전 설정으로 고르거나 정리하지 않는다.
 * 스위치가 꺼졌거나 replay 면 곧 돌아온다.
 */
export async function requireStageAssignments(): Promise<void> {
  if (!assignmentTableEnabled()) return;
  await ensureStageAssignments();
  const current = state();
  if (!current.loaded && !inReplay(current)) {
    const { ModelCapacityDeferredError } = await import("./capacity-deferred");
    throw new ModelCapacityDeferredError("assignments_unavailable");
  }
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
