import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobBatchControl, jobs, operationsObservations } from '@/lib/db/schema';
import { requestJob } from '@/lib/jobs/control';
import { getJobState, runJob } from '@/lib/jobs/runner';
import { isPausedJob } from '@/lib/jobs/status';
import { adminJobControlVersions, controlAdminJob, type AdminJobControl } from '@/lib/operations/admin-job-control';
import { auditFloor, auditRowsAfter, ensureSchema } from './setup';

const name = 'crawl-fetch';
let originalJob: (typeof jobs.$inferSelect)[] = [];
let originalBatch: (typeof jobBatchControl.$inferSelect)[] = [];
let originalObservation: (typeof operationsObservations.$inferSelect)[] = [];
let originalFence: Record<string, unknown> | undefined;

async function form(pause: boolean, reason = '독립 회귀 검증'): Promise<AdminJobControl> {
  const state = await getJobState(name);
  return { name, pause, reason, expectedNotBefore: state?.notBefore?.toISOString() ?? null,
    expectedControlVersion: (await adminJobControlVersions())[name] ?? 0 };
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

beforeAll(async () => {
  ensureSchema();
  originalJob = await db.select().from(jobs).where(eq(jobs.name, name));
  originalBatch = await db.select().from(jobBatchControl);
  originalObservation = await db.select().from(operationsObservations).where(eq(operationsObservations.key, `job:${name}`));
  [originalFence] = await db.execute(sql`SELECT * FROM dr_writer_fence WHERE id = 1`);
});
beforeEach(async () => {
  await db.execute(sql`UPDATE dr_writer_fence SET state='active', reason=NULL, fenced_db=NULL, promotion_id=NULL WHERE id=1`);
  await db.update(jobBatchControl).set({ mode: 'legacy', drainingFrom: null }).where(eq(jobBatchControl.id, 1));
  await db.delete(jobs).where(eq(jobs.name, name));
  await db.insert(jobs).values({ name, requestedVersion: 4, processedVersion: 3, cursor: { page: 2 } });
});
afterAll(async () => {
  await db.delete(jobs).where(eq(jobs.name, name));
  if (originalJob.length) await db.insert(jobs).values(originalJob);
  await db.delete(operationsObservations).where(eq(operationsObservations.key, `job:${name}`));
  if (originalObservation.length) await db.insert(operationsObservations).values(originalObservation);
  if (originalBatch.length) await db.update(jobBatchControl).set(originalBatch[0]).where(eq(jobBatchControl.id, 1));
  if (originalFence) await db.execute(sql`UPDATE dr_writer_fence SET state=${originalFence.state as string},
    reason=${originalFence.reason as string | null}, fenced_db=${originalFence.fenced_db ? JSON.stringify(originalFence.fenced_db) : null}::jsonb,
    promotion_id=${originalFence.promotion_id as string | null}::uuid WHERE id=1`);
});

describe('administrator job pause and resume', () => {
  it('preserves pending requests, cursor, schedule and the live owner while recording who changed the pause', async () => {
    const at = new Date('2026-10-22T12:00:00.000Z');
    await db.update(jobs).set({ leaseToken: 'live-owner', lockedAt: at, workerSeenAt: at,
      nextScheduledAt: at, lastRunAt: at, lastSuccessAt: at, runs: 9 }).where(eq(jobs.name, name));
    const before = (await getJobState(name))!;
    const floor = await auditFloor();
    await controlAdminJob(await form(true, '  모델 부하 확인  '), 'reviewer');
    const paused = (await getJobState(name))!;
    expect(paused).toMatchObject({ ...before, notBefore: expect.any(Date), updatedAt: expect.any(Date) });
    expect(isPausedJob(paused)).toBe(true);
    expect(await auditRowsAfter(floor, 'job-pause')).toEqual([expect.objectContaining({ actor: 'reviewer', target: name,
      detail: expect.objectContaining({ reason: '모델 부하 확인', inFlight: true, requestedVersion: 4, processedVersion: 3,
        beforeNotBefore: null, afterNotBefore: paused.notBefore!.toISOString() }) })]);
    await controlAdminJob(await form(false), 'reviewer');
    expect(await getJobState(name)).toMatchObject({ ...before, notBefore: null, updatedAt: expect.any(Date) });
  });

  it.each(['success', 'failure', 'deferred'] as const)('keeps a pause made during an active %s tick without cancelling the handler', async outcome => {
    const entered = deferred(), release = deferred();
    const controller = new AbortController();
    const running = runJob<{ page: number }>(name, async ctx => {
      entered.resolve();
      await release.promise;
      expect(ctx.signal?.aborted).toBe(false);
      await ctx.save({ page: 3 });
      if (outcome === 'failure') throw new Error('upstream rejected');
      return outcome === 'deferred' ? { done: false, deferred: 'model_capacity' } : { done: false, cursor: { page: 4 } };
    }, { requestedOnly: true, signal: controller.signal });
    await entered.promise;
    let paused: Awaited<ReturnType<typeof getJobState>>;
    try {
      await controlAdminJob(await form(true), 'reviewer');
      paused = await getJobState(name);
      expect(paused?.leaseToken).toBeTruthy();
      expect(paused?.lockedAt).toBeInstanceOf(Date);
      await requestJob(name);
    } finally { release.resolve(); }
    expect((await running).status).toBe(outcome === 'failure' ? 'failed' : outcome === 'deferred' ? 'deferred' : 'completed');
    const after = (await getJobState(name))!;
    expect(after).toMatchObject({ requestedVersion: 5, processedVersion: outcome === 'success' ? 4 : 3,
      leaseToken: null, lockedAt: null, notBefore: paused!.notBefore,
      cursor: { page: outcome === 'success' ? 4 : 3 } });
    expect(await runJob(name, async () => { throw new Error('paused handler ran'); }, { requestedOnly: true }))
      .toEqual({ status: 'skipped', reason: 'backoff' });
  });

  it('restores an unexpired retry delay, and clears an expired delay on resume', async () => {
    const retryAt = new Date(Date.now() + 120_000);
    await db.update(jobs).set({ notBefore: retryAt }).where(eq(jobs.name, name));
    await controlAdminJob(await form(true), 'reviewer');
    await controlAdminJob(await form(false), 'reviewer');
    expect((await getJobState(name))?.notBefore).toEqual(retryAt);
    await db.update(jobs).set({ notBefore: new Date(Date.now() - 1_000) }).where(eq(jobs.name, name));
    await controlAdminJob(await form(true), 'reviewer');
    await controlAdminJob(await form(false), 'reviewer');
    expect((await getJobState(name))?.notBefore).toBeNull();
  });

  it('restores the original retry after the paused live tick finishes', async () => {
    const retryAt = new Date(Date.now() + 120_000), entered = deferred(), release = deferred();
    const running = runJob(name, async () => {
      entered.resolve();
      await release.promise;
      return { done: false };
    }, { requestedOnly: true });
    await entered.promise;
    try {
      await db.update(jobs).set({ notBefore: retryAt }).where(eq(jobs.name, name));
      await controlAdminJob(await form(true), 'reviewer');
    } finally { release.resolve(); }
    expect((await running).status).toBe('completed');
    expect(isPausedJob(await getJobState(name))).toBe(true);
    await controlAdminJob(await form(false), 'reviewer');
    expect((await getJobState(name))?.notBefore).toEqual(retryAt);
  });

  it('serializes simultaneous changes and rejects an old form after pause-resume returns to the same state', async () => {
    const stale = await form(true);
    const floor = await auditFloor();
    const results = await Promise.allSettled([controlAdminJob(stale, 'first'), controlAdminJob(stale, 'second')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message).toBe('job_control_conflict');
    expect(await auditRowsAfter(floor, 'job-pause')).toHaveLength(1);
    const staleResume = await form(false);
    await controlAdminJob(staleResume, 'reviewer');
    expect((await getJobState(name))?.notBefore).toBeNull();
    await expect(controlAdminJob(stale, 'stale')).rejects.toThrow('job_control_conflict');
    await expect(controlAdminJob(staleResume, 'stale')).rejects.toThrow('job_control_conflict');
  });

  it('rejects a changed retry time and a repeated desired state without changing the row', async () => {
    const stale = await form(true);
    await db.update(jobs).set({ notBefore: new Date(Date.now() + 120_000) }).where(eq(jobs.name, name));
    const before = await getJobState(name);
    await expect(controlAdminJob(stale, 'reviewer')).rejects.toThrow('job_control_conflict');
    expect(await getJobState(name)).toEqual(before);
    await expect(controlAdminJob(await form(false), 'reviewer')).rejects.toThrow('job_control_conflict');
  });

  it.each(['heartbeat', 'unknown-job'])('rejects %s as a target', async target => {
    await expect(controlAdminJob({ ...await form(true), name: target }, 'reviewer')).rejects.toThrow('job_control_invalid');
    expect((await getJobState(name))?.notBefore).toBeNull();
  });

  it.each(['draining', 'versioned'] as const)('rejects per-job controls in %s batch mode', async mode => {
    await db.update(jobBatchControl).set({ mode, drainingFrom: mode === 'draining' ? 'legacy' : null }).where(eq(jobBatchControl.id, 1));
    const before = await getJobState(name);
    await expect(controlAdminJob(await form(true), 'reviewer')).rejects.toThrow('job_control_unsupported_mode');
    expect(await getJobState(name)).toEqual(before);
  });

  it('rejects a job absent from the legacy catalog and an absent job row', async () => {
    await expect(controlAdminJob({ ...await form(true), name: 'product-site-evidence-refresh' }, 'reviewer'))
      .rejects.toThrow('job_control_unsupported_mode');
    await db.delete(jobs).where(eq(jobs.name, name));
    await expect(controlAdminJob(await form(true), 'reviewer')).rejects.toThrow('job_control_not_found');
  });

  it('refuses changes on a fenced database without modifying state or appending a control audit', async () => {
    const input = await form(true), before = await getJobState(name), floor = await auditFloor();
    await db.execute(sql`UPDATE dr_writer_fence SET state='fenced', reason='operator_fence',
      fenced_db='{"systemIdentifier":"1","databaseOid":"1","databaseName":"nomorevibe_test"}'::jsonb WHERE id=1`);
    await expect(controlAdminJob(input, 'reviewer')).rejects.toThrow('dr_writer_site_fenced');
    expect(await getJobState(name)).toEqual(before);
    expect(await auditRowsAfter(floor, 'job-pause')).toHaveLength(0);
  });

  it.each([
    { reason: '   ' }, { reason: 'x'.repeat(501) }, { pause: 'true' },
    { expectedControlVersion: -1 }, { expectedControlVersion: 0.1 }, { expectedNotBefore: 'yesterday' },
  ])('rejects malformed input %# before touching state', async extra => {
    const before = await getJobState(name);
    await expect(controlAdminJob({ ...await form(true), ...extra } as AdminJobControl, 'reviewer')).rejects.toThrow('job_control_invalid');
    expect(await getJobState(name)).toEqual(before);
  });
});
