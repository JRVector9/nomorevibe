import { createHash } from "node:crypto";
import { cliExecutorIndeterminateRemovedPlanHash,cliExecutorIndeterminateRemovedReceiptSchema } from "@/lib/llm/cli-executor-indeterminate-removed-boundary-contract";
import { cliExecutorIndeterminateFixture } from "./cli-executor-indeterminate-boundary";
export function cliExecutorIndeterminateRemovedFixture(now=Date.now(),candidateId=17){
  const base=cliExecutorIndeterminateFixture(now,candidateId),plan=base.plan,at=(ago:number)=>new Date(now-ago).toISOString();
  const exits=base.receipt.exits.map(x=>({identity:x.identity,taskState:"removed",containerState:"removed",running:false,exitCode:1,method:"trusted_docker_die_removed_executor",originalBefore:x.originalBefore,
    dockerDie:{source:"docker_engine_events",type:"container",action:"die",containerId:x.identity.containerId,taskId:x.identity.taskId,serviceId:x.identity.serviceId,nodeId:x.identity.nodeId,
      daemonId:plan.executor.daemonId,daemonBootId:plan.executor.daemonBootId,timeNano:(BigInt(now-17000)*BigInt(1000000)+BigInt(123456)).toString(),occurredAt:at(17000),exitCode:1,artifactHash:"e".repeat(64)}}));
  const observations=base.receipt.closureBoundary.observations.map((o,i)=>({...o,exits:structuredClone(exits),missing:plan.candidates.map(identity=>({identity,
    task:{observedAt:o.observedAt,result:"no_such_object",exitCode:1,artifactHash:(i?"2":"1").repeat(64)},container:{observedAt:o.observedAt,result:"no_such_object",exitCode:1,artifactHash:(i?"4":"3").repeat(64)}}))}));
  const receipt=cliExecutorIndeterminateRemovedReceiptSchema.parse({...base.receipt,kind:"cli_executor_indeterminate_removed_boundary_receipt",exits,closureBoundary:{...base.receipt.closureBoundary,observations}});
  const evidence={...base.evidence,kind:"cli_executor_indeterminate_removed_boundary_exit" as const,plan,receipt};
  return {plan,receipt,evidence,binding:base.binding,token:base.token};
}
export function materializeIndeterminateRemovedArtifacts(fx:ReturnType<typeof cliExecutorIndeterminateRemovedFixture>,write:(hash:string,bytes:Buffer)=>void){
  const seal=(label:string)=>{const bytes=Buffer.from(JSON.stringify({fixtureOnly:true,label})),hash=createHash("sha256").update(bytes).digest("hex");write(hash,bytes);return hash;};
  for(const key of Object.keys(fx.plan.artifactHashes) as (keyof typeof fx.plan.artifactHashes)[])fx.plan.artifactHashes[key]=seal("plan:"+key);
  for(const key of Object.keys(fx.receipt.artifactHashes) as (keyof typeof fx.receipt.artifactHashes)[])fx.receipt.artifactHashes[key]=seal("receipt:"+key);
  const b=fx.receipt.closureBoundary;b.stopAttemptArtifactHash=seal("stop");b.reviewArtifactHash=seal("review");
  for(const [i,x] of fx.receipt.exits.entries()){for(const key of ["artifactHash","taskSpecArtifactHash","containerConfigArtifactHash","pidNamespaceArtifactHash"] as const)x.originalBefore[key]=seal(`before:${i}:${key}`);x.dockerDie.artifactHash=seal(`die:${i}`);}
  for(const [i,o] of b.observations.entries()){o.captureArtifactHash=seal(`capture:${i}`);o.inventoryArtifactHash=seal(`inventory:${i}`);o.exits=structuredClone(fx.receipt.exits);for(const [j,m] of o.missing.entries()){m.task.artifactHash=seal(`task:${i}:${j}`);m.container.artifactHash=seal(`container:${i}:${j}`);}}
  fx.receipt.planHash=cliExecutorIndeterminateRemovedPlanHash(fx.plan);
}
