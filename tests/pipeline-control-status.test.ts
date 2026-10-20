import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildPipelineControlStatus, readPipelineControlStatus } from '@/lib/operations/pipeline-control-status';
import { batchPolicyHash, BATCH_ROLES } from '@/lib/jobs/batches';
import { httpOriginPolicyHash } from '@/lib/net/http-origin-policy';
import { uptimeSplitPolicyHash, type UptimeSplitPolicy } from '@/lib/domain/products/uptime-split-policy';

const reads = vi.hoisted(() => ({ execute: vi.fn(), readiness: vi.fn(), primary: vi.fn(), replica: vi.fn(), transaction: vi.fn(), setLocal: vi.fn() }));
// R4 fixture: 읽기 전용 TX 안의 SET LOCAL(문장 상한)은 따로 받는다 — execute 는 스냅숏 한 문장 그대로다
vi.mock('@/lib/db', () => ({ db: { execute: reads.execute,
  transaction: async (load: (tx: unknown) => Promise<unknown>, config?: unknown) => { reads.transaction(config); return load({ execute: (query: { queryChunks?: unknown }) =>
    JSON.stringify(query.queryChunks ?? query).includes('SET LOCAL') ? reads.setLocal(query) : reads.execute(query) }); } },
  onPrimary: (load: () => Promise<unknown>) => { reads.primary(); return load(); },
  onReplica: (load: () => Promise<unknown>) => { reads.replica(); return load(); } }));
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
    expect(status.controls).toHaveLength(6);
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

const splitPolicy: UptimeSplitPolicy = { version: 1, hosts: [{ host: 'm3', instanceId: 'm3-maintenance', region: 'kr-home', class: 'home' }],
  claim: { ttlMs: 180_000 }, confirm: { affinityDays: 7 },
  breaker: { windowMinutes: 10, minChecks: 100, openRatio: 0.08, batchMin: 30, batchOpenRatio: 0.3, coolDownMinutes: 10,
    maxCoolDownMinutes: 60, probeSize: 30, probeCloseRatio: 0.05 } };
function splitReadback(mode: 'legacy' | 'claims', policyHash: string | null = uptimeSplitPolicyHash(splitPolicy)) {
  return { at, control: { mode, epoch: 4, policy: policyHash ? splitPolicy : null, policyHash }, uptimeControl: { observationsEnabled: false, gateEnabled: false },
    queue: { due: 120, dueOldestMinutes: 7.6, claimed: 40, submitted: 3, submittedOldestMinutes: 1.2, confirm: 2, confirmOldestMinutes: 4.4,
      applied5m: 410, missingRows: 5 },
    breakers: [{ host: 'm3', state: 'open', reason: 'batch_ratio', ratio: 0.8, openedAt: '2026-10-16T11:55:00.000Z',
      probeAfter: '2026-10-16T12:05:00.000Z', probeChecks: 0, probeFailures: 0 }],
    outcomes1h: { split_success: 400, split_broad_failure: 40 }, applied1h: { m3: 400 } };
}

describe('uptime split readback', () => {
  it('shows the claims ledger: due and oldest, submitted, confirm waits, breaker and hold reasons', () => {
    const status = buildPipelineControlStatus({ ...fixture(), uptimeSplit: splitReadback('claims') }, readiness);
    const row = status.controls.find(control => control.key === 'uptimeSplit');
    expect(row).toMatchObject({ label: '응답 점검 분담', mode: 'claims', epoch: 4, policy: 'verified' });
    expect(row?.metrics).toEqual(expect.arrayContaining([{ label: '마감 지남', value: 120 }, { label: '최장 지남(분)', value: 8 },
      { label: '제출 대기', value: 3 }, { label: '제출 최장(분)', value: 1 }, { label: '재확인 대기', value: 2 }, { label: '재확인 최장(분)', value: 4 },
      { label: '확인 중', value: 40 }, { label: '5분 반영', value: 410 }, { label: 'claim 행 없음', value: 5 }]));
    expect(row?.note).toContain('m3 열림(batch_ratio 0.80, 시험 12:05 UTC)');
    expect(row?.note).toContain('split_broad_failure 40');
  });
  it('keeps legacy as the default and an unverifiable claims policy unknown', () => {
    const legacy = buildPipelineControlStatus({ ...fixture(), uptimeSplit: { ...splitReadback('legacy', null), breakers: [], outcomes1h: {} } }, readiness);
    expect(legacy.controls.find(row => row.key === 'uptimeSplit')).toMatchObject({ mode: 'legacy', policy: 'unset' });
    expect(legacy.controls.find(row => row.key === 'uptimeSplit')?.note).toContain('기존 방식');
    const broken = buildPipelineControlStatus({ ...fixture(), uptimeSplit: splitReadback('claims', '0'.repeat(64)) }, readiness);
    expect(broken.controls.find(row => row.key === 'uptimeSplit')).toMatchObject({ mode: null, policy: 'unknown', epoch: 4 });
    // 장부를 못 읽으면 미확인으로 남는다
    expect(buildPipelineControlStatus(fixture(), readiness).controls.find(row => row.key === 'uptimeSplit')).toMatchObject({ mode: null, metrics: [] });
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
  it('keeps the host table when an Oracle scheduler candidate sits in the candidate list', () => {
    // readJobBatchReadiness 는 batch 역할 밖 후보(Oracle scheduler 의 role 'scheduler')를 identity_mismatch 행으로 함께 낸다
    const scheduler = { role: 'scheduler', instanceId: 'oracle-scheduler', host: 'oracle-osaka-smoke', release: 'release-one',
      anchor: null, ready: false, reason: 'identity_mismatch' };
    const status = buildPipelineControlStatus(fixture(), { ...readiness, candidates: [
      ...readiness.candidates.map(row => ({ ...row, ready: true, reason: 'ready' })), scheduler] });
    expect(status.hosts.find(row => row.host === 'oracle-osaka-smoke')?.roles.find(row => row.role === 'official-news')).toMatchObject({ ready: true, reason: 'ready' });
    expect(status.hosts.flatMap(row => row.roles).some(row => row.reason === 'readback_unknown')).toBe(false);
    expect(status.hosts.flatMap(row => row.roles).some(row => row.role === 'scheduler')).toBe(false);
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


describe('replica-first read-only loader', () => {
  it('uses one statement for DB clock/control/ledger counts and existing readiness separately', async () => {
    reads.execute.mockReset().mockResolvedValue([{ snapshot: fixture() }]);
    reads.readiness.mockReset().mockResolvedValue(readiness);
    reads.replica.mockClear();
    const status = await readPipelineControlStatus();
    // R4: 주 DB(onPrimary) → 복제본 우선(onReplica). 밀리거나 닿지 않으면 router 가 주 DB 로 읽는다
    expect(reads.replica).toHaveBeenCalledOnce();
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

// R4: 관리자 제어 상태 패널은 약 30개 count 를 주 DB 에서 상한·실패 기록 없이 읽었다 — 복제본 우선, 읽기 전용 TX + 문장 상한, 실패 로그.
describe('bounded replica-first loader', () => {
  it('reads on the replica in a read-only transaction whose statement bound precedes the snapshot', async () => {
    reads.execute.mockReset().mockResolvedValue([{ snapshot: fixture() }]);
    reads.readiness.mockReset().mockResolvedValue(readiness);
    for (const spy of [reads.primary, reads.replica, reads.transaction, reads.setLocal]) spy.mockClear();
    const status = await readPipelineControlStatus();
    expect(status.observedAt).toBe(at);
    expect(reads.replica).toHaveBeenCalledOnce();
    expect(reads.primary).not.toHaveBeenCalled();
    expect(reads.transaction).toHaveBeenCalledWith({ accessMode: 'read only' });
    expect(reads.setLocal).toHaveBeenCalledOnce();
    expect(new PgDialect().sqlToQuery(reads.setLocal.mock.calls[0][0]).sql).toBe("SET LOCAL statement_timeout = '10s'");
    expect(reads.setLocal.mock.invocationCallOrder[0]).toBeLessThan(reads.execute.mock.invocationCallOrder[0]);
  });
  it('logs a failed snapshot or readiness read without rendering the error', async () => {
    reads.execute.mockReset().mockRejectedValue(new Error('canceling statement due to statement timeout'));
    reads.readiness.mockReset().mockRejectedValue(new Error('readiness-never-render'));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const status = await readPipelineControlStatus();
      const events = out.mock.calls.map(([line]) => JSON.parse(String(line))).filter(row => row.event === 'operations.control_status_read_failed');
      expect(events.map(row => [row.level, row.part])).toEqual([['warn', 'snapshot'], ['warn', 'readiness']]);
      expect(events[0].error).toMatchObject({ message: 'canceling statement due to statement timeout' });
      expect(status.observedAt).toBeNull();
      expect(JSON.stringify(status)).not.toContain('readiness-never-render');
    } finally { out.mockRestore(); }
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
