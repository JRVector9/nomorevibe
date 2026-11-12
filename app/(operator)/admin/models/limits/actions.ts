"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { isRuntimeSettingGroup, LIMITS_PAGE_GROUPS, runtimeSettingsIssueMessage, runtimeSettingsPatchFromForm } from "@/lib/operations/admin-runtime-settings";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { saveRuntimeSettings } from "@/lib/operations/runtime-settings";
import { shortRuntimeSettingsVersion } from "@/lib/operations/runtime-settings-schema";

export type LimitsSaveState = { ok?: true; message?: string; issues?: string[] } | null;

/** 실시간 한도를 그리는 화면들 — 저장 뒤 다시 그린다(옮긴 칸은 장비 한도·작업 배정·공개 번역 화면이 같은 행을, 운영 홈의 단계 패널이 그 단계 줄을 그린다) */
const AFFECTED_PATHS = ["/admin/models/limits", "/admin/models", "/admin/models/assignments", "/admin/models/devices", "/admin/models/tasks", "/admin/translations",
  "/admin/status", "/admin/flow"];

function expectedRevisionOf(form: FormData): number | null {
  const revisionText = String(form.get("expectedRevision") ?? "").trim();
  const expectedRevision = /^\d{1,15}$/.test(revisionText) ? Number(revisionText) : NaN;
  return Number.isSafeInteger(expectedRevision) && expectedRevision >= 1 ? expectedRevision : null;
}

/**
 * 실시간 한도 한 그룹 저장(장비 한도 화면의 결과 미확정 점유, 공개 번역 화면의 번역 한도, 작업 배정 화면의 동시 업무, 모델 배정 표 화면의 배정 표 읽기).
 * 폼은 바뀐 칸만 sparse patch 로 보내고(null = 기본값으로), 숨은 expectedRevision 으로 CAS 를 건다 — 그 사이 다른 곳에서 저장했으면 stale_form 거절을 그대로 보인다.
 * 쓰기 관문(webWriteAction) → 관리자 확인 → saveRuntimeSettings(WP-A: fence·CAS·zod·교차 검사·UPDATE·감사) 순서다.
 */
export const saveRuntimeSettingsGroup = webWriteAction(async function saveRuntimeSettingsGroup(_previous: LimitsSaveState, form: FormData): Promise<LimitsSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const group = form.get("group");
  if (!isRuntimeSettingGroup(group) || group === "devices") return { issues: ["모르는 설정 묶음입니다. 새로고침해주세요."] };
  const expectedRevision = expectedRevisionOf(form);
  if (expectedRevision === null) return { issues: ["판 번호(revision)를 읽지 못했습니다. 새로고침해주세요."] };
  const parsed = runtimeSettingsPatchFromForm(group, form);
  if (parsed.issues.length) return { issues: parsed.issues };
  if (!parsed.changed.length) return { issues: ["바뀐 값이 없습니다."] };
  try {
    const result = await saveRuntimeSettings(parsed.patch, admin.login, { expectedRevision, group });
    if (!result.ok) return { issues: result.issues.map(runtimeSettingsIssueMessage) };
    for (const path of AFFECTED_PATHS) revalidatePath(path);
    // 모델 장부 점유(capacity)는 입장 TX 가 행을 바로 읽는다 — 30초 스냅숏을 기다리지 않는다
    const when = group === "capacity" ? "다음 모델 입장부터 씁니다" : "각 워커는 30초 안에 다음 틱부터 씁니다";
    return { ok: true, message: `저장했습니다(판 ${shortRuntimeSettingsVersion(result.version)}, revision ${result.revision}). ${when}.` };
  } catch (error) {
    return { issues: [runtimeSettingsIssueMessage(error instanceof Error ? error.message : "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요.")] };
  }
});

/**
 * 「실시간 한도」(2026-11-11 개편) 저장 — 한 화면의 바뀐 칸을 한 번에 저장한다. 작업 한 줄의 호출 상한(routes)과 틱 시간(budgets)을 함께 바꿔야
 * 교차 검사(틱 ≥ 상한 + 2초)가 중간 상태에서 거절하지 않으므로, 그룹 여럿을 saveRuntimeSettings 한 TX(한 revision, 감사는 그룹마다 한 줄)로 보낸다.
 * 칸 이름·patch 규칙은 그룹 하나 저장과 같다(runtimeSettingsPatchFromForm). 이 화면 밖 그룹(LIMITS_PAGE_GROUPS 밖)의 칸은 받지 않는다.
 */
export const saveRuntimeLimits = webWriteAction(async function saveRuntimeLimits(_previous: LimitsSaveState, form: FormData): Promise<LimitsSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const expectedRevision = expectedRevisionOf(form);
  if (expectedRevision === null) return { issues: ["판 번호(revision)를 읽지 못했습니다. 새로고침해주세요."] };
  const parsed = runtimeSettingsPatchFromForm(LIMITS_PAGE_GROUPS, form);
  if (parsed.issues.length) return { issues: parsed.issues };
  if (!parsed.changed.length) return { issues: ["바뀐 값이 없습니다."] };
  const groups = LIMITS_PAGE_GROUPS.filter(group => group in parsed.patch);
  try {
    const result = await saveRuntimeSettings(parsed.patch, admin.login, { expectedRevision, group: groups.length === 1 ? groups[0] : groups });
    if (!result.ok) return { issues: result.issues.map(runtimeSettingsIssueMessage) };
    for (const path of AFFECTED_PATHS) revalidatePath(path);
    return { ok: true, message: `저장했습니다 — 바뀐 값 ${parsed.changed.length}개(판 ${shortRuntimeSettingsVersion(result.version)}, revision ${result.revision}). `
      + "각 워커는 30초 안에 다음 틱부터 씁니다." };
  } catch (error) {
    return { issues: [runtimeSettingsIssueMessage(error instanceof Error ? error.message : "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요.")] };
  }
});
