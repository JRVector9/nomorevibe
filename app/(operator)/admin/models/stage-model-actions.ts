"use server";
import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { validateAdminStagePools } from "@/lib/llm/admin-model-pools";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import type { ModelSaveState } from "./actions";

export const saveAdminStageModels = webWriteAction(async function saveAdminStageModels(_previous: ModelSaveState, form: FormData): Promise<ModelSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["관리자만 단계별 모델을 저장할 수 있습니다."] };
  const raw = form.get("stageModelPools");
  if (typeof raw !== "string" || raw.length > 32_000) return { issues: ["단계별 모델 값을 읽지 못했습니다."] };
  let pools;
  try { pools = validateAdminStagePools(JSON.parse(raw)); }
  catch { return { issues: ["등록되지 않은 모델·중복 모델·지원하지 않는 제공자 조합입니다. 모델 등록부와 선택 목록을 확인해주세요."] }; }
  const result = await saveSettings({ stageModelPools: pools }, admin.login, { expectedFormVersion: String(form.get("settingsVersion") ?? "") });
  if (!result.ok) return { issues: result.issues };
  for (const path of ["/admin/models", "/admin", "/admin/status"]) revalidatePath(path);
  return { ok: true, version: settingsFormVersion(result.settings) };
});
