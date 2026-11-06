"use server";

import { ensureCliStageModelResources } from "@/lib/operations/admin-ai-tasks-repository";
import { revalidatePath } from "next/cache";
import { ensureCliStageCatalogs, validateAdminStagePools } from "@/lib/llm/admin-model-pools";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

/** warnings: 저장은 됐지만 그 순위가 아직 쓰일 수 없는 까닭(연결 계약·용량 경로·장비 한도 없음) — 실행은 그 순위를 건너뛰고 다음 순위로 간다 */
export type ModelSaveState = { ok?: true; version?: string; issues?: string[]; warnings?: string[] } | null;

/**
 * 단계별 모델 풀만 저장한다. 1차 AI 검수·2차 투표·2차 대체 칸(crawl_settings.firstReview·firstReviewAdditional·secondReview.voters·fallbacks)은
 * 쓰지 않는다(PR C1) — 실행 쪽은 「작업 ↔ 모델」 순위만 읽는다. 옛 화면이 그 칸을 보내도 저장된 옛 값(가져오기 출처)은 그대로 남는다.
 */
export const saveReviewModels = webWriteAction(async function saveReviewModels(_previous: ModelSaveState, form: FormData): Promise<ModelSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  if (!form.has("stageModelPools")) return { issues: ["1차·2차 심사 모델은 작업 ↔ 모델(/admin/models/tasks)에서 바꿉니다. 이 화면은 저장하지 않습니다."] };
  const raw = form.get("stageModelPools");
  await ensureServingContracts(0);
  let stageModelPools;
  try {
    if (typeof raw !== "string" || raw.length > 32_000) throw new Error("invalid_pool");
    const parsed = JSON.parse(raw);
    await ensureCliStageCatalogs(parsed);
    stageModelPools = validateAdminStagePools(parsed);
  } catch { return { issues: ["등록되지 않은 모델·중복 모델·지원하지 않는 제공자 조합입니다. 모델 등록부와 선택 목록을 확인해주세요."] }; }
  const resources = await ensureCliStageModelResources(stageModelPools, admin.login);
  if (!resources.ok) return { issues: resources.issues };
  const result = await saveSettings({ stageModelPools }, admin.login, { expectedFormVersion: String(form.get("settingsVersion") ?? "") });
  if (!result.ok) return { issues: result.issues };
  for (const path of ["/admin/models", "/admin", "/admin/status", "/admin/review"]) revalidatePath(path);
  return { ok: true, version: settingsFormVersion(result.settings) };
});
