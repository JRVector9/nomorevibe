import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { assertJobBatchAdmission, batchResultObservation, completeJobBatchTransition, JobBatchBlockedError } from '@/lib/jobs/batch-repository';
import { requestDueJobs } from '@/lib/jobs/control';
import { classifyBatchReadiness } from '@/lib/jobs/batches';
vi.mock('@/lib/operations/dr/epoch', async original => ({ ...await original<typeof import('@/lib/operations/dr/epoch')>(), writerSiteActive: async () => true })); // PR15c: fence는 dr-fence-paths 테스트가 본다(이 fixture의 lock 순서 불변)

const state = vi.hoisted(() => ({ mode: 'legacy', contract: 0, sourceBusy: false, transitions: 0,
  inserted: [] as string[], order: [] as string[] }));
vi.mock('@/lib/db', () => ({
  onPrimary: <T>(load: () => T) => load(),
  db: { transaction: async <T>(load: (tx: unknown) => Promise<T>) => {
    let name = '';
    const tx = {
      select: () => ({ from: (table: object) => {
        const tableName = Reflect.get(table, Symbol.for('drizzle:Name'));
        type Selection = { where: (...args: unknown[]) => Selection; orderBy: (...args: unknown[]) => Selection;
          for: (lock: string) => Promise<unknown[]>; limit: (count: number) => Promise<unknown[]> };
        const rows = () => tableName === 'job_batch_control'
          ? [{ id: 1, mode: state.mode, drainingFrom: 'versioned', epoch: 1, writerContractVersion: state.contract, policy: null }]
          : tableName === 'evidence_source_control' ? [{ id: 1 }]
          : tableName === 'evidence_source_claims' && state.sourceBusy ? [{ productId: 1 }] : [];
        const selected: Selection = { where: () => selected, orderBy: () => selected,
          for: async lock => { state.order.push(tableName === 'job_batch_control' ? `batch-${lock}` : `lock:${tableName}`); return rows(); },
          limit: async () => rows() };
        return selected;
      } }),
      insert: () => ({ values: (row: { name: string }) => {
        name = row.name; state.inserted.push(name); state.order.push(`insert:${name}`);
        return { onConflictDoNothing: async () => {} };
      } }),
      update: () => ({ set: (values: Record<string, unknown>) => {
        if (values.mode) state.transitions += 1;
        return { where: () => ({ returning: async () => [{ name, mode: values.mode, epoch: 2 }] }) };
      } }),
    };
    return load(tx);
  } },
}));

beforeEach(() => { state.mode = 'legacy'; state.contract = 0; state.sourceBusy = false; state.transitions = 0;
  state.inserted.length = 0; state.order.length = 0; });

it('blocks legacy direct/cron execution of the batch-only canonical job without any lease', async () => {
  await expect(db.transaction(tx => assertJobBatchAdmission(tx, 'product-site-evidence-refresh')))
    .rejects.toBeInstanceOf(JobBatchBlockedError);
});

it('preserves legacy direct admission of the existing product job', async () => {
  await expect(db.transaction(tx => assertJobBatchAdmission(tx, 'product-evidence-refresh'))).resolves.toBeNull();
});

it.each(['legacy', 'draining'])('keeps the new due job unscheduled in %s mode', async mode => {
  state.mode = mode;
  await requestDueJobs();
  expect(state.inserted).not.toContain('product-site-evidence-refresh');
  expect(state.inserted).toContain('product-evidence-refresh');
});

it('schedules the canonical descriptor in versioned mode under the first batch SHARE lock', async () => {
  state.mode = 'versioned'; state.contract = 1;
  await requestDueJobs();
  expect(state.order[0]).toBe('batch-share');
  expect(state.inserted.filter(name => name === 'product-site-evidence-refresh')).toHaveLength(1);
});

it('preserves an independently healthy source claim when completing a drained transition', async () => {
  state.mode = 'draining'; state.contract = 1; state.sourceBusy = true;
  await expect(completeJobBatchTransition('legacy')).rejects.toThrow('job_batch_not_drained');
  expect(state.transitions).toBe(0);
});

it('keeps the existing transition control when no healthy source owner remains', async () => {
  state.mode = 'draining'; state.contract = 1;
  await expect(completeJobBatchTransition('legacy')).resolves.toMatchObject({ mode: 'legacy', epoch: 2 });
  expect(state.transitions).toBe(1);
});

it('locks source control before role/job rows so in-flight source renewals settle before transition', async () => {
  state.mode = 'draining'; state.contract = 1;
  await completeJobBatchTransition('legacy');
  expect(state.order).toContain('lock:evidence_source_control');
  expect(state.order.indexOf('lock:evidence_source_control')).toBeLessThan(state.order.indexOf('lock:role_leases'));
  expect(state.order.indexOf('lock:evidence_source_control')).toBeLessThan(state.order.indexOf('lock:jobs'));
});

const identity = { role: 'site-evidence' as const, host: 'oracle-osaka-smoke' as const,
  instanceId: 'site-fixture', bootId: 'boot-fixture', release: 'fixture-release', batchEpoch: 1 };
it('records only actual positive canonical source results in successful batch ACK evidence', () => {
  const event = (succeeded: number) => [{ event: 'evidence.site_refresh_batch', counts: { attempted: 1, succeeded, factsChanged: succeeded } }];
  expect(batchResultObservation(identity, 'product-site-evidence-refresh', event(1), 7))
    .toEqual({ ...identity, job: 'product-site-evidence-refresh', count: 1, requestedVersion: 7 });
  expect(batchResultObservation(identity, 'product-site-evidence-refresh', event(0), 7)).toBeNull();
  expect(batchResultObservation(identity, 'product-site-evidence-refresh', [], 7)).toBeNull();
  expect(batchResultObservation(null, 'product-site-evidence-refresh', event(1), 7)).toBeNull();
});

it('requires separate domain readback after a positive site ACK and keeps empty/heartbeat results unready', () => {
  const at = Date.parse('2026-10-16T12:00:00Z');
  const capability = { ...identity, dbPrivileges: 'verified', dbRole: 'fixture-role',
    effectivePrivilegeHash: 'a'.repeat(64), http: 'verified', model: 'unknown', observedAt: new Date(at - 1_000).toISOString() };
  const evidence = { host: capability.host, release: capability.release, instanceId: capability.instanceId,
    dbPrivileges: capability.dbPrivileges, dbRole: capability.dbRole, effectivePrivilegeHash: capability.effectivePrivilegeHash,
    http: capability.http, model: capability.model, observedAt: capability.observedAt };
  const result = { ...identity, job: 'product-site-evidence-refresh', count: 1, requestedVersion: 7, recordedAt: new Date(at - 500).toISOString() };
  const input = { ...identity, at, evidence, result };
  expect(classifyBatchReadiness(input)).toEqual({ ready: false, reason: 'result_unverified' });
  expect(classifyBatchReadiness({ ...input, readback: { job: result.job, instanceId: identity.instanceId, host: identity.host,
    release: identity.release, requestedVersion: 7, domainReadbackHash: 'b'.repeat(64), observedAt: new Date(at).toISOString() } }))
    .toEqual({ ready: true, reason: 'ready' });
  expect(classifyBatchReadiness({ ...input, result: { ...result, count: 0 } }).ready).toBe(false);
  expect(classifyBatchReadiness({ ...input, result: null }).ready).toBe(false);
});
