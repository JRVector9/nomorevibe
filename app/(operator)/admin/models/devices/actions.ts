"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { capacityDeviceInputFromForm, capacityDeviceIssueMessage, saveAdminCapacityDevice } from "@/lib/operations/admin-capacity-devices";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { saveEngineSharedLimit } from "@/lib/operations/admin-engine-limits";
import { modelLimitIssueMessage, modelLimitsInputFromForm, modelLimitWarningMessage, saveAdminModelLimits } from "@/lib/operations/admin-capacity-model-limits";

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
  try {
    const shared = form.get("formMode") === "shared-limit";
    const parsed = shared ? null : capacityDeviceInputFromForm(form);
    if (parsed && (parsed.issues.length || !parsed.input))
      return { issues: parsed.issues.length ? parsed.issues : ["폼을 읽지 못했습니다. 새로고침해주세요."] };
    const version = String(form.get("expectedVersion") ?? "");
    const result = shared ? await saveEngineSharedLimit({ deviceId: form.get("deviceId"), limitSlots: Number(form.get("limitSlots")),
      expectedVersion: version === "" ? null : Number(version), policyHash: form.get("policyHash") }, admin.login)
      : await saveAdminCapacityDevice(parsed!.input, parsed!.expectedVersion, admin.login);
    if (!result.ok) return { issues: result.issues.map(capacityDeviceIssueMessage) };
    for (const path of ["/admin/models/devices", "/admin/models/limits", "/admin/models", "/admin/models/llm", "/admin/status"]) revalidatePath(path);
    const changed = result.changes.length ? ` 바뀐 값: ${result.changes.join(" · ")}` : " 바뀐 값이 없습니다.";
    return { ok: true, message: `${result.created ? "만들었습니다" : "저장했습니다"}(장비 ${result.deviceId}, 판 ${result.version}). ${shared ? "이 엔진을 쓰는 모든 작업이 이 한도를 함께 사용합니다. " : ""}다음 입장 판정부터 바로 쓰입니다 — DRAIN 불필요.${changed}` };
  } catch (error) {
    return { issues: [capacityDeviceIssueMessage(error instanceof Error ? error.message : "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요.")] };
  }
});

/** message = 짧은 결과 한 줄, changes = 바뀐 줄(「gpt-oss-120b: 상한 없음 → 최대 4칸」), warnings = 저장은 했지만 알릴 것 */
export type ModelLimitsSaveState = { ok?: true; message?: string; changes?: string[]; warnings?: string[]; issues?: string[] } | null;

/** 모델 상한이 바뀌면 점유·사유 글이 달라지는 화면 — 장비 한도(판이 오른다)·칸 배분(같은 판)·LLM 운영·작업 배정·운영센터 */
const MODEL_LIMIT_AFFECTED = ["/admin/models/devices", "/admin/models/allocation", "/admin/models", "/admin/models/llm", "/admin/models/tasks", "/admin/status"];

/**
 * 장비 한 대의 모델 상한(0170)을 통째로 저장한다 — 공유 칸(칸 수)과 따로 모델마다 최대 칸. 숨은 expectedVersion(장비 행 판)으로 CAS 를 건다 —
 * 그 사이 장비 한도·칸 배분이 저장했으면 version_mismatch 거절을 그대로 보인다.
 * 쓰기 관문(webWriteAction) → 관리자 확인 → 폼 숫자 모양 검사 → saveAdminModelLimits(fence·zod·control·장비 행 CAS·줄 교체·감사) 순서다.
 * 저장 즉시 다음 입장 판정부터 쓰인다 — 잡힌 칸은 그대로 끝나고 DRAIN·배포가 없다.
 */
export const saveModelLimitsAction = webWriteAction(async function saveModelLimitsAction(_previous: ModelLimitsSaveState, form: FormData): Promise<ModelLimitsSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  try {
    const parsed = modelLimitsInputFromForm(form);
    if (parsed.issues.length || !parsed.input) return { issues: parsed.issues.length ? parsed.issues : ["폼을 읽지 못했습니다. 새로고침해주세요."] };
    const input = parsed.input;
    const result = await saveAdminModelLimits(input, admin.login);
    if (!result.ok) return { issues: result.issues.map(issue => modelLimitIssueMessage(issue, input.limits)) };
    for (const path of MODEL_LIMIT_AFFECTED) revalidatePath(path);
    return { ok: true, message: `저장했습니다(장비 ${result.deviceId}, 판 ${result.version}). 다음 입장부터 바로 쓰입니다 — 이미 잡힌 칸은 그대로 끝나고 DRAIN 은 필요 없습니다.${result.changes.length ? "" : " 바뀐 값은 없습니다."}`,
      changes: result.changes, warnings: result.warnings.map(modelLimitWarningMessage) };
  } catch (error) {
    return { issues: [modelLimitIssueMessage(error instanceof Error ? error.message : "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요.")] };
  }
});
