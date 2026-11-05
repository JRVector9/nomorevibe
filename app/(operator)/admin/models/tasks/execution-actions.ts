"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { aiTask, aiTaskSlotLabel } from "@/lib/llm/ai-tasks";
import { aiTaskExecutionInputSchema } from "@/lib/llm/ai-task-execution-config";
import { aiTaskIssueMessage } from "@/lib/operations/admin-ai-tasks";
import { saveAiTaskExecutionConfig } from "@/lib/operations/admin-ai-task-execution";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import type { AiTaskActionState } from "./actions";

const ISSUE_TEXT: Readonly<Record<string, string>> = {
  ai_task_execution_invalid_input: "실행 방식과 모델 구성을 확인하세요.",
  ai_task_execution_revision_mismatch: "다른 곳에서 실행 설정이 바뀌었습니다. 새로고침 후 다시 확인하세요.",
  ai_task_pool_empty: "분산할 모델을 하나 이상 선택하세요.",
  ai_task_pool_task_unsupported: "이 작업 구성은 아직 분산 실행을 지원하지 않습니다.",
  ai_task_pool_engine_device_mismatch: "같은 엔진은 같은 장비 한도를 공유해야 합니다. AI 연결의 장비 이름을 맞춰주세요.",
  ai_task_pool_repeated_model_options_mismatch: "같은 CLI 연결·모델을 반복할 때는 추론 강도도 같게 설정하세요. 대기 작업을 같은 설정으로 이어가기 위한 조건입니다.",
  ai_task_pool_engine_identity_unconfirmed: "같은 주소의 모델이 서로 다른 엔진인지 확인할 수 없습니다.",
  ai_task_pool_model_not_offered: "서버 모델 목록이 바뀌었습니다. 목록을 다시 읽고 선택하세요.",
  ai_task_pool_connection_unsupported: "이 작업에서 사용할 수 없는 연결입니다.",
  ai_task_pool_reasoning_unsupported: "선택한 작업·모델이 지원하는 추론 강도를 골라주세요.",
  ai_task_pool_ai2_single_slot_only: "2차 분산은 투표자 1에서만 지원합니다.",
  ai_task_pool_ai2_other_slots_configured: "2차 분산은 투표자 1개 구성에서 지원합니다. 다른 투표자 설정은 자동으로 지우지 않습니다.",
  ai_task_pool_catalog_unavailable: "서버의 현재 모델 목록을 확인하지 못했습니다. 연결 상태를 확인하세요.",
  ai_task_pool_member_identity_mismatch: "저장된 분산 모델 구성이 바뀌었습니다. 새로고침 후 다시 확인하세요.",
  ai_task_pool_cli_connection_ambiguous: "같은 CLI 모델을 여러 연결로 중복 등록할 수 없습니다.",
};
const issueText = (issue: string) => ISSUE_TEXT[issue] ?? aiTaskIssueMessage(issue);
const field = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value : ""; };

/** Execution mode has its own CAS. Saving it never rewrites the stored fallback ranks. */
export const saveTaskExecutionAction = webWriteAction(async function saveTaskExecutionAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: [aiTaskIssueMessage("denied")] };
  const encoded = field(form, "members");
  if (encoded.length > 8_192) return { issues: [ISSUE_TEXT.ai_task_execution_invalid_input] };
  let members: unknown;
  try { members = JSON.parse(encoded); } catch { return { issues: [ISSUE_TEXT.ai_task_execution_invalid_input] }; }
  const revision = field(form, "expectedRevision");
  const parsed = aiTaskExecutionInputSchema.safeParse({ task: field(form, "task"), slot: Number(field(form, "slot")),
    expectedRevision: revision === "" ? null : Number(revision), mode: field(form, "mode"), members });
  if (!parsed.success) return { issues: [ISSUE_TEXT.ai_task_execution_invalid_input] };
  const saved = await saveAiTaskExecutionConfig(parsed.data, admin.login);
  if (!saved.ok) return { issues: saved.issues.map(issueText) };
  for (const path of ["/admin/models/tasks", "/admin/models", "/admin/flow"]) revalidatePath(path);
  const task = aiTask(parsed.data.task)!;
  return { ok: true, warnings: saved.warnings,
    message: `${aiTaskSlotLabel(task, parsed.data.slot)}: ${parsed.data.mode === "workload_pool"
      ? `모델 ${parsed.data.members.length}개의 작업 분산 설정을 저장했습니다.`
      : "기존 실행 방식으로 전환했습니다. 보관된 대체 순위를 사용합니다."} 진행 중인 호출은 유지되고 새 업무부터 반영됩니다.` };
});
