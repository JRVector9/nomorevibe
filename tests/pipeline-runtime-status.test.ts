import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildPipelineControlStatus, readPipelineControlStatus } from '@/lib/operations/pipeline-control-status';
import { ORACLE_ROLES, summarizeHostLedger } from '@/lib/operations/pipeline-runtime-status';
import { batchPolicyHash } from '@/lib/jobs/batches';
import { modelCapacityPolicyHash } from '@/lib/llm/capacity';
import { httpOriginPolicyHash } from '@/lib/net/http-origin-policy';

const reads = vi.hoisted(() => ({ execute: vi.fn(), readiness: vi.fn(), primary: vi.fn(), replica: vi.fn(), transaction: vi.fn(), setLocal: vi.fn() }));
// R4 fixture: 읽기 전용 TX 안의 SET LOCAL(문장 상한)은 따로 받는다 — execute 는 스냅숏 한 문장 그대로다
vi.mock('@/lib/db', () => ({ db: { execute: reads.execute,
  transaction: async (load: (tx: unknown) => Promise<unknown>, config?: unknown) => { reads.transaction(config); return load({ execute: (query: { queryChunks?: unknown }) =>
    JSON.stringify(query.queryChunks ?? query).includes('SET LOCAL') ? reads.setLocal(query) : reads.execute(query) }); } },
  onPrimary: (load: () => Promise<unknown>) => { reads.primary(); return load(); },
  onReplica: (load: () => Promise<unknown>) => { reads.replica(); return load(); } }));
vi.mock('@/lib/operations/job-batch-readiness', () => ({ readJobBatchReadiness: reads.readiness }));

const at = '2026-10-16T12:00:00.000Z', now = Date.parse(at);
const boot = '0b9f6c1e-1d1f-4a55-9a3b-5d1f2c3b4a51', token = '7d2c4e3f-9a1b-4c2d-8e3f-1a2b3c4d5e6f', shape = 'c'.repeat(64);
const policy = { version: 1 as const, release: 'release-one', instances: [{ instanceId: 'oracle-news', host: 'oracle-osaka-smoke' as const },
  { instanceId: 'm3-main', host: 'm3' as const }] };
const modelPolicy = { version: 1 as const, globalLimit: 4, providerLimits: { abcllm: 2, idle: 1 }, groupLimits: { g: 2 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 10, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: 'r1', provider: 'abcllm', model: 'm', providerBudgetId: 'abcllm', groupId: 'g' },
    { routeId: 'r2', provider: 'other', model: 'm', providerBudgetId: 'idle', groupId: 'g' }] };
const httpPolicy = { version: 1 as const, instanceHosts: { 'oracle-news': 'oracle-osaka-smoke' as const } };
const prefix = 'host-slot:oracle-osaka-smoke';
const processRow = (identity: string, patch: Record<string, unknown> = {}) => ({ key: `${prefix}:p:${identity}`, value: { type: 'process', bootId: boot, shape,
  identity, pid: 987_654, release: 'release-one', primaryMax: 3, readMax: 1, leaseUntilMs: now + 30_000, renewedAtMs: now - 2_000,
  rssBytes: 200 * 1024 * 1024, eventLoopDelayMs: 40, heartbeatGapMs: 10_000, loadPerCpu: 0.5, ...patch } });
const ledgerRows = () => [
  { key: prefix, value: { type: 'anchor' } },
  processRow('worker:translation:-:1:1', { renewedAtMs: now - 12_000 }),
  processRow('role-parent:translation:-:1:1', { primaryMax: 1, readMax: 0, eventLoopDelayMs: 75, loadPerCpu: 1.25 }),
  processRow('worker:official-news:-:1:1', { leaseUntilMs: now - 1 }),
  { key: `${prefix}:t:1`, value: { type: 'translation', bootId: boot, shape, leaseUntilMs: now + 60_000, token, job: 'reason-translate', owner: 'worker:translation:-:1:1', holdMs: 30_000 } },
];
const capability = { host: 'oracle-osaka-smoke', release: 'release-one', instanceId: 'oracle-news', dbPrivileges: 'verified', http: 'verified', model: 'unknown',
  dbRole: 'nmv_oracle_news_private', effectivePrivilegeHash: 'a'.repeat(64), observedAt: at };
function fixture() {
  return { at, batch: { mode: 'versioned', epoch: 7, contract: 1, policy, policyHash: batchPolicyHash(policy) },
    stages: [], source: null,
    model: { mode: 'open', epoch: 5, revision: 3, policy: modelPolicy, policyHash: modelCapacityPolicyHash(modelPolicy),
      waiting: 2, reserved: 1, dispatched: 4, indeterminate: 4, oldestWaitingAt: '2026-10-16T11:30:00.000Z' },
    http: { mode: 'open', epoch: 9, revision: 2, policy: httpPolicy, policyHash: httpOriginPolicyHash(httpPolicy), reserved: 0, dispatched: 0, indeterminate: 0, oracleCharged: 0 },
    uptime: null, backlog: null,
    owners: [{ role: 'official-news', instanceId: 'oracle-news', release: 'release-one', epoch: 11, live: true },
      { role: 'crawler', instanceId: 'm3-main', release: 'release-one', epoch: 4, live: false },
      { role: 'publisher', instanceId: 'ghost', release: 'release-one', epoch: 2, live: true },
      { role: 'text', instanceId: null, release: null, epoch: 0, live: false }],
    hostSlots: { atMs: now, rows: ledgerRows() },
    modelBudgets: [
      { budget: 'abcllm', waiting: 2, reserved: 1, expiredReserved: 1, dispatched: 3, indeterminate: 4,
        oldestWaitingAt: '2026-10-16T11:30:00.000Z', oldestUnsettledAt: '2026-10-16T11:00:00.000Z', untimed: 0 },
      { budget: 'claude-cli', waiting: 0, reserved: 0, expiredReserved: 0, dispatched: 1, indeterminate: 0, oldestWaitingAt: null, oldestUnsettledAt: null, untimed: 1 }],
    dr: { state: 'fenced', epoch: 3, reason: 'promotion_sealed', updatedAt: at, promoted: 1,
      sealed: [{ id: '5e0c2a4b-7f61-4c3d-9a8b-2c1d0e9f8a7b', fromEpoch: 3, toEpoch: 4, sealedAt: '2026-10-16T11:50:00.000Z', evidence: ['old_db_fenced', 'writer_process_stopped'] }] },
    oracleCandidates: [{ role: 'official-news', instanceId: 'oracle-news', release: 'release-one', capability },
      { role: 'translation', instanceId: 'oracle-news', release: 'old-release', capability: null }] };
}
const readiness = { mode: 'versioned', epoch: 7, policyHash: batchPolicyHash(policy), ready: false, reason: 'evidence', candidates: [
  { role: 'official-news', instanceId: 'oracle-news', host: 'oracle-osaka-smoke', release: 'release-one', anchor: true, ready: true, reason: 'ready' },
  { role: 'crawler', instanceId: 'm3-main', host: 'm3', release: 'release-one', anchor: false, ready: false, reason: 'capability_unknown' },
  { role: 'maintenance', instanceId: 'm3-main', host: 'm3', release: 'release-one', anchor: true, ready: false, reason: 'anchor_identity_mismatch' },
] };

describe('host-slot ledger summary', () => {
  it('reads live processes, expired rows, translation slots and the worst heartbeat without judging limits', () => {
    expect(summarizeHostLedger('oracle-osaka-smoke', ledgerRows(), now)).toEqual({ state: 'ok', processes: 2, expired: 1,
      primaryClients: 4, replicaClients: 1, shapes: 1, heartbeatGapMs: 12_000, eventLoopDelayMs: 75, loadPerCpu: 1.25,
      rssBytes: 400 * 1024 * 1024, translationHeld: 1, translationCap: 1 });
  });
  it('keeps absent, unread and malformed ledgers distinct from an empty healthy host', () => {
    expect(summarizeHostLedger('m3', ledgerRows(), now)).toMatchObject({ state: 'absent', processes: null, translationCap: null });
    expect(summarizeHostLedger('m3', null, now)).toMatchObject({ state: 'unknown', processes: null });
    const broken = [...ledgerRows(), { key: `${prefix}:p:wrong-identity`, value: processRow('worker:text:-:1:1').value }];
    expect(summarizeHostLedger('oracle-osaka-smoke', broken, now)).toMatchObject({ state: 'invalid', processes: null, rssBytes: null });
  });
  it('counts different policy shapes so a mismatched roster is visible', () => {
    const rows = [...ledgerRows(), processRow('worker:site-evidence:-:1:1', { shape: 'd'.repeat(64) })];
    expect(summarizeHostLedger('oracle-osaka-smoke', rows, now).shapes).toBe(2);
  });
});

describe('runtime readback', () => {
  it('maps leases, anchors, ledgers, model slots, DR fence and Oracle gate from one snapshot', () => {
    const { runtime, owners } = buildPipelineControlStatus(fixture(), readiness);
    expect(owners.find(row => row.instanceId === 'oracle-news')).toMatchObject({ host: 'oracle-osaka-smoke', release: 'release-one', epoch: 11, live: true });
    expect(owners.find(row => row.instanceId === 'ghost')?.host).toBeNull();
    expect(runtime.ownersRead).toBe(true);
    const anchor = (host: string, role: string) => runtime.anchors.find(row => row.host === host && row.role === role)?.anchor;
    expect([anchor('oracle-osaka-smoke', 'official-news'), anchor('m3', 'crawler'), anchor('m3', 'maintenance'), anchor('mini', 'crawler')])
      .toEqual(['pinned', 'absent', 'invalid', null]);
    expect(runtime.ledgers.map(row => [row.host, row.ledger.state])).toEqual([['m3', 'absent'], ['mini', 'absent'], ['oracle-osaka-smoke', 'ok']]);
    expect(runtime.models).toEqual([
      { budget: 'abcllm', limit: 2, waiting: 2, reserved: 1, expiredReserved: 1, dispatched: 3, indeterminate: 4, oldestWaitingMin: 30, oldestUnsettledMin: 60 },
      { budget: 'claude-cli', limit: null, waiting: 0, reserved: 0, expiredReserved: 0, dispatched: 1, indeterminate: 0, oldestWaitingMin: null, oldestUnsettledMin: null },
      { budget: 'idle', limit: 1, waiting: 0, reserved: 0, expiredReserved: 0, dispatched: 0, indeterminate: 0, oldestWaitingMin: null, oldestUnsettledMin: null }]);
    expect(runtime.dr).toMatchObject({ state: 'fenced', epoch: 3, reason: 'promotion_sealed', promoted: 1 });
    expect(runtime.dr.sealed?.[0]).toMatchObject({ fromEpoch: 3, toEpoch: 4, evidence: ['old_db_fenced', 'writer_process_stopped'] });
    expect(runtime.oracle.checks).toEqual([
      { key: 'batch', status: 'verified', reason: 'oracle_instance_registered' }, { key: 'http', status: 'verified', reason: 'oracle_http_mapped' },
      { key: 'ledger', status: 'verified', reason: 'ledger_participating' }, { key: 'dr', status: 'rejected', reason: 'writer_fenced' }]);
    expect(runtime.oracle.roles.map(row => row.role)).toEqual([...ORACLE_ROLES]);
    expect(runtime.oracle.roles.find(row => row.role === 'official-news')).toEqual({ role: 'official-news', candidate: true,
      db: 'verified', http: 'verified', model: 'unknown', reason: 'ready', anchor: 'pinned', lease: true });
    expect(runtime.oracle.roles.find(row => row.role === 'translation')).toEqual({ role: 'translation', candidate: true,
      db: null, http: null, model: null, reason: 'candidate_missing', anchor: null, lease: false });
    expect(runtime.oracle.roles.find(row => row.role === 'product-health')).toMatchObject({ candidate: false, lease: false });
    expect(runtime.oracle.liveLeases).toBe(1);
  });
  it('shows the model card dispatched and indeterminate separately next to the existing unsettled sum', () => {
    const model = buildPipelineControlStatus(fixture(), readiness).controls.find(row => row.key === 'model')!;
    expect(model.metrics).toEqual(expect.arrayContaining([{ label: '미정산', value: 8 }, { label: 'dispatched', value: 4 }, { label: 'indeterminate', value: 4 }]));
  });
  it('never carries ledger tokens, boot ids, pids, DB roles or privilege hashes into the view model', () => {
    const text = JSON.stringify(buildPipelineControlStatus(fixture(), readiness));
    for (const secret of [boot, token, '987654', 'nmv_oracle_news_private', 'a'.repeat(64), 'c'.repeat(64)]) expect(text).not.toContain(secret);
  });
});

describe('runtime unknown boundaries', () => {
  it('leaves every runtime section unknown when nothing was read', () => {
    const { runtime } = buildPipelineControlStatus(null, null);
    expect(runtime.ledgers.every(row => row.ledger.state === 'unknown')).toBe(true);
    expect(runtime).toMatchObject({ models: null, ownersRead: false, dr: { state: null, epoch: null, sealed: null }, oracle: { liveLeases: null } });
    expect(runtime.oracle.checks.every(row => row.status === 'unknown')).toBe(true);
    expect(runtime.oracle.roles.every(row => row.candidate === null && row.lease === null && row.anchor === null && row.reason === null)).toBe(true);
  });
  it('rejects contradictory fence rows and unverified slot policies instead of guessing', () => {
    const raw = fixture();
    const status = buildPipelineControlStatus({ ...raw, dr: { ...raw.dr, state: 'active' }, model: { ...raw.model, policyHash: '0'.repeat(64) } }, readiness);
    expect(status.runtime.dr.state).toBeNull();
    expect(status.runtime.oracle.checks.find(row => row.key === 'dr')).toMatchObject({ status: 'unknown', reason: 'fence_unread' });
    expect(status.runtime.models?.map(row => [row.budget, row.limit])).toEqual([['abcllm', null], ['claude-cli', null]]);
  });
  it('turns a malformed Oracle ledger into a rejected gate check and keeps unadopted readiness anchors unknown', () => {
    const raw = fixture();
    raw.hostSlots.rows.push({ key: `${prefix}:t:x`, value: { type: 'anchor' } });
    const status = buildPipelineControlStatus(raw, { ...readiness, epoch: 6 });
    expect(status.runtime.oracle.checks.find(row => row.key === 'ledger')).toEqual({ key: 'ledger', status: 'rejected', reason: 'ledger_invalid' });
    expect(status.runtime.anchors.every(row => row.anchor === null)).toBe(true);
    expect(status.runtime.oracle.roles.find(row => row.role === 'official-news')).toMatchObject({ reason: 'readback_unknown', anchor: null });
  });
  it('does not mark the batch gate verified without an Oracle instance in the verified policy', () => {
    const raw = fixture(), local = { ...policy, instances: [policy.instances[1]] };
    const status = buildPipelineControlStatus({ ...raw, batch: { ...raw.batch, policy: local, policyHash: batchPolicyHash(local) } }, null);
    expect(status.runtime.oracle.checks.find(row => row.key === 'batch')).toEqual({ key: 'batch', status: 'unknown', reason: 'oracle_instance_missing' });
    const legacy = buildPipelineControlStatus({ ...raw, batch: { mode: 'legacy', epoch: 1, contract: 0, policy: null, policyHash: null } }, null);
    expect(legacy.runtime.oracle.checks.find(row => row.key === 'batch')).toMatchObject({ status: 'unknown', reason: 'batch_not_versioned' });
  });
});

describe('runtime SQL stays in the one read-only statement', () => {
  it('reads host-slot rows, slot budgets, DR fence and Oracle candidates without locks or writes', async () => {
    reads.execute.mockReset().mockResolvedValue([{ snapshot: fixture() }]);
    reads.readiness.mockReset().mockResolvedValue(readiness);
    const status = await readPipelineControlStatus();
    expect(reads.execute).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(reads.execute.mock.calls[0][0]).sql;
    for (const table of ["key LIKE 'host-slot:%'", 'model_capacity_events', 'dr_writer_fence', 'dr_promotions', 'dr_promotion_evidence', 'job_batch_candidates'])
      expect(query).toContain(table);
    expect(query).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|LOCK|FOR UPDATE|FOR SHARE|FOR NO KEY|FOR KEY SHARE)\b|pg_advisory|nextval|setval/i);
    expect(status.runtime.oracle.liveLeases).toBe(1);
  });
});
