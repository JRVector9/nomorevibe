import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { evidenceSourceClaims, evidenceSourceControl, jobBatchControl, jobBatchCandidates, jobs, operationsObservations, pipelineItemLeases, roleLeases } from '@/lib/db/schema';
import { JOB_CATALOG } from './catalog';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { batchCandidateSchema, batchLeaseSchema, batchHostOrder, batchJobsForRole, batchPolicyHash, batchPolicySchema, BATCH_ROLES,
  batchCanaryAnchorKey, classifyBatchCandidateEvidence, type BatchCanaryCandidate, type BatchHost, type BatchMode, type BatchRole,
  batchBootstrapEligible, batchBootstrapGrantSchema, classifyBatchBootstrap } from './batches';
import { STALE_LOCK_MS } from './lease';
import type { RoleCandidate, RoleLease } from './role-leader';
import { writerSiteActive } from '@/lib/operations/dr/epoch';

export class JobBatchBlockedError extends Error { constructor() { super('job_batch_blocked'); } }
export type BatchExecutionIdentity = { role: BatchRole; host: BatchHost; instanceId: string; bootId: string; release: string; batchEpoch: number };

/** All runtime admissions take this before role/job locks. Existing writers retain their own tokens. */
export async function lockJobBatch(tx: ProductTransaction) {
  const [row] = await tx.select().from(jobBatchControl).where(eq(jobBatchControl.id,1)).for('share');
  if (!row) throw new Error('job_batch_control_missing');
  return row;
}
function checkedPolicy(row: typeof jobBatchControl.$inferSelect) {
  const policy = batchPolicySchema.parse(row.policy);
  if (batchPolicyHash(policy) !== row.policyHash) throw new Error('job_batch_policy_mismatch');
  return policy;
}
export async function assertJobBatchAdmission(tx: ProductTransaction, name: string, lease?: RoleLease): Promise<BatchExecutionIdentity | null> {
  const row = await lockJobBatch(tx);
  if (row.mode === 'draining') throw new JobBatchBlockedError();
  if (row.mode === 'legacy') {
    if (JOB_CATALOG.some(job => job.name === name && job.batchVersion === 1) || lease?.batchVersion ||
      (lease && !batchJobsForRole(lease.role,'legacy').includes(name))) throw new JobBatchBlockedError();
    // Optional operator policy only adds execution provenance, never activates a role.
    if (!lease || !row.policy) return null;
    const policy = checkedPolicy(row), instance = policy.instances.find(item => item.instanceId === lease.instanceId);
    return instance && policy.release === lease.release ? { role: lease.role, host: instance.host,
      instanceId: lease.instanceId, bootId: lease.bootId, release: lease.release, batchEpoch: row.epoch } : null;
  }
  if (row.writerContractVersion < 1 || !lease || lease.batchVersion !== 1 || lease.batchEpoch !== row.epoch ||
    !batchJobsForRole(lease.role,'versioned').includes(name)) throw new JobBatchBlockedError();
  const policy = checkedPolicy(row), instance = policy.instances.find(item => item.instanceId === lease.instanceId);
  if (!instance || instance.host !== lease.host || lease.release !== policy.release) throw new JobBatchBlockedError();
  // Serialize short admissions for this role; in-flight work never holds this lock.
  await tx.select({role:roleLeases.role}).from(roleLeases).where(eq(roleLeases.role,lease.role)).for('update');
  const [candidate] = await tx.select().from(jobBatchCandidates).where(and(eq(jobBatchCandidates.role,lease.role),eq(jobBatchCandidates.instanceId,lease.instanceId),eq(jobBatchCandidates.bootId,lease.bootId),eq(jobBatchCandidates.release,lease.release),eq(jobBatchCandidates.policyHash,row.policyHash!)));
  const [clock] = await tx.select({now:sql<string>`clock_timestamp()::text`}).from(jobBatchControl).where(eq(jobBatchControl.id,1));
  if (!candidate || !(await candidateReadiness(tx,candidate,new Date(clock.now),row.epoch)
    || await bootstrapReadiness(tx,candidate,new Date(clock.now),row.epoch))) throw new JobBatchBlockedError();
  if (lease.role === 'translation') {
    const [busy] = await tx.select({name:jobs.name}).from(jobs).where(and(inArray(jobs.name,batchJobsForRole('translation','versioned')),sql`${jobs.name}<>${name}`,sql`${jobs.leaseToken} is not null AND ${jobs.lockedAt}>=clock_timestamp()-${STALE_LOCK_MS}*interval '1 millisecond'`)).limit(1);
    if (busy) throw new JobBatchBlockedError();
  }
  return { role: lease.role, host: instance.host, instanceId: lease.instanceId, bootId: lease.bootId,
    release: lease.release, batchEpoch: row.epoch };
}
export async function batchPendingNames(role: BatchRole): Promise<string[]> {
  return onPrimary(async () => {
    const [row] = await db.select().from(jobBatchControl).where(eq(jobBatchControl.id,1));
    if (!row) throw new Error('job_batch_control_missing');
    return batchJobsForRole(role,row.mode);
  });
}
function resultCount(name: string, events: Array<{event:string;counts:Record<string,number|boolean>}>) {
  const keys: Record<string, readonly [string,string]> = {
    'reason-translate': ['translate.done','translated'], 'product-tagline-ko': ['tagline_ko.done','written'],
    'product-translate': ['product_translation.tick','stored'], 'news-refresh': ['news.refreshed','added'],
    'crawl-fetch':['crawl.fetched','fetched'], 'second-review':['crawl.second_reviewed','reviewed'],
    'crawl-publish':['crawl.publish_done','published'], 'product-search-profile':['search_profile.done','written'],
    'click-rollup':['clicks.rolled','rows'], 'uptime-ping':['uptime.checked','alive'],
    'product-site-evidence-refresh':['evidence.site_refresh_batch','succeeded'],
  };
  const key = keys[name];
  if (!key) return 0;
  return events.filter(event => event.event === key[0]).reduce((count,event) => Math.max(count,typeof event.counts[key[1]] === 'number' ? Number(event.counts[key[1]]) : 0),0);
}
/** Stored in the same successful ACK TX. Empty ticks and failed/deferred handlers never certify results. */
export function batchResultObservation(identity: BatchExecutionIdentity | null, name: string, events: Array<{event:string;counts:Record<string,number|boolean>}>, version: number) {
  const count = resultCount(name,events);
  return identity && count > 0 ? { ...identity, job: name, count, requestedVersion: version } : null;
}
async function candidateEvidence(tx: ProductTransaction, candidate: BatchCanaryCandidate, now: Date, controlEpoch: number) {
  const names = batchJobsForRole(candidate.role,'versioned'), anchorKey = batchCanaryAnchorKey(candidate.role,candidate.instanceId);
  const observations = await tx.select().from(operationsObservations).where(inArray(operationsObservations.key,
    [anchorKey,...names.map(name => `batch-result:${candidate.instanceId}:${name}`)]));
  const anchor=observations.find(row=>row.key===anchorKey);
  return classifyBatchCandidateEvidence({candidate,controlEpoch,at:now.getTime(),anchor:anchor?.value,
    latest:observations.filter(row=>row.key!==anchorKey).map(row=>({key:row.key,result:row.value.batchResult}))});
}
async function candidateReadiness(tx: ProductTransaction, candidate: typeof jobBatchCandidates.$inferSelect, now: Date, controlEpoch: number) {
  return (await candidateEvidence(tx,{...candidate,role:candidate.role as BatchRole,host:candidate.host as BatchHost},now,controlEpoch)).report.ready;
}
/** Separate first-ACK path (classifyBatchBootstrap); normal candidates never reach the extra read. */
async function bootstrapReadiness(tx: ProductTransaction, candidate: typeof jobBatchCandidates.$inferSelect, now: Date, controlEpoch: number) {
  const role = candidate.role as BatchRole;
  if (!batchBootstrapEligible(role) || !batchBootstrapGrantSchema.safeParse(candidate.resultEvidence).success) return false;
  const [prior] = await tx.select({key:operationsObservations.key}).from(operationsObservations).where(inArray(operationsObservations.key,
    [batchCanaryAnchorKey(role,candidate.instanceId),...batchJobsForRole(role,'versioned').map(name => `batch-result:${candidate.instanceId}:${name}`)])).limit(1);
  return classifyBatchBootstrap({candidate:{...candidate,role,host:candidate.host as BatchHost},controlEpoch,at:now.getTime(),prior:Boolean(prior)}).ready;
}
/** Only the successful acquirer pins an already operator-verified ACK. Never refresh an existing anchor. */
async function pinCandidateCanary(tx: ProductTransaction, row: typeof jobBatchCandidates.$inferSelect, controlEpoch: number) {
  const candidate={...row,role:row.role as BatchRole,host:row.host as BatchHost};
  const [clock]=await tx.execute<{at:string}>(sql`SELECT clock_timestamp()::text AS at`);
  const evidence=await candidateEvidence(tx,candidate,new Date(clock.at),controlEpoch);
  if(!evidence.report.ready) throw new JobBatchBlockedError();
  if(evidence.anchorToPin) await tx.insert(operationsObservations).values({key:batchCanaryAnchorKey(candidate.role,candidate.instanceId),
    value:evidence.anchorToPin,observedAt:sql`clock_timestamp()`}).onConflictDoNothing();
  // Re-read after possible INSERT/unique-key wait. A foreign/changed anchor is never overwritten.
  const [after]=await tx.execute<{at:string}>(sql`SELECT clock_timestamp()::text AS at`);
  const checked=await candidateEvidence(tx,candidate,new Date(after.at),controlEpoch);
  if(!checked.report.ready || checked.anchorToPin) throw new JobBatchBlockedError();
  return new Date(after.at);
}
/** Candidate heartbeat cannot write capability or result evidence. Operator evidence is separately reviewed. */
export async function acquireBatchRole(value: RoleCandidate): Promise<RoleLease | null> {
  const candidate = batchCandidateSchema.parse(value);
  return onPrimary(async () => { try { return await db.transaction(async tx => {
    // DR fence가 첫 lock이다(legacy tryAcquireRole과 같은 순서). fenced DB에서는 역할을 얻지 않는다.
    if (!await writerSiteActive(tx)) return null;
    const control = await lockJobBatch(tx);
    if (control.mode !== 'versioned' || control.writerContractVersion < 1 || candidate.batchVersion !== 1) return null;
    const policy = checkedPolicy(control), instance = policy.instances.find(item => item.instanceId === candidate.instanceId);
    if (!instance || instance.host !== candidate.host || candidate.release !== policy.release || !BATCH_ROLES.includes(candidate.role)) return null;
    await tx.insert(jobBatchCandidates).values({ role:candidate.role,instanceId:candidate.instanceId,host:instance.host,
      bootId:candidate.bootId,release:candidate.release,policyHash:control.policyHash!,observedAt:sql`clock_timestamp()` })
      .onConflictDoUpdate({target:[jobBatchCandidates.role,jobBatchCandidates.instanceId],set:{host:instance.host,bootId:candidate.bootId,
        release:candidate.release,policyHash:control.policyHash!,observedAt:sql`clock_timestamp()`}});
    await tx.insert(roleLeases).values({role:candidate.role}).onConflictDoNothing();
    const [current] = await tx.select().from(roleLeases).where(eq(roleLeases.role,candidate.role)).for('update');
    const [clock] = await tx.select({now:sql<string>`clock_timestamp()::text`}).from(jobBatchControl).where(eq(jobBatchControl.id,1));
    const now = new Date(clock.now);
    if (current.leaseUntil > now) {
      if(current.ownerInstanceId !== candidate.instanceId || current.ownerBootId !== candidate.bootId || current.ownerRelease !== candidate.release) return null;
      const [own]=await tx.select().from(jobBatchCandidates).where(and(eq(jobBatchCandidates.role,candidate.role),eq(jobBatchCandidates.instanceId,candidate.instanceId)));
      const checkedAt=await pinCandidateCanary(tx,own,control.epoch);
      if(current.leaseUntil<=checkedAt) throw new JobBatchBlockedError();
      return {...candidate,epoch:current.epoch,batchEpoch:control.epoch};
    }
    const candidates = await tx.select().from(jobBatchCandidates).where(and(eq(jobBatchCandidates.role,candidate.role),eq(jobBatchCandidates.policyHash,control.policyHash!),
      sql`${jobBatchCandidates.observedAt} >= clock_timestamp() - interval '30 seconds'`));
    const ready = [];
    for (const row of candidates) {
      if (row.release !== policy.release || !policy.instances.some(item => item.instanceId === row.instanceId && item.host === row.host)) continue;
      if (await candidateReadiness(tx,row,now,control.epoch)) ready.push(row);
    }
    ready.sort((a,b) => batchHostOrder(candidate.role).indexOf(a.host as BatchHost)-batchHostOrder(candidate.role).indexOf(b.host as BatchHost) || a.instanceId.localeCompare(b.instanceId));
    // A bootstrap grant elects only its own exact boot, and only while no candidate of the role is normally ready.
    const own = candidates.find(row => row.instanceId === candidate.instanceId && row.bootId === candidate.bootId && row.release === policy.release && row.host === instance.host);
    const bootstrap = !ready.length && Boolean(own) && await bootstrapReadiness(tx,own!,now,control.epoch);
    if (!bootstrap && (ready[0]?.instanceId !== candidate.instanceId || ready[0]?.bootId !== candidate.bootId)) return null;
    const rank = batchHostOrder(candidate.role).indexOf(instance.host);
    if (rank > 0 && current.leaseUntil.getTime() + rank * 20_000 > now.getTime()) return null;
    // There is no verified ACK to pin before the first one; the PR10d anchor starts with the later normal canary.
    if (!bootstrap) await pinCandidateCanary(tx,ready[0],control.epoch);
    // Election does not revoke either healthy jobs or independently owned item leases.
    const [claimed] = await tx.update(roleLeases).set({ownerInstanceId:candidate.instanceId,ownerBootId:candidate.bootId,
      ownerKind:candidate.kind,ownerRelease:candidate.release,epoch:sql`${roleLeases.epoch}+1`,leaseUntil:sql`clock_timestamp()+interval '45 seconds'`,updatedAt:sql`clock_timestamp()`})
      .where(and(eq(roleLeases.role,candidate.role),sql`${roleLeases.epoch}<9007199254740991`)).returning({epoch:roleLeases.epoch});
    if (!claimed) throw new Error('role_epoch_exhausted');
    return {...candidate,epoch:claimed.epoch,batchEpoch:control.epoch};
  }); } catch(error) { if(error instanceof JobBatchBlockedError) return null; throw error; } });
}
export async function renewBatchRole(value: RoleLease): Promise<boolean> {
  const lease = batchLeaseSchema.parse(value);
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return false;
    const control = await lockJobBatch(tx);
    if ((control.mode !== 'versioned' && !(control.mode === 'draining' && control.drainingFrom === 'versioned')) || lease.batchEpoch !== control.epoch) return false;
    await tx.select().from(roleLeases).where(eq(roleLeases.role,lease.role)).for('update');
    const [row] = await tx.update(roleLeases).set({leaseUntil:sql`clock_timestamp()+interval '45 seconds'`,updatedAt:sql`clock_timestamp()`})
      .where(and(eq(roleLeases.role,lease.role),eq(roleLeases.ownerInstanceId,lease.instanceId),eq(roleLeases.ownerBootId,lease.bootId),
        eq(roleLeases.ownerRelease,lease.release),eq(roleLeases.epoch,lease.epoch),sql`${roleLeases.leaseUntil}>clock_timestamp()`)).returning({role:roleLeases.role});
    return Boolean(row);
  }));
}
export async function releaseBatchRole(value: RoleLease): Promise<boolean> {
  const lease = batchLeaseSchema.parse(value);
  return onPrimary(() => db.transaction(async tx => {
    const control = await lockJobBatch(tx);
    if (lease.batchEpoch !== control.epoch) return false;
    const [owned] = await tx.select().from(roleLeases).where(and(eq(roleLeases.role,lease.role),eq(roleLeases.ownerInstanceId,lease.instanceId),
      eq(roleLeases.ownerBootId,lease.bootId),eq(roleLeases.ownerRelease,lease.release),eq(roleLeases.epoch,lease.epoch))).for('update');
    if (!owned) return false;
    const names = batchJobsForRole(lease.role,'versioned');
    if (names.length) {
      const active = await tx.select({name:jobs.name}).from(jobs).where(and(inArray(jobs.name,names),sql`${jobs.leaseToken} is not null AND ${jobs.lockedAt} >= clock_timestamp()-${STALE_LOCK_MS}*interval '1 millisecond'`));
      if (active.length) return false;
    }
    await tx.update(roleLeases).set({ownerInstanceId:null,ownerBootId:null,ownerKind:null,leaseUntil:sql`clock_timestamp()`,updatedAt:sql`clock_timestamp()`}).where(eq(roleLeases.role,lease.role));
    return true;
  }));
}
export async function beginJobBatchDrain() {
  return onPrimary(() => db.transaction(async tx => {
    const [row] = await tx.select().from(jobBatchControl).where(eq(jobBatchControl.id,1)).for('update');
    if (!row || row.writerContractVersion < 1) throw new Error('job_batch_contract_required');
    if (row.mode === 'draining') throw new Error('job_batch_transition_invalid');
    await tx.update(jobBatchControl).set({mode:'draining',drainingFrom:row.mode,updatedAt:sql`clock_timestamp()`}).where(eq(jobBatchControl.id,1));
  }));
}
export async function completeJobBatchTransition(target: Exclude<BatchMode,'draining'>) {
  return onPrimary(() => db.transaction(async tx => {
    const [row] = await tx.select().from(jobBatchControl).where(eq(jobBatchControl.id,1)).for('update');
    if (!row || row.writerContractVersion < 1) throw new Error('job_batch_contract_required');
    if (row.mode !== 'draining' || target === row.drainingFrom) throw new Error('job_batch_transition_invalid');
    if (target === 'versioned') checkedPolicy(row);
    // Existing renew/result TXs start with this control lock and may later need
    // a job row. Wait here before roles/jobs so neither a pending renew nor an
    // opposite source->job lock order can be hidden by the old expiry snapshot.
    const [sourceControl] = await tx.select({id:evidenceSourceControl.id}).from(evidenceSourceControl)
      .where(eq(evidenceSourceControl.id,1)).for('update');
    if (!sourceControl) throw new Error('evidence_source_control_missing');
    await tx.select({role:roleLeases.role}).from(roleLeases).orderBy(roleLeases.role).for('update');
    await tx.select({name:jobs.name}).from(jobs).orderBy(jobs.name).for('update');
    // Wall time is evaluated again after all job-row waits.
    const [active] = await tx.select({name:jobs.name}).from(jobs).where(sql`${jobs.leaseToken} is not null AND ${jobs.lockedAt} >= clock_timestamp()-${STALE_LOCK_MS}*interval '1 millisecond'`).limit(1);
    const [item] = await tx.select({key:pipelineItemLeases.workKey}).from(pipelineItemLeases).where(sql`${pipelineItemLeases.token} is not null AND ${pipelineItemLeases.leaseUntil}>clock_timestamp()`).limit(1);
    const [role] = await tx.select({role:roleLeases.role}).from(roleLeases).where(sql`${roleLeases.ownerInstanceId} is not null AND ${roleLeases.leaseUntil}>clock_timestamp()`).limit(1);
    const [source] = await tx.select({id:evidenceSourceClaims.productId}).from(evidenceSourceClaims)
      .where(sql`${evidenceSourceClaims.token} is not null AND ${evidenceSourceClaims.leaseUntil}>clock_timestamp()`).limit(1);
    if (active || item || role || source) throw new Error('job_batch_not_drained');
    const [updated] = await tx.update(jobBatchControl).set({mode:target,drainingFrom:null,epoch:sql`${jobBatchControl.epoch}+1`,updatedAt:sql`clock_timestamp()`})
      .where(and(eq(jobBatchControl.id,1),sql`${jobBatchControl.epoch}<9007199254740991`)).returning();
    if (!updated) throw new Error('job_batch_epoch_exhausted');
    return updated;
  }));
}
