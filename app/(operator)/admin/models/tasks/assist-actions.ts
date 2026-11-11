"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { ASSIST_TASK_LABELS } from "@/lib/operations/llm-display";
import { ASSIST_CONTROL_MODE_LABELS, assistControlInputFromForm, assistControlIssueText, saveAssistControl } from "@/lib/operations/llm-assist-controls";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import type { AiTaskActionState } from "./actions";

const PATHS = ["/admin/models/tasks", "/admin/models", "/admin/models/llm", "/admin/status"];

/**
 * 「LLM 보강 제어」 한 줄 저장(2026-11-11) — 쓰기 관문(webWriteAction) → 관리자 확인 → 폼 읽기 → saveAssistControl(판 compare-and-set, DB 규칙, 감사 한 줄).
 * 보강 일 하나의 단계(끔·그림자·확인 후 반영)·보내기·반영만 바꾼다. 모델은 「작업 ↔ 모델」 순위가 고른다(이 저장은 순위를 바꾸지 않는다).
 */
export const saveAssistControlAction = webWriteAction(async function saveAssistControlAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["관리자 확인이 필요합니다. 다시 로그인하세요."] };
  const parsed = assistControlInputFromForm(form);
  if (!parsed.input) return { issues: parsed.issues.map(assistControlIssueText) };
  const saved = await saveAssistControl(parsed.input, admin.login);
  if (!saved.ok) return { issues: saved.issues.map(assistControlIssueText) };
  for (const path of PATHS) revalidatePath(path);
  const row = saved.row;
  return { ok: true, message: `${ASSIST_TASK_LABELS[row.task]}: ${ASSIST_CONTROL_MODE_LABELS[row.mode]} · 보내기 ${row.dispatchEnabled ? "켜짐" : "꺼짐"} · 반영 ${row.applyEnabled
    ? "켜짐" : "꺼짐"}${row.confirmationRequired ? " · 확인 필수" : ""}(판 ${row.revision}). 진행 중이던 이 일의 호출은 판이 바뀌어 모델을 부르기 전에 멈춥니다.` };
});
