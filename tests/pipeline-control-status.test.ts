import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildPipelineControlStatus, readPipelineControlStatus } from '@/lib/operations/pipeline-control-status';
import { batchPolicyHash, BATCH_ROLES } from '@/lib/jobs/batches';
import { httpOriginPolicyHash } from '@/lib/net/http-origin-policy';

const reads = vi.hoisted(() => ({ execute: vi.fn(), readiness: vi.fn(), primary: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: reads.execute }, onPrimary: (load: () => Promise<unknown>) => { reads.primary(); return load(); } }));
vi.mock('@/lib/operations/job-batch-readiness', () => ({ readJobBatchReadiness: reads.readiness }));

const at = '2026-10-16T12:00:00.000Z';
const policy = { version: 1 as const, release: 'release-one', instances: [{ instanceId: 'oracle-news', host: 'oracle-osaka-smoke' as const }] };
const httpPolicy = { version: 1 as const, instanceHosts: { 'oracle-news': 'oracle-osaka-smoke' as const } };
function fixture() {
  return { at, batch: { mode: 'versioned', epoch: 7, contract: 1, policy, policyHash: batchPolicyHash(policy) },
    stages: [{ stage: 'fetch', mode: 'legacy', epoch: 2, contract: 1, live: 1, unsettled: 2 },
      { stage: 'ai1', mode: 'draining', epoch: 3, contract: 1, live: 0, unsettled: 0 },
      { stage: 'ai2', mode: 'items', epoch: 4, contract: 1, live: 2, unsettled: 1 }],
    source: { enabled: false, epoch: 6, live: 1, unsettled: 1, due: 3, backoff: 4 },
    model: { mode: 'disabled', epoch: 5, revision: 3, policy: null, policyHash: null,
      waiting: 2, reserved: 1, dispatched: 3, indeterminate: 4, oldestWaitingAt: '2026-10-16T11:30:00.000Z' },
    http: { mode: 'draining', epoch: 9, revision: 2, policy: httpPolicy, policyHash: httpOriginPolicyHash(httpPolicy),
      reserved: 1, dispatched: 2, indeterminate: 3, oracleCharged: 2 },
    uptime: { observationsEnabled: true, gateEnabled: false, revision: 8, sources: [], rawOnly: 5, held: 2, applied: 1,
      latestAt: '2026-10-16T11:59:00.000Z' },
    backlog: { fetchReady: 8, fetchBackoff: 6, human: 9, jobRequests: 10 },
    owners: [{ role: 'official-news', instanceId: 'oracle-news', release: 'release-one', epoch: 11, live: true }] };
}
const readiness = { mode: 'versioned', epoch: 7, policyHash: batchPolicyHash(policy), ready: false, reason: 'evidence', candidates: [
  { role: 'official-news', instanceId: 'oracle-news', host: 'oracle-osaka-smoke', release: 'release-one', ready: false, reason: 'capability_unknown' },
] };

describe('pipeline control readback', () => {
  it('leaves missing readback unknown instead of showing a healthy empty system', () => {
    const status = buildPipelineControlStatus(null, null);
    expect(status.observedAt).toBeNull();
    expect(status.controls).toHaveLength(5);
    expect(status.controls.every(row => row.mode === null && row.policy === 'unknown')).toBe(true);
  });
  it('preserves actual modes, epochs and unsettled charges even under disabled or draining controls', () => {
    const status = buildPipelineControlStatus(fixture(), readiness);
    expect(status.observedAt).toBe(at);
    expect(status.controls.find(row => row.key === 'batch')).toMatchObject({ mode: 'versioned', epoch: 7, policy: 'verified' });
    expect(status.controls.find(row => row.key === 'model')).toMatchObject({ mode: 'disabled', epoch: 5, revision: 3, policy: 'unset' });
    expect(status.controls.find(row => row.key === 'model')?.metrics).toContainEqual({ label: '미정산', value: 7 });
    expect(status.controls.find(row => row.key === 'http')?.metrics).toContainEqual({ label: 'Oracle 점유', value: 2 });
    expect(status.stages.find(row => row.stage === 'ai2')).toMatchObject({ mode: 'items', epoch: 4, live: 2, unsettled: 1 });
    expect(status.backlog).toContainEqual({ label: '심사 대기', value: 9 });
  });
  it('keeps installation-only host evidence unknown and shows actual owner separately', () => {
    const status = buildPipelineControlStatus(fixture(), readiness);
    const oracle = status.hosts.find(row => row.host === 'oracle-osaka-smoke');
    expect(oracle?.roles).toHaveLength(BATCH_ROLES.length);
    expect(oracle?.roles.find(row => row.role === 'official-news')).toEqual({ role: 'official-news', ready: false, reason: 'capability_unknown' });
    expect(status.owners).toContainEqual({ role: 'official-news', instanceId: 'oracle-news', host: 'oracle-osaka-smoke', release: 'release-one', epoch: 11, live: true });
  });
});

describe('unknown boundaries', () => {
  it('does not promote an invalid policy or old readiness epoch while retaining other readbacks', () => {
    const raw = fixture();
    raw.http.policyHash = '0'.repeat(64);
    const status = buildPipelineControlStatus(raw, { ...readiness, epoch: 6, candidates: readiness.candidates.map(row => ({ ...row, ready: true, reason: 'ready' })) });
    expect(status.controls.find(row => row.key === 'http')).toMatchObject({ mode: null, policy: 'unknown', epoch: 9 });
    expect(status.controls.find(row => row.key === 'uptime')).toMatchObject({ mode: 'observing', revision: 8 });
    expect(status.hosts.every(host => host.roles.every(role => !role.ready))).toBe(true);
  });
  it('keeps missing sections/counts unknown and never leaks private row material', () => {
    const raw = { ...fixture(), model: null, token: 'private-token', binding: { secret: 'never-render' } };
    const status = buildPipelineControlStatus(raw, null);
    expect(status.controls.find(row => row.key === 'model')).toMatchObject({ mode: null, metrics: [] });
    expect(JSON.stringify(status)).not.toMatch(/private-token|never-render/);
    expect(status.controls.find(row => row.key === 'source')).toMatchObject({ mode: 'disabled', epoch: 6 });
  });
  it('does not infer readiness from fresh installation or from empty candidate lists', () => {
    for (const candidates of [[], readiness.candidates]) {
      const status = buildPipelineControlStatus(fixture(), { ...readiness, candidates });
      expect(status.hosts).toHaveLength(3);
      expect(status.hosts.every(host => host.roles.every(role => !role.ready))).toBe(true);
    }
  });
  it('shows only the existing strict readiness result, independently from lease liveness', () => {
    const status = buildPipelineControlStatus(fixture(), { ...readiness, candidates: readiness.candidates.map(row => ({ ...row, ready: true, reason: 'ready' })) });
    expect(status.hosts.find(row => row.host === 'oracle-osaka-smoke')?.roles.find(row => row.role === 'official-news')).toMatchObject({ ready: true, reason: 'ready' });
    expect(status.owners[0]).toMatchObject({ live: true, epoch: 11 });
    expect(status.hosts.find(row => row.host === 'm3')?.roles.every(row => !row.ready)).toBe(true);
  });
  it('does not select one duplicate stage row or convert invalid clock/counters into zero', () => {
    const raw = fixture();
    raw.stages.push({ ...raw.stages[0] });
    const status = buildPipelineControlStatus(raw, readiness);
    expect(status.stages.find(row => row.stage === 'fetch')?.mode).toBeNull();
    expect(buildPipelineControlStatus({ ...raw, at: 'broken' }, readiness).observedAt).toBeNull();
    expect(buildPipelineControlStatus({ ...raw, backlog: { ...raw.backlog, human: -1 } }, readiness).backlog.every(row => row.value === null)).toBe(true);
  });
});


describe('primary read-only loader', () => {
  it('uses one statement for DB clock/control/ledger counts and existing readiness separately', async () => {
    reads.execute.mockReset().mockResolvedValue([{ snapshot: fixture() }]);
    reads.readiness.mockReset().mockResolvedValue(readiness);
    reads.primary.mockClear();
    const status = await readPipelineControlStatus();
    expect(reads.primary).toHaveBeenCalledOnce();
    expect(reads.execute).toHaveBeenCalledOnce();
    expect(reads.readiness).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(reads.execute.mock.calls[0][0]).sql;
    expect(query).toContain('clock_timestamp()');
    expect(query).toContain('http_origin_hops');
    expect(query).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|FOR UPDATE|FOR SHARE)\b/);
    expect(status.observedAt).toBe(at);
    expect(status.controls.find(row => row.key === 'model')?.metrics).toContainEqual({ label: '미정산', value: 7 });
  });
  it('preserves successful counts when readiness fails without exposing the error', async () => {
    reads.execute.mockReset().mockResolvedValue([{ snapshot: fixture() }]);
    reads.readiness.mockReset().mockRejectedValue(new Error('credential-never-render'));
    const status = await readPipelineControlStatus();
    expect(status.backlog).toContainEqual({ label: '수집 대기', value: 8 });
    expect(status.hosts.every(host => host.roles.every(role => !role.ready))).toBe(true);
    expect(JSON.stringify(status)).not.toContain('credential-never-render');
  });
  it('settles both reads and shows unknown when the SQL read fails', async () => {
    let settled = false;
    reads.execute.mockReset().mockRejectedValue(new Error('database unavailable'));
    reads.readiness.mockReset().mockImplementation(async () => { await Promise.resolve(); settled = true; return readiness; });
    const status = await readPipelineControlStatus();
    expect(settled).toBe(true);
    expect(status.observedAt).toBeNull();
    expect(status.backlog.every(row => row.value === null)).toBe(true);
    expect(status.hosts.every(host => host.roles.every(role => !role.ready))).toBe(true);
  });
});

describe('separate readiness snapshot identity', () => {
  it('keeps an older policy unknown when only another instance changes under the same epoch and release', () => {
    const raw = fixture();
    const currentPolicy = { ...policy, instances: [...policy.instances, { instanceId: 'm3-maintenance', host: 'm3' as const }] };
    const old = { ...readiness, candidates: readiness.candidates.map(row => ({ ...row, ready: true, reason: 'ready' })) };
    const status = buildPipelineControlStatus({ ...raw, batch: { ...raw.batch, policy: currentPolicy, policyHash: batchPolicyHash(currentPolicy) } }, old);
    expect(status.controls.find(row => row.key === 'batch')).toMatchObject({ mode: 'versioned', epoch: 7, policy: 'verified' });
    expect(status.hosts.find(host => host.host === 'oracle-osaka-smoke')?.roles.find(role => role.role === 'official-news'))
      .toMatchObject({ ready: false, reason: 'readback_unknown' });
  });
  it('keeps a different release unknown even when mode and epoch still match', () => {
    const old = { ...readiness, candidates: readiness.candidates.map(row => ({ ...row, release: 'old-release', ready: true, reason: 'ready' })) };
    const status = buildPipelineControlStatus(fixture(), old);
    expect(status.hosts.find(host => host.host === 'oracle-osaka-smoke')?.roles.find(role => role.role === 'official-news'))
      .toMatchObject({ ready: false, reason: 'identity_mismatch' });
  });
});
