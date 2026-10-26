import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { assertJobBatchAdmission } from '@/lib/jobs/batch-repository';
import { assertJobLeaseAtWallTime, type JobLease } from '@/lib/jobs/control';
import { assertRoleLease, roleLeaseFromEnv } from '@/lib/jobs/role-leader';
import { lockModelCapacityCallerControl } from '@/lib/llm/capacity-repository';
import { modelCapacityPolicyHash, parseModelCapacityPolicy } from '@/lib/llm/capacity';

export const PUBLISHER_DRAIN_KEY = 'publisher:classification-draining';
const FRESH_MS = 60_000;
const positive = z.number().int().positive().safe();
const counter = z.number().int().nonnegative().safe();
const stamp = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
const capacity = z.object({ epoch: positive, revision: positive, policyHash: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: stamp }).strict();
const role = z.object({ instanceId: z.string().min(1), bootId: z.uuid(), release: z.string().min(1), epoch: positive,
  kind: z.enum(['primary', 'standby']) }).strict();
const generation = z.object({ requestedVersion: counter, processedVersion: counter, runs: positive, lastRunAt: stamp }).strict();
const evidence = z.object({ version: z.literal(1), reason: z.literal('classification_draining'), capacity, role,
  job: generation.extend({ name: z.literal('crawl-publish'), token: z.uuid() }).strict() }).strict();
const snapshot = z.object({ value: evidence, observedAt: z.number().finite(), at: z.number().finite(),
  capacity, policy: z.unknown(), mode: z.literal('draining'), writerActive: z.literal(true), batchMode: z.literal('legacy'),
  role, roleLive: z.literal(true), job: generation.extend({ token: z.uuid().nullable(), lastError: z.null(),
    claimLive: z.boolean(), released: z.boolean() }).strict() }).strict();

/** An advisory observation, never admission authority. Missing/unknown/stale evidence leaves normal alarms intact. */
export function publisherClassificationDrainHeld(value: unknown): boolean {
  const parsed = snapshot.safeParse(value);
  if (!parsed.success) return false;
  const row = parsed.data, proof = row.value;
  try { if (modelCapacityPolicyHash(parseModelCapacityPolicy(row.policy)) !== row.capacity.policyHash) return false; }
  catch { return false; }
  return row.at >= row.observedAt && row.at - row.observedAt <= FRESH_MS
    && JSON.stringify(proof.capacity) === JSON.stringify(row.capacity)
    && JSON.stringify(proof.role) === JSON.stringify(row.role)
    && proof.job.requestedVersion === row.job.requestedVersion && proof.job.processedVersion === row.job.processedVersion
    && proof.job.runs === row.job.runs && proof.job.lastRunAt === row.job.lastRunAt
    && row.job.requestedVersion > row.job.processedVersion
    && (row.job.released && row.job.token === null || row.job.claimLive && row.job.token === proof.job.token);
}

/** Called only for the publisher's typed draining refusal. Locks retain capacity → batch → role → job order. */
export async function recordPublisherClassificationDraining(lease: JobLease | undefined): Promise<void> {
  if (currentReplayDb() || !lease || lease.name !== 'crawl-publish') return;
  const owner = roleLeaseFromEnv('publisher', process.env);
  if (!owner || owner.batchVersion === 1) return;
  await onPrimary(() => db.transaction(async tx => {
    const control = await lockModelCapacityCallerControl(tx);
    if (control.mode !== 'draining' || !control.policyHash) return;
    await assertJobBatchAdmission(tx, 'crawl-publish', owner);
    await assertRoleLease(tx, owner);
    await assertJobLeaseAtWallTime(tx, lease, 'update');
    // All timestamps/generations are captured from the same primary statement. A fenced site cannot write a hint.
    await tx.execute(sql`INSERT INTO operations_observations(key,value,observed_at)
      SELECT ${PUBLISHER_DRAIN_KEY}, jsonb_build_object('version',1,'reason','classification_draining',
        'capacity',jsonb_build_object('epoch',c.epoch,'revision',c.revision,'policyHash',c.policy_hash,
          'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
        'role',jsonb_build_object('instanceId',r.owner_instance_id,'bootId',r.owner_boot_id,'release',r.owner_release,
          'epoch',r.epoch,'kind',r.owner_kind),
        'job',jsonb_build_object('name',j.name,'token',j.lease_token,'requestedVersion',j.requested_version,
          'processedVersion',j.processed_version,'runs',j.runs,
          'lastRunAt',to_char(j.last_run_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),clock_timestamp() AT TIME ZONE 'UTC'
      FROM model_capacity_control c CROSS JOIN role_leases r CROSS JOIN jobs j CROSS JOIN dr_writer_fence f
      WHERE c.id=1 AND c.mode='draining' AND c.epoch=${control.epoch} AND c.revision=${control.revision}
        AND c.policy_hash=${control.policyHash} AND f.id=1 AND f.state='active'
        AND r.role='publisher' AND r.owner_instance_id=${owner.instanceId} AND r.owner_boot_id=${owner.bootId}
        AND r.owner_release=${owner.release} AND r.epoch=${owner.epoch} AND r.lease_until>clock_timestamp()
        AND j.name='crawl-publish' AND j.lease_token=${lease.token} AND j.requested_version=${lease.requestedVersion}
        AND j.locked_at>=clock_timestamp()-interval '90 seconds' AND j.last_error IS NULL
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at`);
  }));
}

/** Nonlocking SELECT-only snapshot: the hint is checked against current primary policy, role and exact job execution. */
export async function readPublisherClassificationDrain(): Promise<boolean> {
  if (currentReplayDb()) return false;
  const [row] = await onPrimary(() => db.execute<{ value: unknown }>(sql`SELECT jsonb_build_object(
    'value',o.value,'observedAt',extract(epoch FROM o.observed_at)*1000,'at',extract(epoch FROM clock_timestamp())*1000,
    'mode',c.mode,'policy',c.policy,'writerActive',f.state='active','batchMode',b.mode,
    'capacity',jsonb_build_object('epoch',c.epoch,'revision',c.revision,'policyHash',c.policy_hash,
      'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'role',jsonb_build_object('instanceId',r.owner_instance_id,'bootId',r.owner_boot_id,'release',r.owner_release,
      'epoch',r.epoch,'kind',r.owner_kind),'roleLive',r.lease_until>clock_timestamp(),
    'job',jsonb_build_object('token',j.lease_token,'requestedVersion',j.requested_version,'processedVersion',j.processed_version,
      'runs',j.runs,'lastRunAt',to_char(j.last_run_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'lastError',j.last_error,
      'claimLive',coalesce(j.lease_token IS NOT NULL AND j.locked_at>=clock_timestamp()-interval '90 seconds',false),
      'released',j.lease_token IS NULL AND j.locked_at IS NULL)) AS value
    FROM operations_observations o CROSS JOIN model_capacity_control c CROSS JOIN role_leases r CROSS JOIN jobs j
      CROSS JOIN dr_writer_fence f CROSS JOIN job_batch_control b
    WHERE o.key=${PUBLISHER_DRAIN_KEY} AND c.id=1 AND r.role='publisher' AND j.name='crawl-publish' AND f.id=1 AND b.id=1`));
  return publisherClassificationDrainHeld(row?.value);
}
