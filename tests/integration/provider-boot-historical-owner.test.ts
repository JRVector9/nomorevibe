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
import {historicalBootBoundaryFixture,invalidHistoricalBootBoundaries} from '../fixtures/provider-boot-historical-owner';
import {TEST_DATABASE_URL} from './setup';
const root=process.cwd(),name=`nomorevibe_test_boot_hist_${randomUUID().replaceAll('-','')}`,url=new URL(TEST_DATABASE_URL);url.pathname=`/${name}`;
const admin=postgres(TEST_DATABASE_URL,{max:1,onnotice:()=>{}}),client=postgres(url.toString(),{max:3,prepare:false,onnotice:()=>{}});
const journal=JSON.parse(readFileSync(path.join(root,'drizzle/meta/_journal.json'),'utf8'));
const fx=historicalBootBoundaryFixture(),requestId=randomUUID(),token=randomUUID(),hash='a'.repeat(64),owner=fx.plan.request.owner;
const binding=localModelBindingSchema.parse({kind:'local_model_direct',version:1,target:{kind:'assist',purpose:'assist_review',workId:randomUUID(),workRevision:30,
 claimToken:randomUUID(),task:'uptime',subjectId:47220,backendId:'gpu3090-qwen'},logicalWorkKey:'direct:assist:47220:uptime',routeId:'local-assist-uptime-gpu3090-qwen',
 provider:'local-direct',model:fx.plan.servingContract.model,backendId:'gpu3090-qwen',physicalGroup:'gpu3090-qwen',deploymentRevision:fx.plan.servingContract.deploymentRevision,
 inputHash:hash,sourceRevisionHash:hash,reviewPolicyHash:hash,promptVersion:'fixture',wireHash:hash,servingContractHash:fx.plan.request.servingContractHash,
 totalTokenBound:50000,chargedTokens:50000,job:{name:'product-llm-assist-review',token:randomUUID(),requestedVersion:2524}});
const policy:ModelCapacityPolicy={version:1,globalLimit:1,providerLimits:{'gpu3090-qwen':1},groupLimits:{'gpu3090-qwen':1},poolLimits:{reviewer:1,text:1},
 weights:{first:1,second:1,background:1},maxWaiting:10,queueTtlMs:120000,reservationTtlMs:30000,routes:[{routeId:binding.routeId,provider:'local-direct',model:binding.model,providerBudgetId:'gpu3090-qwen',groupId:'gpu3090-qwen'}]};
type FunctionRow = { name:string; oid:string; source:string; definition:string };
let frozen:{plan:typeof fx.plan;receipt:typeof fx.receipt},created=false,beforeRows:unknown[],beforeChecks:unknown[],beforeFunctions:FunctionRow[];
async function catalog(){return client<FunctionRow[]>`SELECT proname name,oid::text oid,prosrc source,pg_get_functiondef(oid) definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'nmv_boundary_%' OR proname LIKE 'nmv_provider_boundary_%' OR proname LIKE 'nmv_boot_%') ORDER BY proname`;}
async function migrateThrough(limit:number,connection=client){const partial=mkdtempSync(path.join(tmpdir(),'historical-boot-predecessor-'));
 try{mkdirSync(path.join(partial,'meta'));const entries=journal.entries.filter((e:{idx:number})=>e.idx<limit);for(const e of entries)copyFileSync(path.join(root,'drizzle',`${e.tag}.sql`),path.join(partial,`${e.tag}.sql`));writeFileSync(path.join(partial,'meta/_journal.json'),JSON.stringify({...journal,entries}));await migrate(drizzle(connection),{migrationsFolder:partial});}finally{rmSync(partial,{recursive:true,force:true});}}

const input=()=>({...frozen,expectedPlanHash:providerBoundaryPlanHash(frozen.plan),operator:'boot-fixture',reference:'synthetic raw boot boundary fixture'});
function saveCatalog(file:string,value:unknown){const dir=process.env.BOUNDARY_CATALOG_OUTPUT_DIR;if(!dir)return;mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(path.join(dir,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function rows(){return client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`;}
async function checks(){return client`SELECT oid::text,conname,pg_get_constraintdef(oid) definition,convalidated FROM pg_constraint WHERE conrelid IN ('model_capacity_requests'::regclass,'model_capacity_events'::regclass) AND contype='c' ORDER BY conname`;}
async function evidence(plan=frozen.plan,receipt=frozen.receipt){const[clock]=await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`;return{version:1,kind:'provider_boundary_exit',requestId,owner,fromState:'indeterminate',dispatchAt:plan.request.dispatchAt,bindingHash:plan.request.bindingHash,notBefore:receipt.provider.observedAt,evaluatedAt:clock.at,operator:'boot-fixture',reference:'synthetic raw boot boundary fixture',plan,receipt};}
async function physical(value:unknown){return(await client`SELECT nmv_provider_boundary_release_valid(${JSON.stringify(value)}::jsonb) valid`)[0].valid;}
beforeAll(async()=>{
 await admin.unsafe(`CREATE DATABASE ${name}`);created=true;await migrateThrough(130);
 const now=Date.now(),iso=(ago:number)=>new Date(now-ago).toISOString(),micro=(ago:number)=>iso(ago).replace('Z','000Z');
 const plan=structuredClone(fx.plan),receipt=structuredClone(fx.receipt);plan.createdAt=iso(30000);plan.control.updatedAt=micro(40000);plan.control.policyHash=modelCapacityPolicyHash(policy);
 Object.assign(plan.request,{requestId,tokenHash:createHash('sha256').update(token).digest('hex'),policyHash:modelCapacityPolicyHash(policy),bindingHash:localModelBindingHash(binding),dispatchAt:iso(3600000)});
 plan.currentIngressOwner.startedAt=iso(1800000);plan.localEnd.endedAt=micro(3590000);plan.provider.oldJournal.firstAt=micro(7200000);plan.provider.oldJournal.lastAt=micro(3580000);plan.provider.currentJournal.firstAt=micro(3539000);
 const wall=iso(3540000);Object.assign(plan.bootWitness,{dbBefore:micro(33000),dbAfter:micro(31000),uptimeNs:'3508000000000',hostBtimeAt:wall});
 receipt.currentIngressOwner.identity=plan.currentIngressOwner;receipt.currentIngressOwner.observedAt=iso(20000);receipt.provider.identity=plan.provider;receipt.provider.observedAt=iso(10000);
 Object.assign(receipt.provider.bootWitness,{dbBefore:micro(12000),dbAfter:micro(10000),uptimeNs:'3529000000000',hostBtimeAt:wall});frozen={plan,receipt};
 await client`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=2,policy=${JSON.stringify(policy)}::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},updated_at=${plan.control.updatedAt} WHERE id=1`;
 await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,epoch,revision,policy_hash,state,logical_work_key,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until) VALUES(${requestId},${`${binding.logicalWorkKey}:${binding.inputHash}`},${owner.instanceId},${owner.bootId},'background','reviewer',${binding.routeId},'local-direct',${binding.model},'gpu3090-qwen','gpu3090-qwen',1,2,${modelCapacityPolicyHash(policy)},'indeterminate',${binding.logicalWorkKey},${JSON.stringify(binding)}::jsonb,${localModelBindingHash(binding)},${plan.request.dispatchAt},${token},clock_timestamp(),clock_timestamp())`;
 const runId=randomUUID();const group=await client`INSERT INTO dr_process_group_events(owner_instance_id,owner_boot_id,kind,seq,run_id,pid,method,recorded_at) VALUES (${owner.instanceId},${owner.bootId},'owner_opened',0,NULL,NULL,NULL,${iso(7100000)}),(${owner.instanceId},${owner.bootId},'spawn_intent',1,${runId},NULL,NULL,${iso(7000000)}),(${owner.instanceId},${owner.bootId},'spawned',1,${runId},279,NULL,${iso(6999000)}),(${owner.instanceId},${owner.bootId},'group_exited',1,${runId},279,'pgid_esrch_after_sigkill',${iso(1800000)}) RETURNING id,kind`;
 Object.assign(plan.ownerAssociation,{pid:279,spawnedEventId:Number(group.find(x=>x.kind==='spawned')!.id),runIdHash:createHash('sha256').update(runId).digest('hex')});
 const localEvidence={version:1,kind:'gateway_local_end',requestId,owner,bindingHash:plan.request.bindingHash,dispatches:1,terminals:1};
 const[ended]=await client`INSERT INTO model_capacity_events(request_id,kind,from_state,to_state,epoch,revision,policy_hash,evidence,created_at) VALUES(${requestId},'dispatch_local_ended','indeterminate','indeterminate',1,2,${modelCapacityPolicyHash(policy)},${JSON.stringify(localEvidence)}::jsonb,${plan.localEnd.endedAt}) RETURNING id,encode(sha256(convert_to(nmv_boundary_canonical(evidence),'UTF8')),'hex') hash,encode(sha256(convert_to(evidence::text,'UTF8')),'hex') text_hash`;
 Object.assign(plan.localEnd,{eventId:Number(ended.id),evidenceHash:ended.hash});Object.assign(plan.originalOwner,{openedEventId:Number(group.find(x=>x.kind==='owner_opened')!.id),
 groups:[{seq:1,pid:279,runIdHash:plan.ownerAssociation.runIdHash,spawnIntentEventId:Number(group.find(x=>x.kind==='spawn_intent')!.id),spawnedEventId:plan.ownerAssociation.spawnedEventId,exitEventId:Number(group.find(x=>x.kind==='group_exited')!.id)}],
 localEndEventId:Number(ended.id),localEndEvidenceHash:ended.text_hash});
 receipt.originalOwnerProofHash=providerBoundaryCanonicalHash(plan.originalOwner);receipt.planHash=providerBoundaryPlanHash(plan);beforeRows=await rows();beforeChecks=await checks();expect(await physical(await evidence())).toBe(false);
 saveCatalog('v4-before-130.safe.json',{synthetic:true,rows:beforeRows,checks:beforeChecks,functions:await catalog(),journal:await client`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`});
 await migrateThrough(131);beforeFunctions=await catalog();expect(await physical(await evidence())).toBe(false);
 saveCatalog('v4-before-131.safe.json',{synthetic:true,functions:beforeFunctions,journal:await client`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`});
 await migrate(drizzle(client),{migrationsFolder:path.join(root,'drizzle')});saveCatalog('v4-after-132.safe.json',{synthetic:true,rows:await rows(),checks:await checks(),functions:await catalog(),journal:await client`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`});const g=globalThis as{db?:unknown;pgClient?:unknown};g.db=drizzle(client,{schema});g.pgClient=client;
},120000);
afterAll(async()=>{await client.end({timeout:5});if(created)await admin.unsafe(`DROP DATABASE ${name}`);await admin.end({timeout:5});});
it('nonempty130→132 preserves CHECK OIDs/rows and accepts a historical group exit after native boot',async()=>{expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(132);expect(await rows()).toEqual(beforeRows);expect(await checks()).toEqual(beforeChecks);expect(await physical(await evidence())).toBe(true);});
it('preserves all V1/V2/V3 bodies/OIDs and archives only the two public dispatch bodies with exact migration hashes',async()=>{
 const after=await catalog(),archives=new Map([['nmv_provider_boundary_release_valid','nmv_boot_historical_previous_release_valid'],['nmv_provider_boundary_transition_guard','nmv_boot_historical_previous_transition_guard']]);
 expect(after.length-beforeFunctions.length).toBe(4);
 for(const old of beforeFunctions){const current=after.find(x=>x.name===old.name)!;expect(current.oid).toBe(old.oid);
  if(archives.has(old.name))expect(after.find(x=>x.name===archives.get(old.name))!.source).toBe(old.source);else expect(current).toEqual(old);}
 const migrationRows=await client`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
 expect(migrationRows.map(x=>({hash:x.hash,at:Number(x.created_at)}))).toEqual(journal.entries.map((e:{tag:string;when:number})=>({hash:createHash('sha256').update(readFileSync(path.join(root,'drizzle',`${e.tag}.sql`))).digest('hex'),at:e.when})));
 expect(beforeFunctions.some(x=>x.name==='nmv_provider_boundary_release_v3_valid')).toBe(true);
 expect((await client`SELECT nmv_boot_historical_records_valid(${JSON.stringify(frozen.plan)}::jsonb,to_jsonb(r)) valid FROM model_capacity_requests r WHERE request_id=${requestId}`)[0].valid).toBe(true);
 expect(frozen.plan.originalOwner.localEndEvidenceHash).not.toBe(frozen.plan.localEnd.evidenceHash);
});
it('stock migrator applies both pending0130+0131 in one call from a nonempty130 predecessor',async()=>{
 const stockName=`${name}_stock`,stockUrl=new URL(url);stockUrl.pathname=`/${stockName}`;
 const stock=postgres(stockUrl.toString(),{max:1,prepare:false,onnotice:()=>{}});let stockCreated=false;
 try{await admin.unsafe(`CREATE DATABASE ${stockName}`);stockCreated=true;await migrateThrough(130,stock);
  const tables=['model_capacity_requests','model_capacity_events','dr_process_group_events'],before:Record<string,unknown[]>={};
  for(const table of tables){const values=await client.unsafe(`SELECT to_jsonb(r) value FROM ${table} r ORDER BY to_jsonb(r)::text`);before[table]=values.map(r=>r.value);
   for(const r of values)await stock.unsafe(`INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::${table},$1::jsonb)).*`,[JSON.stringify(r.value)]);}
  expect((await stock`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(130);
  const e=await evidence();expect((await stock`SELECT nmv_provider_boundary_release_valid(${JSON.stringify(e)}::jsonb) valid`)[0].valid).toBe(false);
  await migrate(drizzle(stock),{migrationsFolder:path.join(root,'drizzle')});
  const migrated=await stock`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  expect(migrated).toHaveLength(132);expect(migrated.slice(-2).map(r=>r.hash)).toEqual(journal.entries.slice(-2).map((entry:{tag:string})=>createHash('sha256').update(readFileSync(path.join(root,'drizzle',`${entry.tag}.sql`))).digest('hex')));
  for(const table of tables)expect((await stock.unsafe(`SELECT to_jsonb(r) value FROM ${table} r ORDER BY to_jsonb(r)::text`)).map(r=>r.value)).toEqual(before[table]);
  expect((await stock`SELECT nmv_provider_boundary_release_valid(${JSON.stringify(e)}::jsonb) valid`)[0].valid).toBe(true);
  expect((await stock`SELECT nmv_boot_historical_records_valid(${JSON.stringify(frozen.plan)}::jsonb,to_jsonb(r)) valid FROM model_capacity_requests r WHERE request_id=${requestId}`)[0].valid).toBe(true);
  saveCatalog('v4-stock-130-to-132.safe.json',{synthetic:true,stockMigrateCallsAfter130:1,preservedTables:before,journal:migrated});
 }finally{await stock.end({timeout:5});if(stockCreated)await admin.unsafe(`DROP DATABASE ${stockName}`);}
},120000);
it('the same strict null/missing/extra/topology matrix is rejected by TypeScript and actual SQL',async()=>{
 const base=await evidence();const matrix=invalidHistoricalBootBoundaries(frozen);expect(matrix.length).toBeGreaterThan(300);
 for(const value of matrix){const p=value.plan as Record<string,unknown>,r=value.receipt as Record<string,unknown>;if(p&&r&&r.planHash===frozen.receipt.planHash)r.planHash=providerBoundaryCanonicalHash(p);
  const e={...base,...value};expect(modelDispatchReleaseEvidenceSchema.safeParse(e).success).toBe(false);expect(await physical(e)).toBe(false);}
});
it('authoritative binding checks reject another transport kind, model, backend, group, revision or token bound',async()=>{
 const[row]=await client`SELECT to_jsonb(r) value FROM model_capacity_requests r WHERE request_id=${requestId}`;
 for(const [key,value]of [['kind','ai1_legacy_gateway'],['model','other-model'],['backendId','other-backend'],['physicalGroup','other-group'],['deploymentRevision','other-revision'],['totalTokenBound',1],['chargedTokens',1]]){
  const changed=structuredClone(row.value);changed.dispatch_binding[key as string]=value;
  expect((await client`SELECT nmv_boot_historical_records_valid(${JSON.stringify(frozen.plan)}::jsonb,${JSON.stringify(changed)}::jsonb) valid`)[0].valid).toBe(false);
 }
});
it('physical hashes cannot substitute for original owner, group, same-event or either evidence hash domain',async()=>{
 for(const mutate of[
  (p:typeof frozen.plan)=>{p.originalOwner.openedEventId+=999;},
  (p:typeof frozen.plan)=>{p.originalOwner.groups[0].seq++;},
  (p:typeof frozen.plan)=>{p.originalOwner.groups[0].spawnIntentEventId+=999;},
  (p:typeof frozen.plan)=>{p.originalOwner.groups[0].exitEventId+=999;},
  (p:typeof frozen.plan)=>{p.originalOwner.groups[0].runIdHash='0'.repeat(64);p.ownerAssociation.runIdHash='0'.repeat(64);},
  (p:typeof frozen.plan)=>{p.originalOwner.groups[0].pid++;p.ownerAssociation.pid++;},
  (p:typeof frozen.plan)=>{p.localEnd.eventId+=999;p.originalOwner.localEndEventId=p.localEnd.eventId;},
  (p:typeof frozen.plan)=>{p.originalOwner.localEndEvidenceHash=p.localEnd.evidenceHash;},
  (p:typeof frozen.plan)=>{p.localEnd.evidenceHash=p.originalOwner.localEndEvidenceHash;},
  (p:typeof frozen.plan)=>{p.localEnd.endedAt=p.localEnd.endedAt.slice(0,23)+'001Z';},
 ]){const x=structuredClone(frozen);mutate(x.plan);x.receipt.originalOwnerProofHash=providerBoundaryCanonicalHash(x.plan.originalOwner);x.receipt.planHash=providerBoundaryPlanHash(x.plan);
  const e=await evidence(x.plan,x.receipt);expect(await physical(e)).toBe(true);
  expect((await client`SELECT nmv_boot_historical_records_valid(${JSON.stringify(x.plan)}::jsonb,to_jsonb(r)) valid FROM model_capacity_requests r WHERE request_id=${requestId}`)[0].valid).toBe(false);
  await expect(releaseProviderBoundaryRequest({...x,expectedPlanHash:x.receipt.planHash,operator:'boot-fixture',reference:'synthetic raw boot boundary fixture'},true)).rejects.toThrow();
  await expect(client`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(e)} WHERE request_id=${requestId}`).rejects.toThrow();expect(await rows()).toEqual(beforeRows);}
});
it('a new dispatch-relevant live group or sequence gap is re-read and cannot be omitted from historical proof',async()=>{
 for(const seq of [2,3])await expect(client.begin(async tx=>{
  await tx`INSERT INTO dr_process_group_events(owner_instance_id,owner_boot_id,kind,seq,run_id,pid,recorded_at) VALUES(${owner.instanceId},${owner.bootId},'spawn_intent',${seq},${randomUUID()},NULL,${frozen.plan.request.dispatchAt})`;
  expect((await tx`SELECT nmv_boot_historical_records_valid(${JSON.stringify(frozen.plan)}::jsonb,to_jsonb(r)) valid FROM model_capacity_requests r WHERE request_id=${requestId}`)[0].valid).toBe(false);
  const e=await evidence();await expect(tx.savepoint(sp=>sp`UPDATE model_capacity_requests SET state='withdrawn',terminal_evidence=${JSON.stringify(e)}::jsonb,terminal_evidence_hash=${providerBoundaryCanonicalHash(e)} WHERE request_id=${requestId}`)).rejects.toThrow('provider_boot_historical_records_mismatch');
  throw new Error('synthetic_group_rollback');
 })).rejects.toThrow('synthetic_group_rollback');
 expect(await rows()).toEqual(beforeRows);
});
it('retains token/binding/control/fence CAS and rejects a direct withdrawn INSERT',async()=>{
 for(const mutate of[
  (p:typeof frozen.plan)=>{p.request.tokenHash='0'.repeat(64);},
  (p:typeof frozen.plan)=>{p.request.bindingHash='0'.repeat(64);},
  (p:typeof frozen.plan)=>{p.control.updatedAt=p.control.updatedAt.slice(0,23)+'001Z';},
  (p:typeof frozen.plan)=>{p.request.revision++;},
 ]){const x=structuredClone(frozen);mutate(x.plan);x.receipt.planHash=providerBoundaryPlanHash(x.plan);await expect(releaseProviderBoundaryRequest({...x,expectedPlanHash:x.receipt.planHash,operator:'boot-fixture',reference:'synthetic raw boot boundary fixture'},true)).rejects.toThrow();}
 await client`UPDATE model_capacity_control SET mode='open' WHERE id=1`;
 await expect(releaseProviderBoundaryRequest(input(),true)).rejects.toThrow('model_capacity_provider_boundary_conflict');
 await client`UPDATE model_capacity_control SET mode='draining' WHERE id=1`;
 await client`UPDATE dr_writer_fence SET state='fenced',reason='operator_fence',fenced_db='{"systemIdentifier":"1","databaseOid":"1","databaseName":"fixture"}'::jsonb WHERE id=1`;
 await expect(releaseProviderBoundaryRequest(input(),true)).rejects.toThrow('dr_writer_site_fenced');
 await client`UPDATE dr_writer_fence SET state='active',reason=NULL,fenced_db=NULL WHERE id=1`;
 const e=await evidence();await expect(client`INSERT INTO model_capacity_requests SELECT (jsonb_populate_record(NULL::model_capacity_requests,to_jsonb(r)||jsonb_build_object('request_id',${randomUUID()}::text,'queue_ordinal',99999,'work_key','fake','state','withdrawn','terminal_evidence',${JSON.stringify(e)}::jsonb,'terminal_evidence_hash',${providerBoundaryCanonicalHash(e)}::text))).* FROM model_capacity_requests r WHERE request_id=${requestId}`).rejects.toThrow('provider_boundary_transition_invalid');
 expect(await rows()).toEqual(beforeRows);
});
it('dry-run rolls back and apply releases exact one row/event/audit with unknown usage; replay is immutable',async()=>{expect((await releaseProviderBoundaryRequest(input(),false)).kind).toBe('released');expect(await rows()).toEqual(beforeRows);expect((await releaseProviderBoundaryRequest(input(),true)).kind).toBe('released');const[row]=await client`SELECT * FROM model_capacity_requests WHERE request_id=${requestId}`;expect(row.state).toBe('withdrawn');expect(row.settled_at).toBeNull();expect(row.dispatch_binding).toEqual(binding);expect(row.dispatch_binding_hash).toBe(localModelBindingHash(binding));expect(await client`SELECT id FROM model_capacity_events WHERE request_id=${requestId} AND kind='dispatch_released'`).toHaveLength(1);const[audit]=await client`SELECT detail FROM operations_audit WHERE target=${requestId} AND action='model-provider-boundary-release'`;expect(audit.detail).toMatchObject({usageKnown:false,businessResult:false,modelTerminal:false});expect((await releaseProviderBoundaryRequest(input(),true)).kind).toBe('already_released');await expect(client`UPDATE model_capacity_requests SET state='indeterminate',terminal_evidence=NULL,terminal_evidence_hash=NULL WHERE request_id=${requestId}`).rejects.toThrow();});
