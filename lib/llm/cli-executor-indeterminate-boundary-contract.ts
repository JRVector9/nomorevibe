import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cliExecutorEvidenceShape, cliExecutorPlanSchema, cliExecutorReceiptSchema } from "./cli-executor-boundary-contract";
import { providerBoundaryCanonicalHash } from "./provider-boundary-contract";

const sha = z.string().regex(/^[a-f0-9]{64}$/), at = cliExecutorPlanSchema.shape.createdAt;
const executor = cliExecutorPlanSchema.shape.executor, topology = cliExecutorPlanSchema.shape.topology;
const candidate = cliExecutorPlanSchema.shape.candidates.element, wholeService = cliExecutorReceiptSchema.shape.wholeService;
export const cliExecutorIndeterminatePlanSchema = cliExecutorPlanSchema.omit({ kind: true, request: true }).extend({
  kind: z.literal("cli_executor_indeterminate_boundary_plan"),
  request: cliExecutorPlanSchema.shape.request.omit({ state: true }).extend({ state: z.literal("indeterminate"), rowHash: sha }).strict(),
}).strict();
const knownExit = cliExecutorReceiptSchema.shape.exits.element.extend({
  originalBefore: z.object({ observedAt: at, identity: candidate, executor, topology,
    taskState: z.literal("running"), running: z.literal(true), hostPid: z.number().int().positive().safe(),
    user: z.literal("worker"), entrypoint: z.tuple([z.literal("/sbin/tini"), z.literal("--")]),
    command: z.tuple([z.literal("node"), z.literal("--import"), z.literal("tsx"), z.literal("scripts/connect-agent.ts")]),
    initOwnsPrivatePidNamespace: z.literal(true), childCannotEscapeNamespace: z.literal(true),
    artifactHash: sha, taskSpecArtifactHash: sha, containerConfigArtifactHash: sha, pidNamespaceArtifactHash: sha }).strict(),
}).strict();
const zero = z.object({ observedAt: at, executor, topology, wholeService,
  control: cliExecutorPlanSchema.shape.control, writer: cliExecutorPlanSchema.shape.writer,
  originalSpecProjectedOnlyReplicasZero: z.literal(true), servicePresent: z.literal(true), daemonReachable: z.literal(true),
  singleNode: z.literal(true), noAlternativeExecutor: z.literal(true), captureArtifactHash: sha, inventoryArtifactHash: sha,
  exits: z.array(knownExit).min(1).max(64),
}).strict();
export const cliExecutorIndeterminateReceiptSchema = cliExecutorReceiptSchema.omit({ kind: true, exits: true }).extend({
  kind: z.literal("cli_executor_indeterminate_boundary_receipt"), exits: z.array(knownExit).min(1).max(64),
  closureBoundary: z.object({ stopAttemptAt: at, stopAttemptArtifactHash: sha, reviewArtifactHash: sha,
    continuousServiceFence: z.literal(true), observations: z.tuple([zero, zero]) }).strict(),
}).strict();
export const cliExecutorIndeterminateEvidenceShape = cliExecutorEvidenceShape.omit({ kind: true, fromState: true, plan: true, receipt: true }).extend({
  kind: z.literal("cli_executor_indeterminate_boundary_exit"), fromState: z.literal("indeterminate"),
  plan: cliExecutorIndeterminatePlanSchema, receipt: cliExecutorIndeterminateReceiptSchema,
}).strict();
export type CliExecutorIndeterminatePlan = z.infer<typeof cliExecutorIndeterminatePlanSchema>;
export type CliExecutorIndeterminateReceipt = z.infer<typeof cliExecutorIndeterminateReceiptSchema>;
export const cliExecutorIndeterminatePlanHash = (value: unknown) => providerBoundaryCanonicalHash(cliExecutorIndeterminatePlanSchema.parse(value));

/** Trusted root lifecycle observations; never a native terminal, known usage or a successful business result. */
export function validCliExecutorIndeterminateEvidence(e: z.infer<typeof cliExecutorIndeterminateEvidenceShape>): boolean {
  const p=e.plan,r=e.receipt,q=p.request,b=r.closureBoundary,[first,last]=b.observations;
  const now=Date.parse(e.evaluatedAt),created=Date.parse(p.createdAt),observed=Date.parse(r.observedAt);
  const tasks=p.candidates.map(c=>c.taskId),containers=p.candidates.map(c=>c.containerId);
  const endpoint=(s:z.infer<typeof wholeService>)=>s.endpointClosed.kind!=="trusted_forwarder_no_backend"||s.endpointClosed.backendServiceId===p.executor.serviceId;
  const exits=(xs:z.infer<typeof knownExit>[])=>xs.length===p.candidates.length&&xs.every((x,i)=>isDeepStrictEqual(x.identity,p.candidates[i])
    && (x.initClosure.kind!=="removed_after_trusted_init_exit"||x.containerState==="removed")
    && isDeepStrictEqual(x.originalBefore.identity,x.identity)&&isDeepStrictEqual(x.originalBefore.executor,p.executor)
    && isDeepStrictEqual(x.originalBefore.topology,p.topology)&&Date.parse(x.originalBefore.observedAt)>=Date.parse(q.dispatchAt)
    && Date.parse(x.originalBefore.observedAt)<=Date.parse(b.stopAttemptAt));
  return e.requestId===q.requestId&&isDeepStrictEqual(e.owner,q.owner)&&e.dispatchAt===q.dispatchAt&&e.bindingHash===q.bindingHash
    && e.reference===p.reviewReference&&e.notBefore===r.observedAt&&r.planHash===cliExecutorIndeterminatePlanHash(p)
    && isDeepStrictEqual(p.executor,r.executor)&&isDeepStrictEqual(p.topology,r.topology)
    && p.executor.baseUrlHash===createHash("sha256").update(p.executor.baseUrl).digest("hex")
    && q.provider===q.transport.provider&&q.model===q.transport.model&&q.chargedTokens===q.totalTokenBound
    && Date.parse(p.interval.beforeNativeAt)<Date.parse(q.dispatchAt)&&created>=Date.parse(q.dispatchAt)&&Date.parse(p.control.updatedAt)<=created
    && now>=observed&&observed>=created&&now-created<=30*60_000&&now-observed<=5*60_000
    && new Set(tasks).size===tasks.length&&new Set(containers).size===containers.length&&tasks.includes(p.interval.singleTaskId)
    && p.candidates.every(c=>c.serviceId===p.executor.serviceId&&c.nodeId===p.executor.nodeId)
    && Date.parse(b.stopAttemptAt)>=Date.parse(q.dispatchAt)&&Date.parse(b.stopAttemptAt)<=Date.parse(first.observedAt)
    && Date.parse(first.observedAt)>=created&&Date.parse(first.observedAt)<Date.parse(last.observedAt)
    && last.observedAt===r.observedAt&&now-Date.parse(first.observedAt)<=5*60_000
    && first.captureArtifactHash!==last.captureArtifactHash&&first.inventoryArtifactHash!==last.inventoryArtifactHash
    && exits(r.exits)&&endpoint(r.wholeService)&&isDeepStrictEqual(r.exits,last.exits)&&isDeepStrictEqual(r.wholeService,last.wholeService)
    && b.observations.every(o=>isDeepStrictEqual(o.executor,p.executor)&&isDeepStrictEqual(o.topology,p.topology)
      && isDeepStrictEqual(o.control,p.control)&&isDeepStrictEqual(o.writer,p.writer)&&endpoint(o.wholeService)
      && exits(o.exits)&&isDeepStrictEqual(o.exits,r.exits));
}
export const cliExecutorIndeterminateEvidenceSchema=cliExecutorIndeterminateEvidenceShape.refine(validCliExecutorIndeterminateEvidence,"invalid_cli_executor_indeterminate_boundary");
export function cliExecutorIndeterminateArtifactHashes(plan:CliExecutorIndeterminatePlan,receipt:CliExecutorIndeterminateReceipt):string[]{
  return [...new Set([...Object.values(plan.artifactHashes),...Object.values(receipt.artifactHashes),receipt.closureBoundary.stopAttemptArtifactHash,
    receipt.closureBoundary.reviewArtifactHash,...receipt.closureBoundary.observations.flatMap(o=>[o.captureArtifactHash,o.inventoryArtifactHash]),
    ...receipt.exits.flatMap(x=>[x.originalBefore.artifactHash,x.originalBefore.taskSpecArtifactHash,x.originalBefore.containerConfigArtifactHash,x.originalBefore.pidNamespaceArtifactHash])])];
}
