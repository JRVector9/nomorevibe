import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cliTransportSchema } from "./cli-serving-contract";
import { providerBoundaryCanonicalHash } from "./provider-boundary-contract";

const id = (max = 200) => z.string().min(1).max(max).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive().safe();
const at = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const databaseAt = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
  .refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === `${v.slice(0, 23)}Z`);
const owner = z.object({ instanceId: id(120), bootId: z.uuid() }).strict();
const executor = z.object({ baseUrl: z.literal("http://100.92.77.66:3020"), baseUrlHash: sha, rpcPath: z.literal("/rpc"),
  serviceId: id(), nodeId: id(), daemonId: id(), daemonBootId: z.uuid(), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), specHash: sha }).strict();
const candidate = z.object({ taskId: id(), containerId: sha, serviceId: id(), nodeId: id() }).strict();
const topology = z.object({ privatePid: z.literal(true), unprivileged: z.literal(true), noHostPid: z.literal(true), noSocketMounts: z.literal(true),
  vaultVolumeOnly: z.literal(true), noEscape: z.literal(true), sourcePinned: z.literal(true) }).strict();
export const cliExecutorPlanSchema = z.object({ version: z.literal(1), kind: z.literal("cli_executor_boundary_plan"), createdAt: at, reviewReference: id(400),
  request: z.object({ requestId: z.uuid(), state: z.literal("dispatched"), owner, tokenHash: sha, epoch: positive, revision: positive, policyHash: sha,
    bindingHash: sha, dispatchAt: at, providerBudgetId: id(120), groupId: id(120), routeId: z.literal("crawl-publish-classify"),
    provider: z.enum(["codex-cli", "claude-cli"]), model: id(), logicalWorkKey: id(160), inputHash: sha, payloadHash: sha,
    // These privileged classification-only receipts keep their historical transport schema; review providers do not gain recovery authority here.
    transport: cliTransportSchema.extend({ provider: z.enum(["claude-cli", "grok-cli", "codex-cli"]) }).strict(), totalTokenBound: positive, chargedTokens: positive }).strict(),
  writer: z.object({ lineageId: z.uuid(), writerEpoch: positive }).strict(),
  control: z.object({ mode: z.literal("draining"), epoch: positive, revision: positive, policyHash: sha, updatedAt: databaseAt }).strict(),
  executor, candidates: z.array(candidate).min(1).max(64), topology,
  interval: z.object({ beforeNativeAt: at, nativeDispatchAbsent: z.literal(true), singleTaskId: id(), inventoryComplete: z.literal(true), taskHistoryGap: z.literal(false) }).strict(),
  artifactHashes: z.object({ before: sha, closurePlan: sha, inventory: sha, endpoint: sha, topology: sha, noReplay: sha }).strict(),
}).strict();
export const cliExecutorReceiptSchema = z.object({ version: z.literal(1), kind: z.literal("cli_executor_boundary_receipt"), planHash: sha, observedAt: at, executor,
  wholeService: z.object({ desiredReplicas: z.literal(0), runningTasks: z.literal(0), runningContainers: z.literal(0), replacements: z.literal(0),
    autoRestartBlocked: z.literal(true), inventoryComplete: z.literal(true), taskHistoryGap: z.literal(false), orphanExecutors: z.literal(0),
    endpointClosed: z.discriminatedUnion("kind", [z.object({ kind: z.literal("no_listener"), count: z.literal(0) }).strict(),
      z.object({ kind: z.literal("trusted_forwarder_no_backend"), forwarderIdentity: id(), forwarderHash: sha, backendServiceId: id(),
        backendCount: z.literal(0), noAlternativeExecutor: z.literal(true), RPCUnavailable: z.literal(true) }).strict()]) }).strict(),
  exits: z.array(z.object({ identity: candidate, taskState: z.enum(["shutdown", "complete", "failed"]), initClosure: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("container_inspect"), pid: z.literal(0), running: z.literal(false) }).strict(),
      z.object({ kind: z.literal("removed_after_trusted_init_exit"), containerRemoved: z.literal(true), trustedInitExited: z.literal(true) }).strict()]), running: z.literal(false),
    exitCode: z.number().int().min(0).max(255), containerState: z.enum(["exited", "removed"]), method: z.literal("trusted_swarm_service_lifecycle") }).strict()).min(1).max(64),
  topology, noReplay: z.object({ sourcePinned: z.literal(true), durableQueue: z.literal(false), oldCallerAuthorityRevoked: z.literal(true), pendingRpcCannotReplay: z.literal(true), newBootCannotReplay: z.literal(true) }).strict(),
  artifactHashes: z.object({ closure: sha, inventory: sha, endpoint: sha, topology: sha, noReplay: sha }).strict(),
}).strict();
/** Physical observations are privileged operator evidence. Hashes bind reviewed bytes, never manufacture process-exit authority. */
export const cliExecutorEvidenceShape = z.object({ version: z.literal(1), kind: z.literal("cli_executor_boundary_exit"), requestId: z.uuid(), owner,
  fromState: z.literal("dispatched"), dispatchAt: at, bindingHash: sha, notBefore: at, evaluatedAt: at, operator: id(120), reference: id(400),
  plan: cliExecutorPlanSchema, receipt: cliExecutorReceiptSchema }).strict();
export type CliExecutorPlan = z.infer<typeof cliExecutorPlanSchema>;
export type CliExecutorReceipt = z.infer<typeof cliExecutorReceiptSchema>;
export const cliExecutorPlanHash = (value: unknown) => providerBoundaryCanonicalHash(cliExecutorPlanSchema.parse(value));
export function validCliExecutorEvidence(e: z.infer<typeof cliExecutorEvidenceShape>): boolean {
  const p = e.plan, r = e.receipt, q = p.request, now = Date.parse(e.evaluatedAt), created = Date.parse(p.createdAt), observed = Date.parse(r.observedAt);
  const tasks = p.candidates.map(c => c.taskId), containers = p.candidates.map(c => c.containerId);
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
    && r.exits.every(x => x.initClosure.kind !== "removed_after_trusted_init_exit" || x.containerState === "removed")
    && (r.wholeService.endpointClosed.kind !== "trusted_forwarder_no_backend" || r.wholeService.endpointClosed.backendServiceId === p.executor.serviceId);
}
export const cliExecutorEvidenceSchema = cliExecutorEvidenceShape.refine(validCliExecutorEvidence, "invalid_cli_executor_boundary");
export const cliExecutorArtifactHashes = (plan: CliExecutorPlan, receipt: CliExecutorReceipt) => [...new Set([...Object.values(plan.artifactHashes), ...Object.values(receipt.artifactHashes)])];
