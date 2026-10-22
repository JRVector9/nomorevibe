import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs, operationsObservations, roleLeases } from '@/lib/db/schema';
import { requestJob } from '@/lib/jobs/control';
import { runJob } from '@/lib/jobs/runner';
import { readWaitingPrimary, releaseRole, renewRole, tryAcquireRole, yieldRoleToPrimary, type RoleLease } from '@/lib/jobs/role-leader';
import { observe } from '@/lib/operations/observations';
import { ensureSchema } from './setup';

// 2026-10-22 #597: 같은 릴리스의 예비가 정상 반납된 역할을 넘겨받고 놓지 않아 다시 뜬 주가 끝없이 기다렸다.
// 예비 넘겨주기(readWaitingPrimary → drain → yieldRoleToPrimary)의 DB 쪽 안전 조건을 실제 PostgreSQL 에서 본다.
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(jobs);
  await db.delete(roleLeases);
  await db.delete(operationsObservations).where(like(operationsObservations.key, 'candidate:%'));
});

const primary = { role: 'crawler' as const, instanceId: 'm3-crawler', bootId: 'primary-boot-1', release: 'release-1', kind: 'primary' as const };
const restarted = { ...primary, bootId: 'primary-boot-2' };
const standby = { role: 'crawler' as const, instanceId: 'mini-crawler-standby', bootId: 'standby-boot', release: 'release-1', kind: 'standby' as const };
const rival = { ...standby, instanceId: 'other-standby', bootId: 'other-boot' };

/** #597 상태: 주가 같은 릴리스로 재시작하며 정상 반납했고, 같은 릴리스 예비가 유예 없이 넘겨받았다 */
async function standbyHolds(): Promise<RoleLease> {
  const owned = (await tryAcquireRole(primary))!;
  expect(await releaseRole(owned)).toBe(true);
  return (await tryAcquireRole(standby))!;
}

async function primaryWaits(overrides: Record<string, unknown> = {}) {
  await observe(`candidate:crawler:${restarted.instanceId}`, { role: 'crawler', kind: 'primary', instanceId: restarted.instanceId,
    bootId: restarted.bootId, release: restarted.release, phase: 'standby', epoch: null, electable: true, ...overrides });
}

it('a same-release standby takes a gracefully released role and the restarted primary only waits (the bug the handoff fixes)', async () => {
  const lease = await standbyHolds();
  expect(lease).toMatchObject({ instanceId: standby.instanceId, epoch: 2 });
  for (let attempt = 0; attempt < 3; attempt++) expect(await tryAcquireRole(restarted)).toBeNull();
  expect(await renewRole(lease)).toBe(true);
});

it('sees a waiting primary only when it is fresh, electable, on the same release and not quarantined', async () => {
  const lease = await standbyHolds();
  expect(await readWaitingPrimary(lease)).toBeNull(); // 아직 관측이 없다
  await primaryWaits();
  expect(await readWaitingPrimary(lease)).toEqual({ instanceId: restarted.instanceId, bootId: restarted.bootId });
  for (const overrides of [{ phase: 'active' }, { electable: false }, { electable: undefined }, { release: 'release-2' },
    { kind: 'standby' }, { bootId: '' }, { instanceId: standby.instanceId }]) {
    await primaryWaits(overrides);
    expect(await readWaitingPrimary(lease), JSON.stringify(overrides)).toBeNull();
  }
  await primaryWaits();
  await db.update(operationsObservations).set({ observedAt: sql`localtimestamp - interval '30 seconds'` })
    .where(eq(operationsObservations.key, `candidate:crawler:${restarted.instanceId}`));
  expect(await readWaitingPrimary(lease)).toBeNull(); // 오래된 관측은 살아 있다는 근거가 아니다
  await primaryWaits();
  await db.update(roleLeases).set({ quarantineUntil: sql`now() + interval '15 minutes'` }).where(eq(roleLeases.role, 'crawler'));
  expect(await readWaitingPrimary(lease)).toBeNull(); // 격리된 주에게는 넘기지 않는다
  await db.update(roleLeases).set({ quarantineUntil: sql`now() - interval '1 second'` }).where(eq(roleLeases.role, 'crawler'));
  expect(await readWaitingPrimary(lease)).not.toBeNull();
  // 이 예비가 지금 그 epoch 의 lease 를 쥐고 있지 않으면 묻지 않는다
  expect(await readWaitingPrimary({ ...lease, epoch: lease.epoch + 1 })).toBeNull();
  expect(await readWaitingPrimary({ ...lease, kind: 'primary' })).toBeNull();
});

it('yields so the waiting primary is elected at once with a new epoch while every standby waits out the grace', async () => {
  const lease = await standbyHolds();
  await requestJob('crawl-fetch');
  await db.update(jobs).set({ leaseToken: 'standby-token', lockedAt: sql`now()` }).where(eq(jobs.name, 'crawl-fetch'));
  expect(await yieldRoleToPrimary(lease)).toBe(true);
  const [yielded] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
  // owner 칸은 남고 lease 만 끝났다 — 예비 쪽 20초 유예가 걸린다
  expect(yielded).toMatchObject({ ownerInstanceId: standby.instanceId, ownerKind: 'standby', epoch: lease.epoch });
  const [job] = await db.select().from(jobs).where(eq(jobs.name, 'crawl-fetch'));
  expect(job.leaseToken).toBeNull();
  expect(await renewRole(lease)).toBe(false);
  expect(await tryAcquireRole(standby)).toBeNull();
  expect(await tryAcquireRole(rival)).toBeNull();
  const taken = await tryAcquireRole(restarted);
  expect(taken).toMatchObject({ instanceId: primary.instanceId, bootId: restarted.bootId, epoch: lease.epoch + 1 });
  // 옛 예비 lease 로는 일감을 맡거나 저장할 수 없다(epoch fencing)
  expect(await runJob('crawl-fetch', async () => ({ done: true }), { requestedOnly: true, roleLease: lease }))
    .toMatchObject({ status: 'skipped', reason: 'stopping' });
  expect(await runJob('crawl-fetch', async () => ({ done: true }), { requestedOnly: true, roleLease: taken! }))
    .toMatchObject({ status: 'completed' });
});

it('elects exactly one holder, the primary, when it races the standbys right after a yield', async () => {
  for (let round = 0; round < 5; round++) {
    await db.delete(roleLeases);
    const lease = await standbyHolds();
    expect(await yieldRoleToPrimary(lease)).toBe(true);
    const results = await Promise.all([tryAcquireRole(standby), tryAcquireRole(restarted), tryAcquireRole(rival),
      tryAcquireRole(standby), yieldRoleToPrimary(lease)]);
    const leases = results.slice(0, 4).filter(Boolean) as RoleLease[];
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ instanceId: primary.instanceId, epoch: lease.epoch + 1 });
    expect(results[4]).toBe(false); // 이미 넘긴 lease 는 다시 넘기지 않는다
    const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
    expect(row.epoch).toBe(lease.epoch + 1);
    expect(row.ownerInstanceId).toBe(primary.instanceId);
  }
});

it('takes the role back after the grace when the waiting primary dies before it is elected', async () => {
  const lease = await standbyHolds();
  expect(await yieldRoleToPrimary(lease)).toBe(true);
  expect(await tryAcquireRole(standby)).toBeNull();
  await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '21 seconds'` }).where(eq(roleLeases.role, 'crawler'));
  expect(await tryAcquireRole(standby)).toMatchObject({ instanceId: standby.instanceId, epoch: lease.epoch + 1 });
});

it('never yields a lease it no longer owns, an expired lease, a primary lease or another release', async () => {
  const lease = await standbyHolds();
  const before = (await db.select().from(roleLeases))[0];
  for (const other of [{ ...lease, epoch: lease.epoch + 1 }, { ...lease, bootId: 'older-boot' }, { ...lease, release: 'release-2' },
    { ...lease, kind: 'primary' as const }]) expect(await yieldRoleToPrimary(other)).toBe(false);
  expect((await db.select().from(roleLeases))[0]).toEqual(before);
  await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(roleLeases.role, 'crawler'));
  expect(await yieldRoleToPrimary(lease)).toBe(false);
});

it('keeps crash-loop quarantine after a handoff and does not hand a quarantined primary the role again', async () => {
  const lease = await standbyHolds();
  expect(await yieldRoleToPrimary(lease)).toBe(true);
  let epoch = lease.epoch;
  for (let boot = 0; boot < 3; boot++) {
    // 넘겨받은 주가 매번 선출 직후 죽는다(정상 반납 없이 만료)
    expect(await tryAcquireRole({ ...primary, bootId: `crash-${boot}` })).toMatchObject({ epoch: ++epoch });
    await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '21 seconds'` }).where(eq(roleLeases.role, 'crawler'));
  }
  expect(await tryAcquireRole({ ...primary, bootId: 'crash-3' })).toBeNull();
  const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
  expect(row.quarantineUntil).toBeInstanceOf(Date);
  const again = (await tryAcquireRole(standby))!;
  expect(again).toMatchObject({ instanceId: standby.instanceId, epoch: epoch + 1 });
  await observe(`candidate:crawler:${primary.instanceId}`, { role: 'crawler', kind: 'primary', instanceId: primary.instanceId,
    bootId: 'crash-4', release: primary.release, phase: 'standby', epoch: null, electable: true });
  expect(await readWaitingPrimary(again)).toBeNull();
});
