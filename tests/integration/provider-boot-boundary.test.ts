import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {afterAll,beforeAll,expect,it} from 'vitest';
import * as schema from '@/lib/db/schema';
import {modelCapacityPolicyHash,type ModelCapacityPolicy,modelDispatchReleaseEvidenceSchema} from '@/lib/llm/capacity';
import {localModelBindingHash,localModelBindingSchema} from '@/lib/llm/local-model-capacity-contract';
import {providerBoundaryCanonicalHash,providerBoundaryPlanHash} from '@/lib/llm/provider-boundary-contract';
import {releaseProviderBoundaryRequest} from '@/lib/operations/dr/provider-boundary-release';
import {bootBoundaryFixture,invalidBootBoundaries} from '../fixtures/provider-boot-boundary';
import {TEST_DATABASE_URL} from './setup';
const root=process.cwd(),name=`nomorevibe_test_boot_${randomUUID().replaceAll('-','')}`,url=new URL(TEST_DATABASE_URL);url.pathname=`/${name}`;
const admin=postgres(TEST_DATABASE_URL,{max:1,onnotice:()=>{}}),client=postgres(url.toString(),{max:3,prepare:false,onnotice:()=>{}});
const journal=JSON.parse(readFileSync(path.join(root,'drizzle/meta/_journal.json'),'utf8'));
const fx=bootBoundaryFixture(),requestId=randomUUID(),token=randomUUID(),hash='a'.repeat(64),owner=fx.plan.request.owner;
const binding=localModelBindingSchema.parse({kind:'local_model_direct',version:1,target:{kind:'assist',purpose:'assist_review',workId:randomUUID(),workRevision:30,
 claimToken:randomUUID(),task:'uptime',subjectId:47220,backendId:'gpu3090-qwen'},logicalWorkKey:'direct:assist:47220:uptime',routeId:'local-assist-uptime-gpu3090-qwen',
 provider:'local-direct',model:fx.plan.servingContract.model,backendId:'gpu3090-qwen',physicalGroup:'gpu3090-qwen',deploymentRevision:fx.plan.servingContract.deploymentRevision,
 inputHash:hash,sourceRevisionHash:hash,reviewPolicyHash:hash,promptVersion:'fixture',wireHash:hash,servingContractHash:fx.plan.request.servingContractHash,
 totalTokenBound:50000,chargedTokens:50000,job:{name:'product-llm-assist-review',token:randomUUID(),requestedVersion:2524}});
const policy:ModelCapacityPolicy={version:1,globalLimit:1,providerLimits:{'gpu3090-qwen':1},groupLimits:{'gpu3090-qwen':1},poolLimits:{reviewer:1,text:1},
 weights:{first:1,second:1,background:1},maxWaiting:10,queueTtlMs:120000,reservationTtlMs:30000,routes:[{routeId:binding.routeId,provider:'local-direct',model:binding.model,providerBudgetId:'gpu3090-qwen',groupId:'gpu3090-qwen'}]};
let frozen:{plan:typeof fx.plan;receipt:typeof fx.receipt},created=false,beforeRows:unknown[],beforeChecks:unknown[];
const input=()=>({...frozen,expectedPlanHash:providerBoundaryPlanHash(frozen.plan),operator:'boot-fixture',reference:'synthetic raw boot boundary fixture'});
async function rows(){return client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`;}
async function checks(){return client`SELECT oid::text,conname,pg_get_constraintdef(oid) definition,convalidated FROM pg_constraint WHERE conrelid IN ('model_capacity_requests'::regclass,'model_capacity_events'::regclass) AND contype='c' ORDER BY conname`;}
async function evidence(plan=frozen.plan,receipt=frozen.receipt){const[clock]=await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`;return{version:1,kind:'provider_boundary_exit',requestId,owner,fromState:'indeterminate',dispatchAt:plan.request.dispatchAt,bindingHash:plan.request.bindingHash,notBefore:receipt.provider.observedAt,evaluatedAt:clock.at,operator:'boot-fixture',reference:'synthetic raw boot boundary fixture',plan,receipt};}
async function physical(value:unknown){return(await client`SELECT nmv_provider_boundary_release_valid(${JSON.stringify(value)}::jsonb) valid`)[0].valid;}
beforeAll(async()=>{
 await admin.unsafe(`CREATE DATABASE ${name}`);created=true;const partial=mkdtempSync(path.join(tmpdir(),'boot-predecessor-'));
 try{mkdirSync(path.join(partial,'meta'));const entries=journal.entries.filter((e:{idx:number})=>e.idx<130);for(const e of entries)copyFileSync(path.join(root,'drizzle',`${e.tag}.sql`),path.join(partial,`${e.tag}.sql`));writeFileSync(path.join(partial,'meta/_journal.json'),JSON.stringify({...journal,entries}));await migrate(drizzle(client),{migrationsFolder:partial});}finally{rmSync(partial,{recursive:true,force:true});}
 const now=Date.now(),iso=(ago:number)=>new Date(now-ago).toISOString(),micro=(ago:number)=>iso(ago).replace('Z','000Z');
 const plan=structuredClone(fx.plan),receipt=structuredClone(fx.receipt);plan.createdAt=iso(30000);plan.control.updatedAt=micro(40000);plan.control.policyHash=modelCapacityPolicyHash(policy);
 Object.assign(plan.request,{requestId,tokenHash:createHash('sha256').update(token).digest('hex'),policyHash:modelCapacityPolicyHash(policy),bindingHash:localModelBindingHash(binding),dispatchAt:iso(3600000)});
 plan.owner.startedAt=iso(7200000);plan.localEnd.endedAt=micro(3590000);plan.provider.oldJournal.firstAt=micro(7200000);plan.provider.oldJournal.lastAt=micro(3580000);plan.provider.currentJournal.firstAt=micro(3539000);
 const wall=iso(3540000);Object.assign(plan.bootWitness,{dbBefore:micro(33000),dbAfter:micro(31000),uptimeNs:'3508000000000',hostBtimeAt:wall});
 receipt.owner.identity=plan.owner;receipt.owner.observedAt=iso(20000);receipt.provider.identity=plan.provider;receipt.provider.observedAt=iso(10000);
 Object.assign(receipt.provider.bootWitness,{dbBefore:micro(12000),dbAfter:micro(10000),uptimeNs:'3529000000000',hostBtimeAt:wall});frozen={plan,receipt};
 await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=2,policy=${JSON.stringify(policy)}::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},updated_at=${plan.control.updatedAt} WHERE id=1`;
 await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until) VALUES(${requestId},${`${binding.logicalWorkKey}:${binding.inputHash}`},${owner.instanceId},${owner.bootId},'background','reviewer',${binding.routeId},'local-direct',${binding.model},'gpu3090-qwen','gpu3090-qwen',1,2,${modelCapacityPolicyHash(policy)},'indeterminate',${binding.logicalWorkKey},${JSON.stringify(binding)}::jsonb,${localModelBindingHash(binding)},${plan.request.dispatchAt},${token},clock_timestamp(),clock_timestamp())`;
 const runId=randomUUID();const group=await client`INSERT INTO dr_process_group_events(owner_instance_id,owner_boot_id,kind,seq,run_id,pid,recorded_at) VALUES (${owner.instanceId},${owner.bootId},'owner_opened',0,NULL,NULL,${iso(7100000)}),(${owner.instanceId},${owner.bootId},'spawn_intent',1,${runId},NULL,${iso(7000000)}),(${owner.instanceId},${owner.bootId},'spawned',1,${runId},279,${iso(6999000)}) RETURNING id,kind`;
 Object.assign(plan.ownerAssociation,{spawnedEventId:Number(group.find(x=>x.kind==='spawned')!.id),runIdHash:createHash('sha256').update(runId).digest('hex')});
 const localEvidence={version:1,kind:'gateway_local_end',requestId,owner,bindingHash:plan.request.bindingHash,dispatches:1,terminals:1};
 const[ended]=await client`INSERT INTO model_capacity_events(request_id,kind,from_state,to_state,epoch,revision,policy_hash,evidence,created_at) VALUES(${requestId},'dispatch_local_ended','indeterminate','indeterminate',1,2,${modelCapacityPolicyHash(policy)},${JSON.stringify(localEvidence)}::jsonb,${plan.localEnd.endedAt}) RETURNING id,encode(sha256(convert_to(nmv_boundary_canonical(evidence),'UTF8')),'hex') hash`;
 Object.assign(plan.localEnd,{eventId:Number(ended.id),evidenceHash:ended.hash});receipt.planHash=providerBoundaryPlanHash(plan);beforeRows=await rows();beforeChecks=await checks();expect(await physical(await evidence())).toBe(false);
 await migrate(drizzle(client),{migrationsFolder:path.join(root,'drizzle')});const g=globalThis as{db?:unknown;pgClient?:unknown};g.db=drizzle(client,{schema});g.pgClient=client;
},120000);
afterAll(async()=>{await client.end({timeout:5});if(created)await admin.unsafe(`DROP DATABASE ${name}`);await admin.end({timeout:5});});
it('nonempty130→131 preserves CHECK OIDs/rows and accepts the strict new physical boundary',async()=>{expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(131);expect(await rows()).toEqual(beforeRows);expect(await checks()).toEqual(beforeChecks);expect(await physical(await evidence())).toBe(true);});
it('the same strict null/missing/extra/topology matrix is rejected by TypeScript and actual SQL',async()=>{
 const base=await evidence();const matrix=invalidBootBoundaries(frozen);expect(matrix.length).toBeGreaterThan(300);
 for(const value of matrix){const p=value.plan as Record<string,unknown>,r=value.receipt as Record<string,unknown>;if(p&&r&&r.planHash===frozen.receipt.planHash)r.planHash=providerBoundaryCanonicalHash(p);
  const e={...base,...value};expect(modelDispatchReleaseEvidenceSchema.safeParse(e).success).toBe(false);expect(await physical(e)).toBe(false);}
});
it('authoritative binding checks reject another transport kind, model, backend, group, revision or token bound',async()=>{
 const[row]=await client`SELECT to_jsonb(r) value FROM model_capacity_requests r WHERE request_id=${requestId}`;
 for(const [key,value]of [['kind','ai1_legacy_gateway'],['model','other-model'],['backendId','other-backend'],['physicalGroup','other-group'],['deploymentRevision','other-revision'],['totalTokenBound',1],['chargedTokens',1]]){
  const changed=structuredClone(row.value);changed.dispatch_binding[key as string]=value;
  expect((await client`SELECT nmv_boot_records_valid(${JSON.stringify(frozen.plan)}::jsonb,${JSON.stringify(changed)}::jsonb) valid`)[0].valid).toBe(false);
 }
});
it('forged local-end or original owner-group facts cannot bypass official or SQL guards',async()=>{
 for(const mutate of[(p:typeof frozen.plan)=>{p.localEnd.eventId+=999;},(p:typeof frozen.plan)=>{p.localEnd.evidenceHash='0'.repeat(64);},(p:typeof frozen.plan)=>{p.ownerAssociation.pid++;},(p:typeof frozen.plan)=>{p.ownerAssociation.spawnedEventId+=999;},(p:typeof frozen.plan)=>{p.ownerAssociation.runIdHash='0'.repeat(64);}]){const x=structuredClone(frozen);mutate(x.plan);x.receipt.planHash=providerBoundaryPlanHash(x.plan);await expect(releaseProviderBoundaryRequest({...x,expectedPlanHash:x.receipt.planHash,operator:'boot-fixture',reference:'synthetic raw boot boundary fixture'},true)).rejects.toThrow();const e=await evidence(x.plan,x.receipt);await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(e)} WHERE request_id=${requestId}`).rejects.toThrow();expect(await rows()).toEqual(beforeRows);}
});
it('dry-run rolls back and apply releases exact one row/event/audit with unknown usage; replay is immutable',async()=>{expect((await releaseProviderBoundaryRequest(input(),false)).kind).toBe('released');expect(await rows()).toEqual(beforeRows);expect((await releaseProviderBoundaryRequest(input(),true)).kind).toBe('released');const[row]=await client`SELECT * FROM model_capacity_requests WHERE request_id=${requestId}`;expect(row.state).toBe('withdrawn');expect(row.settled_at).toBeNull();expect(row.dispatch_binding).toEqual(binding);expect(row.dispatch_binding_hash).toBe(localModelBindingHash(binding));expect(await client`SELECT id FROM model_capacity_events WHERE request_id=${requestId} AND kind='dispatch_released'`).toHaveLength(1);const[audit]=await client`SELECT detail FROM operations_audit WHERE target=${requestId} AND action='model-provider-boundary-release'`;expect(audit.detail).toMatchObject({usageKnown:false,businessResult:false,modelTerminal:false});expect((await releaseProviderBoundaryRequest(input(),true)).kind).toBe('already_released');await expect(client`UPDATE model_capacity_requests SET state='indeterminate',terminal_evidence=NULL,terminal_evidence_hash=NULL WHERE request_id=${requestId}`).rejects.toThrow();});
