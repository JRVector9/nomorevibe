"use server";
import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings, saveSettings, settingsFormVersion, settingsUnreadable } from "@/lib/crawl/settings";
import { onPrimary } from "@/lib/db";
import { validateAdminStagePools } from "@/lib/llm/admin-model-pools";
import { adminStagePoolsSchema } from "@/lib/llm/admin-model-stages";
import { readModelRegistry } from "@/lib/llm/model-registry";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { ensureStageAssignments, requireStageAssignments } from "@/lib/llm/stage-assignment-snapshot";
import { currentHumanModelSelection } from "@/lib/operations/human-model-source";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import type { ModelSaveState } from "./actions";

const POOL_ISSUE = "등록되지 않은 모델·중복 모델·지원하지 않는 제공자 조합입니다. 모델 등록부와 선택 목록을 확인해주세요.";
const HUMAN_POOL_LOCKED = "배정 표가 사람 확인의 실제 출처일 때는 사람 위임 검수 풀을 바꿀 수 없습니다. 배정 표에서 모델을 바꿔주세요.";
const SETTINGS_UNREADABLE = "현재 단계별 모델 설정을 읽지 못했습니다. 새로고침한 뒤 다시 시도해주세요.";
const SOURCE_UNREADABLE = "사람 확인 배정 표 또는 설정 출처를 읽지 못해 저장할 수 없습니다. 새로고침한 뒤 다시 시도해주세요.";

function samePool(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const saveAdminStageModels = webWriteAction(async function saveAdminStageModels(_previous: ModelSaveState, form: FormData): Promise<ModelSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["관리자만 단계별 모델을 저장할 수 있습니다."] };
  const raw = form.get("stageModelPools");
  if (typeof raw !== "string" || raw.length > 32_000) return { issues: ["단계별 모델 값을 읽지 못했습니다."] };

  const current = await onPrimary(() => getSettings());
  if (settingsUnreadable(current)) return { issues: [SETTINGS_UNREADABLE] };

  let submitted;
  try { submitted = adminStagePoolsSchema.parse(JSON.parse(raw)); }
  catch { return { issues: [POOL_ISSUE] }; }

  try {
    readModelRegistry();
    await ensureServingContracts(0);
    await ensureStageAssignments(0);
    await requireStageAssignments();
  } catch { return { issues: [SOURCE_UNREADABLE] }; }

  const storedPools = current.stageModelPools;
  const storedHuman = storedPools?.["human-review"];
  const selection = currentHumanModelSelection(storedHuman ?? []);

  let pools;
  try {
    if (selection.source === "table") {
      if (!samePool(submitted["human-review"], storedHuman)) return { issues: [HUMAN_POOL_LOCKED] };
      const rest: Record<string, unknown> = { ...submitted };
      delete rest["human-review"];
      pools = validateAdminStagePools(rest);
      if (Object.prototype.hasOwnProperty.call(storedPools ?? {}, "human-review")) {
        Object.assign(pools, { "human-review": storedHuman });
      }
    } else {
      pools = validateAdminStagePools(submitted);
    }
  } catch { return { issues: [POOL_ISSUE] }; }

  const result = await saveSettings({ stageModelPools: pools }, admin.login, { expectedFormVersion: String(form.get("settingsVersion") ?? "") });
  if (!result.ok) return { issues: result.issues };
  for (const path of ["/admin/models", "/admin/models/human", "/admin", "/admin/status", "/admin/flow"]) revalidatePath(path);
  return { ok: true, version: settingsFormVersion(result.settings) };
});
