import { randomUUID } from "node:crypto";
import { replacedProviderDigest as sha, replacedProviderPlanHash, type ReplacedProviderPlan, type ReplacedProviderReceipt } from "@/lib/llm/replaced-provider-boundary-contract";

/** Synthetic fixture only. No real endpoint, model call, stop, or production receipt. */
export function replacedProviderFixture() {
  const now = Date.now(), at = (offset: number) => new Date(now + offset).toISOString(), h = sha("fixture");
  const owner = { instanceId: "m3-text", bootId: randomUUID() };
  const plan: ReplacedProviderPlan = { version: 1, kind: "replaced_provider_boundary_plan", createdAt: at(-20_000), reviewReference: "synthetic replacement boundary",
    request: { requestId: randomUUID(), owner, state: "indeterminate", tokenHash: h, epoch: 1, revision: 7, policyHash: h, bindingHash: h,
      dispatchAt: at(-3_600_000), providerBudgetId: "abcllm-m1", groupId: "m1", servingContractHash: h, rowHash: h, wireHash: h, chargedTokens: 40768 },
    control: { mode: "draining", epoch: 1, revision: 7, policyHash: h, updatedAt: at(-30_000).replace("Z", "000Z") },
    writer: { lineageId: randomUUID(), writerEpoch: 1 },
    originalOwner: { kind: "durable_process_group_exit", ...owner, openedEventId: 1,
      groups: [{ seq: 1, pid: 52, runIdHash: h, spawnIntentEventId: 2, spawnedEventId: 3, exitEventId: 4 }],
      localEndEventId: 5, localEndEvidenceHash: h, artifactHash: h } };
  const messages = [{ role: "system", content: "Translate exactly." }, { role: "user", content: "[한국어]" }];
  const originalWire = JSON.stringify({ model: "[m1] qwen3.8-flash-next", stream: false, temperature: 0, reasoning_effort: "low", max_tokens: 2000, messages });
  const relayWire = JSON.stringify({ model: "qwen3.8-flash-next", messages, stream: true, stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: false }, max_tokens: 2000, temperature: 0 });
  plan.request.wireHash = sha(originalWire);
  const receipt: ReplacedProviderReceipt = { version: 1, kind: "replaced_provider_boundary_receipt", observedAt: at(-2000), planHash: replacedProviderPlanHash(plan),
    containers: ["owner", "gateway-m3", "gateway-mini"].map((role, i) => ({ role, host: i === 2 ? "9mini" : "m3ultra",
      serviceName: ["nomorevibe-text-m3-ebmybu", "app-reboot-optical-matrix-3bl2a4", "app-hack-optical-monitor-v1ioak"][i],
      serviceId: `service-${i}`, taskId: `task-${i}`, containerId: sha(`container-${i}`), startedAt: at(-1_800_000), observedAt: at(-5000), replicas: 1,
      privatePidNamespace: true, noPreDispatchActiveTask: true, noAlternativeIngress: true, artifactHash: h, topologyArtifactHash: h })) as ReplacedProviderReceipt["containers"],
    relay: { requestId: randomUUID(), requestModel: "qwen3.8-flash-next", requestHash: sha(relayWire), relayGeneration: randomUUID(),
      startedAt: at(-3_597_000), endedAt: at(-3_500_000), state: "indeterminate", error: "upstream_timeout", receiptArtifactHash: h, recoveryArtifactHash: h,
      currentGeneration: randomUUID(), currentStartedAt: at(-1_700_000), currentPid: 40297, currentArtifactHash: h, oldRelayGroupEnded: true, oldModelGroupEnded: true,
      originalModelPid: 47047, originalModelStartedAt: at(-7_200_000), currentModelPid: 48000, currentModelStartedAt: at(-1_700_000), currentModel: "Gemma4", originalWireArtifactHash: sha(originalWire),
      gatewaySourceArtifactHash: h, transform: "abcllm-qwen-nonstream-httpx-0.27.2", originalWire, relayWire } };
  const evidence = { version: 1 as const, kind: "replaced_provider_boundary_exit" as const, requestId: plan.request.requestId, owner, fromState: "indeterminate" as const,
    dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash, notBefore: receipt.observedAt, evaluatedAt: at(0),
    operator: "fixture-operator", reference: plan.reviewReference, plan, receipt };
  return { plan, receipt, evidence };
}
