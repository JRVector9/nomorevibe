import { randomUUID } from "node:crypto";
import { replacedPathDigest as sha, replacedPathPlanHash, replacedPathRequiredHops, type ReplacedPathPlan,
  type ReplacedPathReceipt } from "@/lib/llm/replaced-path-boundary-contract";

/** Synthetic fixture only. No real host, stop, restart, model call or production receipt. */
export function replacedPathFixture(budget = "abcllm-m1-qwen", instanceId = "m3-text") {
  const now = Date.now(), at = (offset: number) => new Date(now + offset).toISOString(), h = sha("fixture");
  const owner = { instanceId, bootId: randomUUID() };
  const plan: ReplacedPathPlan = { version: 1, kind: "replaced_path_boundary_plan", createdAt: at(-20_000), reviewReference: "synthetic path replacement",
    request: { requestId: randomUUID(), owner, state: "indeterminate", tokenHash: h, epoch: 1, revision: 7, policyHash: h, bindingHash: h,
      dispatchAt: at(-3_600_000), providerBudgetId: budget, groupId: "m1-qwen", servingContractHash: h, rowHash: h,
      routeId: "product-translate", provider: "abcllm", model: "[m1] qwen3.8-flash-next" },
    control: { mode: "draining", epoch: 1, revision: 7, policyHash: h, updatedAt: at(-30_000).replace("Z", "000Z") },
    writer: { lineageId: randomUUID(), writerEpoch: 1 } };
  const hops = (replacedPathRequiredHops(instanceId, budget) ?? []).map((hop, i) => ({ ...hop, incarnationId: `incarnation-${i}`,
    startedAt: at(-1_800_000 + i * 1000), observedAt: at(-5000 + i * 100), singleInstance: true as const, artifactHash: sha(`artifact-${i}`) }));
  const receipt: ReplacedPathReceipt = { version: 1, kind: "replaced_path_boundary_receipt", planHash: replacedPathPlanHash(plan),
    observedAt: at(-2000), hops };
  const evidence = { version: 1 as const, kind: "replaced_path_boundary_exit" as const, requestId: plan.request.requestId, owner,
    fromState: "indeterminate" as const, dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash, notBefore: receipt.observedAt,
    evaluatedAt: at(0), operator: "fixture-operator", reference: plan.reviewReference, plan, receipt };
  return { plan, receipt, evidence };
}
