import { withAdminStagePools } from "@/lib/llm/admin-model-pools";
import { modelForPurpose, readModelRegistry } from "@/lib/llm/model-registry";
import { deepseekReviewReady } from "@/lib/crawl/deepseek-review";

/** Validate every configured delegate through the same scoped model/endpoint resolver as inference. */
export async function configuredHumanModelsReady(keys: readonly string[] = []): Promise<boolean> {
  if (!keys.length) return deepseekReviewReady();
  try {
    const results = await Promise.all(keys.map(key => withAdminStagePools({ "human-review": [key] }, "admin-models-readiness", () => deepseekReviewReady())));
    return results.every(Boolean);
  } catch { return false; }
}

/** Operator label for the human-review delegate: the saved pool, else the registry's human-review model. Never a fixed name. */
export function humanReviewModelDisplay(keys: readonly string[] = []): { modelLabel: string; modelLocation: string } {
  if (keys.length) {
    const models = readModelRegistry().models;
    return { modelLabel: "선택 모델", modelLocation: `사람 위임 검수 풀 · ${keys.map(key => models.find(model => model.key === key)?.displayName ?? key).join(", ")}` };
  }
  const model = modelForPurpose("human-review");
  return { modelLabel: model.displayName, modelLocation: `${model.key} · ${model.model}` };
}
