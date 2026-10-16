import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { batchPolicyHash } from '@/lib/jobs/batches';

// Same mocked DB surface as tests/oracle-runtime-preflight.test.ts; this file covers the PR11d follow-ups only.
const io = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn(), lock: vi.fn(), admission: vi.fn(), role: vi.fn(), replay: vi.fn(),
  classify: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: io.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: io.replay }));
vi.mock('@/lib/jobs/batch-repository', async load => ({ ...await load<typeof import('@/lib/jobs/batch-repository')>(),
  lockJobBatch: io.lock, assertJobBatchAdmission: io.admission }));
vi.mock('@/lib/jobs/role-leader', async load => ({ ...await load<typeof import('@/lib/jobs/role-leader')>(), assertRoleLease: io.role }));
vi.mock('@/lib/runtime/oracle-model-evidence', () => ({ classifyOracleModelEvidence: io.classify }));

const { readOracleRuntimePreflight, oracleRoleTimeouts } = await import('@/lib/runtime/oracle-preflight');
const release = 'a'.repeat(40), instanceId = 'oracle-translation', now = '2026-10-16T12:00:00Z';
const policy = { version: 1 as const, release, instances: [{ instanceId, host: 'oracle-osaka-smoke' as const }] };
const roleSettings = (config: string[], database = false) => ({ database, config });
let session: Record<string, unknown>, candidate: Record<string, unknown>, observation: Record<string, unknown>, modelRows: unknown[];
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ JOB_BATCH_VERSION: '1', PHYSICAL_HOST: 'oracle-osaka-smoke', SERVICE_INSTANCE_ID: instanceId,
    RELEASE_TAG: release, DB_POOLER_MODE: 'pgbouncer' })) vi.stubEnv(key, value);
  for (const key of Object.keys(process.env).filter(key => key.startsWith('ROLE_LEASE_'))) vi.stubEnv(key, undefined);
  io.replay.mockReturnValue(undefined);
  const control = { mode: 'versioned', writerContractVersion: 1, epoch: 3, policy, policyHash: batchPolicyHash(policy) };
  session = { at: now, principal: 'oracle_runtime', sessionPrincipal: 'oracle_runtime', unsafe: false, readOnly: false, replica: false,
    statementMs: 60000, lockMs: 5000, idleMs: 60000, privileges: [],
    roleSettings: [roleSettings(['statement_timeout=60s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s'])] };
  candidate = { role: 'translation', instanceId, host: 'oracle-osaka-smoke', bootId: 'boot', release, policyHash: control.policyHash,
    capability: { host: 'oracle-osaka-smoke', instanceId, release, dbPrivileges: 'verified', dbRole: 'oracle_runtime', effectivePrivilegeHash: 'b'.repeat(64),
      http: 'verified', model: 'verified', modelBoundEvidenceHash: 'd'.repeat(64), observedAt: '2026-10-16T11:59:00Z' },
    resultEvidence: { job: 'product-translate', instanceId, host: 'oracle-osaka-smoke', release, requestedVersion: 4, domainReadbackHash: 'c'.repeat(64),
      observedAt: '2026-10-16T11:59:50Z' } };
  observation = { key: `batch-result:${instanceId}:product-translate`, value: { batchResult: { role: 'translation', batchEpoch: 3, job: 'product-translate',
    instanceId, host: 'oracle-osaka-smoke', release, bootId: 'boot', recordedAt: '2026-10-16T11:59:40Z', count: 1, requestedVersion: 4 } } };
  modelRows = [{ requestId: 'r1' }];
  io.lock.mockResolvedValue(control);
  let reads = 0; // Per inspection transaction: session, candidate, observations, then the model ledger.
  io.transaction.mockImplementation(async load => { reads = 0; return load({ execute: io.execute }); });
  io.execute.mockImplementation(async () => [[session], [candidate], [observation]][reads++] ?? modelRows);
  io.classify.mockReturnValue({ model: 'verified', reason: 'model_bound_readback_verified', modelBoundEvidenceHash: 'd'.repeat(64), calls: 1 });
});
afterEach(() => vi.unstubAllEnvs());

it('parses role-specific catalog defaults with PostgreSQL units and role-in-database precedence', () => {
  expect(oracleRoleTimeouts([roleSettings(['statement_timeout=1min', 'lock_timeout=5000', 'idle_in_transaction_session_timeout=60000ms', 'search_path=public'])]))
    .toEqual({ statementMs: 60000, lockMs: 5000, idleMs: 60000 });
  expect(oracleRoleTimeouts([roleSettings(['statement_timeout=60s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s']),
    roleSettings(['statement_timeout=0'], true)])).toEqual({ statementMs: 0, lockMs: 5000, idleMs: 60000 });
  for (const value of [undefined, null, {}, [roleSettings(['statement_timeout=60s', 'lock_timeout=5s'])],
    [roleSettings(['statement_timeout=1.5s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s'])],
    [roleSettings(['statement_timeout=60s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=-1'])], [{ database: 'no', config: [] }]])
    expect(oracleRoleTimeouts(value)).toBeNull();
});

it('verifies PgBouncer timeouts from the role catalog plus this transaction, never from the transaction alone', async () => {
  const verified = await readOracleRuntimePreflight({ role: 'translation' });
  expect(verified.checks.timeouts).toEqual({ status: 'verified', reason: 'role_server_timeouts_bounded' });
  session.roleSettings = [];
  expect((await readOracleRuntimePreflight({ role: 'translation' })).checks.timeouts).toEqual({ status: 'unknown', reason: 'pooler_server_settings_unverified' });
});

it.each([
  ['an unbounded role-in-database override', [roleSettings(['statement_timeout=60s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s']),
    roleSettings(['idle_in_transaction_session_timeout=0'], true)], {}, 'role_server_timeouts_unbounded'],
  ['a role lock wait above five seconds', [roleSettings(['statement_timeout=60s', 'lock_timeout=6s', 'idle_in_transaction_session_timeout=60s'])], {}, 'role_server_timeouts_unbounded'],
  ['a leaked unbounded session value', [roleSettings(['statement_timeout=60s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s'])],
    { statementMs: 0 }, 'effective_session_timeouts_unbounded'],
] as const)('rejects %s before any workload or admission read', async (_name, settings, effective, reason) => {
  Object.assign(session, { roleSettings: settings, ...effective });
  const report = await readOracleRuntimePreflight({ role: 'translation' });
  expect(report.checks.timeouts).toEqual({ status: 'rejected', reason }); expect(report.workload.reason).toBe('timeouts_rejected');
  expect(io.execute).toHaveBeenCalledOnce();
});

it('marks the model check verified only when this release re-derives the attested model-bound hash', async () => {
  const report = await readOracleRuntimePreflight({ role: 'translation' });
  expect(report.workload).toMatchObject({ ready: true, job: 'product-translate' });
  expect(report.checks.model).toEqual({ status: 'verified', reason: 'model_bound_readback_matches', hash: 'd'.repeat(64) });
  expect(io.classify).toHaveBeenCalledExactlyOnceWith({ job: 'product-translate', instanceId, release, bootId: 'boot', batchEpoch: 3, requestedVersion: 4,
    recordedAt: '2026-10-16T11:59:40Z' }, modelRows);
  expect(report.ready).toBe(false); expect(report.activationAllowed).toBe(false);
});

it.each([
  ['a different re-derived hash', { model: 'verified', reason: 'model_bound_readback_verified', modelBoundEvidenceHash: 'e'.repeat(64), calls: 1 }, 'model_bound_evidence_mismatch'],
  ['a null serving contract', { model: 'unknown', reason: 'serving_contract_unavailable' }, 'serving_contract_unavailable'],
] as const)('keeps the model check unknown for %s', async (_name, classified, reason) => {
  io.classify.mockReturnValue(classified);
  const report = await readOracleRuntimePreflight({ role: 'translation' });
  expect(report.checks.model).toEqual({ status: 'unknown', reason });
});

it('never reads the model ledger for a non-model role or a not-ready translation workload', async () => {
  (candidate.capability as Record<string, unknown>).model = 'unknown';
  expect((await readOracleRuntimePreflight({ role: 'translation' })).checks.model.status).toBe('unknown');
  Object.assign(candidate, { role: 'official-news' });
  Object.assign(candidate.resultEvidence as object, { job: 'news-refresh' });
  observation.key = `batch-result:${instanceId}:news-refresh`;
  Object.assign((observation.value as { batchResult: object }).batchResult, { role: 'official-news', job: 'news-refresh' });
  const news = await readOracleRuntimePreflight({ role: 'official-news' });
  expect(news.workload.ready).toBe(true); expect(news.checks.model).toEqual({ status: 'unknown', reason: 'physical_model_slot_unverified' });
  expect(io.classify).not.toHaveBeenCalled();
});
