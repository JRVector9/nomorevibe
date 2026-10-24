import type { ModelCapacityPolicy } from "./capacity";
import { verifiedLocalModelContract, localModelRouteReady } from "./local-model-capacity";
import { localModelServingContractsSchema } from "./local-model-serving-contract";
import { localModelTargetSchema } from "./local-model-capacity-contract";

/** 읽기 전용 부분 진단이다. production의 전체 입구·gateway alias inventory 증거는 아직 수집하지 않았다.
 * 이 보고서는 전역 open 허가나 relay nativeCapacityReady 증인으로 사용할 수 없다. */
export function localModelCapacityReadiness(policy: ModelCapacityPolicy | null,
  env: Readonly<Record<string, string | undefined>> = process.env) {
  const targets = [
    { kind: "audit", itemId: 1, slug: "diagnostic", purpose: "audit" },
    { kind: "audit", itemId: 1, slug: "diagnostic", purpose: "second_opinion" },
    { kind: "audit", itemId: 1, slug: "diagnostic", purpose: "screen" },
    { kind: "published", secondReviewId: 1, slug: "diagnostic", purpose: "published_filter" },
    { kind: "candidate", attemptId: 1, candidateId: 1, repo: "diagnostic/only", purpose: "held_qwen" },
    { kind: "candidate", attemptId: 1, candidateId: 1, repo: "diagnostic/only", purpose: "human_deepseek" },
    { kind: "split", tiebreakId: 1, candidateId: 1, generationKey: "0".repeat(64), repo: "diagnostic/only", purpose: "qwen_tiebreak" },
    { kind: "split", tiebreakId: 1, candidateId: 1, generationKey: "0".repeat(64), repo: "diagnostic/only", purpose: "deepseek_confirm" },
  ].map(value => localModelTargetSchema.parse(value));
  let contracts: ReturnType<typeof localModelServingContractsSchema.parse> = [];
  try { contracts = localModelServingContractsSchema.parse(JSON.parse(env.LOCAL_MODEL_SERVING_CONTRACTS ?? "null")); } catch { /* unverified */ }
  const localRoutes = (policy?.routes ?? []).filter(route => route.provider === "local-direct").map(route => {
    const contract = contracts.find(value => value.backendId === route.providerBudgetId && value.model === route.model);
    const verified = contract && verifiedLocalModelContract(contract.endpoint, contract.model, env);
    const target = targets.find(target => `local-${target.purpose.replaceAll("_", "-")}` === route.routeId);
    return { routeId: route.routeId, backendId: route.providerBudgetId, physicalGroup: route.groupId,
      ready: Boolean(verified && target && localModelRouteReady(policy, target, verified, env)) };
  });
  return { scope: "existing_direct_callers" as const, localRoutes, globalReady: false as const,
    blockers: ["active_caller_deployment_inventory_unverified", "gateway_physical_alias_inventory_unverified",
      "legacy_gateway_and_cli_contract_readback_unverified"] as const };
}
