"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { routeQuotaIssueMessage, routeQuotaWarningMessage, saveAdminRouteQuotas } from "@/lib/operations/admin-capacity-allocation";
import { routeQuotasInputFromForm } from "@/lib/operations/capacity-allocation-view";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

/** message = 짧은 결과 한 줄, changes = 바뀐 줄(「카테고리 분류: 없음 → 보장 1 · 상한 2」) — 좁은 열 아래에 줄마다 보인다 */
export type RouteQuotaSaveState = { ok?: true; message?: string; changes?: string[]; warnings?: string[]; issues?: string[] } | null;

/** 몫이 바뀌면 점유·사유 글이 달라지는 화면 — 장비 한도(판이 오른다)·LLM 운영·작업 배정·운영센터 */
const AFFECTED = ["/admin/models/allocation", "/admin/models/devices", "/admin/models", "/admin/models/llm", "/admin/models/tasks", "/admin/status"];

/**
 * 칸 배분 — 장비 한 대의 빈 칸 빌려 쓰기와 작업 영역별 보장·상한을 통째로 저장한다(step 3). 숨은 expectedVersion(장비 행 판)으로 CAS 를 건다 —
 * 그 사이 장비 한도나 다른 탭이 저장했으면 version_mismatch 거절을 그대로 보인다.
 * 쓰기 관문(webWriteAction) → 관리자 확인 → 폼 숫자 모양 검사 → saveAdminRouteQuotas(fence·zod·control·장비 행 CAS·칸 수 검사·줄 교체·감사) 순서다.
 * 저장 즉시 다음 입장 판정부터 쓰인다 — 잡힌 칸은 그대로 끝나고 DRAIN·배포가 없다.
 */
export const saveRouteQuotasAction = webWriteAction(async function saveRouteQuotasAction(_previous: RouteQuotaSaveState, form: FormData): Promise<RouteQuotaSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  try {
    const parsed = routeQuotasInputFromForm(form);
    if (parsed.issues.length || !parsed.input) return { issues: parsed.issues.length ? parsed.issues : ["폼을 읽지 못했습니다. 새로고침해주세요."] };
    const input = parsed.input;
    const result = await saveAdminRouteQuotas(input, admin.login);
    if (!result.ok) return { issues: result.issues.map(issue => routeQuotaIssueMessage(issue, input.quotas)) };
    for (const path of AFFECTED) revalidatePath(path);
    return { ok: true, message: `저장했습니다(장비 ${result.deviceId}, 판 ${result.version}). 다음 입장부터 바로 쓰입니다 — 이미 잡힌 칸은 그대로 끝나고 DRAIN 은 필요 없습니다.${result.changes.length ? "" : " 바뀐 값은 없습니다."}`,
      changes: result.changes, warnings: result.warnings.map(routeQuotaWarningMessage) };
  } catch (error) {
    return { issues: [routeQuotaIssueMessage(error instanceof Error ? error.message : "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요.")] };
  }
});
