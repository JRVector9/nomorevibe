import { capacityOwnerFromEnv, type CapacityOwner } from "./capacity-busy-targets";
import { findOwnPendingProductTextRequests, findOwnPendingReasonTranslationRequests, readTextTargetPoolAffinities, type TextTargetPoolInput } from "./capacity-repository";
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { aiTaskAliasIdentity } from "./ai-tasks";
import type { TextTaskRanks } from "./ai-task-resolver";

/** Prefer an existing unstarted batch's model before selecting another pool member.
 * This read grants nothing: each existing adapter rehydrates and validates the
 * complete membership, policy generation and domain claim before dispatch.
 * A parallel tick omits requests already claimed by a sibling lane.
 */
export async function pendingTextPoolModel(ranks: TextTaskRanks, claimedRequestIds?: ReadonlySet<string>): Promise<string | null> {
  const routeId = ranks.routeId;
  if (ranks.mode !== "workload_pool" || !["reason-translate", "product-translate", "product-tagline-ko"].includes(routeId)) return null;
  const owner = capacityOwnerFromEnv();
  if (!owner) return null;
  const pending = await Promise.all(ranks.usable().map(async binding => {
    const expected = { owner, model: binding.identity, provider: binding.provider };
    const requests = routeId === "reason-translate" ? await findOwnPendingReasonTranslationRequests(expected)
      : await findOwnPendingProductTextRequests({ ...expected, routeId: routeId as "product-translate" | "product-tagline-ko" });
    return requests.filter(request => !claimedRequestIds?.has(request.request.requestId))
      .map(request => ({ model: binding.identity, state: request.state }));
  }));
  const requests = pending.flat();
  return (requests.find(request => request.state === "reserved") ?? requests[0])?.model ?? null;
}

export type { TextTargetPoolInput } from './capacity-repository';
/** Resume a fixed target's actual prior model before any new member selection. */
export async function pendingTextPoolTargetModel(ranks: TextTaskRanks, target: TextTargetPoolInput,
  owner: CapacityOwner | undefined = capacityOwnerFromEnv()): Promise<string | null> {
  if (ranks.mode !== 'workload_pool') return null;
  if (ranks.routeId !== target.routeId) throw new Error('text_pool_affinity_route_mismatch');
  if (!owner) throw new ModelCapacityDeferredError('owner_unavailable');
  // 구성원과 예비 순위(0179) 모두 — 예비로 줄에 세운 고정 대상도 그 모델로 이어받는다
  const models = ranks.candidates().flatMap(candidate => candidate.binding ? [candidate.binding.identity]
    : [candidate.rank.model, aiTaskAliasIdentity(candidate.rank.model, candidate.rank.connection.id)].filter((model): model is string => !!model));
  const matches = await readTextTargetPoolAffinities(target, models, owner);
  if (matches.length > 1) throw new ModelCapacityDeferredError('ledger_mismatch');
  const match = matches[0];
  if (!match) return null;
  if (!ranks.bindings().some(binding => binding.identity === match.model && binding.provider === match.provider))
    throw new ModelCapacityDeferredError('provider_contract_unavailable');
  return match.model;
}
