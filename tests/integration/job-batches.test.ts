import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { runJob } from '@/lib/jobs/runner';
import { jobsForRole } from '@/lib/jobs/catalog';
import { requestJob } from '@/lib/jobs/control';
import { batchCanaryAnchorKey, batchPolicyHash } from '@/lib/jobs/batches';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const client = postgres(TEST_DATABASE_URL,{max:2});
const names = ['reason-translate','product-translate','second-review'];
const managedNames=[...new Set([...names,...jobsForRole('text')])];
const tasks = new Set<Promise<unknown>>();
const track = <T>(task:Promise<T>) => {tasks.add(task); void task.catch(()=>{}); return task;};
let baseline: Record<string,unknown[]>;
const ownItemKeys=new Set<string>();
let setup:Promise<void>|undefined;
let cleaning:Promise<void>|undefined;
const ownObservationKeys = [...['pr10-oracle','pr10-m3','pr10-mini'].map(id=>batchCanaryAnchorKey('translation',id)),...names.map(name=>`job:${name}`),...['pr10-oracle','pr10-m3','pr10-mini'].flatMap(id=>names.map(name=>`batch-result:${id}:${name}`))];
const tables = ['jobs','role_leases','job_batch_control','job_batch_candidates','pipeline_item_leases','pipeline_stage_modes','operations_observations'] as const;
const policy = {version:1 as const,release:'pr10-test',instances:[{instanceId:'pr10-oracle',host:'oracle-osaka-smoke' as const},{instanceId:'pr10-m3',host:'m3' as const},{instanceId:'pr10-mini',host:'mini' as const}]};
async function snapshot() {
  const result:Record<string,unknown[]> = {};
  for (const table of tables) {
    const rows = await client.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
    result[table] = rows.map(row=>row.row);
  }
  return result;
}
async function restoreManaged(tx:postgres.TransactionSql,table:'jobs'|'role_leases'|'operations_observations',key:string,values:string[]) {
  const [metadata]=await tx`SELECT array_agg(column_name::text ORDER BY ordinal_position) names FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} AND column_name<>${key}`;
  const columns=(metadata.names as string[]).map(name=>`"${name}"`);
  for(const value of values) {
    const original=baseline[table].find(item=>(item as Record<string,unknown>)[key]===value);
    if(!original) {await tx.unsafe(`DELETE FROM ${table} WHERE "${key}"=$1`,[value]);continue;}
    await tx.unsafe(`UPDATE ${table} t SET (${columns.join(',')}) = (${columns.map(name=>`r.${name}`).join(',')}) FROM jsonb_populate_record(NULL::${table},$1::text::jsonb) r WHERE t."${key}"=r."${key}"`,[JSON.stringify(original)]);
  }
}
async function cleanupOnce() {
  await setup;
  const pending = [...tasks]; await Promise.allSettled(pending); pending.forEach(task=>tasks.delete(task));
  if (!baseline) return;
  await client.begin(async tx=> {
    await restoreManaged(tx,'operations_observations','key',ownObservationKeys);
    await restoreManaged(tx,'jobs','name',managedNames);
    for(const workKey of ownItemKeys)await tx`DELETE FROM pipeline_item_leases WHERE stage='fetch' AND work_key=${workKey}`;
    await tx`UPDATE pipeline_stage_modes t SET (mode,draining_from,epoch,writer_contract_version,updated_at)=(r.mode,r.draining_from,r.epoch,r.writer_contract_version,r.updated_at) FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(baseline.pipeline_stage_modes)}::text::jsonb) r WHERE t.stage=r.stage`;
    await tx`DELETE FROM job_batch_candidates WHERE instance_id IN ('pr10-oracle','pr10-m3','pr10-mini')`;
    await restoreManaged(tx,'role_leases','role',['translation','text']);
    const control = baseline.job_batch_control[0];
    await tx`UPDATE job_batch_control t SET (mode,draining_from,epoch,writer_contract_version,policy,policy_hash,updated_at) =
      (r.mode,r.draining_from,r.epoch,r.writer_contract_version,r.policy,r.policy_hash,r.updated_at)
      FROM jsonb_populate_record(NULL::job_batch_control,${JSON.stringify(control)}::text::jsonb) r WHERE t.id=r.id`;
  });
  expect(await snapshot()).toEqual(baseline);
}
async function cleanup() {
  if(cleaning)return cleaning;
  const current=cleanupOnce();cleaning=current;
  try {await current;}finally{if(cleaning===current)cleaning=undefined;}
}
function exercise(body:()=>Promise<void>) { return ()=>track(body()); }
beforeAll(()=>setup=(async()=> {ensureSchema(); baseline=await snapshot();
  expect(baseline.job_batch_candidates.some(row=>policy.instances.some(instance=>instance.instanceId===(row as Record<string,unknown>).instance_id))).toBe(false);
  writeFileSync('/tmp/nomorevibe-pr10-actual-baseline-20261016.json',JSON.stringify(baseline,null,2));
})());
beforeEach(async()=>{await client`UPDATE role_leases SET owner_instance_id=NULL,owner_boot_id=NULL,owner_kind=NULL,owner_release=NULL,epoch=0,quarantine_until=NULL,primary_boots='[]'::jsonb,lease_until=clock_timestamp()-interval '1 minute' WHERE role IN ('text','translation')`;});
afterEach(cleanup);
afterAll(async()=> {const errors:unknown[]=[]; try{await cleanup();}catch(e){errors.push(e);}try{await client.end();}catch(e){errors.push(e);}if(errors.length)throw new AggregateError(errors,'pr10_cleanup');});
async function configure(mode:'legacy'|'draining'|'versioned') {
  await client`UPDATE job_batch_control SET mode=${mode},draining_from=${mode==='draining'?'legacy':null},writer_contract_version=1,
    policy=${client.json(policy)},policy_hash=${batchPolicyHash(policy)} WHERE id=1`;
}
it('normal legacy direct control still consumes its requested version',exercise(async()=> {
  await requestJob(names[0]); const handler=async()=>({done:true});
  expect(await runJob(names[0],handler,{requestedOnly:true})).toMatchObject({status:'completed'});
}));
it('draining blocks direct legacy runner before handler, preserving producer and history',exercise(async()=> {
  await requestJob(names[0]); await configure('draining');
  const [before]=await client`SELECT to_jsonb(j) row FROM jobs j WHERE name=${names[0]}`;
  let calls=0;
  const result=await runJob(names[0],async()=>{calls++;return {done:true};},{requestedOnly:true});
  expect(calls).toBe(0); expect(result).toMatchObject({status:'skipped',reason:'stopping'});
  const [after]=await client`SELECT to_jsonb(j) row FROM jobs j WHERE name=${names[0]}`;
  expect(after.row).toEqual(before.row);
}));
it('versioned translation cannot be claimed by an old direct text consumer',exercise(async()=> {
  await requestJob(names[0]); await configure('versioned');
  let calls=0; const result=await runJob(names[0],async()=>{calls++;return {done:true};},{requestedOnly:true});
  expect(calls).toBe(0); expect(result).toMatchObject({status:'skipped',reason:'stopping'});
}));

// The callback below performs real runner cursor/result writes; it is not a provider or operational canary.
async function seedReadiness(instanceId='pr10-oracle',host='oracle-osaka-smoke') {
  await configure('legacy');
  const {tryAcquireRole,releaseRole}=await import('@/lib/jobs/role-leader');
  const legacy=await tryAcquireRole({role:'text',instanceId,bootId:'pr10-boot',release:'pr10-test',kind:'primary'});
  if(!legacy)throw Error('fixture_legacy_role_unavailable');
  try {
    const run=await runJob(names[0],async ctx=>{await ctx.save({fixture:'actual-runner-result'});ctx.log('translate.done',{translated:1});return {done:false};},{roleLease:legacy});
    expect(run.status).toBe('completed');
  } finally {expect(await releaseRole(legacy)).toBe(true);}
  const [proofClock]=await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`;
  const evidence={host,release:'pr10-test',instanceId,dbPrivileges:'verified',dbRole:'fixture-only',effectivePrivilegeHash:'a'.repeat(64),modelBoundEvidenceHash:'b'.repeat(64),http:'verified',model:'verified',observedAt:proofClock.at};
  const [saved]=await client`SELECT requested_version,cursor FROM jobs WHERE name=${names[0]}`;
  const readback={host,release:'pr10-test',instanceId,job:names[0],requestedVersion:Number(saved.requested_version),domainReadbackHash:createHash('sha256').update(JSON.stringify(saved.cursor)).digest('hex'),observedAt:proofClock.at};
  await client`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence)
    VALUES('translation',${instanceId},${host},'pr10-boot','pr10-test',${batchPolicyHash(policy)},${client.json(evidence)},${client.json(readback)})
    ON CONFLICT(role,instance_id) DO UPDATE SET capability=excluded.capability,result_evidence=excluded.result_evidence,observed_at=clock_timestamp()`;
}
const oracle={role:'translation' as const,instanceId:'pr10-oracle',bootId:'pr10-boot',release:'pr10-test',kind:'primary' as const,batchVersion:1 as const,host:'oracle-osaka-smoke' as const};
it('contract zero cannot begin activation and a new role cannot be elected in legacy mode',exercise(async()=> {
  const {beginJobBatchDrain}=await import('@/lib/jobs/batch-repository');
  const {tryAcquireRole}=await import('@/lib/jobs/role-leader');
  await expect(beginJobBatchDrain()).rejects.toThrow('job_batch_contract_required');
  expect(await tryAcquireRole(oracle)).toBeNull();
}));
it('requires operator capability plus actual host/release result, then executes the original translation job and preserves the healthy owner',exercise(async()=> {
  await seedReadiness(); await configure('versioned');
  const {tryAcquireRole,renewRole}=await import('@/lib/jobs/role-leader');
  const lease=await tryAcquireRole(oracle); expect(lease).toMatchObject({epoch:1,batchEpoch:1});
  const [before]=await client`SELECT to_jsonb(t) row FROM role_leases t WHERE role='translation'`;
  expect(await tryAcquireRole({...oracle,instanceId:'pr10-m3',host:'m3',bootId:'pr10-boot-other'})).toBeNull();
  const [after]=await client`SELECT to_jsonb(t) row FROM role_leases t WHERE role='translation'`;expect(after.row).toEqual(before.row);
  expect(await renewRole(lease!)).toBe(true);
  await requestJob(names[0]); let called=0;
  expect(await runJob(names[0],async()=>{called++;return{done:true};},{roleLease:lease!,requestedOnly:true})).toMatchObject({status:'completed'});
  expect(called).toBe(1);
  expect(await runJob('crawl-tagline',async()=>{throw Error('wrong_job_dispatched');},{roleLease:lease!})).toMatchObject({status:'skipped',reason:'stopping'});
}));
it('unknown capability and empty ticks cannot elect an installed candidate',exercise(async()=> {
  await configure('versioned'); const {tryAcquireRole}=await import('@/lib/jobs/role-leader');
  expect(await tryAcquireRole(oracle)).toBeNull();
  const [row]=await client`SELECT epoch,owner_instance_id FROM role_leases WHERE role='translation'`;
  expect(Number(row.epoch)).toBe(0);expect(row.owner_instance_id).toBeNull();
}));
it('does not overlap two translation jobs while a healthy original job is running',exercise(async()=> {
  await seedReadiness(); await configure('versioned'); const {tryAcquireRole}=await import('@/lib/jobs/role-leader');
  const lease=(await tryAcquireRole(oracle))!;
  const gate=Promise.withResolvers<void>(), started=Promise.withResolvers<void>();
  let running:Promise<unknown>|undefined;
  try {
    running=track(runJob(names[0],async()=>{started.resolve();await gate.promise;return{done:true};},{roleLease:lease}));
    await Promise.race([started.promise,running]);
    let secondCalls=0;
    const second=await runJob(names[1],async()=>{secondCalls++;return{done:true};},{roleLease:lease});
    expect(secondCalls).toBe(0);expect(second).toMatchObject({status:'skipped',reason:'stopping'});
  } finally {gate.resolve();await running;}
}));
it('retains canaries for both hosts and elects the preferred ready Oracle before its M3 fallback',exercise(async()=> {
  await seedReadiness();await seedReadiness('pr10-m3','m3');await configure('versioned');
  const {tryAcquireRole}=await import('@/lib/jobs/role-leader');
  expect(await tryAcquireRole({...oracle,instanceId:'pr10-m3',host:'m3'})).toBeNull();
  expect(await tryAcquireRole(oracle)).toMatchObject({instanceId:'pr10-oracle',epoch:1});
}));
it('atomically closes new claims on drain and increments the batch epoch only after a real live job and role have drained',exercise(async()=> {
  await configure('legacy');
  const {beginJobBatchDrain,completeJobBatchTransition}=await import('@/lib/jobs/batch-repository');
  const gate=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
  let running:Promise<unknown>|undefined;
  try {
    running=track(runJob(names[0],async()=>{started.resolve();await gate.promise;return{done:true};}));
    await Promise.race([started.promise,running]);
    const [before]=await client`SELECT lease_token,locked_at FROM jobs WHERE name=${names[0]}`;
    await beginJobBatchDrain();
    const [draining]=await client`SELECT mode,epoch FROM job_batch_control`;expect(draining.mode).toBe('draining');expect(Number(draining.epoch)).toBe(1);
    await expect(completeJobBatchTransition('versioned')).rejects.toThrow('job_batch_not_drained');
    const [after]=await client`SELECT lease_token,locked_at FROM jobs WHERE name=${names[0]}`;expect(after).toEqual(before);
    gate.resolve();expect(await running).toMatchObject({status:'completed'});
    expect(await completeJobBatchTransition('versioned')).toMatchObject({mode:'versioned',epoch:2});
  } finally {gate.resolve();await running;}
}));
it('a control UPDATE holder blocks a new claim until its committed draining state is checked',exercise(async()=> {
  await configure('legacy');await requestJob(names[0]);
  const holdingStarted=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  const holder=postgres(TEST_DATABASE_URL,{max:1,connection:{application_name:'pr10-drain-holder'}});
  const holding=track(holder.begin(async tx=>{await tx`UPDATE job_batch_control SET mode='draining',draining_from='legacy' WHERE id=1`;holdingStarted.resolve();await finish.promise;}));
  let running:Promise<unknown>|undefined;
  try {
    await Promise.race([holdingStarted.promise,holding]);
    let calls=0;running=track(runJob(names[0],async()=>{calls++;return{done:true};},{requestedOnly:true}));
    const deadline=Date.now()+2500;
    let waiting=false;
    while(Date.now()<deadline) {
      const [row]=await client`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%job_batch_control%' AND query NOT LIKE '%pg_stat_activity%') waiting`;
      if(row.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(waiting).toBe(true);finish.resolve();await holding;
    expect(await running).toMatchObject({status:'skipped',reason:'stopping'});expect(calls).toBe(0);
  } finally {finish.resolve();await Promise.allSettled([holding,...(running?[running]:[])]);await holder.end();}
}));
it('only the genuine fixed replay DB scope has legacy job admission and receives no new table privilege',exercise(async()=> {
  const {getReplayHandlerIdentityPath}=await import('./replay-handler-setup');
  const {withReplayDatabaseScope}=await import('@/lib/db/replay-scope');
  const {readReplayDatabaseIdentity}=await import('@/lib/operations/pipeline-replay-database');
  const {identityPath,release}=await getReplayHandlerIdentityPath();
  const errors:unknown[]=[];
  try {
    const identity=await readReplayDatabaseIdentity(identityPath);
    const [grant]=await client`SELECT has_table_privilege(${identity.roleName},'job_batch_control','SELECT') allowed`;
    expect(grant.allowed).toBe(false);
    await withReplayDatabaseScope(identityPath,async()=> {
      expect(await runJob('second-review',async ctx=>{await ctx.save({fixedLegacy:true});return{done:true};})).toMatchObject({status:'completed'});
      await expect(runJob('reason-translate',async()=>({done:true}))).rejects.toThrow('replay_job_not_allowed');
      await expect(runJob('second-review',async()=>({done:true}),{roleLease:{...oracle,epoch:1,batchEpoch:1}})).rejects.toThrow('replay_role_lease_rejected');
    });
  } catch(error){errors.push(error);}
  finally {try{await release();}catch(error){errors.push(error);}}
  if(errors.length)throw new AggregateError(errors,'replay_legacy_compatibility');
}));
it('lets a ready fallback take an expired role epoch without revoking a healthy original job token',exercise(async()=> {
  await seedReadiness();await seedReadiness('pr10-m3','m3');await configure('versioned');
  const {tryAcquireRole}=await import('@/lib/jobs/role-leader');
  const first=(await tryAcquireRole(oracle))!;
  const started=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let running:Promise<unknown>|undefined;
  try {
    running=track(runJob(names[0],async ctx=>{started.resolve();await finish.promise;await ctx.save({oldHealthyOwner:true});return{done:false};},{roleLease:first}));
    await Promise.race([started.promise,running]);
    const [before]=await client`SELECT lease_token,locked_at FROM jobs WHERE name=${names[0]}`;
    await client`UPDATE role_leases SET lease_until=clock_timestamp()-interval '21 seconds' WHERE role='translation'`;
    await client`UPDATE job_batch_candidates SET observed_at=clock_timestamp()-interval '31 seconds' WHERE role='translation' AND instance_id='pr10-oracle'`;
    const second=await tryAcquireRole({...oracle,instanceId:'pr10-m3',host:'m3'});expect(second).toMatchObject({epoch:2,instanceId:'pr10-m3'});
    const [after]=await client`SELECT lease_token,locked_at FROM jobs WHERE name=${names[0]}`;expect(after).toEqual(before);
    let newCalls=0;expect(await runJob(names[1],async()=>{newCalls++;return{done:true};},{roleLease:second!})).toMatchObject({status:'skipped',reason:'stopping'});expect(newCalls).toBe(0);
    finish.resolve();expect(await running).toMatchObject({status:'completed'});
    expect(await runJob(names[1],async()=>({done:true}),{roleLease:first})).toMatchObject({status:'skipped',reason:'stopping'});
    expect(await runJob(names[1],async()=>({done:true}),{roleLease:second!})).toMatchObject({status:'completed'});
  } finally {finish.resolve();await running;}
}));
it('preserves producer version, paused cursor and historical fields while drain rejects an old worker',exercise(async()=> {
  await configure('legacy');await requestJob(names[0]);
  await client`UPDATE jobs SET cursor='{"position":19}'::jsonb,not_before='2100-01-02 03:04:05.123456'::timestamp,
    last_error='historical',last_success_at='2001-02-03 04:05:06.654321'::timestamp WHERE name=${names[0]}`;
  const {beginJobBatchDrain}=await import('@/lib/jobs/batch-repository');await beginJobBatchDrain();
  await requestJob(names[0]);
  const [before]=await client`SELECT to_jsonb(t) row FROM jobs t WHERE name=${names[0]}`;
  expect(await runJob(names[0],async()=>{throw Error('must_not_dispatch');},{requestedOnly:true})).toMatchObject({status:'skipped',reason:'stopping'});
  const [after]=await client`SELECT to_jsonb(t) row FROM jobs t WHERE name=${names[0]}`;expect(after.row).toEqual(before.row);expect(Number(after.row.requested_version)).toBe(2);
}));
it('elects one owner under two actual concurrent role acquisitions',exercise(async()=> {
  await seedReadiness();await configure('versioned');const {tryAcquireRole}=await import('@/lib/jobs/role-leader');
  const results=await Promise.all([track(tryAcquireRole(oracle)),track(tryAcquireRole({...oracle,bootId:'pr10-rival-boot'}))]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(results.find(Boolean)?.epoch).toBe(1);
}));
it('preserves an independently issued healthy item across role election and rejects transition without releasing it',exercise(async()=> {
  const {lockItemStage,claimItemLease,releaseItemLease}=await import('@/lib/jobs/items/repository');
  const {beginJobBatchDrain,completeJobBatchTransition}=await import('@/lib/jobs/batch-repository');
  const {tryAcquireRole}=await import('@/lib/jobs/role-leader');
  const frontierId=2_000_000_000+Math.floor(Math.random()*100_000_000),workKey=`fetch:${frontierId}`;
  expect(await client`SELECT 1 FROM pipeline_item_leases WHERE stage='fetch' AND work_key=${workKey}`).toHaveLength(0);ownItemKeys.add(workKey);
  await client`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='fetch'`;
  // Generic ownership provenance only; this is not a fetched-domain or external-call authority proof.
  const item=await db.transaction(async tx=>claimItemLease(tx,await lockItemStage(tx,'fetch'),{stage:'fetch',frontierId,repo:'pr10/item-sentinel',claim:{attempts:1,nextAttemptAt:new Date().toISOString()}},{instanceId:'pr10-independent-item',bootId:randomUUID()},90_000));
  if(!item)throw Error('fixture_generic_item_not_claimed');
  try {
    const [before]=await client`SELECT to_jsonb(t) row FROM pipeline_item_leases t WHERE stage='fetch' AND work_key=${workKey}`;
    await seedReadiness();await configure('versioned');expect(await tryAcquireRole(oracle)).not.toBeNull();
    const [after]=await client`SELECT to_jsonb(t) row FROM pipeline_item_leases t WHERE stage='fetch' AND work_key=${workKey}`;expect(after.row).toEqual(before.row);
    await beginJobBatchDrain();await expect(completeJobBatchTransition('legacy')).rejects.toThrow('job_batch_not_drained');
    const [still]=await client`SELECT to_jsonb(t) row FROM pipeline_item_leases t WHERE stage='fetch' AND work_key=${workKey}`;expect(still.row).toEqual(before.row);
  } finally {await db.transaction(async tx=>releaseItemLease(tx,await lockItemStage(tx,'fetch'),item));}
}));
it('uses mini as the last ready fallback and never lets a returned Oracle preempt it',exercise(async()=> {
  await seedReadiness('pr10-mini','mini');await configure('versioned');
  const {tryAcquireRole}=await import('@/lib/jobs/role-leader');
  await client`INSERT INTO role_leases(role,lease_until) VALUES('translation',clock_timestamp()-interval '41 seconds') ON CONFLICT(role) DO UPDATE SET lease_until=excluded.lease_until`;
  const mini=await tryAcquireRole({...oracle,instanceId:'pr10-mini',host:'mini'});expect(mini).toMatchObject({instanceId:'pr10-mini',epoch:1});
  const [before]=await client`SELECT to_jsonb(t) row FROM role_leases t WHERE role='translation'`;
  expect(await tryAcquireRole(oracle)).toBeNull();
  const [after]=await client`SELECT to_jsonb(t) row FROM role_leases t WHERE role='translation'`;expect(after.row).toEqual(before.row);
}));
it('reports missing role/host and capability dimensions as unknown, even after a single positive result',exercise(async()=> {
  const {readJobBatchReadiness}=await import('@/lib/operations/job-batch-readiness');
  await seedReadiness();await configure('versioned');
  const report=await readJobBatchReadiness();expect(report.ready).toBe(false);expect(report.missing).toContainEqual({role:'site-evidence',host:'oracle-osaka-smoke'});
}));
