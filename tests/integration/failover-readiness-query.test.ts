import { beforeAll, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { operationsObservations, roleLeases } from '@/lib/db/schema';
import { readFailoverReadiness } from '@/lib/operations/failover-readiness';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(operationsObservations);
  await db.delete(roleLeases);
});

it('reads DB-clock ages, verifies the lease boot ID, and alarms on a stale standby', async () => {
  await db.insert(roleLeases).values({ role: 'crawler', ownerInstanceId: 'm3-crawler',
    ownerBootId: 'boot-a', ownerKind: 'primary', ownerRelease: 'release-a', epoch: 3,
    leaseUntil: sql`localtimestamp + interval '40 seconds'` });
  await db.insert(operationsObservations).values([
    { key: 'candidate:crawler:m3-crawler', value: { kind: 'primary', phase: 'active',
      bootId: 'boot-a', release: 'release-a', epoch: 3 }, observedAt: sql`localtimestamp` },
    { key: 'candidate:crawler:mini-crawler-standby', value: { kind: 'standby', phase: 'standby',
      bootId: 'boot-b', release: 'release-a', epoch: null }, observedAt: sql`localtimestamp` },
    { key: 'service:scheduler:scheduler-one', value: { status: 'running' }, observedAt: sql`localtimestamp` },
    { key: 'service:scheduler:scheduler-two', value: { status: 'running' }, observedAt: sql`localtimestamp` },
  ]);
  const first = await readFailoverReadiness();
  expect(first.roles.find(row => row.role === 'crawler')).toMatchObject({ reason: 'ready', alarm: false });
  expect(first.scheduler).toMatchObject({ reason: 'ready', freshReplicas: 2 });
  await db.update(operationsObservations).set({ observedAt: sql`localtimestamp - interval '70 seconds'` })
    .where(eq(operationsObservations.key, 'candidate:crawler:mini-crawler-standby'));
  const second = await readFailoverReadiness();
  expect(second.roles.find(row => row.role === 'crawler')).toMatchObject({ reason: 'standby_missing', alarm: true });
});

it('emits a machine-readable alarm and exit code 2 from the independent CLI', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-failover-readiness.ts'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, WORKER_ROLE: 'monitor' },
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ overall: 'alarm', readiness: {
    overall: 'alarm', roles: expect.any(Array), scheduler: expect.any(Object) },
    progress: expect.any(Object) });
});
