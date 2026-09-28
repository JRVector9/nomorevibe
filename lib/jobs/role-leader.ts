import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs, roleLeases } from '@/lib/db/schema';
import { jobsForRole, type JobRole } from './catalog';
import type { ProductTransaction } from '@/lib/domain/products/generation';

export type RoleCandidate = {
  role: JobRole;
  instanceId: string;
  bootId: string;
  release: string;
  kind: 'primary' | 'standby';
};
export type RoleLease = RoleCandidate & { epoch: number };
export class RoleLeaseLostError extends Error {
  constructor() { super('role_lease_lost'); }
}

const leaseDuration = sql`now() + interval '45 seconds'`;

/** Legacy single workers have no role token; an incomplete token is never accepted. */
export function roleLeaseFromEnv(role: JobRole, env: Readonly<Record<string, string | undefined>>): RoleLease | undefined {
  const fields = [env.ROLE_LEASE_ROLE, env.ROLE_LEASE_INSTANCE_ID, env.ROLE_LEASE_BOOT_ID,
    env.ROLE_LEASE_RELEASE, env.ROLE_LEASE_EPOCH];
  if (fields.every(value => value === undefined)) return undefined;
  const epoch = Number(env.ROLE_LEASE_EPOCH);
  if (env.ROLE_LEASE_ROLE !== role || !env.ROLE_LEASE_INSTANCE_ID || !env.ROLE_LEASE_BOOT_ID ||
      !env.ROLE_LEASE_RELEASE || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('invalid_role_lease_environment');
  return { role, instanceId: env.ROLE_LEASE_INSTANCE_ID, bootId: env.ROLE_LEASE_BOOT_ID,
    release: env.ROLE_LEASE_RELEASE, epoch, kind: 'primary' };
}

/** Serialize election with token revocation; result writers lock only their job row. */
export async function tryAcquireRole(candidate: RoleCandidate): Promise<RoleLease | null> {
  return db.transaction(async tx => {
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
    for (const name of jobsForRole(candidate.role)) {
      await tx.update(jobs).set({ leaseToken: null, lockedAt: null })
        .where(and(eq(jobs.name, name), sql`${jobs.leaseToken} is not null`));
    }
    return { ...candidate, epoch: claimed.epoch };
  });
}

export async function renewRole(lease: RoleLease): Promise<boolean> {
  const [row] = await db.update(roleLeases).set({ leaseUntil: leaseDuration, updatedAt: sql`now()` })
    .where(and(eq(roleLeases.role, lease.role), eq(roleLeases.ownerInstanceId, lease.instanceId),
      eq(roleLeases.ownerBootId, lease.bootId), eq(roleLeases.ownerRelease, lease.release),
      eq(roleLeases.epoch, lease.epoch), gt(roleLeases.leaseUntil, sql`now()`)))
    .returning({ role: roleLeases.role });
  return Boolean(row);
}

/** Called after a successful graceful drain. A crash must wait for expiry instead. */
export async function releaseRole(lease: RoleLease): Promise<boolean> {
  return db.transaction(async tx => {
    const [owned] = await tx.select().from(roleLeases).where(and(
      eq(roleLeases.role, lease.role), eq(roleLeases.ownerInstanceId, lease.instanceId),
      eq(roleLeases.ownerBootId, lease.bootId), eq(roleLeases.epoch, lease.epoch),
    )).for('update');
    if (!owned) return false;
    await tx.update(roleLeases).set({ ownerInstanceId: null, ownerBootId: null, ownerKind: null,
      primaryBoots: lease.kind === 'primary' ? [] : owned.primaryBoots,
      leaseUntil: sql`now()`, updatedAt: sql`now()` }).where(eq(roleLeases.role, lease.role));
    for (const name of jobsForRole(lease.role)) await tx.update(jobs).set({ leaseToken: null, lockedAt: null })
      .where(and(eq(jobs.name, name), sql`${jobs.leaseToken} is not null`));
    return true;
  });
}

/** Take this lock before claiming a job; takeover obtains UPDATE on the same row. */
export async function assertRoleLease(tx: ProductTransaction, lease: RoleLease): Promise<void> {
  const [row] = await tx.select({ role: roleLeases.role }).from(roleLeases).where(and(
    eq(roleLeases.role, lease.role), eq(roleLeases.ownerInstanceId, lease.instanceId),
    eq(roleLeases.ownerBootId, lease.bootId), eq(roleLeases.ownerRelease, lease.release),
    eq(roleLeases.epoch, lease.epoch), gt(roleLeases.leaseUntil, sql`now()`),
  )).for('share');
  if (!row) throw new RoleLeaseLostError();
}
