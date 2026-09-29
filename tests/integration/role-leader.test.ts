import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlFrontier, jobs, roleLeases } from '@/lib/db/schema';
import { getJobState, runJob } from '@/lib/jobs/runner';
import { requestJob } from '@/lib/jobs/control';
import { releaseRole, renewRole, tryAcquireRole } from '@/lib/jobs/role-leader';
import { ensureSchema } from './setup';
import * as crawl from '@/lib/crawl/repository';

beforeAll(() => ensureSchema());
beforeEach(async () => { await db.delete(crawlFrontier); await db.delete(jobs); await db.delete(roleLeases); });

const primary = { role: 'crawler' as const, instanceId: 'crawler-a', bootId: 'boot-a', release: 'release-1', kind: 'primary' as const };
const standby = { role: 'crawler' as const, instanceId: 'crawler-b', bootId: 'boot-b', release: 'release-1', kind: 'standby' as const };

it('elects one role owner and renews only the current boot', async () => {
  const [a, b] = await Promise.all([tryAcquireRole(primary), tryAcquireRole(standby)]);
  expect(a).toMatchObject({ role: 'crawler', instanceId: 'crawler-a', bootId: 'boot-a', epoch: 1 });
  expect(b).toBeNull();
  expect(await renewRole(a!)).toBe(true);
  expect(await renewRole({ ...a!, bootId: 'older-boot' })).toBe(false);
});

it('keeps a standby passive for the first 20 seconds when no primary has ever started', async () => {
  expect(await tryAcquireRole(standby)).toBeNull();
  const [row] = await db.select().from(roleLeases);
  expect(row.epoch).toBe(0);
  expect(await tryAcquireRole(primary)).toMatchObject({ epoch: 1, instanceId: 'crawler-a' });
});

it('quarantines a primary after three rapid lost boots so standby can take over', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await tryAcquireRole({ ...primary, bootId: `crash-${attempt}` })).toMatchObject({ epoch: attempt + 1 });
    await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '21 seconds'` })
      .where(eq(roleLeases.role, 'crawler'));
  }
  expect(await tryAcquireRole({ ...primary, bootId: 'crash-3' })).toBeNull();
  const [row] = await db.select().from(roleLeases);
  expect(row.quarantineUntil).toBeInstanceOf(Date);
  expect(await tryAcquireRole(standby)).toMatchObject({ instanceId: 'crawler-b', epoch: 4 });
});

it('lets a restarted primary retry before standby and revokes old job tokens on takeover', async () => {
  const first = (await tryAcquireRole(primary))!;
  await requestJob('crawl-fetch');
  let releaseOld!: () => void;
  const oldPaused = new Promise<void>(resolve => { releaseOld = resolve; });
  let oldStarted!: () => void;
  const started = new Promise<void>(resolve => { oldStarted = resolve; });
  const oldRun = runJob('crawl-fetch', async ctx => {
    oldStarted();
    await oldPaused;
    await ctx.save({ stale: true });
    return { done: true };
  }, { requestedOnly: true, roleLease: first });
  await started;
  await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(roleLeases.role, 'crawler'));
  expect(await tryAcquireRole(standby)).toBeNull();
  const restarted = (await tryAcquireRole({ ...primary, bootId: 'boot-a2' }))!;
  expect(restarted.epoch).toBe(2);
  releaseOld();
  expect(await oldRun).toMatchObject({ status: 'failed', error: 'job_lease_lost' });
  expect(await getJobState('crawl-fetch')).toMatchObject({ cursor: null, requestedVersion: 1, processedVersion: 0 });
  expect(await runJob('crawl-fetch', async () => ({ done: true }), { requestedOnly: true, roleLease: first }))
    .toMatchObject({ status: 'skipped', reason: 'stopping' });
  expect(await runJob('crawl-fetch', async () => ({ done: true }), { requestedOnly: true, roleLease: restarted }))
    .toMatchObject({ status: 'completed' });
});

it('promotes a same-release standby after the primary grace and rejects a different release', async () => {
  await tryAcquireRole(primary);
  await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '21 seconds'` }).where(eq(roleLeases.role, 'crawler'));
  expect(await tryAcquireRole({ ...standby, release: 'release-2' })).toBeNull();
  const promoted = await tryAcquireRole(standby);
  expect(promoted).toMatchObject({ instanceId: 'crawler-b', epoch: 2 });
  expect(await tryAcquireRole(primary)).toBeNull();
});

it('rejects a different-release standby after a graceful primary release', async () => {
  const owned = (await tryAcquireRole(primary))!;
  expect(await releaseRole(owned)).toBe(true);
  expect(await tryAcquireRole({ ...standby, release: 'release-2' })).toBeNull();
  expect(await tryAcquireRole(standby)).toMatchObject({ instanceId: 'crawler-b', epoch: 2 });
});

it('elects exactly one of two standby candidates after primary expiry', async () => {
  await tryAcquireRole(primary);
  await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '21 seconds'` })
    .where(eq(roleLeases.role, 'crawler'));
  const rival = { ...standby, instanceId: 'crawler-c', bootId: 'boot-c' };
  const results = await Promise.all([tryAcquireRole(standby), tryAcquireRole(rival)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(results.find(Boolean)?.epoch).toBe(2);
  const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
  expect(row.ownerInstanceId).toBe(results.find(Boolean)?.instanceId);
});

it('rolls back a late crawler frontier enqueue after role takeover', async () => {
  await tryAcquireRole(primary);
  await db.insert(jobs).values({ name: 'crawl-seed', leaseToken: 'old-token',
    lockedAt: sql`now()`, requestedVersion: 1 });
  const oldLease = { name: 'crawl-seed', token: 'old-token', requestedVersion: 1 };
  await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(roleLeases.role, 'crawler'));
  await tryAcquireRole({ ...primary, bootId: 'boot-a2' });
  await expect(crawl.enqueue([{ repo: 'late/enqueue', signal: 'test' }], oldLease)).rejects.toThrow('job_lease_lost');
  expect(await db.select().from(crawlFrontier).where(eq(crawlFrontier.repo, 'late/enqueue'))).toHaveLength(0);
});
