import { and, eq, gt, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { jobs, roleLeases } from '@/lib/db/schema';
import { jobsForRole, JOB_ROLES, type JobRole } from './catalog';
import { BATCH_HOSTS, type BatchRole, type BatchHost } from './batches';
import { acquireBatchRole, boundRoleTransaction, lockJobBatch, releaseBatchRole, renewBatchRole } from './batch-repository';
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
    await boundRoleTransaction(tx);
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
    await boundRoleTransaction(tx);
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

/** 예비 넘겨주기에서 기다리는 주 후보(관측 `candidate:<role>:<instance>`의 boot). */
export type WaitingPrimary = { instanceId: string; bootId: string };
/** 기다리는 주의 관측은 5초마다(선출 실패마다) 새로 쓴다. 이보다 오래된 관측은 살아 있다는 근거가 아니다 */
export const WAITING_PRIMARY_FRESH_SECONDS = 20;

/**
 * 예비가 쥔 legacy lease 에서만: 같은 릴리스의 주 후보가 격리되지 않은 채 선출을 기다리는지 읽는다(잠그지 않는 읽기).
 * 주 후보는 phase=standby(선출 실패 대기)·electable=true(host 장부 준비·DB 실패 연속 없음)인 최근 관측이어야 한다.
 * 이 예비가 아직 그 epoch 의 lease 를 쥐고 있지 않거나 주가 격리 중이면 null 이다. 판정은 DB 시계로 한다.
 */
export async function readWaitingPrimary(lease: RoleLease): Promise<WaitingPrimary | null> {
  if (lease.batchVersion === 1 || lease.kind !== 'standby') return null;
  return onPrimary(() => db.transaction(async tx => {
    await boundRoleTransaction(tx);
    const [row] = await tx.execute<{ owned: boolean; quarantined: boolean }>(sql`SELECT
        (owner_instance_id = ${lease.instanceId} AND owner_boot_id = ${lease.bootId} AND owner_release = ${lease.release}
          AND owner_kind = 'standby' AND epoch = ${lease.epoch} AND lease_until > localtimestamp) IS TRUE AS owned,
        (quarantine_until IS NOT NULL AND quarantine_until > localtimestamp) AS quarantined
      FROM role_leases WHERE role = ${lease.role}`);
    if (!row?.owned || row.quarantined) return null;
    const rows = await tx.execute<{ key: string; value: Record<string, unknown>; age: number }>(sql`SELECT key, value,
        extract(epoch from (localtimestamp - observed_at))::float8 AS age
      FROM operations_observations WHERE key LIKE ${`candidate:${lease.role}:%`} ORDER BY key`);
    for (const { key, value, age } of Array.from(rows)) {
      if (value.role === lease.role && value.kind === 'primary' && value.phase === 'standby' && value.electable === true &&
          value.release === lease.release && typeof value.instanceId === 'string' && value.instanceId !== lease.instanceId &&
          key === `candidate:${lease.role}:${value.instanceId}` && typeof value.bootId === 'string' && value.bootId &&
          Number.isFinite(Number(age)) && Number(age) >= -5 && Number(age) <= WAITING_PRIMARY_FRESH_SECONDS) {
        return { instanceId: value.instanceId, bootId: value.bootId };
      }
    }
    return null;
  }));
}

/**
 * 예비 넘겨주기(2026-10-22 #597): drain 을 마친 예비가 부른다. lease 를 지금 만료시키되 owner 칸은 남긴다.
 * 주 후보는 만료된 lease 를 유예 없이 다음 확인(5초)에서 선출받고(epoch+1·이전 일감 token 무효화는 선출 TX 가 한다),
 * 예비 쪽(이 예비 포함)은 owner 가 남은 만료의 20초 유예 동안 다시 잡지 못한다 — 그 사이 주가 선출되지 않으면(주도 죽었다)
 * 유예 뒤 예비가 다시 맡는다. 이 lease 가 지금도 이 boot·epoch 의 유효한 예비 lease 일 때만 바꾼다.
 */
export async function yieldRoleToPrimary(lease: RoleLease): Promise<boolean> {
  if (lease.batchVersion === 1 || lease.kind !== 'standby') return false;
  return db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return false;
    await boundRoleTransaction(tx);
    if ((await lockJobBatch(tx)).mode !== 'legacy') return false;
    const [owned] = await tx.select({ role: roleLeases.role }).from(roleLeases).where(and(
      eq(roleLeases.role, lease.role), eq(roleLeases.ownerInstanceId, lease.instanceId),
      eq(roleLeases.ownerBootId, lease.bootId), eq(roleLeases.ownerRelease, lease.release),
      eq(roleLeases.ownerKind, 'standby'), eq(roleLeases.epoch, lease.epoch), gt(roleLeases.leaseUntil, sql`now()`),
    )).for('update');
    if (!owned) return false;
    await tx.update(roleLeases).set({ leaseUntil: sql`now()`, updatedAt: sql`now()` }).where(eq(roleLeases.role, lease.role));
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

export type RoleLockHolder = { pid: number; applicationName: string | null; state: string | null; waitEventType: string | null;
  xactAgeSeconds: number | null; blockedBy: number[]; relations: string[] };
/** 선출·갱신이 lock 오류(55P03 등)로 끝난 뒤 한 번 읽는 진단: 선출 표를 잡은 다른 세션과 그 세션을 막는 pid. 쿼리 본문·값은 읽지 않는다. */
export async function readRoleLockHolders(): Promise<RoleLockHolder[]> {
  return onPrimary(() => db.transaction(async tx => {
    await boundRoleTransaction(tx);
    const rows = await tx.execute<{ pid: number; application_name: string | null; state: string | null; wait_event_type: string | null;
      xact_age_s: number | null; blocked_by: number[]; relations: string[] }>(sql`SELECT a.pid, a.application_name, a.state, a.wait_event_type,
        floor(extract(epoch FROM clock_timestamp() - a.xact_start))::int AS xact_age_s, pg_blocking_pids(a.pid) AS blocked_by,
        array_agg(DISTINCT c.relname::text ORDER BY c.relname::text) AS relations
      FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE c.relnamespace = 'public'::regnamespace AND a.pid <> pg_backend_pid()
        AND c.relname IN ('dr_writer_fence', 'job_batch_control', 'role_leases', 'job_batch_candidates', 'jobs')
      GROUP BY a.pid, a.application_name, a.state, a.wait_event_type, a.xact_start ORDER BY a.xact_start NULLS LAST LIMIT 10`);
    return Array.from(rows).map(row => ({ pid: Number(row.pid), applicationName: row.application_name, state: row.state, waitEventType: row.wait_event_type,
      xactAgeSeconds: row.xact_age_s === null ? null : Number(row.xact_age_s), blockedBy: (row.blocked_by ?? []).map(Number), relations: row.relations ?? [] }));
  }));
}
