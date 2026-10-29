"use server";

import { revalidatePath } from "next/cache";
import { validateAdminStagePools } from "@/lib/llm/admin-model-pools";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

export type ModelSaveState = { ok?: true; version?: string; issues?: string[] } | null;

/** Patch only model identities. Existing admission, review gates and enable switches stay authoritative. */
export const saveReviewModels = webWriteAction(async function saveReviewModels(_previous: ModelSaveState, form: FormData): Promise<ModelSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const rows = (prefix: string, max: number) => Array.from({ length: max }, (_, index) => {
    const model = String(form.get(`${prefix}Model${index}`) ?? "").trim();
    return model ? { provider: String(form.get(`${prefix}Provider${index}`) ?? "abcllm"), model } : null;
  }).filter(row => row !== null);
  let stageModelPools;
  if (form.has("stageModelPools")) {
    const raw = form.get("stageModelPools");
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
  return { ok: true, version: settingsFormVersion(result.settings) };
});
