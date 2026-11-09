"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { aiTask, aiTaskSlotLabel } from "@/lib/llm/ai-tasks";
import { aiTaskIssueMessage } from "@/lib/operations/admin-ai-tasks";
import { aiTaskSlotRevision, listAiTaskRows, saveAiTaskRanks } from "@/lib/operations/admin-ai-tasks-repository";
import { cliTaskModelEdit, cliTaskModelEditFromForm } from "@/lib/operations/cli-task-usage";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

export type CliTaskSaveState = { ok?: true; message?: string; issues?: string[]; warnings?: string[] } | null;

// 작업 배정 저장(saveAiTaskRanksAction)과 같은 화면들을 새로 읽는다 — 같은 순위 행을 보인다
const PATHS = ["/admin/models/devices", "/admin/models/tasks", "/admin/models", "/admin/models/llm", "/admin/models/contracts", "/admin/flow"];

/**
 * 장비 한도 화면의 CLI 작업 줄 저장 — 한 순위의 모델·추론 강도만 바꾼다. 새 쓰기 경로가 아니다: 지금 저장된 같은 칸의 순위를 읽어 그 순위만 바꾼 입력으로
 * 작업 배정과 같은 saveAiTaskRanks 를 부른다(검증·준비 확인·CLI 계약·판 compare-and-set·감사 ai-task-models-save 가 같다).
 * 화면이 본 판과 지금 판이 다르면(그사이 누가 바꿈) 저장하지 않는다.
 */
export const saveCliTaskModelAction = webWriteAction(async function saveCliTaskModelAction(_previous: CliTaskSaveState, form: FormData): Promise<CliTaskSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: [aiTaskIssueMessage("denied")] };
  const request = cliTaskModelEditFromForm(form);
  if (!request) return { issues: ["저장할 값의 모양이 맞지 않습니다 — 새로 고친 뒤 다시 저장하세요."] };
  let rows;
  try { rows = await listAiTaskRows(); }
  catch { return { issues: ["작업 순위를 읽지 못했습니다 — 잠시 뒤 다시 저장하세요."] }; }
  const edit = cliTaskModelEdit(rows, request, aiTaskSlotRevision);
  if (!edit.ok) return { issues: [aiTaskIssueMessage(edit.issue)] };
  if (!edit.changed) return { ok: true, message: "바뀐 것이 없습니다." };
  const saved = await saveAiTaskRanks(edit.input, admin.login);
  if (!saved.ok) return { issues: saved.issues.map(aiTaskIssueMessage) };
  for (const path of PATHS) revalidatePath(path);
  const task = aiTask(request.task)!;
  const effort = request.reasoningEffort || "기본";
  return { ok: true, warnings: saved.warnings,
    message: `${aiTaskSlotLabel(task, request.slot)} ${request.rank}순위: ${request.model} · 추론 강도 ${effort}로 저장했습니다. 워커는 30초 주기로 다시 읽어 새 작업부터 씁니다.` };
});
