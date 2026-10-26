import { createHash } from "node:crypto";
import { cliExecutorPlanHash } from "@/lib/llm/cli-executor-boundary-contract";
import { cliExecutorRemovedEvidenceShape } from "@/lib/llm/cli-executor-removed-boundary-contract";
import { cliExecutorFixture } from "./cli-executor-boundary";

export function cliExecutorRemovedFixture(now = Date.now()) {
  const fx = cliExecutorFixture(now), p = fx.plan, at = (ago: number) => new Date(now - ago).toISOString();
  const identity = p.candidates[1], hash = (n: string) => n.repeat(64);
  const receipt = { ...fx.receipt, version: 2, kind: "cli_executor_removed_boundary_receipt",
    exits: [fx.receipt.exits[0], { identity, taskState: "removed", running: false, exitCode: null, containerState: "removed", method: "trusted_swarm_service_removal",
      originalBefore: { observedAt: at(120000), identity, taskState: "running", running: true, hostPid: 83123, user: "worker",
        entrypoint: ["/sbin/tini", "--"], command: ["node", "--import", "tsx", "scripts/connect-agent.ts"], executor: p.executor,
        topology: p.topology, taskSpecHash: hash("a"), containerConfigHash: hash("b"), artifactHash: hash("c") },
      engineTaskDelete: { source: "orbstack_docker_engine_log", namespace: "moby", topic: "/tasks/delete", eventType: "*events.TaskDelete",
        containerId: identity.containerId, occurredAt: at(90000), rawTimestamp: at(90000).replace("Z", "538984Z"),
        daemonId: p.executor.daemonId, daemonBootId: p.executor.daemonBootId, artifactHash: hash("d") } }],
    removalBoundary: { stopAttemptAt: at(100000), stopAttemptArtifactHash: hash("e"), stopOutcome: "ambiguous", continuousServiceFence: true,
      reviewArtifactHash: hash("f"), observations: [20000, 10000].map((ago, i) => ({ observedAt: at(ago), executor: p.executor, topology: p.topology,
        control: p.control, writer: p.writer, wholeService: fx.receipt.wholeService, originalSpecProjectedOnlyReplicasZero: true,
        servicePresent: true, daemonReachable: true, singleNode: true, noAlternativeExecutor: true,
        captureArtifactHash: hash(i ? "2" : "1"), inventoryArtifactHash: hash(i ? "4" : "3"), missing: [{ identity,
          task: { observedAt: at(ago), result: "no_such_object", exitCode: 1, artifactHash: hash(i ? "6" : "5") },
          container: { observedAt: at(ago), result: "no_such_object", exitCode: 1, artifactHash: hash(i ? "8" : "7") } }] })) } };
  receipt.planHash = cliExecutorPlanHash(p);
  const evidence = cliExecutorRemovedEvidenceShape.parse({ ...fx.evidence, version: 2, kind: "cli_executor_removed_boundary_exit", receipt });
  return { ...fx, plan: evidence.plan, receipt: evidence.receipt, evidence };
}

export function materializeRemovedArtifacts(fx: ReturnType<typeof cliExecutorRemovedFixture>, write: (hash: string, bytes: string) => void) {
  let ordinal = 0;
  const layer = (o: object, keys: string[]) => { for (const key of keys) {
    const bytes = JSON.stringify({ fixture: true, ordinal: ordinal++ }), hash = createHash("sha256").update(bytes).digest("hex");
    Object.assign(o, { [key]: hash }); write(hash, bytes);
  } };
  for (const o of [fx.plan.artifactHashes, fx.receipt.artifactHashes]) layer(o, Object.keys(o));
  layer(fx.receipt.removalBoundary, ["stopAttemptArtifactHash", "reviewArtifactHash"]);
  for (const o of fx.receipt.removalBoundary.observations) {
    layer(o, ["captureArtifactHash", "inventoryArtifactHash"]);
    for (const m of o.missing) { layer(m.task, ["artifactHash"]); layer(m.container, ["artifactHash"]); }
  }
  for (const x of fx.receipt.exits) if (x.taskState === "removed") {
    layer(x.originalBefore, ["artifactHash", "taskSpecHash", "containerConfigHash"]); layer(x.engineTaskDelete, ["artifactHash"]);
  }
  fx.receipt.planHash = cliExecutorPlanHash(fx.plan);
}
