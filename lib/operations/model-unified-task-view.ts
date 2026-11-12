import type { AiTaskGroup } from "@/lib/llm/ai-tasks";
import { aiTaskPoolFeatures, aiTaskSupportsPool, aiTaskWorkloadPoolApiOnly } from "@/lib/llm/ai-task-execution-config";
import { aiRankReasoningEfforts, aiSameUnderlyingModel, type AiRankChoice } from "./admin-ai-tasks";
import { aiTaskEditTarget } from "./ai-task-edit-target";
import { FLOW_RANK_LOCKS, type FlowRankEditor, type FlowRankLine, type FlowRankOption } from "./flow-rank-editor";
import type { TaskAssignRow } from "./llm-task-assign-view";
import { attachDraft, attachPoolFull, attachTargets, savedAssignment } from "./model-attach";
import type { AssignmentState } from "./stage-panel-model";
import { stagePanelHref, stagePanelKeyOfTask } from "./stage-panel-catalog";

export type UnifiedTaskFilter = "all" | "attention" | "duplicate";
export type UnifiedTaskGroup = "all" | AiTaskGroup;
export const UNIFIED_TASK_GROUPS: Readonly<Record<AiTaskGroup, string>> = Object.freeze({
  review: "검수", text: "소개·번역", search: "검색·분류", audit: "감사·보강", cli: "CLI 전용",
});

/** The approved overview's eight main task slots; values and status still come from the live read. */
export const UNIFIED_MAIN_TASKS: readonly string[] = Object.freeze([
  "first-review#1", "second-review#1", "crawl-tagline#1", "product-translate#1",
  "product-tagline-ko#1", "search-query-translate#1", "product-search-profile#1", "publish-classify#1",
]);

/** Repeated fallback choices add another attempt, not an independent model or more capacity. */
export function unifiedTaskDuplicate(row: Pick<TaskAssignRow, "mode" | "choices">): boolean {
  return row.mode === "fallback" && row.choices.some((choice, index) => row.choices.slice(0, index).some(previous =>
    (choice.connectionId ?? choice.connection) === (previous.connectionId ?? previous.connection)
    && aiSameUnderlyingModel(choice.model, previous.model)));
}

export const unifiedTaskNeedsAttention = (row: TaskAssignRow) => unifiedTaskDuplicate(row) || row.status.level === "warn" || row.status.level === "bad";

export function unifiedTaskRows(rows: readonly TaskAssignRow[], input: {
  filter: UnifiedTaskFilter; group: UnifiedTaskGroup; search: string; modelScope: string | null; showAll: boolean;
  /** Names in the model picker are the same names the model table uses. */
  nameOf?: (choice: TaskAssignRow["choices"][number]) => string;
}) {
  const search = input.search.trim().toLocaleLowerCase("ko-KR");
  const filtered = rows.filter(row => (input.filter !== "attention" || unifiedTaskNeedsAttention(row))
    && (input.filter !== "duplicate" || unifiedTaskDuplicate(row))
    && (input.group === "all" || row.group === input.group)
    && (!input.modelScope || row.choices.some(choice => choice.connectionId === input.modelScope))
    && (!search || [row.label, row.task, UNIFIED_TASK_GROUPS[row.group], ...row.choices.flatMap(choice =>
      [choice.connection, choice.model, input.nameOf?.(choice) ?? ""])].join(" ").toLocaleLowerCase("ko-KR").includes(search)));
  const hasFilter = input.filter !== "all" || input.group !== "all" || !!search || !!input.modelScope;
  const visible = input.showAll || hasFilter ? filtered : UNIFIED_MAIN_TASKS.flatMap(key => filtered.filter(row => row.key === key));
  return { filtered, visible, hasFilter };
}

/** Non-live ranks never become an editable production configuration. */
export function unifiedTaskEditTarget(line: FlowRankLine) {
  return line.task === "publish-classify" ? null : aiTaskEditTarget(line.task);
}

export function unifiedTaskLock(line: FlowRankLine): string | null {
  if (FLOW_RANK_LOCKS[line.task]) return FLOW_RANK_LOCKS[line.task];
  if (unifiedTaskEditTarget(line)) return "이 작업은 별도 설정을 사용합니다. 실제 적용 설정에서 변경하세요.";
  // The old drawer's pool-only navigation lock is replaced by this editor's mode/member controls.
  return line.execution?.mode === "workload_pool" && line.lock?.startsWith("작업 분산 중입니다.") ? null : line.lock;
}

export function unifiedTaskInitialDraft(editor: FlowRankEditor, line: FlowRankLine, attachConnectionId?: string | null): {
  draft: AssignmentState; issue: string | null;
} {
  const before = savedAssignment(line);
  if (!attachConnectionId) return { draft: before, issue: null };
  const target = attachTargets(editor, attachConnectionId).find(entry => entry.key === line.key);
  const option = line.options.find(entry => entry.provider === attachConnectionId && !entry.off && !entry.saved);
  if (!target || !option) return { draft: before, issue: "이 모델은 이 작업에 붙일 수 없습니다. 연결 상태와 쓸 수 있는 작업을 확인하세요." };
  const choice: AiRankChoice = { provider: option.provider, model: option.model };
  const mode = before.mode === "workload_pool" || !target.rank ? "pool" : "rank";
  if (mode === "pool" && attachPoolFull(before, choice)) return { draft: before, issue: "함께 쓰는 모델은 4개까지입니다. 기존 모델 하나를 바꾼 뒤 붙이세요." };
  return { draft: attachDraft({ before, choice, mode, rank: Math.min(before.ranks.filter(Boolean).length + 1, 3), features: target.features }), issue: null };
}

/** Saved pool choices remain visible even when their connection/catalog is missing or switched off. */
export function unifiedTaskPoolOptions(editor: FlowRankEditor, line: FlowRankLine): FlowRankOption[] {
  const apiOnly = aiTaskWorkloadPoolApiOnly(line.task);
  const choices = line.options.filter(option => !apiOnly || editor.connections.some(connection => connection.id === option.provider
    && (connection.kind === "api" || connection.cliTool === "opencode")));
  for (const member of line.execution?.members ?? []) {
    if (choices.some(option => option.provider === member.connectionId && option.model === member.model)) continue;
    const connection = editor.connections.find(entry => entry.id === member.connectionId);
    choices.push({ provider: member.connectionId, model: member.model, label: `${member.model} (저장된 값)`, saved: true,
      reasoningEfforts: connection ? aiRankReasoningEfforts(line.task, connection, member.model) : [] });
  }
  return choices;
}

/** Empty pool rows start with the current live fallback choices; changing mode never changes saved ranks. */
export function unifiedTaskSwitchMode(draft: AssignmentState, mode: AssignmentState["mode"], line: FlowRankLine): AssignmentState {
  if (mode === "workload_pool" && !aiTaskSupportsPool(line.task, line.slot)) return draft;
  if (mode === "workload_pool" && !draft.members.some(Boolean)) return { ...draft, mode,
    members: draft.ranks.filter((choice): choice is AiRankChoice => !!choice).slice(0, 4),
    reserve: aiTaskPoolFeatures(line.task, line.slot).reserve && !!draft.reserve };
  return { ...draft, mode };
}

export const unifiedTaskHomeHref = (task: string) => {
  const stage = stagePanelKeyOfTask(task);
  return stage ? stagePanelHref(stage, "models") : "/admin/flow";
};

export const unifiedTaskIsExternal = (row: TaskAssignRow) => row.task !== "publish-classify" && !!aiTaskEditTarget(row.task);
