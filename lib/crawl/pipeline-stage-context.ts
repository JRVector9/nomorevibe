import type { ProductTransaction } from "@/lib/domain/products/generation";
import { lockItemStage, type ItemStageGuard } from "@/lib/jobs/items/repository";

/** Source/input controllers lock stages before domain rows, in one fixed order.
 * Do not hold this transaction across an HTTP or model call. */
export async function lockPipelineInputStages(tx: ProductTransaction): Promise<{
  fetch: ItemStageGuard;
  ai1: ItemStageGuard;
  ai2: ItemStageGuard;
}> {
  const fetch = await lockItemStage(tx, "fetch");
  const ai1 = await lockItemStage(tx, "ai1");
  const ai2 = await lockItemStage(tx, "ai2");
  return { fetch, ai1, ai2 };
}
