"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { aiTaskIssueMessage } from "@/lib/operations/admin-ai-tasks";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { requestModelSampleComparison } from "@/lib/operations/model-sample-compare-repository";
import { sampleSize } from "@/lib/operations/model-sample-compare";

export type SampleCompareActionState = { ok?: true; message?: string; issues?: string[] } | null;
const field = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };

/**
 * 표본 비교 요청(2026-11-12 운영 콘솔 조각 3a). 쓰기 관문(webWriteAction) → 관리자 확인 → requestModelSampleComparison(검증 · 후보의 그 작업 계약·장부 경로 준비 ·
 * 대기 일감에서 표본 고르기 · 비교 줄 · 감사 model-sample-compare-request). 모델 호출은 여기서 하지 않는다 — 그 작업의 배경 잡이 장부를 거쳐 부른다.
 */
export const requestSampleComparisonAction = webWriteAction(async function requestSampleComparisonAction(_previous: SampleCompareActionState, form: FormData): Promise<SampleCompareActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const size = sampleSize(field(form, "size"));
  if (size === null) return { issues: ["표본 수는 숫자로 적으세요."] };
  const result = await requestModelSampleComparison({ task: field(form, "task"), connectionId: field(form, "candidate"), model: field(form, "model"), size }, admin.login);
  if (!result.ok) return { issues: result.issues.map(aiTaskIssueMessage) };
  revalidatePath("/admin/models/compare");
  return { ok: true, message: `표본 ${result.size}건으로 비교를 시작했습니다. 그 작업의 배경 잡이 1분마다 한 묶음씩 부릅니다(지금 모델 → 후보 모델).`
    + (result.created.length ? ` 후보를 이 단계에서 부를 수 있게 함께 만든 것: ${result.created.join(" · ")}.` : "") };
});
