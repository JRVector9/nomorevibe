import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { evidenceSourceClaims, evidenceSourceControl, jobBatchControl, jobBatchCandidates, jobs, operationsObservations, pipelineItemLeases, roleLeases } from '@/lib/db/schema';
import { JOB_CATALOG } from './catalog';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { batchCandidateSchema, batchLeaseSchema, batchHostOrder, batchJobsForRole, batchPolicyHash, batchPolicySchema, BATCH_ROLES,
  batchCanaryAnchorKey, classifyBatchCandidateEvidence, type BatchCanaryCandidate, type BatchHost, type BatchMode, type BatchRole,
  batchBootstrapEligible, batchBootstrapGrantSchema, classifyBatchBootstrap, batchRecanaryGrantSchema, classifyBatchRecanary } from './batches';
import { STALE_LOCK_MS } from './lease';
import type { RoleCandidate, RoleLease, RoleTakeoverGate } from './role-leader';
import { writerSiteActive } from '@/lib/operations/dr/epoch';

export class JobBatchBlockedError extends Error { constructor() { super('job_batch_blocked'); } }
export type BatchExecutionIdentity = { role: BatchRole; host: BatchHost; instanceId: string; bootId: string; release: string; batchEpoch: number };

/**
 * 역할 선출·갱신 TX 의 짧은 상한(DR fence 확인 바로 다음 문장). pgbouncer transaction 모드는 연결 시작 값으로 timeout 을 넘길 수 없어(lib/db/pool.ts)
 * 행 lock 을 쥔 채 남은 TX 가 있으면 선출이 끝없이 기다렸다. TX 안에서만(set_config is_local) 걸고, 이미 더 짧은 값은 늘리지 않는다(feedback 경로와 같은 least).
 * lock 5초·statement 10초: lease 45초·갱신 10초 간격 안에서 lock 을 기다리는 문장(≤4개)이 모두 실패로 끝나 다음 갱신·선출이 새로 판단한다.
 */
export const ROLE_TX_LOCK_TIMEOUT_MS = 5_000, ROLE_TX_STATEMENT_TIMEOUT_MS = 10_000;
export async function boundRoleTransaction(tx: ProductTransaction): Promise<void> {
  await tx.execute(sql`SELECT set_config(name, (CASE WHEN setting::bigint = 0 THEN cap ELSE least(setting::bigint, cap) END)::text || 'ms', true)
    FROM (SELECT name, setting, CASE name WHEN 'lock_timeout' THEN ${ROLE_TX_LOCK_TIMEOUT_MS}::bigint ELSE ${ROLE_TX_STATEMENT_TIMEOUT_MS}::bigint END AS cap
      FROM pg_settings WHERE name IN ('statement_timeout', 'lock_timeout')) s`);
}
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
  // versioned claim·결과 관문도 DR fence 를 본다(acquire/renew 와 같은 판정). batch lock 다음, 역할·후보 행보다 먼저.
  // 이 SHARE lock 은 commit 까지 남아 fence UPDATE 와 직렬화된다: fence 뒤에 commit 되는 versioned claim·결과는 없다.
  if (!await writerSiteActive(tx)) throw new JobBatchBlockedError();
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
/** 잠그지 않는 batch 상태 읽기 — 진행 판정·관리자 목록이 지금 일정·실행이 있는 잡을 고를 때(catalogJobsForBatch) 쓴다 */
export async function readJobBatchMode() {
  const [row] = await db.select({ mode: jobBatchControl.mode, writerContractVersion: jobBatchControl.writerContractVersion })
    .from(jobBatchControl).where(eq(jobBatchControl.id,1));
  if (!row) throw new Error('job_batch_control_missing');
  return row;
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
/** Separate operator-grant paths: first ACK (classifyBatchBootstrap) and stale-result re-canary (classifyBatchRecanary).
 * Normal candidates never reach the extra read. */
async function bootstrapReadiness(tx: ProductTransaction, candidate: typeof jobBatchCandidates.$inferSelect, now: Date, controlEpoch: number) {
  const role = candidate.role as BatchRole;
  if (batchRecanaryGrantSchema.safeParse(candidate.resultEvidence).success) {
    const anchorKey = batchCanaryAnchorKey(role,candidate.instanceId);
    const rows = await tx.select().from(operationsObservations).where(inArray(operationsObservations.key,
      [anchorKey,...batchJobsForRole(role,'versioned').map(name => `batch-result:${candidate.instanceId}:${name}`)]));
    return classifyBatchRecanary({candidate:{...candidate,role,host:candidate.host as BatchHost},controlEpoch,at:now.getTime(),
      anchor:rows.find(row=>row.key===anchorKey)?.value,latest:rows.filter(row=>row.key!==anchorKey).map(row=>({key:row.key,result:row.value.batchResult}))}).ready;
  }
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
export async function acquireBatchRole(value: RoleCandidate, takeover?: RoleTakeoverGate): Promise<RoleLease | null> {
  const candidate = batchCandidateSchema.parse(value);
  return onPrimary(async () => { try { return await db.transaction(async tx => {
    // DR fence가 첫 lock이다(legacy tryAcquireRole과 같은 순서). fenced DB에서는 역할을 얻지 않는다.
    if (!await writerSiteActive(tx)) return null;
    await boundRoleTransaction(tx);
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
    // A bootstrap or re-canary grant elects only its own exact boot, and only while no candidate of the role is normally ready.
    const own = candidates.find(row => row.instanceId === candidate.instanceId && row.bootId === candidate.bootId && row.release === policy.release && row.host === instance.host);
    const bootstrap = !ready.length && Boolean(own) && await bootstrapReadiness(tx,own!,now,control.epoch);
    if (!bootstrap && (ready[0]?.instanceId !== candidate.instanceId || ready[0]?.bootId !== candidate.bootId)) return null;
    const rank = batchHostOrder(candidate.role).indexOf(instance.host);
    if (rank > 0 && current.leaseUntil.getTime() + rank * 20_000 > now.getTime()) return null;
    if (takeover && !await takeover(tx, candidate.role)) return null;
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
    await boundRoleTransaction(tx);
    const control = await lockJobBatch(tx);
    if ((control.mode !== 'versioned' && !(control.mode === 'draining' && control.drainingFrom === 'versioned')) || lease.batchEpoch !== control.epoch) return false;
    await tx.select().from(roleLeases).where(eq(roleLeases.role,lease.role)).for('update');
    const [row] = await tx.update(roleLeases).set({leaseUntil:sql`clock_timestamp()+interval '45 seconds'`,updatedAt:sql`clock_timestamp()`})
      .where(and(eq(roleLeases.role,lease.role),eq(roleLeases.ownerInstanceId,lease.instanceId),eq(roleLeases.ownerBootId,lease.bootId),
        eq(roleLeases.ownerRelease,lease.release),eq(roleLeases.epoch,lease.epoch),sql`${roleLeases.leaseUntil}>clock_timestamp()`)).returning({role:roleLeases.role});
    return Boolean(row);
  }));
}
/**
 * 선출된 versioned lease 의 claim 관문 중 readiness(capability·결과·anchor·bootstrap/re-canary grant)만 읽는다. 잠그지 않는 짧은 읽기 TX 다.
 * 갱신은 readiness 를 보지 않으므로(lease 유지가 claim 권한이 아니다) 결과가 24시간을 넘거나 capability 가 만료돼 모든 claim 이 막혀도 lease 는 남는다.
 * role-worker 는 이것으로 그 상태를 찾아 lease 를 놓는다. versioned 가 아니거나(draining 포함) control epoch 가 바뀌었으면 null(판정 대상 아님 — 갱신이 따로 본다).
 */
export async function batchLeaseAdmission(value: RoleLease): Promise<{ ready: boolean; reason: string } | null> {
  const lease = batchLeaseSchema.parse(value);
  return onPrimary(() => db.transaction(async tx => {
    await boundRoleTransaction(tx);
    const [row] = await tx.select().from(jobBatchControl).where(eq(jobBatchControl.id,1));
    if (!row || row.mode !== 'versioned' || lease.batchEpoch !== row.epoch || !row.policyHash) return null;
    const [candidate] = await tx.select().from(jobBatchCandidates).where(and(eq(jobBatchCandidates.role,lease.role),eq(jobBatchCandidates.instanceId,lease.instanceId),
      eq(jobBatchCandidates.bootId,lease.bootId),eq(jobBatchCandidates.release,lease.release),eq(jobBatchCandidates.policyHash,row.policyHash)));
    if (!candidate) return { ready: false, reason: 'candidate_missing' };
    const [clock] = await tx.select({now:sql<string>`clock_timestamp()::text`}).from(jobBatchControl).where(eq(jobBatchControl.id,1));
    const now = new Date(clock.now);
    // assertJobBatchAdmission 과 같은 술어: 정상 readiness, 아니면 운영자 bootstrap/re-canary grant
    const evidence = await candidateEvidence(tx,{...candidate,role:candidate.role as BatchRole,host:candidate.host as BatchHost},now,row.epoch);
    if (evidence.report.ready || !await bootstrapReadiness(tx,candidate,now,row.epoch)) return evidence.report;
    return { ready: true, reason: 'grant' };
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
  return onPrimary(() => db.transaction(async tx => { await beginJobBatchDrainIn(tx); }));
}
/** Same transition inside a caller TX whose first lock is this control row. */
export async function beginJobBatchDrainIn(tx: ProductTransaction) {
  const [row] = await tx.select().from(jobBatchControl).where(eq(jobBatchControl.id,1)).for('update');
  if (!row || row.writerContractVersion < 1) throw new Error('job_batch_contract_required');
  if (row.mode === 'draining') throw new Error('job_batch_transition_invalid');
  const [updated] = await tx.update(jobBatchControl).set({mode:'draining',drainingFrom:row.mode,updatedAt:sql`clock_timestamp()`}).where(eq(jobBatchControl.id,1)).returning();
  return updated;
}
export async function completeJobBatchTransition(target: Exclude<BatchMode,'draining'>) {
  return onPrimary(() => db.transaction(tx => completeJobBatchTransitionIn(tx,target)));
}
export async function completeJobBatchTransitionIn(tx: ProductTransaction, target: Exclude<BatchMode,'draining'>) {
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
}
/** Operator policy write. Legacy only: versioned elections and candidates are bound to the current hash. */
export async function setJobBatchPolicy(tx: ProductTransaction, value: unknown) {
  const [row] = await tx.select().from(jobBatchControl).where(eq(jobBatchControl.id,1)).for('update');
  if (!row) throw new Error('job_batch_control_missing');
  if (row.mode !== 'legacy') throw new Error('job_batch_transition_invalid');
  const policy = batchPolicySchema.parse(value);
  const [updated] = await tx.update(jobBatchControl).set({policy,policyHash:batchPolicyHash(policy),updatedAt:sql`clock_timestamp()`})
    .where(eq(jobBatchControl.id,1)).returning();
  return updated;
}
/** Operator attestation for versioned writers. Legacy only, one step up, never lowered. */
export async function bumpJobBatchContract(tx: ProductTransaction) {
  const [row] = await tx.select().from(jobBatchControl).where(eq(jobBatchControl.id,1)).for('update');
  if (!row) throw new Error('job_batch_control_missing');
  if (row.mode !== 'legacy') throw new Error('job_batch_transition_invalid');
  const [updated] = await tx.update(jobBatchControl).set({writerContractVersion:row.writerContractVersion+1,updatedAt:sql`clock_timestamp()`})
    .where(eq(jobBatchControl.id,1)).returning();
  return updated;
}
