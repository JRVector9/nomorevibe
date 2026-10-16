import { eq, inArray, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { jobBatchCandidates, jobBatchControl, operationsObservations } from '@/lib/db/schema';
import { batchJobsForRole, batchPolicyHash, batchPolicySchema, BATCH_HOSTS, BATCH_ROLES, classifyBatchReadiness, type BatchHost, type BatchRole } from '@/lib/jobs/batches';

/** Read-only evidence report. Neither installation nor a heartbeat creates capability/canary evidence. */
export async function readJobBatchReadiness() {
  return onPrimary(() => db.transaction(async tx => {
    const [control] = await tx.select().from(jobBatchControl).where(eq(jobBatchControl.id,1));
    if (!control) throw new Error('job_batch_control_missing');
    const policy=batchPolicySchema.safeParse(control.policy);
    if (!policy.success || batchPolicyHash(policy.data)!==control.policyHash) return {mode:control.mode,epoch:control.epoch,ready:false,reason:'policy_unknown' as const,candidates:[]};
    const [clock]=await tx.execute<{at:string}>(sql`SELECT clock_timestamp()::text AS at`);
    const candidates=await tx.select().from(jobBatchCandidates);
    const rows:Array<{role:string;instanceId:string;host:string;release:string;ready:boolean;reason:string}>=[];
    for(const candidate of candidates) {
      const role=candidate.role as BatchRole;
      const registered=policy.data.instances.find(instance=>instance.instanceId===candidate.instanceId);
      if(!BATCH_ROLES.includes(role) || !registered || registered.host!==candidate.host || candidate.release!==policy.data.release || candidate.policyHash!==control.policyHash) {
        rows.push({role:candidate.role,instanceId:candidate.instanceId,host:candidate.host,release:candidate.release,ready:false,reason:'identity_mismatch'});continue;
      }
      const names=batchJobsForRole(role,'versioned');
      const observations=names.length ? await tx.select().from(operationsObservations).where(inArray(operationsObservations.key,names.map(name=>`batch-result:${candidate.instanceId}:${name}`))) : [];
      const reports=[null,...observations.map(row=>row.value.batchResult)].map(result=>classifyBatchReadiness({role,instanceId:candidate.instanceId,
        host:candidate.host as BatchHost,release:candidate.release,at:new Date(clock.at).getTime(),evidence:candidate.capability,result,readback:candidate.resultEvidence}));
      const report=reports.find(row=>row.ready) ?? reports.at(-1)!;
      rows.push({role,instanceId:candidate.instanceId,host:candidate.host,release:candidate.release,...report});
    }
    const missing=BATCH_ROLES.flatMap(role=>BATCH_HOSTS.filter(host=>!rows.some(row=>row.role===role && row.host===host && row.ready)).map(host=>({role,host})));
    return {mode:control.mode,epoch:control.epoch,ready:control.mode==='versioned' && missing.length===0,reason:'evidence' as const,candidates:rows,missing};
  }));
}
