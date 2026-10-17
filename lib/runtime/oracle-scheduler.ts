import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { jobBatchCandidates, operationsObservations } from '@/lib/db/schema';
import { batchPolicyHash, batchPolicySchema } from '@/lib/jobs/batches';
import { lockJobBatch } from '@/lib/jobs/batch-repository';
import { markSchedulerSeen, requestDueJobs } from '@/lib/jobs/control';
import { writerSiteActive } from '@/lib/operations/dr/epoch';
import { oracleSchedulerIdentity, oracleSchedulerResultKey, oracleSchedulerResultSchema, type OracleSchedulerIdentity,
  type OracleSchedulerResult } from './oracle-scheduler-evidence';

const HOST = 'oracle-osaka-smoke';

/**
 * The scheduler principal's candidate heartbeat: identity columns only, exactly like a worker heartbeat (capability/result evidence
 * stay attest-only; the 0098 trigger refuses them on INSERT). Same first locks as role election: DR writer fence, then batch SHARE.
 * A fenced DB or a policy without this instance/release records nothing.
 */
export async function recordOracleSchedulerBoot(identity: OracleSchedulerIdentity, bootId: string): Promise<void> {
  const recorded = await onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return false;
    const control = await lockJobBatch(tx);
    const policy = batchPolicySchema.safeParse(control.policy);
    if (!policy.success || batchPolicyHash(policy.data) !== control.policyHash || policy.data.release !== identity.release
      || !policy.data.instances.some(row => row.instanceId === identity.instanceId && row.host === HOST)) return false;
    const values = { host: HOST, bootId, release: identity.release, policyHash: control.policyHash!, observedAt: sql`clock_timestamp()` };
    await tx.insert(jobBatchCandidates).values({ role: 'scheduler', instanceId: identity.instanceId, ...values })
      .onConflictDoUpdate({ target: [jobBatchCandidates.role, jobBatchCandidates.instanceId], set: values });
    return true;
  }));
  if (!recorded) throw new Error('oracle_scheduler_boot_unrecorded');
}

/** One boot per process. record() retries until it succeeds once; until then recorded() is false. */
export function oracleSchedulerBoot(env: Readonly<Record<string, string | undefined>>) {
  const identity = oracleSchedulerIdentity(env), bootId = randomUUID();
  let recorded = false;
  return { bootId, recorded: () => recorded,
    record: async () => { if (!recorded) { await recordOracleSchedulerBoot(identity, bootId); recorded = true; } } };
}

/** One real scheduler tick plus its ACK inside the requestDueJobs transaction. A fenced DB commits neither and returns null. */
export async function runOracleSchedulerTick(identity: OracleSchedulerIdentity, bootId: string): Promise<OracleSchedulerResult | null> {
  await markSchedulerSeen();
  let result: OracleSchedulerResult | null = null;
  await requestDueJobs(async (tx, tick) => {
    // tickAt is this transaction's now(): every jobs row it scheduled was compared and written against it.
    const [clock] = await tx.execute<{ tickAt: string; recordedAt: string }>(sql`SELECT
      to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "tickAt",
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"`);
    const value = oracleSchedulerResultSchema.parse({ role: 'scheduler', instanceId: identity.instanceId, host: HOST, release: identity.release,
      bootId, batchEpoch: tick.batchEpoch, requested: tick.requested, tickAt: clock.tickAt, recordedAt: clock.recordedAt });
    await tx.insert(operationsObservations).values({ key: oracleSchedulerResultKey(identity.instanceId), value: { schedulerResult: value },
      observedAt: sql`clock_timestamp()` }).onConflictDoUpdate({ target: operationsObservations.key,
      set: { value: { schedulerResult: value }, observedAt: sql`clock_timestamp()` } });
    result = value;
  });
  return result;
}
