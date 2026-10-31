"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { capacityDeviceInputFromForm, capacityDeviceIssueMessage, saveAdminCapacityDevice } from "@/lib/operations/admin-capacity-devices";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

export type DeviceSaveState = { ok?: true; message?: string; issues?: string[] } | null;

/**
 * 장비 한 대 저장(칸 수·낮은 순위 상한·유휴 시간·비워 둘 칸·엔진 실제 동시 처리 수·역할 순서·메모). 숨은 expectedVersion 으로 CAS 를 건다 —
 * 그 사이 다른 곳에서 저장했으면 version_mismatch 거절을 그대로 보인다. 새 장비(expectedVersion 빈 값)는 CAS 없이 만든다.
 * 쓰기 관문(webWriteAction) → 관리자 확인 → 폼 숫자 모양 검사 → saveAdminCapacityDevice(fence·WP-A zod·CAS·행+역할 교체·감사) 순서다.
 * 저장 즉시 다음 입장 판정부터 쓰인다(입장 판정이 TX 안에서 표를 읽는다) — DRAIN·배포 불필요.
 */
export const saveCapacityDevice = webWriteAction(async function saveCapacityDevice(_previous: DeviceSaveState, form: FormData): Promise<DeviceSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const parsed = capacityDeviceInputFromForm(form);
  if (parsed.issues.length || !parsed.input) return { issues: parsed.issues.length ? parsed.issues : ["폼을 읽지 못했습니다. 새로고침해주세요."] };
  try {
    const result = await saveAdminCapacityDevice(parsed.input, parsed.expectedVersion, admin.login);
    if (!result.ok) return { issues: result.issues.map(capacityDeviceIssueMessage) };
    for (const path of ["/admin/models/devices", "/admin/models/limits", "/admin/models", "/admin/status"]) revalidatePath(path);
    const changed = result.changes.length ? ` 바뀐 값: ${result.changes.join(" · ")}` : " 바뀐 값이 없습니다.";
    return { ok: true, message: `${result.created ? "만들었습니다" : "저장했습니다"}(장비 ${result.deviceId}, 판 ${result.version}). 다음 입장 판정부터 바로 쓰입니다 — DRAIN 불필요.${changed}` };
  } catch (error) {
    return { issues: [capacityDeviceIssueMessage(error instanceof Error ? error.message : "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요.")] };
  }
});
