import { expect, it } from 'vitest';
import { classifyFailoverReadiness } from '@/lib/operations/failover-readiness';

const release = '20208d3';
const role = 'crawler';

function healthySnapshot() {
  return {
    leases: [{ role, ownerInstanceId: 'm3-crawler', ownerBootId: 'boot-a', ownerKind: 'primary', ownerRelease: release,
      epoch: 4, secondsUntilExpiry: 40, quarantineSeconds: null as number | null }],
    candidates: [
      { role, instanceId: 'm3-crawler', kind: 'primary', phase: 'active', release,
        bootId: 'boot-a', ageSeconds: 3, epoch: 4 },
      { role, instanceId: 'mini-crawler-standby', kind: 'standby', phase: 'standby', release,
        bootId: 'boot-b', ageSeconds: 4, epoch: null },
    ],
    schedulers: [
      { instanceId: 'm3-scheduler-a', status: 'running', release, ageSeconds: 2 },
      { instanceId: 'm3-scheduler-b', status: 'running', release, ageSeconds: 3 },
      { instanceId: 'mini-scheduler-aabbccddeeff', status: 'running', release, ageSeconds: 4 },
    ],
  };
}

it('alarms when the active primary is healthy but its standby has disappeared', () => {
  const snapshot = healthySnapshot();
  snapshot.candidates[1].ageSeconds = 70;
  const report = classifyFailoverReadiness(snapshot, [role]);
  expect(report.overall).toBe('alarm');
  expect(report.roles).toContainEqual({ role, reason: 'standby_missing', alarm: true });
});

it('accepts a complete healthy pair and scheduler replicas across M3 and mini', () => {
  const report = classifyFailoverReadiness(healthySnapshot(), [role]);
  expect(report).toMatchObject({ overall: 'ok', roles: [{ role, reason: 'ready', alarm: false }],
    scheduler: { reason: 'ready', alarm: false } });
});

it('reports takeover without calling a standby that is already active ready', () => {
  const snapshot = healthySnapshot();
  snapshot.leases[0].ownerInstanceId = 'mini-crawler-standby';
  snapshot.leases[0].ownerBootId = 'boot-b';
  snapshot.leases[0].ownerKind = 'standby';
  snapshot.leases[0].epoch = 5;
  snapshot.candidates[0].phase = 'standby';
  snapshot.candidates[0].epoch = null;
  snapshot.candidates[1].phase = 'active';
  snapshot.candidates[1].epoch = 5;
  expect(classifyFailoverReadiness(snapshot, [role]).roles)
    .toContainEqual({ role, reason: 'standby_active', alarm: true });
});

it.each([
  ['release_mismatch', (snapshot: ReturnType<typeof healthySnapshot>) => { snapshot.candidates[1].release = 'new-release'; }],
  ['lease_expired', (snapshot: ReturnType<typeof healthySnapshot>) => { snapshot.leases[0].secondsUntilExpiry = -1; }],
  ['owner_mismatch', (snapshot: ReturnType<typeof healthySnapshot>) => { snapshot.leases[0].ownerBootId = 'old-boot'; }],
  ['primary_quarantined', (snapshot: ReturnType<typeof healthySnapshot>) => { snapshot.leases[0].quarantineSeconds = 500; }],
] as const)('classifies %s', (reason, change) => {
  const snapshot = healthySnapshot();
  change(snapshot);
  expect(classifyFailoverReadiness(snapshot, [role]).roles).toContainEqual({ role, reason, alarm: true });
});

it('keeps the two-replica minimum when only mini survives M3 loss', () => {
  const snapshot = healthySnapshot();
  snapshot.schedulers[0].ageSeconds = 70;
  snapshot.schedulers[1].ageSeconds = 70;
  expect(classifyFailoverReadiness(snapshot, [role]).scheduler)
    .toEqual({ reason: 'replica_missing', alarm: true, freshReplicas: 1, miniFreshReplicas: 1 });
});

it.each(['missing', 'stale', 'stopped', 'future'] as const)('does not let two M3 replicas hide a %s mini scheduler', condition => {
  const snapshot = healthySnapshot();
  if (condition === 'missing') snapshot.schedulers.pop();
  if (condition === 'stale') snapshot.schedulers[2].ageSeconds = 70;
  if (condition === 'stopped') snapshot.schedulers[2].status = 'stopped';
  if (condition === 'future') snapshot.schedulers[2].ageSeconds = -10;
  expect(classifyFailoverReadiness(snapshot, [role]).scheduler)
    .toEqual({ reason: 'mini_missing', alarm: true, freshReplicas: 2, miniFreshReplicas: 0 });
});

it('accepts two live schedulers when one is mini and does not double-count an observation', () => {
  const snapshot = healthySnapshot();
  snapshot.schedulers[1].ageSeconds = 70;
  snapshot.schedulers.push({ ...snapshot.schedulers[2] });
  expect(classifyFailoverReadiness(snapshot, [role]).scheduler)
    .toEqual({ reason: 'ready', alarm: false, freshReplicas: 2, miniFreshReplicas: 1 });
});
