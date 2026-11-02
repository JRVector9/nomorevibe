"use server";

import { revalidatePath } from "next/cache";
import { validateAdminStagePools } from "@/lib/llm/admin-model-pools";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { FIRST_REVIEW_RANK_STAGE, rankReadiness, validateRanks } from "@/lib/operations/admin-first-review-ranks";
import { readRankReadinessInput } from "@/lib/operations/admin-first-review-ranks-read";
import type { FirstReviewer } from "@/lib/crawl/agent-review";

/** warnings: 저장은 됐지만 그 순위가 아직 쓰일 수 없는 까닭(연결 계약·용량 경로·장비 한도 없음) — 실행은 그 순위를 건너뛰고 다음 순위로 간다 */
export type ModelSaveState = { ok?: true; version?: string; issues?: string[]; warnings?: string[] } | null;

/** Patch only model identities. Existing admission, review gates and enable switches stay authoritative. */
export const saveReviewModels = webWriteAction(async function saveReviewModels(_previous: ModelSaveState, form: FormData): Promise<ModelSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const rows = (prefix: string, max: number) => Array.from({ length: max }, (_, index) => {
    const model = String(form.get(`${prefix}Model${index}`) ?? "").trim();
    return model ? { provider: String(form.get(`${prefix}Provider${index}`) ?? "abcllm"), model } : null;
  }).filter(row => row !== null);
  // 1차 AI 검수 1·2·3순위(2026-11-01): 1순위 = primary0, 2·3순위 = firstAdditional0·1. 빈 칸 사이의 뒤 순위·같은 모델 중복은 저장하지 않는다
  const slot = (prefix: string, index: number): FirstReviewer | null => {
    const model = String(form.get(`${prefix}Model${index}`) ?? "").trim();
    return model ? { provider: String(form.get(`${prefix}Provider${index}`) ?? "abcllm") as FirstReviewer["provider"], model } : null;
  };
  const ranks = [slot("primary", 0), slot("firstAdditional", 0), slot("firstAdditional", 1)];
  const rankIssues = validateRanks(FIRST_REVIEW_RANK_STAGE, ranks);
  if (rankIssues.length) return { issues: rankIssues };
  let stageModelPools;
  if (form.has("stageModelPools")) {
    const raw = form.get("stageModelPools");
    await ensureServingContracts(0);
    try {
      if (typeof raw !== "string" || raw.length > 32_000) throw new Error("invalid_pool");
      stageModelPools = validateAdminStagePools(JSON.parse(raw));
    } catch { return { issues: ["등록되지 않은 모델·중복 모델·지원하지 않는 제공자 조합입니다. 모델 등록부와 선택 목록을 확인해주세요."] }; }
  }
  const result = await saveSettings({
    ...(stageModelPools ? { stageModelPools } : {}),
    firstReview: rows("primary", 1)[0],
    firstReviewAdditional: rows("firstAdditional", 2),
    secondReview: { voters: rows("voter", 3), fallbacks: rows("fallback", 2) },
  }, admin.login, { expectedFormVersion: String(form.get("settingsVersion") ?? "") });
  if (!result.ok) return { issues: result.issues };
  for (const path of ["/admin/models", "/admin", "/admin/status", "/admin/review"]) revalidatePath(path);
  // 저장은 다음 틱부터 쓰인다(1차 틱마다 설정을 다시 읽는다). 아직 쓰일 수 없는 순위는 숨기지 않고 알린다
  const warnings = rankReadiness(FIRST_REVIEW_RANK_STAGE, ranks, await readRankReadinessInput());
  return { ok: true, version: settingsFormVersion(result.settings), ...(warnings.length ? { warnings } : {}) };
});
