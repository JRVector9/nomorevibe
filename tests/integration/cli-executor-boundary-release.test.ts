import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, publicationClassifyMemberKeys, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { cliExecutorPlanHash } from "@/lib/llm/cli-executor-boundary-contract";
import { providerBoundaryCanonicalHash } from "@/lib/llm/provider-boundary-contract";
import { releaseCliExecutorBoundaryRequest } from "@/lib/operations/dr/cli-executor-boundary-release";
import { cliExecutorFixture } from "../fixtures/cli-executor-boundary";
import { TEST_DATABASE_URL } from "./setup";

const root = fileURLToPath(new URL("../..",import.meta.url)), name = `nomorevibe_test_cli_boundary_${randomUUID().replaceAll("-","")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname=`/${name}`;
const admin=postgres(TEST_DATABASE_URL,{max:1,onnotice:()=>{}}), client=postgres(url.toString(),{max:4,prepare:false,onnotice:()=>{}});
const journal=JSON.parse(readFileSync(path.join(root,"drizzle/meta/_journal.json"),"utf8"));
const names=["model_capacity_requests_logical_check","model_capacity_requests_members_check","model_capacity_requests_dispatch_check","model_capacity_requests_terminal_check","model_capacity_events_kind_check"];
const fx=cliExecutorFixture(), {binding,token}=fx, requestId=fx.plan.request.requestId, owner=fx.plan.request.owner;
const policy: ModelCapacityPolicy={version:1,globalLimit:3,providerLimits:{"fixture-cli":3},groupLimits:{"fixture-cli-group":3},
  poolLimits:{reviewer:2,text:1},weights:{first:4,second:2,background:1},maxWaiting:20,queueTtlMs:120000,reservationTtlMs:30000,
  routes:[{routeId:"crawl-publish-classify",provider:binding.provider,model:binding.model,providerBudgetId:"fixture-cli",groupId:"fixture-cli-group"}]};
let created=false, beforeRows: unknown, prior: Record<string,string>;
const proofDir=mkdtempSync(path.join(tmpdir(),"cli-executor-pg-files-"));chmodSync(proofDir,0o700);
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
function cli(apply:boolean){
  const p=JSON.stringify(fx.plan),r=JSON.stringify(fx.receipt);
  writeFileSync(path.join(proofDir,"plan.json"),p,{mode:0o600});writeFileSync(path.join(proofDir,"receipt.json"),r,{mode:0o600});
  const args=["--import","tsx",path.join(root,"scripts/ops/model-cli-executor-boundary-release.ts"),
    `--plan=${path.join(proofDir,"plan.json")}`,`--plan-sha=${sha(p)}`,`--receipt=${path.join(proofDir,"receipt.json")}`,`--receipt-sha=${sha(r)}`,
    `--artifact-dir=${proofDir}`,"--operator=fixture-operator",`--reference=${fx.plan.reviewReference}`,"--database-url-stdin",...(apply?["--apply"]:[])];
  return JSON.parse(execFileSync(process.execPath,args,{cwd:root,env:{...process.env},input:url.toString(),encoding:"utf8",timeout:15000}).trim());
}
const rows=()=>client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`;
const counts=async()=>({events:Number((await client`SELECT count(*) n FROM model_capacity_events`)[0].n),audit:Number((await client`SELECT count(*) n FROM operations_audit`)[0].n),groups:Number((await client`SELECT count(*) n FROM dr_process_group_events`)[0].n)});
const defs=async()=>Object.fromEntries((await client<{conname:string;def:string}[]>`SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname=ANY(${names}::text[])`).map(x=>[x.conname,x.def]));
function input() { const plan=structuredClone(fx.plan),receipt=structuredClone(fx.receipt);receipt.planHash=cliExecutorPlanHash(plan);return {plan,receipt,expectedPlanHash:receipt.planHash,operator:"fixture-operator",reference:plan.reviewReference}; }
async function evidence() { const [clock]=await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`;return {...fx.evidence,plan:fx.plan,receipt:fx.receipt,evaluatedAt:clock.at}; }
beforeAll(async()=>{
  await admin.unsafe(`CREATE DATABASE ${name}`);created=true;
  const partial=mkdtempSync(path.join(tmpdir(),"cli-boundary-predecessor-"));
  try {
    mkdirSync(path.join(partial,"meta"));const entries=journal.entries.filter((e:{idx:number})=>e.idx<134);
    for(const e of entries)copyFileSync(path.join(root,"drizzle",`${e.tag}.sql`),path.join(partial,`${e.tag}.sql`));
    writeFileSync(path.join(partial,"meta/_journal.json"),JSON.stringify({...journal,entries}));
    await migrate(drizzle(client),{migrationsFolder:partial});
  }finally{rmSync(partial,{recursive:true,force:true});}
  fx.plan.request.policyHash=modelCapacityPolicyHash(policy);fx.plan.control.policyHash=fx.plan.request.policyHash;
  let ordinal=0;
  for(const layer of [fx.plan.artifactHashes,fx.receipt.artifactHashes])for(const key of Object.keys(layer)){
    const bytes=JSON.stringify({fixture:true,ordinal:ordinal++}),hash=sha(bytes);Object.assign(layer,{[key]:hash});writeFileSync(path.join(proofDir,`${hash}.json`),bytes,{mode:0o600});
  }
  const [f]=await client`SELECT lineage_id::text,writer_epoch::int FROM dr_writer_fence WHERE id=1`;
  fx.plan.writer={lineageId:f.lineage_id,writerEpoch:f.writer_epoch};fx.receipt.planHash=cliExecutorPlanHash(fx.plan);
  await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=3,policy=${JSON.stringify(policy)}::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},updated_at=${fx.plan.control.updatedAt} WHERE id=1`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,logical_member_keys,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${requestId},${binding.logicalWorkKey+":"+binding.inputHash},${owner.instanceId},${owner.bootId},'background','reviewer','crawl-publish-classify',${binding.provider},${binding.model},'fixture-cli','fixture-cli-group',1,3,${modelCapacityPolicyHash(policy)},'dispatched',${binding.logicalWorkKey},${publicationClassifyMemberKeys(binding.members)}::text[],${JSON.stringify(binding)}::jsonb,${fx.plan.request.bindingHash},${fx.plan.request.dispatchAt},${token},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 minute')`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,queue_until)
    VALUES(${randomUUID()},'unrelated-waiting',${owner.instanceId},${owner.bootId},'background','reviewer','crawl-publish-classify',${binding.provider},${binding.model},'fixture-cli','fixture-cli-group',1,3,${modelCapacityPolicyHash(policy)},'waiting',clock_timestamp()+interval '1 minute')`;
  const other=cliExecutorFixture(Date.now(),18),ob=other.binding;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,logical_member_keys,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${other.plan.request.requestId},${ob.logicalWorkKey+":"+ob.inputHash},${ob.publisherRole.instanceId},${ob.publisherRole.bootId},'background','reviewer','crawl-publish-classify',${ob.provider},${ob.model},'fixture-cli','fixture-cli-group',1,3,${modelCapacityPolicyHash(policy)},'indeterminate',${ob.logicalWorkKey},${publicationClassifyMemberKeys(ob.members)}::text[],${JSON.stringify(ob)}::jsonb,${other.plan.request.bindingHash},${other.plan.request.dispatchAt},${other.token},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 minute')`;
  beforeRows=await rows();prior=await defs();
  const e=await evidence();
  // Actual old-schema RED: a complete new-kind proof cannot release anything before0134.
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(e)} WHERE request_id=${requestId}`).rejects.toThrow();
  expect(await rows()).toEqual(beforeRows);
  await migrate(drizzle(client),{migrationsFolder:path.join(root,"drizzle")});
  const g=globalThis as {db?:unknown;pgClient?:unknown};g.db=drizzle(client,{schema});g.pgClient=client;
},120000);
afterAll(async()=>{await client.end({timeout:5});if(created)await admin.unsafe(`DROP DATABASE ${name}`);await admin.end({timeout:5});rmSync(proofDir,{recursive:true,force:true});});

it("migrates nonempty old data without mutation and retains all predecessor predicates",async()=>{
  expect(await rows()).toEqual(beforeRows);
  const after=await defs(),normalize=(s:string)=>s.replace(/::text\[\]|::text|::character varying/g,"").replace(/[()\s]/g,"");
  for(const n of names)expect(normalize(after[n]).startsWith(normalize(prior[n]))).toBe(true);
  expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(135);
});
it("SQL and TS agree on canonical hash, strict proof shape and both trusted closure variants",async()=>{
  const e=await evidence();
  expect((await client`SELECT nmv_cli_executor_release_valid(${JSON.stringify(e)}::jsonb) ok,encode(sha256(convert_to(nmv_boundary_canonical(${JSON.stringify(fx.plan)}::jsonb),'UTF8')),'hex') hash`)[0]).toEqual({ok:true,hash:cliExecutorPlanHash(fx.plan)});
  const forwarder=structuredClone(e);Object.assign(forwarder.receipt.wholeService,{endpointClosed:{kind:"trusted_forwarder_no_backend",forwarderIdentity:"docker-desktop",forwarderHash:"f".repeat(64),backendServiceId:fx.plan.executor.serviceId,backendCount:0,noAlternativeExecutor:true,RPCUnavailable:true}});
  Object.assign(forwarder.receipt.exits[0],{initClosure:{kind:"removed_after_trusted_init_exit",containerRemoved:true,trustedInitExited:true}});
  expect((await client`SELECT nmv_cli_executor_release_valid(${JSON.stringify(forwarder)}::jsonb) ok`)[0].ok).toBe(true);
  for(const layer of [e.plan.interval,e.plan.topology,e.receipt.wholeService,e.receipt.noReplay,e.receipt.exits[0]])for(const key of Object.keys(layer)){
    const bad=JSON.parse(JSON.stringify(e));const target=layer===e.plan.interval?bad.plan.interval:layer===e.plan.topology?bad.plan.topology:layer===e.receipt.wholeService?bad.receipt.wholeService:layer===e.receipt.noReplay?bad.receipt.noReplay:bad.receipt.exits[0];target[key]=null;
    expect((await client`SELECT nmv_cli_executor_release_valid(${JSON.stringify(bad)}::jsonb) ok`)[0].ok,key).toBe(false);
  }
});
it("wrong exact row/control/writer/binding/transport/C proofs rollback every row, event and audit",async()=>{
  const initial=await counts();
  for(const mutate of [
    (x:ReturnType<typeof input>)=>{x.plan.request.tokenHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.bindingHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.epoch++;},
    (x:ReturnType<typeof input>)=>{x.plan.request.policyHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.providerBudgetId="other";},
    (x:ReturnType<typeof input>)=>{x.plan.request.transport.argvHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.totalTokenBound++;x.plan.request.chargedTokens++;},
    (x:ReturnType<typeof input>)=>{x.plan.control.updatedAt=x.plan.control.updatedAt.replace(/\d{6}Z$/,"999999Z");},
    (x:ReturnType<typeof input>)=>{x.plan.writer.writerEpoch++;},
    (x:ReturnType<typeof input>)=>{x.receipt.exits.pop();},
  ]){const x=input();mutate(x);x.expectedPlanHash=cliExecutorPlanHash(x.plan);x.receipt.planHash=x.expectedPlanHash;await expect(releaseCliExecutorBoundaryRequest(x,true)).rejects.toThrow();expect(await rows()).toEqual(beforeRows);expect(await counts()).toEqual(initial);}
  const corrupt=input();corrupt.plan.request.bindingHash="0".repeat(64);corrupt.expectedPlanHash=cliExecutorPlanHash(corrupt.plan);corrupt.receipt.planHash=corrupt.expectedPlanHash;
  await client`UPDATE model_capacity_requests SET dispatch_binding_hash=${corrupt.plan.request.bindingHash} WHERE request_id=${requestId}`;
  await expect(releaseCliExecutorBoundaryRequest(corrupt,true)).rejects.toThrow();
  await client`UPDATE model_capacity_requests SET dispatch_binding_hash=${fx.plan.request.bindingHash} WHERE request_id=${requestId}`;
  await client`UPDATE model_capacity_control SET mode='open' WHERE id=1`;await expect(releaseCliExecutorBoundaryRequest(input(),true)).rejects.toThrow();
  await client`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
  await client`UPDATE dr_writer_fence SET state='fenced',reason='operator_fence',fenced_db='{"systemIdentifier":"1","databaseOid":"1","databaseName":"fixture"}'::jsonb WHERE id=1`;
  await expect(releaseCliExecutorBoundaryRequest(input(),true)).rejects.toThrow("dr_writer_site_fenced");
  await client`UPDATE dr_writer_fence SET state='active',reason=NULL,fenced_db=NULL WHERE id=1`;
  expect(await rows()).toEqual(beforeRows);
});
it("direct SQL refuses fake INSERT, changed immutable row/charge, wrong hash, stale and backdated evidence",async()=>{
  const e=await evidence();
  await expect(client`INSERT INTO model_capacity_requests SELECT (jsonb_populate_record(NULL::model_capacity_requests,to_jsonb(r)||jsonb_build_object('request_id',${randomUUID()}::text,'queue_ordinal',999999,'work_key','fake','state','withdrawn','terminal_evidence',${JSON.stringify(e)}::jsonb,'terminal_evidence_hash',${providerBoundaryCanonicalHash(e)}::text))).* FROM model_capacity_requests r WHERE request_id=${requestId}`).rejects.toThrow("cli_executor_transition_invalid");
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(e)},token=${randomUUID()} WHERE request_id=${requestId}`).rejects.toThrow("cli_executor_transition_conflict");
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::jsonb,terminal_evidence_hash=${"0".repeat(64)} WHERE request_id=${requestId}`).rejects.toThrow();
  const stale=JSON.parse(JSON.stringify(e)),shift=(s:string)=>new Date(Date.parse(s)-10*60_000).toISOString();
  stale.plan.createdAt=shift(stale.plan.createdAt);stale.receipt.observedAt=shift(stale.receipt.observedAt);stale.plan.control.updatedAt=new Date(Date.parse(stale.plan.createdAt)-1000).toISOString().replace("Z","000Z");
  stale.evaluatedAt=shift(stale.evaluatedAt);stale.notBefore=stale.receipt.observedAt;stale.receipt.planHash=cliExecutorPlanHash(stale.plan);
  expect((await client`SELECT nmv_cli_executor_release_valid(${JSON.stringify(stale)}::jsonb) ok`)[0].ok).toBe(true);
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(stale)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(stale)} WHERE request_id=${requestId}`).rejects.toThrow();
  expect(await rows()).toEqual(beforeRows);
});
it("dry-run executes the canonical transition and rolls back; apply releases exact one once with C and unknown usage intact",async()=>{
  const initial=await counts();
  expect((await releaseCliExecutorBoundaryRequest(input(),false)).kind).toBe("released");expect(await rows()).toEqual(beforeRows);expect(await counts()).toEqual(initial);
  const dry=cli(false);expect(dry.dryRun).toBe(true);expect(dry.result.kind).toBe("released");expect(await rows()).toEqual(beforeRows);expect(await counts()).toEqual(initial);
  const applied=cli(true);expect(applied.dryRun).toBe(false);expect(applied.result.kind).toBe("released");expect(applied.result.auditId).toBeGreaterThan(0);
  const after=await rows(),before=beforeRows as typeof after;
  for(let i=0;i<after.length;i++){
    const old=before[i].value,now=after[i].value;
    if(old.request_id!==requestId){expect(now).toEqual(old);continue;}
    for(const k of Object.keys(old))if(!["state","terminal_evidence","terminal_evidence_hash","updated_at"].includes(k))expect(now[k],k).toEqual(old[k]);
    expect(now.state).toBe("withdrawn");expect(now.settled_at).toBe(null);expect(now.dispatch_binding.chargedTokens).toBe(32000);
    expect(now.terminal_evidence.kind).toBe("cli_executor_boundary_exit");
  }
  expect(await counts()).toEqual({...initial,events:initial.events+1,audit:initial.audit+1});
  expect((await client`SELECT kind,from_state,to_state,reason FROM model_capacity_events WHERE request_id=${requestId}`)[0]).toEqual({kind:"dispatch_released",from_state:"dispatched",to_state:"withdrawn",reason:null});
  expect((await releaseCliExecutorBoundaryRequest(input(),true)).kind).toBe("already_released");expect(await counts()).toEqual({...initial,events:initial.events+1,audit:initial.audit+1});
  await expect(client`UPDATE model_capacity_requests SET updated_at=clock_timestamp() WHERE request_id=${requestId}`).rejects.toThrow("cli_executor_terminal_immutable");
});
