"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { assignmentTableFlag } from "@/lib/operations/admin-assignment-source";
import {
  applyAdminAssignmentImport, assignmentSavedMessage, modelAssignmentInputFromForm, modelAssignmentIssueMessage, saveAdminModelAssignment,
  turnOffAdminModelAssignment, type AssignmentImportRowResult,
} from "@/lib/operations/admin-model-assignments";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

export type AssignmentActionState = { ok?: true; message?: string; issues?: string[]; assignmentId?: string } | null;
export type AssignmentImportRowState = { index: number; origin: string; assignmentId: string; ok: boolean; skipped: boolean; version: number | null; message: string };
export type AssignmentImportState = { ok?: true; message?: string; issues?: string[]; rows?: AssignmentImportRowState[] } | null;

const DENIED = { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
const PATHS = ["/admin/models/assignments", "/admin/models/devices", "/admin/models/helpers", "/admin/models", "/admin/models/contracts", "/admin/status", "/admin/flow"];
const revalidate = () => { for (const path of PATHS) revalidatePath(path); };
const field = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
const messages = (issues: readonly string[]) => issues.map(modelAssignmentIssueMessage);

/**
 * 배정 하나 저장(만들기·고치기). 쓰기 관문(webWriteAction) → 관리자 확인 → 폼 모양 검사(mode 실전이면 확인 「배정」) → saveAdminModelAssignment
 * (onPrimary 쓰기 TX 하나에서 PR 3b-A saveModelAssignment — 계약 readback·probe, 정책 route 덧붙이기, 장비 순위, 감사 한 줄). 숨은 expectedVersion 이 CAS 다.
 * 거절은 저장 함수의 코드를 운영자 문장으로 그대로 보인다.
 */
export const saveModelAssignmentAction = webWriteAction(async function saveModelAssignmentAction(_previous: AssignmentActionState, form: FormData):
  Promise<AssignmentActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const parsed = modelAssignmentInputFromForm(form);
  if (!parsed.input) return { issues: messages(parsed.issues.length ? parsed.issues : ["model_assignment_invalid:root"]) };
  const saved = await saveAdminModelAssignment(parsed.input, admin.login);
  if (!saved.ok) return { issues: messages(saved.issues) };
  revalidate();
  return { ok: true, assignmentId: saved.result.after.assignmentId, message: assignmentSavedMessage(saved.result, await assignmentTableFlag()) };
});

/** 「끄기」 — 지금 행을 mode off 로 다시 저장(CAS = 화면이 본 판). 확인 글자는 받지 않는다(끄기는 언제나 안전한 쪽) */
export const turnOffModelAssignmentAction = webWriteAction(async function turnOffModelAssignmentAction(_previous: AssignmentActionState, form: FormData):
  Promise<AssignmentActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const assignmentId = field(form, "assignmentId"), raw = field(form, "expectedVersion");
  const version = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!assignmentId || !Number.isSafeInteger(version)) return { issues: messages(["model_assignment_invalid:expectedVersion"]) };
  const saved = await turnOffAdminModelAssignment(assignmentId, version, admin.login);
  if (!saved.ok) return { issues: messages(saved.issues) };
  revalidate();
  return { ok: true, assignmentId, message: `껐습니다(배정 ${assignmentId}, 판 ${saved.result.after.version}). 계약·정책 경로·장비 순위는 그대로 남습니다.` };
});

const rowState = (row: AssignmentImportRowResult): AssignmentImportRowState => ({ index: row.index, origin: row.origin, assignmentId: row.assignmentId, ok: row.ok,
  skipped: row.skipped, version: row.version, message: row.skipped ? "그대로 — 건너뜀" : row.ok ? `저장(판 ${row.version})` : messages(row.issues).join(" ") });

/**
 * 「현재 설정 → 배정 표 가져오기」 적용 — 화면이 보여 준 계획 hash 를 받아, 서버가 계획을 다시 만들어 같을 때만 행마다 같은 저장 함수로 저장한다.
 * 행마다 결과(저장·거절 문장·건너뜀)를 돌려준다. 확인 글자 「배정」이 있어야 한다(실전 행이 들어 있을 수 있다).
 */
export const applyAssignmentImportAction = webWriteAction(async function applyAssignmentImportAction(_previous: AssignmentImportState, form: FormData):
  Promise<AssignmentImportState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  if (field(form, "confirm") !== "배정") return { issues: messages(["assignment_confirm_required"]) };
  const applied = await applyAdminAssignmentImport(field(form, "planHash"), admin.login);
  if (!applied.ok) return { issues: messages(applied.issues) };
  revalidate();
  const saved = applied.results.filter(row => row.ok && !row.skipped).length, refused = applied.results.filter(row => !row.ok).length;
  const skipped = applied.results.filter(row => row.skipped).length;
  const warnings = applied.warnings.length ? ` 경고: ${applied.warnings.join(" · ")}` : "";
  return { ok: true, rows: applied.results.map(rowState),
    message: applied.results.length ? `가져오기를 적용했습니다 — 저장 ${saved} · 거절 ${refused} · 그대로 ${skipped}.${warnings}` : `가져올 행이 없습니다.${warnings}` };
});
