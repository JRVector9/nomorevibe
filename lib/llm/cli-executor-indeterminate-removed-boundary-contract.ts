import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cliExecutorEvidenceShape, cliExecutorPlanSchema, cliExecutorReceiptSchema } from "./cli-executor-boundary-contract";
import { cliExecutorIndeterminatePlanSchema, cliExecutorIndeterminatePlanHash, cliExecutorIndeterminateReceiptSchema } from "./cli-executor-indeterminate-boundary-contract";

export const cliExecutorIndeterminateRemovedPlanSchema=cliExecutorIndeterminatePlanSchema;
export const cliExecutorIndeterminateRemovedPlanHash=cliExecutorIndeterminatePlanHash;
const sha=z.string().regex(/^[a-f0-9]{64}$/),at=cliExecutorPlanSchema.shape.createdAt;
const executor=cliExecutorPlanSchema.shape.executor,topology=cliExecutorPlanSchema.shape.topology,candidate=cliExecutorPlanSchema.shape.candidates.element;
const wholeService=cliExecutorReceiptSchema.shape.wholeService,exitCode=z.number().int().min(0).max(255);
const removedExit=z.object({identity:candidate,taskState:z.literal("removed"),containerState:z.literal("removed"),running:z.literal(false),exitCode,
  method:z.literal("trusted_docker_die_removed_executor"),originalBefore:cliExecutorIndeterminateReceiptSchema.shape.exits.element.shape.originalBefore,
  dockerDie:z.object({source:z.literal("docker_engine_events"),type:z.literal("container"),action:z.literal("die"),containerId:sha,
    taskId:candidate.shape.taskId,serviceId:executor.shape.serviceId,nodeId:executor.shape.nodeId,daemonId:executor.shape.daemonId,daemonBootId:executor.shape.daemonBootId,
    timeNano:z.string().regex(/^[1-9][0-9]{18,19}$/),occurredAt:at,exitCode,artifactHash:sha}).strict(),
}).strict();
const missing=z.object({observedAt:at,result:z.literal("no_such_object"),exitCode:z.literal(1),artifactHash:sha}).strict();
const zero=z.object({observedAt:at,executor,topology,wholeService,control:cliExecutorPlanSchema.shape.control,writer:cliExecutorPlanSchema.shape.writer,
  originalSpecProjectedOnlyReplicasZero:z.literal(true),servicePresent:z.literal(true),daemonReachable:z.literal(true),singleNode:z.literal(true),noAlternativeExecutor:z.literal(true),
  captureArtifactHash:sha,inventoryArtifactHash:sha,exits:z.array(removedExit).min(1).max(64),
  missing:z.array(z.object({identity:candidate,task:missing,container:missing}).strict()).min(1).max(64),
}).strict();
export const cliExecutorIndeterminateRemovedReceiptSchema=cliExecutorReceiptSchema.omit({kind:true,exits:true}).extend({
  kind:z.literal("cli_executor_indeterminate_removed_boundary_receipt"),exits:z.array(removedExit).min(1).max(64),
  closureBoundary:z.object({stopAttemptAt:at,stopAttemptArtifactHash:sha,reviewArtifactHash:sha,continuousServiceFence:z.literal(true),observations:z.tuple([zero,zero])}).strict(),
}).strict();
export const cliExecutorIndeterminateRemovedEvidenceShape=cliExecutorEvidenceShape.omit({kind:true,fromState:true,plan:true,receipt:true}).extend({
  kind:z.literal("cli_executor_indeterminate_removed_boundary_exit"),fromState:z.literal("indeterminate"),
  plan:cliExecutorIndeterminateRemovedPlanSchema,receipt:cliExecutorIndeterminateRemovedReceiptSchema,
}).strict();
export type CliExecutorIndeterminateRemovedPlan=z.infer<typeof cliExecutorIndeterminateRemovedPlanSchema>;
export type CliExecutorIndeterminateRemovedReceipt=z.infer<typeof cliExecutorIndeterminateRemovedReceiptSchema>;
/** Exact known Docker init death plus removed objects. Swarm terminal state, native terminal and usage are never invented. */
export function validCliExecutorIndeterminateRemovedEvidence(e:z.infer<typeof cliExecutorIndeterminateRemovedEvidenceShape>):boolean{
  const p=e.plan,r=e.receipt,q=p.request,b=r.closureBoundary,[first,last]=b.observations;
  const now=Date.parse(e.evaluatedAt),created=Date.parse(p.createdAt),observed=Date.parse(r.observedAt),tasks=p.candidates.map(c=>c.taskId),cids=p.candidates.map(c=>c.containerId);
  const endpoint=(s:z.infer<typeof wholeService>)=>s.endpointClosed.kind!=="trusted_forwarder_no_backend"||s.endpointClosed.backendServiceId===p.executor.serviceId;
  return e.requestId===q.requestId&&isDeepStrictEqual(e.owner,q.owner)&&e.dispatchAt===q.dispatchAt&&e.bindingHash===q.bindingHash
    && e.reference===p.reviewReference&&e.notBefore===r.observedAt&&r.planHash===cliExecutorIndeterminateRemovedPlanHash(p)
    && isDeepStrictEqual(p.executor,r.executor)&&isDeepStrictEqual(p.topology,r.topology)
    && p.executor.baseUrlHash===createHash("sha256").update(p.executor.baseUrl).digest("hex")
    && q.provider===q.transport.provider&&q.model===q.transport.model&&q.chargedTokens===q.totalTokenBound
    && Date.parse(p.interval.beforeNativeAt)<Date.parse(q.dispatchAt)&&created>=Date.parse(q.dispatchAt)&&Date.parse(p.control.updatedAt)<=created
    && now>=observed&&observed>=created&&now-created<=30*60_000&&now-observed<=5*60_000
    && new Set(tasks).size===tasks.length&&new Set(cids).size===cids.length&&tasks.includes(p.interval.singleTaskId)
    && p.candidates.every(c=>c.serviceId===p.executor.serviceId&&c.nodeId===p.executor.nodeId)
    && r.exits.length===p.candidates.length&&r.exits.every((x,i)=>isDeepStrictEqual(x.identity,p.candidates[i])
      && isDeepStrictEqual(x.originalBefore.identity,x.identity)&&isDeepStrictEqual(x.originalBefore.executor,p.executor)&&isDeepStrictEqual(x.originalBefore.topology,p.topology)
      && Date.parse(x.originalBefore.observedAt)>=Date.parse(q.dispatchAt)&&Date.parse(x.originalBefore.observedAt)<=Date.parse(b.stopAttemptAt)
      && x.dockerDie.containerId===x.identity.containerId&&x.dockerDie.taskId===x.identity.taskId&&x.dockerDie.serviceId===x.identity.serviceId&&x.dockerDie.nodeId===x.identity.nodeId
      && x.dockerDie.daemonId===p.executor.daemonId&&x.dockerDie.daemonBootId===p.executor.daemonBootId&&x.dockerDie.exitCode===x.exitCode
      && Number(BigInt(x.dockerDie.timeNano)/BigInt(1_000_000))===Date.parse(x.dockerDie.occurredAt)
      && Date.parse(x.dockerDie.occurredAt)>=Date.parse(b.stopAttemptAt)&&Date.parse(x.dockerDie.occurredAt)<=Date.parse(first.observedAt))
    && Date.parse(b.stopAttemptAt)>=Date.parse(q.dispatchAt)&&Date.parse(b.stopAttemptAt)<=Date.parse(first.observedAt)
    && Date.parse(first.observedAt)>=created&&Date.parse(first.observedAt)<Date.parse(last.observedAt)&&last.observedAt===r.observedAt
    && now-Date.parse(first.observedAt)<=5*60_000&&first.captureArtifactHash!==last.captureArtifactHash&&first.inventoryArtifactHash!==last.inventoryArtifactHash
    && isDeepStrictEqual(last.exits,r.exits)&&isDeepStrictEqual(last.wholeService,r.wholeService)&&endpoint(r.wholeService)
    && b.observations.every(o=>isDeepStrictEqual(o.executor,p.executor)&&isDeepStrictEqual(o.topology,p.topology)&&isDeepStrictEqual(o.control,p.control)&&isDeepStrictEqual(o.writer,p.writer)
      && isDeepStrictEqual(o.exits,r.exits)&&endpoint(o.wholeService)&&o.missing.length===p.candidates.length
      && o.missing.every((m,i)=>isDeepStrictEqual(m.identity,p.candidates[i])&&m.task.observedAt===o.observedAt&&m.container.observedAt===o.observedAt))
    && first.missing.every((m,i)=>m.task.artifactHash!==last.missing[i].task.artifactHash&&m.container.artifactHash!==last.missing[i].container.artifactHash);
}
export const cliExecutorIndeterminateRemovedEvidenceSchema=cliExecutorIndeterminateRemovedEvidenceShape.refine(validCliExecutorIndeterminateRemovedEvidence,"invalid_cli_executor_indeterminate_removed_boundary");
export function cliExecutorIndeterminateRemovedArtifactHashes(plan:CliExecutorIndeterminateRemovedPlan,receipt:CliExecutorIndeterminateRemovedReceipt):string[]{
  return [...new Set([...Object.values(plan.artifactHashes),...Object.values(receipt.artifactHashes),receipt.closureBoundary.stopAttemptArtifactHash,receipt.closureBoundary.reviewArtifactHash,
    ...receipt.closureBoundary.observations.flatMap(o=>[o.captureArtifactHash,o.inventoryArtifactHash,...o.missing.flatMap(m=>[m.task.artifactHash,m.container.artifactHash])]),
    ...receipt.exits.flatMap(x=>[x.originalBefore.artifactHash,x.originalBefore.taskSpecArtifactHash,x.originalBefore.containerConfigArtifactHash,x.originalBefore.pidNamespaceArtifactHash,x.dockerDie.artifactHash])])];
}
