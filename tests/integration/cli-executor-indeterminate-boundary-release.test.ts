import { createHash,randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll,beforeAll,expect,it } from "vitest";
import * as schema from "@/lib/db/schema";
import { gatewayNotStartedAllKindsTerminalSql } from "@/lib/db/operations-schema";
import { operatorReviewDispatchSql, operatorReviewEventSql, operatorReviewTerminalSql } from "@/lib/llm/operator-review-sql";
import { localModelSplitJobsDispatchSql, localModelSplitJobsTerminalSql } from "@/lib/llm/local-model-capacity-sql";
import { gatewayLocalDirectDispatchSql, gatewayLocalDirectLogicalSql, gatewayLocalDirectMembersSql, gatewayLocalDirectTerminalSql } from "@/lib/llm/gateway-local-direct-sql";
import { publicationClassifyReleaseLogicalSql, releaseKindsDispatchSql } from "@/lib/llm/dispatch-release-kinds-sql";
import { modelCapacityPolicyHash,publicationClassifyMemberKeys,type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { providerBoundaryCanonicalHash } from "@/lib/llm/provider-boundary-contract";
import { cliExecutorIndeterminatePlanHash } from "@/lib/llm/cli-executor-indeterminate-boundary-contract";
import { releaseCliExecutorIndeterminateBoundaryRequest } from "@/lib/operations/dr/cli-executor-indeterminate-boundary-release";
import { cliExecutorIndeterminateFixture,materializeIndeterminateArtifacts } from "../fixtures/cli-executor-indeterminate-boundary";
import { TEST_DATABASE_URL } from "./setup";

const root=fileURLToPath(new URL("../..",import.meta.url)),name=`nomorevibe_test_cli_unknown_${randomUUID().replaceAll("-","")}`;
const url=new URL(TEST_DATABASE_URL);url.pathname=`/${name}`;
const admin=postgres(TEST_DATABASE_URL,{max:1,onnotice:()=>{}}),client=postgres(url.toString(),{max:4,prepare:false,onnotice:()=>{}});
const fx=cliExecutorIndeterminateFixture(),{binding,token}=fx,id=fx.plan.request.requestId,owner=fx.plan.request.owner;
const journal=JSON.parse(readFileSync(path.join(root,"drizzle/meta/_journal.json"),"utf8"));
const checks=["model_capacity_requests_logical_check","model_capacity_requests_members_check","model_capacity_requests_dispatch_check","model_capacity_requests_terminal_check","model_capacity_events_kind_check"];
const policy:ModelCapacityPolicy={version:1,globalLimit:3,providerLimits:{"fixture-cli":3},groupLimits:{"fixture-cli-group":3},poolLimits:{reviewer:2,text:1},weights:{first:4,second:2,background:1},maxWaiting:20,queueTtlMs:120000,reservationTtlMs:30000,
  routes:[{routeId:"crawl-publish-classify",provider:binding.provider,model:binding.model,providerBudgetId:"fixture-cli",groupId:"fixture-cli-group"}]};
let created=false,beforeRows:Awaited<ReturnType<typeof rows>>,beforeChecks:Record<string,string>;
const proofDir=mkdtempSync(path.join(tmpdir(),"cli-unknown-proof-"));chmodSync(proofDir,0o700);
function rows(){return client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`;}
async function counts(){return {events:Number((await client`SELECT count(*) n FROM model_capacity_events`)[0].n),audit:Number((await client`SELECT count(*) n FROM operations_audit`)[0].n),groups:Number((await client`SELECT count(*) n FROM dr_process_group_events`)[0].n)};}
async function defs(){return Object.fromEntries((await client<{conname:string;definition:string}[]>`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid IN ('model_capacity_requests'::regclass,'model_capacity_events'::regclass) AND conname=ANY(${checks}::text[])`).map(x=>[x.conname,x.definition]));}
function input(){const plan=structuredClone(fx.plan),receipt=structuredClone(fx.receipt);receipt.planHash=cliExecutorIndeterminatePlanHash(plan);return {plan,receipt,expectedPlanHash:receipt.planHash,operator:"fixture-operator",reference:plan.reviewReference};}
function cli(apply:boolean){
  const p=JSON.stringify(fx.plan),r=JSON.stringify(fx.receipt),sha=(v:string)=>createHash("sha256").update(v).digest("hex");
  writeFileSync(path.join(proofDir,"plan.json"),p,{mode:0o600});writeFileSync(path.join(proofDir,"receipt.json"),r,{mode:0o600});
  return JSON.parse(execFileSync(process.execPath,["--import","tsx",path.join(root,"scripts/ops/model-cli-executor-indeterminate-boundary-release.ts"),`--plan=${path.join(proofDir,"plan.json")}`,`--plan-sha=${sha(p)}`,`--receipt=${path.join(proofDir,"receipt.json")}`,`--receipt-sha=${sha(r)}`,`--artifact-dir=${proofDir}`,"--operator=fixture-operator",`--reference=${fx.plan.reviewReference}`,"--database-url-stdin",...(apply?["--apply"]:[])],{cwd:root,input:url.toString(),encoding:"utf8",timeout:15000}));
}
beforeAll(async()=>{
  await admin.unsafe(`CREATE DATABASE ${name}`);created=true;const partial=mkdtempSync(path.join(tmpdir(),"cli-unknown-pre136-"));
  try{mkdirSync(path.join(partial,"meta"));const entries=journal.entries.filter((e:{idx:number})=>e.idx<136);for(const e of entries)copyFileSync(path.join(root,"drizzle",`${e.tag}.sql`),path.join(partial,`${e.tag}.sql`));writeFileSync(path.join(partial,"meta/_journal.json"),JSON.stringify({...journal,entries}));await migrate(drizzle(client),{migrationsFolder:partial});}finally{rmSync(partial,{recursive:true,force:true});}
  const hash=modelCapacityPolicyHash(policy);fx.plan.request.policyHash=hash;fx.plan.control.policyHash=hash;
  const [f]=await client`SELECT lineage_id::text,writer_epoch::int FROM dr_writer_fence WHERE id=1`;fx.plan.writer={lineageId:f.lineage_id,writerEpoch:f.writer_epoch};
  materializeIndeterminateArtifacts(fx,(h,b)=>writeFileSync(path.join(proofDir,`${h}.json`),b,{mode:0o600}));
  for(const o of fx.receipt.closureBoundary.observations){o.writer=structuredClone(fx.plan.writer);o.control=structuredClone(fx.plan.control);for(const x of o.exits){x.originalBefore.executor=structuredClone(fx.plan.executor);}}
  fx.receipt.planHash=cliExecutorIndeterminatePlanHash(fx.plan);
  await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=3,policy=${JSON.stringify(policy)}::jsonb,policy_hash=${hash},updated_at=${fx.plan.control.updatedAt} WHERE id=1`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,logical_member_keys,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${id},${binding.logicalWorkKey+":"+binding.inputHash},${owner.instanceId},${owner.bootId},'background','reviewer','crawl-publish-classify',${binding.provider},${binding.model},'fixture-cli','fixture-cli-group',1,3,${hash},'indeterminate',${binding.logicalWorkKey},${publicationClassifyMemberKeys(binding.members)}::text[],${JSON.stringify(binding)}::jsonb,${fx.plan.request.bindingHash},${fx.plan.request.dispatchAt},${token},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 minute')`;
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,queue_until)
    VALUES(${randomUUID()},'unrelated-waiting',${owner.instanceId},${owner.bootId},'background','reviewer','crawl-publish-classify',${binding.provider},${binding.model},'fixture-cli','fixture-cli-group',1,3,${hash},'waiting',clock_timestamp()+interval '1 minute')`;
  const [request]=await client`SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') hash FROM model_capacity_requests r WHERE request_id=${id}`;
  fx.plan.request.rowHash=request.hash;fx.receipt.planHash=cliExecutorIndeterminatePlanHash(fx.plan);
  beforeRows=await rows();beforeChecks=await defs();
  const e={...fx.evidence,evaluatedAt:new Date().toISOString()};
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(e)} WHERE request_id=${id}`).rejects.toThrow();
  expect(await rows()).toEqual(beforeRows);await migrate(drizzle(client),{migrationsFolder:path.join(root,"drizzle")});
  const g=globalThis as {db?:unknown;pgClient?:unknown};g.db=drizzle(client,{schema});g.pgClient=client;
},120000);
afterAll(async()=>{await client.end({timeout:5});if(created)await admin.unsafe(`DROP DATABASE ${name}`);await admin.end({timeout:5});rmSync(proofDir,{recursive:true,force:true});});

it("0136 preserves nonempty old rows and the complete0135 CHECK predecessor",async()=>{
  expect(await rows()).toEqual(beforeRows);const after=await defs();
  for(const n of checks){const table=n===checks[4]?"model_capacity_events":"model_capacity_requests",fn=n===checks[4]?"event":"request";
    // 0149 appends the all-kinds gateway_not_started branch to the requests terminal CHECK only (the schema constant, not pasted SQL).
    let predicate=`((((${beforeChecks[n].slice(6)}) OR nmv_cli_executor_indeterminate_${fn}_valid(to_jsonb(${table}))) OR nmv_cli_executor_indeterminate_removed_${fn}_valid(to_jsonb(${table}))) OR nmv_replaced_provider_${fn}_valid(to_jsonb(${table}))) OR nmv_replaced_path_${fn}_valid(to_jsonb(${table}))`;
    if(n===checks[3])predicate=`(${predicate}) OR (${gatewayNotStartedAllKindsTerminalSql})`;
    // 0151 appends the operator_review branch (one SQL function shared by the three CHECKs) after everything above.
    if(n===checks[2])predicate=`(${predicate}) OR (${operatorReviewDispatchSql})`;
    if(n===checks[3])predicate=`(${predicate}) OR (${operatorReviewTerminalSql})`;
    if(n===checks[4])predicate=`(${predicate}) OR (${operatorReviewEventSql})`;
    // 0155(2026-10-31, PR 3a-C) appends the split-jobs local_model_direct branch (new per-stage binding.job names; the schema constant, not pasted SQL)
    // to the requests dispatch/terminal CHECKs after everything above — the 0124 branch with the old composite names stays inside the predecessor.
    if(n===checks[2])predicate=`(${predicate}) OR (coalesce((${localModelSplitJobsDispatchSql}),false))`;
    if(n===checks[3])predicate=`(${predicate}) OR (coalesce((${localModelSplitJobsTerminalSql}),false))`;
    // 0157 (PR 3b-C) then rebuilds the four requests CHECKs from their live 0156 definition (0155 included) plus the AI1/text local-direct
    // branches (the schema constants). Like the migration, take PostgreSQL's own deparse of the predecessor as the left side — a second parse
    // flattens 0155's nested BETWEEN-ANDs, so the source chain parsed once would not be the live 0157 text.
    const localDirect:Record<string,string>={[checks[0]]:gatewayLocalDirectLogicalSql,[checks[1]]:gatewayLocalDirectMembersSql,[checks[2]]:gatewayLocalDirectDispatchSql,[checks[3]]:gatewayLocalDirectTerminalSql};
    if(localDirect[n]){
      await client.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT unknown_expected_0156 CHECK (${predicate})`);
      try{predicate=`(${(await client`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='unknown_expected_0156'`)[0].definition.slice(6)}) OR (${localDirect[n]})`;}
      finally{await client.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT unknown_expected_0156`);}
    }
    // 0158 (2026-10-31) appends the process_group_exit/dr_call_drain release branch for publication_classify_cli·local_model_direct to the requests
    // logical/members/dispatch CHECKs (the schema constants), again on PostgreSQL's own deparse of the live 0157 predecessor.
    const releaseKinds:Record<string,string>={[checks[0]]:publicationClassifyReleaseLogicalSql,[checks[1]]:publicationClassifyReleaseLogicalSql,[checks[2]]:releaseKindsDispatchSql};
    if(releaseKinds[n]){
      await client.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT unknown_expected_0157 CHECK (${predicate})`);
      try{predicate=`(${(await client`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='unknown_expected_0157'`)[0].definition.slice(6)}) OR (${releaseKinds[n]})`;}
      finally{await client.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT unknown_expected_0157`);}
    }
    await client.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT unknown_expected CHECK (${predicate})`);
    try{expect(after[n]).toBe((await client`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='unknown_expected'`)[0].definition);}finally{await client.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT unknown_expected`);}}
  expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(journal.entries.length);
});
it("rejects wrong state/token/full binding/control/writer/C and rolls back every row/event/audit",async()=>{
  const initial=await counts();
  for(const mutate of [
    (x:ReturnType<typeof input>)=>{Object.assign(x.plan.request,{state:"dispatched"});},
    (x:ReturnType<typeof input>)=>{x.plan.request.tokenHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.rowHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.transport.argvHash="0".repeat(64);},
    (x:ReturnType<typeof input>)=>{x.plan.request.totalTokenBound++;x.plan.request.chargedTokens++;},
    (x:ReturnType<typeof input>)=>{x.plan.control.revision++;},
    (x:ReturnType<typeof input>)=>{x.plan.writer.writerEpoch++;},
    (x:ReturnType<typeof input>)=>{Object.assign(x.receipt.exits[0],{exitCode:null});},
  ]){const x=input();mutate(x);x.expectedPlanHash=providerBoundaryCanonicalHash(x.plan);x.receipt.planHash=x.expectedPlanHash;await expect(releaseCliExecutorIndeterminateBoundaryRequest(x,true)).rejects.toThrow();expect(await rows()).toEqual(beforeRows);expect(await counts()).toEqual(initial);}
  await client`UPDATE model_capacity_requests SET state='dispatched' WHERE request_id=${id}`;await expect(releaseCliExecutorIndeterminateBoundaryRequest(input(),true)).rejects.toThrow();await client`UPDATE model_capacity_requests SET state='indeterminate' WHERE request_id=${id}`;
  await client`UPDATE model_capacity_control SET mode='open' WHERE id=1`;await expect(releaseCliExecutorIndeterminateBoundaryRequest(input(),true)).rejects.toThrow();await client`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
  expect(await rows()).toEqual(beforeRows);expect(await counts()).toEqual(initial);
});
it("direct SQL cannot insert/fake a release or change C/settled_at/other request fields",async()=>{
  const [clock]=await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`,e={...fx.evidence,evaluatedAt:clock.at};
  expect((await client`SELECT nmv_cli_executor_indeterminate_release_valid(${JSON.stringify(e)}::jsonb) ok`)[0].ok).toBe(true);
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(e)},token=${randomUUID()} WHERE request_id=${id}`).rejects.toThrow("cli_executor_transition_conflict");
  await expect(client`INSERT INTO model_capacity_requests SELECT (jsonb_populate_record(NULL::model_capacity_requests,to_jsonb(r)||jsonb_build_object('request_id',${randomUUID()}::text,'queue_ordinal',999999,'work_key','fake','state','withdrawn','terminal_evidence',${JSON.stringify(e)}::jsonb,'terminal_evidence_hash',${providerBoundaryCanonicalHash(e)}::text))).* FROM model_capacity_requests r WHERE request_id=${id}`).rejects.toThrow("cli_executor_transition_invalid");
  expect(await rows()).toEqual(beforeRows);
});
it("canonical dryrun rolls back; real CLI withdraws only exact unknown once and preserves all charge/unknown usage",async()=>{
  const initial=await counts();expect((await releaseCliExecutorIndeterminateBoundaryRequest(input(),false)).kind).toBe("released");expect(await rows()).toEqual(beforeRows);expect(await counts()).toEqual(initial);
  expect(cli(false).dryRun).toBe(true);expect(await rows()).toEqual(beforeRows);expect(await counts()).toEqual(initial);
  const result=cli(true);expect(result.dryRun).toBe(false);expect(result.result.kind).toBe("released");
  const after=await rows();for(let i=0;i<after.length;i++){const old=beforeRows[i].value,now=after[i].value;if(old.request_id!==id){expect(now).toEqual(old);continue;}
    for(const k of Object.keys(old))if(!["state","terminal_evidence","terminal_evidence_hash","updated_at"].includes(k))expect(now[k],k).toEqual(old[k]);expect(now.state).toBe("withdrawn");expect(now.settled_at).toBeNull();expect(now.terminal_evidence.kind).toBe("cli_executor_indeterminate_boundary_exit");}
  expect(await counts()).toEqual({...initial,events:initial.events+1,audit:initial.audit+1});
  expect((await client`SELECT kind,from_state,to_state,reason FROM model_capacity_events WHERE request_id=${id}`)[0]).toEqual({kind:"dispatch_released",from_state:"indeterminate",to_state:"withdrawn",reason:null});
  expect((await releaseCliExecutorIndeterminateBoundaryRequest(input(),true)).kind).toBe("already_released");expect(await counts()).toEqual({...initial,events:initial.events+1,audit:initial.audit+1});
  await expect(client`UPDATE model_capacity_requests SET updated_at=clock_timestamp() WHERE request_id=${id}`).rejects.toThrow("cli_executor_terminal_immutable");
});
