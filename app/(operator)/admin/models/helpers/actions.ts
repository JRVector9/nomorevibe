"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import {
  clearAdminModelHelperStops, durationLabel, expectedVersionFromForm, HELPER_MODE_LABELS, helperAssignmentInputFromForm, modelHelperIssueMessage, saveAdminModelHelper,
  setAdminModelHelperMode, setAdminSupervisorControl, supervisorTimingFromForm,
} from "@/lib/operations/admin-model-helpers";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

export type HelperActionState = { ok?: true; message?: string; issues?: string[] } | null;

const DENIED: HelperActionState = { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
const PATHS = ["/admin/models/helpers", "/admin/models/devices", "/admin/models", "/admin/status"];
const revalidate = () => { for (const path of PATHS) revalidatePath(path); };
const thrown = (error: unknown): HelperActionState =>
  ({ issues: [modelHelperIssueMessage(error instanceof Error ? error.message : "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요.")] });
const field = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
const versionOf = (form: FormData, issues: string[]): number | null => {
  const version = expectedVersionFromForm(form, issues);
  if (version === null && !issues.length) issues.push("판 번호(version)를 읽지 못했습니다. 새로고침해 주세요.");
  return version;
};

/**
 * 도우미 배정 하나 저장(만들기·임계값·이력·경로·메모). 숨은 expectedVersion 으로 CAS — 그 사이 다른 곳에서 저장했으면 version_mismatch 거절을 그대로 보인다.
 * 새 배정(expectedVersion 빈 값)은 CAS 없이 만들고 모드는 폼 값(기본 꺼짐)이다. 쓰기 관문(webWriteAction) → 관리자 확인 → 폼 숫자 모양 검사 →
 * saveAdminModelHelper(fence·zod·거절 검사·CAS·쓰기·감사 한 줄은 WP-2a-A 저장소) 순서다.
 */
export const saveModelHelper = webWriteAction(async function saveModelHelper(_previous: HelperActionState, form: FormData): Promise<HelperActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const parsed = helperAssignmentInputFromForm(form);
  if (parsed.issues.length || !parsed.input) return { issues: parsed.issues.length ? parsed.issues : ["폼을 읽지 못했습니다. 새로고침해주세요."] };
  try {
    const result = await saveAdminModelHelper(parsed.input, parsed.expectedVersion, admin.login);
    if (!result.ok) return { issues: result.issues.map(modelHelperIssueMessage) };
    revalidate();
    const changed = result.changes.length ? ` 바뀐 값: ${result.changes.join(" · ")}` : " 바뀐 값이 없습니다.";
    const evidence = result.evidenceChanged ? " 모델·경로가 바뀌어 섀도 근거(evidence_key)가 새로 시작합니다." : "";
    const demoted = result.modeBefore === "live" && result.modeAfter !== "live" ? ` 실전은 ${HELPER_MODE_LABELS[result.modeAfter]}(으)로 내려갔습니다.` : "";
    return { ok: true, message: `${result.created ? "만들었습니다" : "저장했습니다"}(배정 ${result.assignmentId}, 판 ${result.version}, 모드 ${HELPER_MODE_LABELS[result.modeAfter]}). 감시자의 다음 순환부터 새 판으로 판정합니다.${evidence}${demoted}${changed}` };
  } catch (error) { return thrown(error); }
});

/** 모드 바꾸기(섀도 시작·섀도로 내리기·끄기) — 누른 단추의 mode 값. 실전 승격은 PR 2c 의 promote 경로만 한다(여기서는 거절). 판이 올라 그 판의 자동 정지가 풀린다 */
export const changeModelHelperMode = webWriteAction(async function changeModelHelperMode(_previous: HelperActionState, form: FormData): Promise<HelperActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const issues: string[] = [];
  const assignmentId = field(form, "assignmentId"), mode = field(form, "mode");
  const version = versionOf(form, issues);
  if (!assignmentId) issues.push("배정 이름을 읽지 못했습니다. 새로고침해 주세요.");
  if (issues.length || version === null) return { issues };
  try {
    const result = await setAdminModelHelperMode(assignmentId, mode, version, admin.login);
    if (!result.ok) return { issues: result.issues.map(modelHelperIssueMessage) };
    revalidate();
    const tail = result.modeAfter === "off" ? " 감시자의 다음 순환부터 이 도우미는 쉽니다 — 돌고 있는 호출은 끝까지 갑니다." : " 감시자의 다음 순환부터 섀도 표본을 모읍니다(섀도 결과는 어떤 판정에도 쓰이지 않습니다).";
    return { ok: true, message: `모드를 ${HELPER_MODE_LABELS[result.modeBefore]} → ${HELPER_MODE_LABELS[result.modeAfter]}(으)로 바꿨습니다(배정 ${result.assignmentId}, 판 ${result.version}).${tail}` };
  } catch (error) { return thrown(error); }
});

/** 「자동 정지 해제」 — 같은 값으로 다시 저장해 판을 올린다(자동 정지 행은 옛 판에 남는다). CAS 다 */
export const clearModelHelperStop = webWriteAction(async function clearModelHelperStop(_previous: HelperActionState, form: FormData): Promise<HelperActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const issues: string[] = [];
  const assignmentId = field(form, "assignmentId");
  const version = versionOf(form, issues);
  if (!assignmentId) issues.push("배정 이름을 읽지 못했습니다. 새로고침해 주세요.");
  if (issues.length || version === null) return { issues };
  try {
    const result = await clearAdminModelHelperStops(assignmentId, version, admin.login);
    if (!result.ok) return { issues: result.issues.map(modelHelperIssueMessage) };
    revalidate();
    return { ok: true, message: `자동 정지를 풀었습니다(배정 ${result.assignmentId}, 판 ${result.version}, 모드 ${HELPER_MODE_LABELS[result.modeAfter]}). 같은 문제가 다시 생기면 감시자가 다시 멈춥니다.` };
  } catch (error) { return thrown(error); }
});

/**
 * 감시자 전체 스위치(kill switch). enabled=true 는 운영자 단계(계정·GRANT·정책의 도우미 경로·배정)를 마쳤다는 확인 칸을 받아야 한다. 끄기는 확인 없이 바로 —
 * 다음 입장 판정부터 모든 도우미가 닫힌다(돌고 있는 호출은 끝까지 간다). 감사 줄(model-supervisor-toggle)은 저장소가 쓴다.
 */
export const switchCapacitySupervisor = webWriteAction(async function switchCapacitySupervisor(_previous: HelperActionState, form: FormData): Promise<HelperActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const raw = field(form, "enabled");
  if (raw !== "true" && raw !== "false") return { issues: [modelHelperIssueMessage("model_supervisor_invalid:enabled")] };
  const enabled = raw === "true";
  if (enabled && field(form, "confirm") !== "yes") return { issues: ["켜기 전에 확인 칸에 표시해 주세요(감시자 계정·GRANT·정책의 도우미 경로·배정을 마쳤는지)."] };
  try {
    const result = await setAdminSupervisorControl({ enabled }, admin.login);
    if (!result.ok) return { issues: result.issues.map(modelHelperIssueMessage) };
    revalidate();
    return { ok: true, message: enabled ? "감시자를 켰습니다 — 감시자가 lease 를 잡고 신호를 쓰면 그때부터 도우미가 열릴 수 있습니다."
      : "감시자를 껐습니다 — 다음 입장 판정부터 모든 도우미가 닫힙니다. 돌고 있는 호출은 끝까지 갑니다." };
  } catch (error) { return thrown(error); }
});

/** 감시자 순환 설정(신호 유효 시간·순환 간격, 초로 받는다). 순환 간격 × 2 ≤ 신호 유효 시간 */
export const saveCapacitySupervisorTiming = webWriteAction(async function saveCapacitySupervisorTiming(_previous: HelperActionState, form: FormData): Promise<HelperActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const parsed = supervisorTimingFromForm(form);
  if (!parsed.patch) return { issues: parsed.issues.map(modelHelperIssueMessage) };
  try {
    const result = await setAdminSupervisorControl(parsed.patch, admin.login);
    if (!result.ok) return { issues: result.issues.map(modelHelperIssueMessage) };
    revalidate();
    return { ok: true, message: `저장했습니다(신호 유효 시간 ${durationLabel(parsed.patch.signalTtlMs)} · 순환 간격 ${durationLabel(parsed.patch.loopMs)}). 감시자의 다음 순환부터 쓰입니다.` };
  } catch (error) { return thrown(error); }
});
