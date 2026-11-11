import { and, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { llmAssistControls, operationsAudit } from "@/lib/db/schema";
import { assistWorkTaskSchema, type AssistControlMode, type AssistWorkTask } from "@/lib/domain/llm-assist/work";
import { AI_ASSIST_TASK_IDS, aiTask, type AiAssistTaskId } from "@/lib/llm/ai-tasks";
import { logger } from "@/lib/observability/logger";
import { LLM_ASSIST_CONTROL_AUDIT_ACTION } from "./admin-ai-tasks";
import { adminAuditRow } from "./admin-log";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";
import { readAssistQueueStatus } from "./llm-assist";
import { ASSIST_TASK_LABELS } from "./llm-display";

/**
 * LLM 보강 제어(llm_assist_controls) 관리(2026-11-11 운영자 결정 「LLM 보강 … 관리자에서 관리할 수 있도록 하자」). 지금까지 이 표는 운영 SQL 로만 바꿨다.
 *
 * 보강 일(uptime·repo_move·intro_recheck·news·decision_audit·semantic_exception)마다:
 * - 단계(mode): off(쌓지도 묻지도 않음) · shadow(묻고 기록만, 반영 안 함) · confirm(확인을 거쳐 반영할 수 있음).
 * - 보내기(dispatch_enabled): 켜져 있고 단계가 shadow·confirm 일 때만 잡이 일을 가져가 모델을 부른다(claimAssistWork).
 * - 반영(apply_enabled): confirm + 보내기일 때만(DB CHECK llm_assist_control_apply).
 * - 확인 필수(confirmation_required): confirm 이면 반드시 켜진다(CHECK llm_assist_control_confirm). 한 번 켜지면 끌 수 없다(트리거
 *   llm_assist_preserve_confirmation — 이 화면도 끄지 않는다). 연결 확인(uptime)은 확인 필수이면 옛 자동 내림이 보강 확인을 기다린다.
 * 저장은 판(revision) compare-and-set — 판이 오르면 그 일의 진행 중 claim 은 모델 호출 전에 막힌다(proveAssistModelDomain 의 controlRevision 대조).
 * 모든 저장은 operations_audit 에 한 줄(llm-assist-control — 운영 SQL 로 바꿀 때 남기던 것과 같은 이름)을 남긴다. 이 모듈은 아무 것도 저절로 켜지 않는다.
 */

export const ASSIST_CONTROL_MODES: readonly AssistControlMode[] = Object.freeze(["off", "shadow", "confirm"]);
export const ASSIST_CONTROL_MODE_LABELS: Readonly<Record<AssistControlMode, string>> = Object.freeze({
  off: "끔", shadow: "그림자(묻고 기록만)", confirm: "확인 후 반영" });

export type AssistControlRow = Readonly<{ task: AssistWorkTask; mode: AssistControlMode; confirmationRequired: boolean; dispatchEnabled: boolean;
  applyEnabled: boolean; revision: number; updatedAt: string | null }>;
export type AssistControlView = AssistControlRow & Readonly<{
  label: string;
  /** 이 일을 부르는 「작업 ↔ 모델」 작업(LLM 보강·LLM 보강 독립 감사) */
  aiTask: AiAssistTaskId; aiTaskLabel: string;
  /** 끝나지 않은 일 수(상태별, done·obsolete 제외). 못 읽었으면 null */
  queue: Readonly<Record<string, number>> | null;
}>;
export type AssistControlsRead = Readonly<{ controls: readonly AssistControlView[]; error: string | null }>;

/** 보강 일 → 그 일을 부르는 AI 작업(작업 목록의 assistWork) */
export function assistWorkAiTask(task: string): AiAssistTaskId | null {
  return AI_ASSIST_TASK_IDS.find(id => aiTask(id)?.assistWork.includes(task)) ?? null;
}

/** 보강 일들이 모두 꺼져 있나(mode off 이거나 보내기 꺼짐) — AI 작업마다. 그 작업의 일 행을 하나라도 못 찾으면 null(모름) */
export function assistTasksOff(controls: readonly Pick<AssistControlRow, "task" | "mode" | "dispatchEnabled">[] | null): Record<string, boolean | null> {
  return Object.fromEntries(AI_ASSIST_TASK_IDS.map(id => {
    const work = aiTask(id)?.assistWork ?? [];
    const rows = controls ? work.map(task => controls.find(row => row.task === task)) : [];
    if (!controls || rows.some(row => !row)) return [id, null];
    return [id, rows.every(row => row!.mode === "off" || !row!.dispatchEnabled)];
  }));
}

export async function readAssistControlRows(): Promise<AssistControlRow[]> {
  const rows = await db.select().from(llmAssistControls);
  return rows.map(row => Object.freeze({ task: row.task, mode: row.mode, confirmationRequired: row.confirmationRequired, dispatchEnabled: row.dispatchEnabled,
    applyEnabled: row.applyEnabled, revision: Number(row.revision), updatedAt: row.updatedAt ?? null }))
    .sort((a, b) => assistWorkTaskSchema.options.indexOf(a.task) - assistWorkTaskSchema.options.indexOf(b.task));
}

/** 화면 한 번 — 제어 행과 끝나지 않은 일 수. 대기 수를 못 읽어도 제어는 보인다. */
export async function readAssistControls(): Promise<AssistControlsRead> {
  try {
    const [rows, queue] = await Promise.all([readAssistControlRows(), readAssistQueueStatus().catch(() => null)]);
    return Object.freeze({ error: null, controls: Object.freeze(rows.map(row => {
      const aiTaskId = assistWorkAiTask(row.task) ?? "assist-review";
      const counts: Record<string, number> = {};
      for (const entry of queue ?? []) if (entry.task === row.task) counts[entry.state] = (counts[entry.state] ?? 0) + Number(entry.count);
      return Object.freeze({ ...row, label: ASSIST_TASK_LABELS[row.task] ?? row.task, aiTask: aiTaskId, aiTaskLabel: aiTask(aiTaskId)?.label ?? aiTaskId,
        queue: queue ? Object.freeze(counts) : null });
    })) });
  } catch (error) {
    return Object.freeze({ controls: Object.freeze([]), error: error instanceof Error ? error.message.slice(0, 160) : "read_failed" });
  }
}

export type AssistControlInput = Readonly<{ task: AssistWorkTask; expectedRevision: number; mode: AssistControlMode; dispatchEnabled: boolean; applyEnabled: boolean }>;
/** 폼 → 입력. 틀리면 issues */
export function assistControlInputFromForm(form: FormData): { input: AssistControlInput | null; issues: string[] } {
  const text = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
  const task = assistWorkTaskSchema.safeParse(text("task"));
  const mode = text("mode");
  const revision = /^\d{1,15}$/.test(text("revision")) ? Number(text("revision")) : NaN;
  const issues = [...task.success ? [] : ["assist_control_invalid:task"], ...(ASSIST_CONTROL_MODES as readonly string[]).includes(mode) ? [] : ["assist_control_invalid:mode"],
    ...Number.isSafeInteger(revision) && revision >= 1 ? [] : ["assist_control_invalid:revision"]];
  if (issues.length || !task.success) return { input: null, issues };
  return { input: Object.freeze({ task: task.data, expectedRevision: revision, mode: mode as AssistControlMode,
    dispatchEnabled: text("dispatch") === "on", applyEnabled: text("apply") === "on" }), issues: [] };
}

/**
 * 바꾼 뒤의 행(순수) — DB 규칙과 같다. 막히면 issues.
 * - 보내기는 그림자·확인 단계에서만(off 에서 보내기는 아무 것도 하지 않으니 받지 않는다).
 * - 반영은 확인 단계 + 보내기에서만.
 * - 확인 필수는 confirm 이면 켜지고, 한 번 켜진 것은 그대로다.
 */
export function nextAssistControl(before: AssistControlRow, input: AssistControlInput): { row: AssistControlRow; issues: string[] } {
  const issues: string[] = [];
  if (input.dispatchEnabled && input.mode === "off") issues.push("assist_control_dispatch_needs_mode");
  if (input.applyEnabled && !(input.mode === "confirm" && input.dispatchEnabled)) issues.push("assist_control_apply_needs_confirm");
  const row = Object.freeze({ ...before, mode: input.mode, dispatchEnabled: input.dispatchEnabled, applyEnabled: input.applyEnabled,
    confirmationRequired: before.confirmationRequired || input.mode === "confirm" });
  return { row, issues };
}

export const ASSIST_CONTROL_ISSUE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "assist_control_invalid:task": "보강 일을 확인하세요.",
  "assist_control_invalid:mode": "단계를 고르세요(끔·그림자·확인 후 반영).",
  "assist_control_invalid:revision": "화면의 판이 올바르지 않습니다. 새로고침한 뒤 다시 저장하세요.",
  assist_control_dispatch_needs_mode: "보내기는 그림자·확인 후 반영 단계에서만 켤 수 있습니다.",
  assist_control_apply_needs_confirm: "반영은 「확인 후 반영」 단계에서 보내기가 켜져 있을 때만 켤 수 있습니다.",
  assist_control_revision_mismatch: "다른 곳에서 이 보강 제어가 바뀌었습니다. 새로고침한 뒤 다시 저장하세요.",
  assist_control_missing: "이 보강 일의 제어 행이 없습니다(마이그레이션 확인).",
  assist_control_unchanged: "바뀐 것이 없습니다.",
  site_fenced: "이 사이트는 지금 쓰기가 막혀 있습니다(DR 펜스).",
  invalid_actor: "관리자 확인이 필요합니다.",
});
export const assistControlIssueText = (issue: string) => ASSIST_CONTROL_ISSUE_TEXT[issue] ?? `저장하지 못했습니다(${issue}).`;

export type SaveAssistControlResult = { ok: true; row: AssistControlRow } | { ok: false; issues: string[] };
const fail = (code: string): never => { throw new Error(code); };

/** 한 보강 일의 제어 저장 — DR 펜스 → 행 FOR UPDATE(판 compare-and-set) → 바꾼 행(판 + 1) → 감사 한 줄. */
export async function saveAssistControl(input: AssistControlInput, actor: string): Promise<SaveAssistControlResult> {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 120) return { ok: false, issues: ["invalid_actor"] };
  try {
    const saved = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      const [current] = await tx.select().from(llmAssistControls).where(eq(llmAssistControls.task, input.task)).for("update");
      if (!current) fail("assist_control_missing");
      const before: AssistControlRow = { task: current!.task, mode: current!.mode, confirmationRequired: current!.confirmationRequired,
        dispatchEnabled: current!.dispatchEnabled, applyEnabled: current!.applyEnabled, revision: Number(current!.revision), updatedAt: current!.updatedAt ?? null };
      if (before.revision !== input.expectedRevision) fail("assist_control_revision_mismatch");
      const next = nextAssistControl(before, input);
      if (next.issues.length) fail(next.issues[0]);
      if (next.row.mode === before.mode && next.row.dispatchEnabled === before.dispatchEnabled && next.row.applyEnabled === before.applyEnabled
        && next.row.confirmationRequired === before.confirmationRequired) fail("assist_control_unchanged");
      const [row] = await tx.update(llmAssistControls).set({ mode: next.row.mode, dispatchEnabled: next.row.dispatchEnabled, applyEnabled: next.row.applyEnabled,
        confirmationRequired: next.row.confirmationRequired, revision: before.revision + 1, updatedAt: sql`now()` })
        .where(and(eq(llmAssistControls.task, input.task), eq(llmAssistControls.revision, before.revision))).returning();
      if (!row) fail("assist_control_revision_mismatch");
      const after: AssistControlRow = { task: row.task, mode: row.mode, confirmationRequired: row.confirmationRequired, dispatchEnabled: row.dispatchEnabled,
        applyEnabled: row.applyEnabled, revision: Number(row.revision), updatedAt: row.updatedAt ?? null };
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: LLM_ASSIST_CONTROL_AUDIT_ACTION, target: input.task,
        detail: { task: input.task, aiTask: assistWorkAiTask(input.task), before: { ...before }, after: { ...after } } }));
      return after;
    }));
    logger.info("llm_assist.control_saved", { actor, task: input.task, mode: saved.mode, dispatchEnabled: saved.dispatchEnabled, applyEnabled: saved.applyEnabled,
      revision: saved.revision });
    return { ok: true, row: saved };
  } catch (error) {
    const code = error instanceof DrWriterFencedError ? "site_fenced" : error instanceof Error && /^[a-z0-9_:.-]{1,80}$/.test(error.message) ? error.message : "save_failed";
    return { ok: false, issues: [code] };
  }
}
