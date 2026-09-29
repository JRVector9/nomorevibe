import { like, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { operationsObservations, roleLeases } from '@/lib/db/schema';

export const FAILOVER_ROLES = ['crawler', 'reviewer', 'publisher', 'maintenance', 'text'] as const;
export type FailoverRole = typeof FAILOVER_ROLES[number];

export type ReadinessSnapshot = {
  leases: Array<{ role: string; ownerInstanceId: string | null; ownerBootId: string | null;
    ownerKind: string | null; ownerRelease: string | null; epoch: number;
    secondsUntilExpiry: number; quarantineSeconds: number | null }>;
  candidates: Array<{ role: string; instanceId: string; kind: string; phase: string;
    release: string; bootId: string; ageSeconds: number; epoch: number | null }>;
  schedulers: Array<{ instanceId: string; status: string; release: string;
    ageSeconds: number }>;
};

export type ReadinessReason = 'ready' | 'primary_missing' | 'standby_missing' |
  'lease_missing' | 'lease_expired' | 'owner_mismatch' | 'release_mismatch' |
  'primary_quarantined' | 'standby_active';
export type ReadinessReport = {
  measuredAt: string;
  overall: 'ok' | 'alarm';
  roles: Array<{ role: string; reason: ReadinessReason; alarm: boolean }>;
  scheduler: { reason: 'ready' | 'replica_missing'; alarm: boolean; freshReplicas: number };
};

const fresh = (age: number) => Number.isFinite(age) && age >= -5 && age <= 60;

export function classifyFailoverReadiness(
  snapshot: ReadinessSnapshot,
  roles: readonly string[] = FAILOVER_ROLES,
): ReadinessReport {
  const rows = roles.map(role => {
    const primary = snapshot.candidates.find(candidate => candidate.role === role &&
      candidate.instanceId === `m3-${role}` && candidate.kind === 'primary' && fresh(candidate.ageSeconds));
    const standby = snapshot.candidates.find(candidate => candidate.role === role &&
      candidate.instanceId === `mini-${role}-standby` && candidate.kind === 'standby' && fresh(candidate.ageSeconds));
    const lease = snapshot.leases.find(item => item.role === role);
    let reason: ReadinessReason = 'ready';
    if (!primary) reason = 'primary_missing';
    else if (!standby) reason = 'standby_missing';
    else if (!lease || !lease.ownerInstanceId) reason = 'lease_missing';
    else if (lease.secondsUntilExpiry <= 0) reason = 'lease_expired';
    else if (lease.quarantineSeconds !== null && lease.quarantineSeconds > 0) reason = 'primary_quarantined';
    else if (primary.release !== standby.release || lease.ownerRelease !== primary.release) reason = 'release_mismatch';
    else {
      const owner = lease.ownerInstanceId === primary.instanceId ? primary :
        lease.ownerInstanceId === standby.instanceId ? standby : null;
      if (!owner || owner.bootId !== lease.ownerBootId || owner.epoch !== lease.epoch ||
          owner.kind !== lease.ownerKind || owner.phase !== 'active' ||
          (owner === primary ? standby.phase !== 'standby' : primary.phase !== 'standby')) {
        reason = 'owner_mismatch';
      } else if (owner === standby) reason = 'standby_active';
    }
    return { role, reason, alarm: reason !== 'ready' };
  });
  const freshReplicas = new Set(snapshot.schedulers.filter(row => row.status === 'running' && fresh(row.ageSeconds))
    .map(row => row.instanceId)).size;
  const scheduler = freshReplicas >= 2
    ? { reason: 'ready' as const, alarm: false, freshReplicas }
    : { reason: 'replica_missing' as const, alarm: true, freshReplicas };
  return { measuredAt: new Date().toISOString(), overall: rows.some(row => row.alarm) || scheduler.alarm ? 'alarm' : 'ok',
    roles: rows, scheduler };
}

/** Read-only snapshot. Timestamp arithmetic stays in PostgreSQL's clock/time zone. */
export async function readFailoverReadiness(): Promise<ReadinessReport> {
  const [leases, observations] = await Promise.all([
    db.select({ role: roleLeases.role, ownerInstanceId: roleLeases.ownerInstanceId,
      ownerBootId: roleLeases.ownerBootId, ownerKind: roleLeases.ownerKind,
      ownerRelease: roleLeases.ownerRelease, epoch: roleLeases.epoch,
      secondsUntilExpiry: sql<number>`extract(epoch from (${roleLeases.leaseUntil} - localtimestamp))::double precision`,
      quarantineSeconds: sql<number | null>`extract(epoch from (${roleLeases.quarantineUntil} - localtimestamp))::double precision`,
    }).from(roleLeases),
    db.select({ key: operationsObservations.key, value: operationsObservations.value,
      ageSeconds: sql<number>`extract(epoch from (localtimestamp - ${operationsObservations.observedAt}))::double precision`,
    }).from(operationsObservations).where(or(like(operationsObservations.key, 'candidate:%'),
      like(operationsObservations.key, 'service:scheduler:%'))),
  ]);
  const candidates: ReadinessSnapshot['candidates'] = [];
  const schedulers: ReadinessSnapshot['schedulers'] = [];
  for (const row of observations) {
    const candidate = /^candidate:([^:]+):([^:]+)$/.exec(row.key);
    if (candidate) {
      const value = row.value;
      candidates.push({ role: candidate[1], instanceId: candidate[2],
        kind: typeof value.kind === 'string' ? value.kind : '',
        phase: typeof value.phase === 'string' ? value.phase : '',
        release: typeof value.release === 'string' ? value.release : '',
        bootId: typeof value.bootId === 'string' ? value.bootId : '',
        ageSeconds: row.ageSeconds,
        epoch: typeof value.epoch === 'number' ? value.epoch : null });
    } else {
      const scheduler = /^service:scheduler:([^:]+)$/.exec(row.key);
      if (scheduler) schedulers.push({ instanceId: scheduler[1],
        status: typeof row.value.status === 'string' ? row.value.status : '',
        release: typeof row.value.release === 'string' ? row.value.release : '',
        ageSeconds: row.ageSeconds });
    }
  }
  return classifyFailoverReadiness({ leases, candidates, schedulers });
}
