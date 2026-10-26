import { createHash, randomUUID } from "node:crypto";
import { cliDispatchBindingHash, publicationClassifyInputHash, publicationClassifyLogicalWorkKey, publicationClassifyCliDispatchBindingSchema } from "@/lib/llm/capacity";
import { providerBoundaryCanonicalHash } from "@/lib/llm/provider-boundary-contract";

export function cliExecutorFixture(now = Date.now(), candidateId = 17) {
  const hash = (n: string) => n.repeat(64), at = (ago: number) => new Date(now - ago).toISOString();
  const owner = { instanceId: "m3-publisher", bootId: randomUUID() }, token = randomUUID();
  const facts = { members: [{ candidateId, repo: "fixture/project", sourceHash: hash("a") }], provider: "codex-cli" as const,
    model: "fixture-codex", payloadHash: hash("b"), definitionsHash: hash("c"), configHash: hash("d"), generation: 3, configVersion: 4 };
  const transport = { protocol: "cli-process-v1" as const, provider: facts.provider, model: facts.model, argvHash: hash("e"), inputHash: hash("f"),
    envPolicyHash: hash("a"), cliContractHash: hash("b"), timeoutMs: 35000, maxStdoutBytes: 65536, maxStderrBytes: 32768 };
  const binding = publicationClassifyCliDispatchBindingSchema.parse({ ...facts, kind: "publication_classify_cli", version: 1,
    logicalWorkKey: publicationClassifyLogicalWorkKey(facts.members), inputHash: publicationClassifyInputHash(facts),
    routeId: "crawl-publish-classify", publisherRole: { role: "publisher", ...owner, release: "fixture-old", epoch: 7, kind: "primary" },
    job: { name: "crawl-publish", token: randomUUID(), requestedVersion: 11 }, transport, totalTokenBound: 32000, chargedTokens: 32000 });
  const executor = { baseUrl: "http://100.92.77.66:3020", baseUrlHash: createHash("sha256").update("http://100.92.77.66:3020").digest("hex"),
    rpcPath: "/rpc", serviceId: "fixture-service", nodeId: "fixture-node", daemonId: "fixture-daemon", daemonBootId: randomUUID(),
    sourceSha: "a".repeat(40), specHash: hash("c") };
  const candidates = ["d", "e"].map((n, i) => ({ taskId: `fixture-task-${i}`, containerId: hash(n), serviceId: executor.serviceId, nodeId: executor.nodeId }));
  const topology = { privatePid: true, unprivileged: true, noHostPid: true, noSocketMounts: true, vaultVolumeOnly: true, noEscape: true, sourcePinned: true };
  const plan = { kind: "cli_executor_boundary_plan", version: 1, createdAt: at(30000), reviewReference: "root-reviewed-fixture-closure",
    request: { requestId: randomUUID(), state: "dispatched", owner, tokenHash: createHash("sha256").update(token).digest("hex"), epoch: 1, revision: 3,
      policyHash: hash("f"), bindingHash: cliDispatchBindingHash(binding), dispatchAt: at(3600000), providerBudgetId: "fixture-cli", groupId: "fixture-cli-group",
      routeId: binding.routeId, provider: binding.provider, model: binding.model, logicalWorkKey: binding.logicalWorkKey, inputHash: binding.inputHash,
      payloadHash: binding.payloadHash, transport, totalTokenBound: binding.totalTokenBound, chargedTokens: binding.chargedTokens },
    writer: { lineageId: randomUUID(), writerEpoch: 1 },
    control: { mode: "draining", epoch: 1, revision: 3, policyHash: hash("f"), updatedAt: at(60000).replace("Z", "000Z") },
    executor, candidates, topology,
    interval: { beforeNativeAt: at(7200000), nativeDispatchAbsent: true, singleTaskId: candidates[0].taskId, inventoryComplete: true, taskHistoryGap: false },
    artifactHashes: { before: hash("1"), closurePlan: hash("2"), inventory: hash("3"), endpoint: hash("4"), topology: hash("5"), noReplay: hash("6") } };
  const receipt = { kind: "cli_executor_boundary_receipt", version: 1, planHash: providerBoundaryCanonicalHash(plan), observedAt: at(10000), executor,
    wholeService: { desiredReplicas: 0, runningTasks: 0, runningContainers: 0, endpointClosed: { kind: "no_listener", count: 0 }, replacements: 0, autoRestartBlocked: true,
      inventoryComplete: true, taskHistoryGap: false, orphanExecutors: 0 },
    exits: candidates.map(identity => ({ identity, taskState: "shutdown", initClosure: { kind: "container_inspect", pid: 0, running: false }, running: false, exitCode: 0, containerState: "removed",
      method: "trusted_swarm_service_lifecycle" })), topology,
    noReplay: { sourcePinned: true, durableQueue: false, oldCallerAuthorityRevoked: true, pendingRpcCannotReplay: true, newBootCannotReplay: true },
    artifactHashes: { closure: hash("7"), inventory: hash("8"), endpoint: hash("9"), topology: hash("a"), noReplay: hash("b") } };
  const evidence = { kind: "cli_executor_boundary_exit", version: 1, requestId: plan.request.requestId, owner, fromState: "dispatched",
    dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash, notBefore: receipt.observedAt, evaluatedAt: at(0),
    operator: "fixture-operator", reference: plan.reviewReference, plan, receipt };
  return { plan, receipt, evidence, binding, token };
}
