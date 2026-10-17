import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs, roleLeases } from '@/lib/db/schema';
import { jobsForRole, JOB_ROLES, type JobRole } from './catalog';
import { BATCH_HOSTS, type BatchRole, type BatchHost } from './batches';
import { acquireBatchRole, lockJobBatch, releaseBatchRole, renewBatchRole } from './batch-repository';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { writerSiteActive } from '@/lib/operations/dr/epoch';

export type RoleCandidate = {
  role: BatchRole;
  instanceId: string;
  bootId: string;
  release: string;
  kind: 'primary' | 'standby';
  batchVersion?: 1;
  host?: BatchHost;
};
export type RoleLease = RoleCandidate & { epoch: number; batchEpoch?: number };
/** 선출 TX 안에서 새 취득(만료된 역할)만 막는 hook — false 면 이번 선출에 나서지 않는다. 이미 쥔 역할의 재확인에는 부르지 않는다 */
export type RoleTakeoverGate = (tx: ProductTransaction, role: BatchRole) => Promise<boolean>;
export class RoleLeaseLostError extends Error {
  constructor() { super('role_lease_lost'); }
}

const leaseDuration = sql`now() + interval '45 seconds'`;

/** Legacy single workers have no role token; an incomplete token is never accepted. */
export function roleLeaseFromEnv(role: BatchRole, env: Readonly<Record<string, string | undefined>>): RoleLease | undefined {
  const fields = [env.ROLE_LEASE_ROLE, env.ROLE_LEASE_INSTANCE_ID, env.ROLE_LEASE_BOOT_ID,
    env.ROLE_LEASE_RELEASE, env.ROLE_LEASE_EPOCH];
  if (fields.every(value => value === undefined)) return undefined;
  const epoch = Number(env.ROLE_LEASE_EPOCH);
  if (env.ROLE_LEASE_ROLE !== role || !env.ROLE_LEASE_INSTANCE_ID || !env.ROLE_LEASE_BOOT_ID ||
      !env.ROLE_LEASE_RELEASE || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('invalid_role_lease_environment');
  const batch = env.ROLE_LEASE_BATCH_VERSION;
  const batchEpoch = Number(env.ROLE_LEASE_BATCH_EPOCH);
  if (batch !== undefined && (batch !== '1' || !BATCH_HOSTS.includes(env.ROLE_LEASE_HOST as BatchHost) || !Number.isSafeInteger(batchEpoch) || batchEpoch < 1)) throw new Error('invalid_role_lease_environment');
  if (!batch && !JOB_ROLES.includes(role as JobRole)) throw new Error('invalid_role_lease_environment');
  return { ...(batch ? {batchVersion:1 as const,host:env.ROLE_LEASE_HOST as BatchHost,batchEpoch} : {}), role, instanceId: env.ROLE_LEASE_INSTANCE_ID, bootId: env.ROLE_LEASE_BOOT_ID,
    release: env.ROLE_LEASE_RELEASE, epoch, kind: 'primary' };
}

/** Serialize election with token revocation; result writers lock only their job row. */
export async function tryAcquireRole(candidate: RoleCandidate, takeover?: RoleTakeoverGate): Promise<RoleLease | null> {
  if (candidate.batchVersion === 1) return acquireBatchRole(candidate, takeover);
  if (!JOB_ROLES.includes(candidate.role as JobRole)) return null;
  return db.transaction(async tx => {
    // DR fence가 첫 lock이다. fenced DB(옛 primary·승격 전 복원본)에서는 역할을 얻지 않는다.
    if (!await writerSiteActive(tx)) return null;
    if ((await lockJobBatch(tx)).mode !== 'legacy') return null;
    await tx.insert(roleLeases).values({ role: candidate.role }).onConflictDoNothing();
    const [current] = await tx.select().from(roleLeases)
      .where(eq(roleLeases.role, candidate.role)).for('update');
    if (!current) throw new Error('role_lease_missing');
    const [clock] = await tx.select({ now: sql<Date>`now()` }).from(roleLeases)
      .where(eq(roleLeases.role, candidate.role));
    const now = new Date(String(clock.now));
    if (candidate.kind === 'primary' && current.quarantineUntil && current.quarantineUntil > now) return null;
    if (candidate.kind === 'standby' && current.epoch === 0 &&
        current.updatedAt.getTime() + 20_000 > now.getTime()) return null;
    if (current.leaseUntil > now) {
      if (current.ownerInstanceId === candidate.instanceId && current.ownerBootId === candidate.bootId &&
          current.ownerRelease === candidate.release) return { ...candidate, epoch: current.epoch };
      return null;
    }
    if (candidate.kind === 'standby' && current.epoch > 0) {
      if (current.ownerRelease !== candidate.release) return null;
      if (current.ownerInstanceId && current.leaseUntil.getTime() + 20_000 > now.getTime()) return null;
    }
    if (takeover && !await takeover(tx, candidate.role)) return null;
    const recentBoots = current.primaryBoots.filter(boot => boot.at > now.getTime() - 5 * 60_000);
    if (candidate.kind === 'primary' && current.ownerInstanceId === candidate.instanceId &&
        current.ownerBootId !== candidate.bootId && recentBoots.length >= 3) {
      await tx.update(roleLeases).set({
        primaryBoots: recentBoots, quarantineUntil: sql`now() + interval '15 minutes'`, updatedAt: sql`now()`,
      }).where(eq(roleLeases.role, candidate.role));
      return null;
    }
    const [claimed] = await tx.update(roleLeases).set({
      ownerInstanceId: candidate.instanceId, ownerBootId: candidate.bootId,
      ownerKind: candidate.kind, ownerRelease: candidate.release,
      primaryBoots: candidate.kind === 'primary' ? [...recentBoots, { id: candidate.bootId, at: now.getTime() }] : recentBoots,
      epoch: sql`${roleLeases.epoch} + 1`, leaseUntil: leaseDuration, updatedAt: sql`now()`,
    }).where(eq(roleLeases.role, candidate.role)).returning({ epoch: roleLeases.epoch });
    // A superseded runner must not save a cursor or a late result after this commits.
    for (const name of jobsForRole(candidate.role as JobRole)) {
      await tx.update(jobs).set({ leaseToken: null, lockedAt: null })
        .where(and(eq(jobs.name, name), sql`${jobs.leaseToken} is not null`));
    }
    return { ...candidate, epoch: claimed.epoch };
  });
}

export async function renewRole(lease: RoleLease): Promise<boolean> {
  if (lease.batchVersion === 1) return renewBatchRole(lease);
  return db.transaction(async tx=> {
    if (!await writerSiteActive(tx)) return false;
    const batch=await lockJobBatch(tx);
    if (batch.mode !== 'legacy' && !(batch.mode === 'draining' && batch.drainingFrom === 'legacy')) return false;
    await tx.select({role:roleLeases.role}).from(roleLeases).where(eq(roleLeases.role,lease.role)).for('update');
    const [row] = await tx.update(roleLeases).set({ leaseUntil: sql`clock_timestamp()+interval '45 seconds'`, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(roleLeases.role, lease.role), eq(roleLeases.ownerInstanceId, lease.instanceId),
        eq(roleLeases.ownerBootId, lease.bootId), eq(roleLeases.ownerRelease, lease.release),
        eq(roleLeases.epoch, lease.epoch), gt(roleLeases.leaseUntil, sql`clock_timestamp()`)))
      .returning({ role: roleLeases.role });
    return Boolean(row);
  });
}

/** Called after a successful graceful drain. A crash must wait for expiry instead. */
export async function releaseRole(lease: RoleLease): Promise<boolean> {
  if (lease.batchVersion === 1) return releaseBatchRole(lease);
  return db.transaction(async tx => {
    const batch = await lockJobBatch(tx);
    if (batch.mode === 'versioned') return false;
    if (batch.mode === 'draining') {
      const [active] = await tx.select({name: jobs.name}).from(jobs).where(and(sql`${jobs.name} = any(${jobsForRole(lease.role as JobRole)})`,sql`${jobs.leaseToken} is not null AND ${jobs.lockedAt} >= clock_timestamp() - interval '90 seconds'`)).limit(1);
      if (active) return false;
    }
    const [owned] = await tx.select().from(roleLeases).where(and(
      eq(roleLeases.role, lease.role), eq(roleLeases.ownerInstanceId, lease.instanceId),
      eq(roleLeases.ownerBootId, lease.bootId), eq(roleLeases.epoch, lease.epoch),
    )).for('update');
    if (!owned) return false;
    await tx.update(roleLeases).set({ ownerInstanceId: null, ownerBootId: null, ownerKind: null,
      primaryBoots: lease.kind === 'primary' ? [] : owned.primaryBoots,
      leaseUntil: sql`now()`, updatedAt: sql`now()` }).where(eq(roleLeases.role, lease.role));
    for (const name of jobsForRole(lease.role as JobRole)) await tx.update(jobs).set({ leaseToken: null, lockedAt: null })
      .where(and(eq(jobs.name, name), sql`${jobs.leaseToken} is not null`));
    return true;
  });
}

/** Take this lock before claiming a job; takeover obtains UPDATE on the same row. */
export async function assertRoleLease(tx: ProductTransaction, lease: RoleLease): Promise<void> {
  if (lease.batchVersion === 1) {
    await tx.select({role:roleLeases.role}).from(roleLeases).where(eq(roleLeases.role,lease.role)).for('share');
    const [owned] = await tx.select({role:roleLeases.role}).from(roleLeases).where(and(eq(roleLeases.role,lease.role),eq(roleLeases.ownerInstanceId,lease.instanceId),eq(roleLeases.ownerBootId,lease.bootId),eq(roleLeases.ownerRelease,lease.release),eq(roleLeases.epoch,lease.epoch),sql`${roleLeases.leaseUntil}>clock_timestamp()`));
    if (!owned) throw new RoleLeaseLostError();
    return;
  }
  const [row] = await tx.select({ role: roleLeases.role }).from(roleLeases).where(and(
    eq(roleLeases.role, lease.role), eq(roleLeases.ownerInstanceId, lease.instanceId),
    eq(roleLeases.ownerBootId, lease.bootId), eq(roleLeases.ownerRelease, lease.release),
    eq(roleLeases.epoch, lease.epoch), gt(roleLeases.leaseUntil, sql`now()`),
  )).for('share');
  if (!row) throw new RoleLeaseLostError();
}
