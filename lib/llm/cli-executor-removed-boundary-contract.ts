import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cliExecutorEvidenceShape, cliExecutorPlanHash, cliExecutorPlanSchema, cliExecutorReceiptSchema } from "./cli-executor-boundary-contract";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const at = cliExecutorPlanSchema.shape.createdAt;
const executor = cliExecutorPlanSchema.shape.executor, candidate = cliExecutorPlanSchema.shape.candidates.element;
const topology = cliExecutorPlanSchema.shape.topology, wholeService = cliExecutorReceiptSchema.shape.wholeService;
const knownExit = cliExecutorReceiptSchema.shape.exits.element;
const missingObject = z.object({ observedAt: at, result: z.literal("no_such_object"), exitCode: z.literal(1), artifactHash: sha }).strict();
const removedExit = z.object({ identity: candidate, taskState: z.literal("removed"), running: z.literal(false),
  exitCode: z.null(), containerState: z.literal("removed"), method: z.literal("trusted_swarm_service_removal"),
  originalBefore: z.object({ observedAt: at, identity: candidate, taskState: z.literal("running"), running: z.literal(true),
    hostPid: z.number().int().positive().safe(), user: z.literal("worker"), entrypoint: z.tuple([z.literal("/sbin/tini"), z.literal("--")]),
    command: z.tuple([z.literal("node"), z.literal("--import"), z.literal("tsx"), z.literal("scripts/connect-agent.ts")]),
    executor, topology, taskSpecHash: sha, containerConfigHash: sha, artifactHash: sha }).strict(),
  engineTaskDelete: z.object({ source: z.literal("orbstack_docker_engine_log"), namespace: z.literal("moby"), topic: z.literal("/tasks/delete"),
    eventType: z.literal("*events.TaskDelete"), containerId: sha, occurredAt: at,
    rawTimestamp: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,9}(Z|[+-]\d\d:\d\d)$/),
    daemonId: executor.shape.daemonId, daemonBootId: executor.shape.daemonBootId, artifactHash: sha }).strict(),
}).strict();
const zeroObservation = z.object({ observedAt: at, executor, topology, wholeService,
  control: cliExecutorPlanSchema.shape.control, writer: cliExecutorPlanSchema.shape.writer,
  originalSpecProjectedOnlyReplicasZero: z.literal(true), servicePresent: z.literal(true), daemonReachable: z.literal(true),
  singleNode: z.literal(true), noAlternativeExecutor: z.literal(true), captureArtifactHash: sha, inventoryArtifactHash: sha,
  missing: z.array(z.object({ identity: candidate, task: missingObject, container: missingObject }).strict()).min(1).max(64),
}).strict();
export const cliExecutorRemovedReceiptSchema = cliExecutorReceiptSchema.omit({ version: true, kind: true, exits: true }).extend({
  version: z.literal(2), kind: z.literal("cli_executor_removed_boundary_receipt"),
  exits: z.array(z.discriminatedUnion("taskState", [knownExit, removedExit])).min(1).max(64),
  removalBoundary: z.object({ stopAttemptAt: at, stopAttemptArtifactHash: sha, stopOutcome: z.enum(["ambiguous", "acknowledged"]),
    continuousServiceFence: z.literal(true), reviewArtifactHash: sha, observations: z.tuple([zeroObservation, zeroObservation]) }).strict(),
}).strict();
/** Privileged physical deletion evidence, never a native CLI terminal or a known provider usage report. */
export const cliExecutorRemovedEvidenceShape = cliExecutorEvidenceShape.omit({ version: true, kind: true, receipt: true }).extend({
  version: z.literal(2), kind: z.literal("cli_executor_removed_boundary_exit"), receipt: cliExecutorRemovedReceiptSchema,
}).strict();
export type CliExecutorRemovedReceipt = z.infer<typeof cliExecutorRemovedReceiptSchema>;
export function validCliExecutorRemovedEvidence(e: z.infer<typeof cliExecutorRemovedEvidenceShape>): boolean {
  const p = e.plan, r = e.receipt, q = p.request, now = Date.parse(e.evaluatedAt), created = Date.parse(p.createdAt), observed = Date.parse(r.observedAt);
  const tasks = p.candidates.map(c => c.taskId), containers = p.candidates.map(c => c.containerId);
  const removed = r.exits.filter(x => x.taskState === "removed"), b = r.removalBoundary, [first, last] = b.observations;
  return e.requestId === q.requestId && isDeepStrictEqual(e.owner, q.owner) && e.dispatchAt === q.dispatchAt && e.bindingHash === q.bindingHash
    && e.reference === p.reviewReference && e.notBefore === r.observedAt && r.planHash === cliExecutorPlanHash(p)
    && isDeepStrictEqual(p.executor, r.executor) && isDeepStrictEqual(p.topology, r.topology)
    && p.executor.baseUrlHash === createHash("sha256").update(p.executor.baseUrl).digest("hex")
    && q.provider === q.transport.provider && q.model === q.transport.model && q.chargedTokens === q.totalTokenBound
    && Date.parse(p.interval.beforeNativeAt) < Date.parse(q.dispatchAt) && created >= Date.parse(q.dispatchAt) && Date.parse(p.control.updatedAt) <= created
    && now >= observed && observed >= created && now - created <= 30 * 60_000 && now - observed <= 5 * 60_000
    && new Set(tasks).size === tasks.length && new Set(containers).size === containers.length && tasks.includes(p.interval.singleTaskId)
    && p.candidates.every(c => c.serviceId === p.executor.serviceId && c.nodeId === p.executor.nodeId)
    && r.exits.length === p.candidates.length && r.exits.every((x, i) => isDeepStrictEqual(x.identity, p.candidates[i]))
    && r.exits.every(x => x.taskState === "removed" || x.initClosure.kind !== "removed_after_trusted_init_exit" || x.containerState === "removed")
    && (r.wholeService.endpointClosed.kind !== "trusted_forwarder_no_backend" || r.wholeService.endpointClosed.backendServiceId === p.executor.serviceId)
    && removed.length > 0 && Date.parse(b.stopAttemptAt) <= created && Date.parse(b.stopAttemptAt) >= Date.parse(q.dispatchAt)
    && Date.parse(first.observedAt) >= created && Date.parse(first.observedAt) < Date.parse(last.observedAt)
    && last.observedAt === r.observedAt && now - Date.parse(first.observedAt) <= 5 * 60_000
    && first.inventoryArtifactHash !== last.inventoryArtifactHash && first.captureArtifactHash !== last.captureArtifactHash
    && isDeepStrictEqual(last.wholeService, r.wholeService)
    && b.observations.every(o => isDeepStrictEqual(o.executor, p.executor) && isDeepStrictEqual(o.topology, p.topology)
      && isDeepStrictEqual(o.control, p.control) && isDeepStrictEqual(o.writer, p.writer)
      && (o.wholeService.endpointClosed.kind !== "trusted_forwarder_no_backend" || o.wholeService.endpointClosed.backendServiceId === p.executor.serviceId)
      && o.missing.length === removed.length && o.missing.every((m, i) => isDeepStrictEqual(m.identity, removed[i].identity)
        && m.task.observedAt === o.observedAt && m.container.observedAt === o.observedAt))
    && first.missing.every((m, i) => m.task.artifactHash !== last.missing[i].task.artifactHash
      && m.container.artifactHash !== last.missing[i].container.artifactHash)
    && removed.every(x => isDeepStrictEqual(x.originalBefore.identity, x.identity) && isDeepStrictEqual(x.originalBefore.executor, p.executor)
      && isDeepStrictEqual(x.originalBefore.topology, p.topology) && Date.parse(x.originalBefore.observedAt) >= Date.parse(q.dispatchAt)
      && Date.parse(x.originalBefore.observedAt) <= Date.parse(b.stopAttemptAt) && Date.parse(x.originalBefore.observedAt) < Date.parse(x.engineTaskDelete.occurredAt)
      && Date.parse(x.engineTaskDelete.occurredAt) >= Date.parse(b.stopAttemptAt) && Date.parse(x.engineTaskDelete.occurredAt) <= Date.parse(first.observedAt)
      && Date.parse(x.engineTaskDelete.rawTimestamp) === Date.parse(x.engineTaskDelete.occurredAt)
      && x.engineTaskDelete.containerId === x.identity.containerId && x.engineTaskDelete.daemonId === p.executor.daemonId
      && x.engineTaskDelete.daemonBootId === p.executor.daemonBootId);
}
export const cliExecutorRemovedEvidenceSchema = cliExecutorRemovedEvidenceShape.refine(validCliExecutorRemovedEvidence, "invalid_cli_executor_removed_boundary");
export function cliExecutorRemovedArtifactHashes(plan: z.infer<typeof cliExecutorPlanSchema>, receipt: CliExecutorRemovedReceipt): string[] {
  return [...new Set([...Object.values(plan.artifactHashes), ...Object.values(receipt.artifactHashes), receipt.removalBoundary.stopAttemptArtifactHash,
    receipt.removalBoundary.reviewArtifactHash, ...receipt.removalBoundary.observations.flatMap(o => [o.captureArtifactHash, o.inventoryArtifactHash,
      ...o.missing.flatMap(m => [m.task.artifactHash, m.container.artifactHash])]), ...receipt.exits.flatMap(x => x.taskState === "removed"
      ? [x.originalBefore.artifactHash, x.originalBefore.taskSpecHash, x.originalBefore.containerConfigHash, x.engineTaskDelete.artifactHash] : [])])];
}
