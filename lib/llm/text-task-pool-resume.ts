import { capacityOwnerFromEnv } from "./capacity-busy-targets";
import { findOwnPendingProductTextRequests, findOwnPendingReasonTranslationRequests } from "./capacity-repository";
import type { TextTaskRanks } from "./ai-task-resolver";

/** Prefer an existing unstarted batch's model before selecting another pool member.
 * This read grants nothing: each existing adapter rehydrates and validates the
 * complete membership, policy generation and domain claim before dispatch.
 */
export async function pendingTextPoolModel(ranks: TextTaskRanks): Promise<string | null> {
  const routeId = ranks.routeId;
  if (ranks.mode !== "workload_pool" || !["reason-translate", "product-translate", "product-tagline-ko"].includes(routeId)) return null;
  const owner = capacityOwnerFromEnv();
  if (!owner) return null;
  const pending = await Promise.all(ranks.usable().map(async binding => {
    const expected = { owner, model: binding.identity, provider: binding.provider };
    const requests = routeId === "reason-translate" ? await findOwnPendingReasonTranslationRequests(expected)
      : await findOwnPendingProductTextRequests({ ...expected, routeId: routeId as "product-translate" | "product-tagline-ko" });
    return requests.map(request => ({ model: binding.identity, state: request.state }));
  }));
  const requests = pending.flat();
  return (requests.find(request => request.state === "reserved") ?? requests[0])?.model ?? null;
}
