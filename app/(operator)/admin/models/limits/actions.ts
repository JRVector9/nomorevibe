"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { isRuntimeSettingGroup, runtimeSettingsIssueMessage, runtimeSettingsPatchFromForm } from "@/lib/operations/admin-runtime-settings";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { saveRuntimeSettings } from "@/lib/operations/runtime-settings";
import { shortRuntimeSettingsVersion } from "@/lib/operations/runtime-settings-schema";

export type LimitsSaveState = { ok?: true; message?: string; issues?: string[] } | null;

/**
 * 실시간 한도 한 그룹 저장(경로 한도·번역·잡별 묶음·틱 예산·배정 읽기·모델 장부 점유). 폼은 바뀐 칸만 sparse patch 로 보내고(null = 기본값으로),
 * 숨은 expectedRevision 으로 CAS 를 건다 — 그 사이 다른 곳에서 저장했으면 stale_form 거절을 그대로 보인다.
 * 쓰기 관문(webWriteAction) → 관리자 확인 → saveRuntimeSettings(WP-A: fence·CAS·zod·교차 검사·UPDATE·감사) 순서다.
 */
export const saveRuntimeSettingsGroup = webWriteAction(async function saveRuntimeSettingsGroup(_previous: LimitsSaveState, form: FormData): Promise<LimitsSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const group = form.get("group");
  if (!isRuntimeSettingGroup(group) || group === "devices") return { issues: ["모르는 설정 묶음입니다. 새로고침해주세요."] };
  const revisionText = String(form.get("expectedRevision") ?? "").trim();
  const expectedRevision = /^\d{1,15}$/.test(revisionText) ? Number(revisionText) : NaN;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return { issues: ["판 번호(revision)를 읽지 못했습니다. 새로고침해주세요."] };
  const parsed = runtimeSettingsPatchFromForm(group, form);
  if (parsed.issues.length) return { issues: parsed.issues };
  if (!parsed.changed.length) return { issues: ["바뀐 값이 없습니다."] };
  try {
    const result = await saveRuntimeSettings(parsed.patch, admin.login, { expectedRevision, group });
    if (!result.ok) return { issues: result.issues.map(runtimeSettingsIssueMessage) };
    // 모델 배정 화면(3b-E)은 같은 행의 assignments 묶음을 그린다 — 저장 뒤 새로고침하면 띠·폼이 새 값이다
    for (const path of ["/admin/models/limits", "/admin/models", "/admin/models/assignments", "/admin/models/devices", "/admin/status"]) revalidatePath(path);
    // 모델 장부 점유(capacity)는 입장 TX 가 행을 바로 읽는다 — 30초 스냅숏을 기다리지 않는다
    const when = group === "capacity" ? "다음 모델 입장부터 씁니다" : "각 워커는 30초 안에 다음 틱부터 씁니다";
    return { ok: true, message: `저장했습니다(판 ${shortRuntimeSettingsVersion(result.version)}, revision ${result.revision}). ${when}.` };
  } catch (error) {
    return { issues: [runtimeSettingsIssueMessage(error instanceof Error ? error.message : "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요.")] };
  }
});
