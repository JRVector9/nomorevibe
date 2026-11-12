import { aiSameUnderlyingModel } from "@/lib/operations/admin-ai-tasks";
import { aiTask } from "@/lib/llm/ai-tasks";
import type { FlowRankEditor } from "@/lib/operations/flow-rank-editor";
import type { ModelConsoleRow } from "@/lib/operations/model-console";

export type ModelSort = "usage" | "calls" | "name";

/** Compact table wording from the approved view; underlying ratios and the shared home formatter stay unchanged. */
export function modelUsageText(row: Pick<ModelConsoleRow, "utilization" | "utilizationText">): string {
  return row.utilization === null ? "—" : row.utilization === 0 ? "0%"
    : row.utilization > 0 && row.utilization < 0.01 ? "<1%" : row.utilizationText;
}

/** Assignment failures cannot establish that a model has no tasks or that its tasks are all stopped. */
export function modelStatusForUses(row: ModelConsoleRow, readable: boolean): ModelConsoleRow["status"] {
  return !readable && row.status.text.startsWith("쓰는 단계") ? { tone: "warn", text: "쓰는 작업 미확인" } : row.status;
}

/** Count affected task/slot rows, ignoring retired rows and inactive rank entries. */
export function modelDuplicateAssignments(editor: FlowRankEditor | null): number | null {
  if (!editor) return null;
  const keys = [...new Set(editor.rows.filter(row => row.enabled && aiTask(row.task)).map(row => `${row.task}#${row.slot}`))];
  return keys.filter(key => {
    if (editor.lines.find(line => line.key === key)?.execution?.mode === "workload_pool") return false;
    const ranks = editor.rows.filter(row => `${row.task}#${row.slot}` === key && row.enabled);
    return ranks.some((choice, index) => ranks.slice(0, index).some(before => aiSameUnderlyingModel(before.model, choice.model)));
  }).length;
}

export function modelRowsFor(rows: readonly ModelConsoleRow[], sort: ModelSort, unused: boolean,
  countOf: (row: ModelConsoleRow) => number): ModelConsoleRow[] {
  return rows.filter(row => !unused || countOf(row) === 0).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "ko")
    : ((sort === "calls" ? b.calls : b.utilization) ?? -1) - ((sort === "calls" ? a.calls : a.utilization) ?? -1) || a.name.localeCompare(b.name, "ko"));
}
