import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { batchPolicyHash } from '@/lib/jobs/batches';

const io = vi.hoisted(() => ({
  transaction: vi.fn(), execute: vi.fn(), lock: vi.fn(), admission: vi.fn(), role: vi.fn(),
  replay: vi.fn(), trace: [] as string[],
}));
vi.mock('@/lib/db', () => ({ db: { transaction: io.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: io.replay }));
vi.mock('@/lib/jobs/batch-repository', async load => ({ ...await load<typeof import('@/lib/jobs/batch-repository')>(),
  lockJobBatch: io.lock, assertJobBatchAdmission: io.admission }));
vi.mock('@/lib/jobs/role-leader', async load => ({ ...await load<typeof import('@/lib/jobs/role-leader')>(), assertRoleLease: io.role }));

const { readOracleRuntimePreflight } = await import('@/lib/runtime/oracle-preflight');
const release = 'a'.repeat(40), instanceId = 'oracle-site';
const now = '2026-10-16T12:00:00Z';
const policy = { version: 1 as const, release, instances: [{ instanceId, host: 'oracle-osaka-smoke' as const }] };
let control: Record<string, unknown>, session: Record<string, unknown>, candidate: Record<string, unknown>;
let observation: { key: string; value: { batchResult: Record<string, unknown> } };
const tx = { execute: io.execute };
beforeEach(() => {
  vi.clearAllMocks(); io.trace.length = 0;
  for (const [key, value] of Object.entries({ JOB_BATCH_VERSION: '1', PHYSICAL_HOST: 'oracle-osaka-smoke',
    SERVICE_INSTANCE_ID: instanceId, RELEASE_TAG: release, DB_POOLER_MODE: 'direct',
    ROLE_LEASE_ROLE: 'site-evidence', ROLE_LEASE_INSTANCE_ID: instanceId, ROLE_LEASE_BOOT_ID: 'boot',
    ROLE_LEASE_RELEASE: release, ROLE_LEASE_EPOCH: '2', ROLE_LEASE_BATCH_VERSION: '1',
    ROLE_LEASE_BATCH_EPOCH: '3', ROLE_LEASE_HOST: 'oracle-osaka-smoke' })) vi.stubEnv(key, value);
  io.replay.mockReturnValue(undefined);
  control = { mode: 'versioned', writerContractVersion: 1, epoch: 3, policy, policyHash: batchPolicyHash(policy) };
  session = { at: now, principal: 'oracle_runtime', sessionPrincipal: 'oracle_runtime', unsafe: false,
    readOnly: false, replica: false, statementMs: 15000, lockMs: 1000, idleMs: 60000, privileges: [] };
  candidate = { role: 'site-evidence', instanceId, host: 'oracle-osaka-smoke', bootId: 'boot', release,
    policyHash: control.policyHash,
    capability: { host: 'oracle-osaka-smoke', instanceId, release, dbPrivileges: 'verified', dbRole: 'oracle_runtime',
      effectivePrivilegeHash: 'b'.repeat(64), http: 'verified', model: 'unknown', observedAt: '2026-10-16T11:59:00Z' },
    resultEvidence: { job: 'product-site-evidence-refresh', instanceId, host: 'oracle-osaka-smoke', release,
      requestedVersion: 4, domainReadbackHash: 'c'.repeat(64), observedAt: '2026-10-16T11:59:50Z' } };
  observation = { key: `batch-result:${instanceId}:product-site-evidence-refresh`, value: { batchResult: {
    role: 'site-evidence', batchEpoch: 3, job: 'product-site-evidence-refresh', instanceId,
    host: 'oracle-osaka-smoke', release, bootId: 'boot', recordedAt: '2026-10-16T11:59:40Z', count: 1, requestedVersion: 4 } } };
  io.lock.mockImplementation(async () => { io.trace.push('batch'); return control; });
  io.transaction.mockImplementation(async load => load(tx));
  io.execute.mockImplementation(async () => {
    io.trace.push('read');
    return io.execute.mock.calls.length === 1 ? [session] : io.execute.mock.calls.length === 2 ? [candidate] : [observation];
  });
  io.admission.mockImplementation(async () => { io.trace.push('admission'); return {}; });
  io.role.mockImplementation(async () => { io.trace.push('role'); });
});
afterEach(() => vi.unstubAllEnvs());

it('reports a current actual ACK tuple through existing admission while keeping physical activation closed', async () => {
  const report = await readOracleRuntimePreflight({ role: 'site-evidence' });
  expect(report.workload).toMatchObject({ ready: true, reason: 'ready', job: 'product-site-evidence-refresh' });
  expect(report.ready).toBe(false); expect(report.activationAllowed).toBe(false);
  expect(report.checks.host.status).toBe('unknown'); expect(report.checks.budget.status).toBe('unknown');
  expect(io.trace[0]).toBe('batch'); expect(io.trace.slice(-2)).toEqual(['admission', 'role']);
  expect(io.admission).toHaveBeenCalledExactlyOnceWith(tx, 'product-site-evidence-refresh', expect.objectContaining({ epoch: 2, batchEpoch: 3 }));
});
it('rejects supplied readiness fields before any database call', async () => {
  await expect(readOracleRuntimePreflight({ role: 'site-evidence', ready: true })).rejects.toThrow('invalid_oracle_preflight_input');
  expect(io.transaction).not.toHaveBeenCalled();
});
it('does not treat a healthy heartbeat or an idle tick as a domain canary', async () => {
  observation.value.batchResult.count = 0;
  const report = await readOracleRuntimePreflight({ role: 'site-evidence' });
  expect(report.workload.ready).toBe(false); expect(io.admission).not.toHaveBeenCalled();
});
it.each(['role', 'bootId', 'batchEpoch', 'host', 'release', 'requestedVersion'])('rejects a mismatched actual ACK %s', async field => {
  observation.value.batchResult[field] = field === 'batchEpoch' || field === 'requestedVersion' ? 99 : 'other';
  expect((await readOracleRuntimePreflight({ role: 'site-evidence' })).workload.ready).toBe(false);
});
it('uses the public classifier freshness and domain readback checks', async () => {
  (candidate.resultEvidence as Record<string, unknown>).observedAt = '2026-10-16T11:58:00Z';
  expect((await readOracleRuntimePreflight({ role: 'site-evidence' })).workload.ready).toBe(false);
});
it.each(['legacy', 'draining'])('keeps %s admission closed without touching roles', async mode => {
  control.mode = mode;
  expect((await readOracleRuntimePreflight({ role: 'site-evidence' })).workload.ready).toBe(false);
  expect(io.admission).not.toHaveBeenCalled(); expect(io.role).not.toHaveBeenCalled();
});
it('rejects a privileged authenticated session and unbounded timeouts', async () => {
  session.unsafe = true; session.statementMs = 0;
  const report = await readOracleRuntimePreflight({ role: 'site-evidence' });
  expect(report.checks.database.status).toBe('rejected'); expect(report.workload.ready).toBe(false);
  expect(io.admission).not.toHaveBeenCalled();
});
it('refuses a genuine replay scope before database work', async () => {
  io.replay.mockReturnValue({});
  expect((await readOracleRuntimePreflight({ role: 'site-evidence' })).workload.reason).toBe('replay_unsupported');
  expect(io.transaction).not.toHaveBeenCalled();
});
it('snapshots process authority before the first await and preserves the original database error', async () => {
  const original = new Error('database fault');
  io.lock.mockImplementation(async () => { vi.stubEnv('ROLE_LEASE_EPOCH', '99'); return control; });
  io.role.mockRejectedValue(original);
  await expect(readOracleRuntimePreflight({ role: 'site-evidence' })).rejects.toBe(original);
  expect(io.role.mock.calls[0][1].epoch).toBe(2);
});
it('leaves scheduler capability unknown without creating a role or producer request', async () => {
  const report = await readOracleRuntimePreflight({ role: 'scheduler' });
  expect(report.workload.reason).toBe('scheduler_canary_unavailable'); expect(report.ready).toBe(false);
  expect(io.transaction).not.toHaveBeenCalled();
});
it('preserves the original inspection and pool-drain failures together', async () => {
  const { oraclePreflightMain } = await import('@/scripts/worker-oracle-preflight');
  const original = new Error('inspection'), close = new Error('drain');
  const global = globalThis as unknown as { pgClient?: { end: () => Promise<void> } };
  const previous = global.pgClient; const end = vi.fn(async () => { throw close; });
  global.pgClient = { end }; io.lock.mockRejectedValue(original);
  try {
    const error = await oraclePreflightMain(['--role=site-evidence']).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([original, close]);
    expect(error.errors[0]).toBe(original); expect(error.errors[1]).toBe(close); expect(end).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledWith({ timeout: 5 });
  } finally { if (previous === undefined) delete global.pgClient; else global.pgClient = previous; }
});

it.each([
  ['translation', 'product-translate'],
  ['official-news', 'news-refresh'],
  ['product-health', 'uptime-ping'],
] as const)('uses the existing %s job mapping and exact current tuple', async (role, job) => {
  vi.stubEnv('ROLE_LEASE_ROLE', role); candidate.role = role;
  (candidate.capability as Record<string, unknown>).model = 'verified';
  (candidate.capability as Record<string, unknown>).modelBoundEvidenceHash = 'd'.repeat(64);
  (candidate.resultEvidence as Record<string, unknown>).job = job;
  observation.key = `batch-result:${instanceId}:${job}`;
  Object.assign(observation.value.batchResult, { role, job });
  const report = await readOracleRuntimePreflight({ role });
  expect(report.workload).toMatchObject({ ready: true, job });
  expect(report.activationAllowed).toBe(false);
  expect(io.admission.mock.calls.map(call => call[1])).toEqual(role === 'translation'
    ? ['reason-translate', 'product-tagline-ko', 'product-translate'] : [job]);
});
it('keeps translation canary unknown without existing model-bound capability evidence', async () => {
  vi.stubEnv('ROLE_LEASE_ROLE', 'translation'); candidate.role = 'translation';
  (candidate.resultEvidence as Record<string, unknown>).job = 'product-translate';
  observation.key = `batch-result:${instanceId}:product-translate`;
  Object.assign(observation.value.batchResult, { role: 'translation', job: 'product-translate' });
  const report = await readOracleRuntimePreflight({ role: 'translation' });
  expect(report.workload).toEqual({ ready: false, reason: 'capability_unknown' });
  expect(io.admission).not.toHaveBeenCalled();
});
it('rejects unbounded effective timeouts independently of role privilege', async () => {
  session.statementMs = 0;
  const report = await readOracleRuntimePreflight({ role: 'site-evidence' });
  expect(report.checks.timeouts).toEqual({ status: 'rejected', reason: 'effective_session_timeouts_unbounded' });
  expect(report.workload.ready).toBe(false); expect(io.admission).not.toHaveBeenCalled();
});
it('keeps missing current-role authority unknown despite a positive persisted canary', async () => {
  for (const key of Object.keys(process.env).filter(key => key.startsWith('ROLE_LEASE_'))) vi.stubEnv(key, undefined);
  const report = await readOracleRuntimePreflight({ role: 'site-evidence' });
  expect(report.workload.ready).toBe(true); expect(report.checks.admission.status).toBe('unknown');
  expect(report.ready).toBe(false); expect(io.admission).not.toHaveBeenCalled(); expect(io.role).not.toHaveBeenCalled();
});
it('rejects actual expired role admission after the other inspection waits', async () => {
  const { RoleLeaseLostError } = await import('@/lib/jobs/role-leader');
  io.role.mockRejectedValue(new RoleLeaseLostError());
  const report = await readOracleRuntimePreflight({ role: 'site-evidence' });
  expect(report.workload).toEqual({ ready: false, reason: 'admission_rejected' });
  expect(report.checks.admission.status).toBe('rejected'); expect(io.trace.at(-1)).toBe('admission');
});
it('returns configuration status 78 and drains the existing pool after a positive workload report', async () => {
  const { oraclePreflightMain } = await import('@/scripts/worker-oracle-preflight');
  const global = globalThis as unknown as { pgClient?: { end: () => Promise<void> } };
  const previous = global.pgClient, end = vi.fn(async () => {});
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  global.pgClient = { end };
  try {
    expect(await oraclePreflightMain(['--role=site-evidence'])).toBe(78);
    const report = JSON.parse(String(write.mock.calls[0][0]));
    expect(report.workload.ready).toBe(true); expect(report.ready).toBe(false); expect(report.activationAllowed).toBe(false);
    expect(end).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledWith({ timeout: 5 });
  } finally { write.mockRestore(); if (previous === undefined) delete global.pgClient; else global.pgClient = previous; }
});

it('rejects invalid arguments through the actual native CLI without a database environment', async () => {
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const child = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'),
    resolve('scripts/worker-oracle-preflight.ts'), '--role=unsupported'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 3000,
  });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(78);
  expect(child.stdout).toBe(''); expect(child.stderr).toBe('{"code":"oracle_runtime_preflight_failed"}\n');
});
