import { withAdminStagePools } from "@/lib/llm/admin-model-pools";
import { deepseekReviewReady } from "@/lib/crawl/deepseek-review";

/** Validate every configured delegate through the same scoped model/endpoint resolver as inference. */
export async function configuredHumanModelsReady(keys: readonly string[] = []): Promise<boolean> {
  if (!keys.length) return deepseekReviewReady();
  try {
    const results = await Promise.all(keys.map(key => withAdminStagePools({ "human-review": [key] }, "admin-models-readiness", () => deepseekReviewReady())));
    return results.every(Boolean);
  } catch { return false; }
}
