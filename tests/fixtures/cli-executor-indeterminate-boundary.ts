import { createHash } from "node:crypto";
import { cliExecutorIndeterminatePlanSchema, cliExecutorIndeterminatePlanHash, cliExecutorIndeterminateReceiptSchema } from "@/lib/llm/cli-executor-indeterminate-boundary-contract";
import { cliExecutorFixture } from "./cli-executor-boundary";

export function cliExecutorIndeterminateFixture(now=Date.now(),candidateId=17){
  const base=cliExecutorFixture(now,candidateId),at=(ago:number)=>new Date(now-ago).toISOString();
  const plan=cliExecutorIndeterminatePlanSchema.parse({...base.plan,kind:"cli_executor_indeterminate_boundary_plan",request:{...base.plan.request,state:"indeterminate",rowHash:"0".repeat(64)}});
  const exits=base.receipt.exits.map(x=>({...x,originalBefore:{observedAt:at(25000),identity:x.identity,executor:plan.executor,topology:plan.topology,
    taskState:"running",running:true,hostPid:1001,user:"worker",entrypoint:["/sbin/tini","--"],command:["node","--import","tsx","scripts/connect-agent.ts"],
    initOwnsPrivatePidNamespace:true,childCannotEscapeNamespace:true,artifactHash:"1".repeat(64),taskSpecArtifactHash:"2".repeat(64),containerConfigArtifactHash:"3".repeat(64),pidNamespaceArtifactHash:"4".repeat(64)}}));
  const zero=(ago:number,hash:string)=>({observedAt:at(ago),executor:plan.executor,topology:plan.topology,wholeService:base.receipt.wholeService,control:plan.control,writer:plan.writer,
    originalSpecProjectedOnlyReplicasZero:true,servicePresent:true,daemonReachable:true,singleNode:true,noAlternativeExecutor:true,captureArtifactHash:hash.repeat(64),inventoryArtifactHash:hash.repeat(64),exits:structuredClone(exits)});
  const receipt=cliExecutorIndeterminateReceiptSchema.parse({...base.receipt,kind:"cli_executor_indeterminate_boundary_receipt",planHash:cliExecutorIndeterminatePlanHash(plan),exits,
    closureBoundary:{stopAttemptAt:at(20000),stopAttemptArtifactHash:"5".repeat(64),reviewArtifactHash:"6".repeat(64),continuousServiceFence:true,observations:[zero(15000,"c"),zero(10000,"d")]}});
  const evidence={version:1 as const,kind:"cli_executor_indeterminate_boundary_exit" as const,requestId:plan.request.requestId,owner:plan.request.owner,fromState:"indeterminate" as const,
    dispatchAt:plan.request.dispatchAt,bindingHash:plan.request.bindingHash,notBefore:receipt.observedAt,evaluatedAt:at(0),operator:"fixture-operator",reference:plan.reviewReference,plan,receipt};
  return {plan,receipt,evidence,binding:base.binding,token:base.token};
}
export function materializeIndeterminateArtifacts(fx:ReturnType<typeof cliExecutorIndeterminateFixture>,write:(hash:string,bytes:Buffer)=>void){
  const seal=(label:string)=>{const bytes=Buffer.from(JSON.stringify({fixtureOnly:true,label}));const hash=createHash("sha256").update(bytes).digest("hex");write(hash,bytes);return hash;};
  for(const key of Object.keys(fx.plan.artifactHashes) as (keyof typeof fx.plan.artifactHashes)[])fx.plan.artifactHashes[key]=seal("plan:"+key);
  for(const key of Object.keys(fx.receipt.artifactHashes) as (keyof typeof fx.receipt.artifactHashes)[])fx.receipt.artifactHashes[key]=seal("receipt:"+key);
  const boundary=fx.receipt.closureBoundary;boundary.stopAttemptArtifactHash=seal("stop");boundary.reviewArtifactHash=seal("review");
  for(const [i,x] of fx.receipt.exits.entries())for(const key of ["artifactHash","taskSpecArtifactHash","containerConfigArtifactHash","pidNamespaceArtifactHash"] as const)x.originalBefore[key]=seal(`before:${i}:${key}`);
  for(const [i,o] of boundary.observations.entries()){o.captureArtifactHash=seal(`capture:${i}`);o.inventoryArtifactHash=seal(`inventory:${i}`);o.exits=structuredClone(fx.receipt.exits);}
  fx.receipt.planHash=cliExecutorIndeterminatePlanHash(fx.plan);
}
