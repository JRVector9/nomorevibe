import { describe, expect, it } from 'vitest';
import { reportLiveCapacityWindow, type LiveCapacityArtifact } from '@/lib/operations/pipeline-capacity-live';
import { buildPipelineCompletions, DEFERRED, type PipelineCompletions } from '@/lib/operations/pipeline-completions';
import { AI1_CASES, AI1_EXPECTED, AI2_EXPECTED } from './pipeline-completions-fixture';

const hash = 'a'.repeat(64), NOW = '2026-10-17T12:00:00.000Z';
const identity = (model: string) => ({ provider: 'abcllm' as const, model, canonicalModel: model });
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

/** 같은 고정 사례를 측정 도구의 live artifact 로 옮긴다(수집기의 relevant: 자동 시도 중 창 안에서 끝난 것). */
function liveArtifact(durationMs: number): LiveCapacityArtifact {
  const candidates = [...new Set(AI1_CASES.map(row => row.candidate))];
  const minutes = durationMs / 60_000, offset = (agoMinutes: number) => durationMs - agoMinutes * 60_000;
  const attempts = AI1_CASES.map((row, index) => ({ row, id: index + 1 }))
    .filter(({ row }) => row.kind === 'automatic' && row.completedAgo !== null && row.completedAgo < minutes)
    .map(({ row, id }) => ({ id, candidateId: candidates.indexOf(row.candidate) + 1, inputHash: hash, state: row.state,
      failure: row.state !== 'failed' ? null : row.errorCode === 'cancelled' || row.errorCode === 'deferred' ? 'cancelled' as const : 'technical' as const,
      provider: row.provider, model: 'first', policyHash: hash, promptVersion: 'p1', rulesVersion: 'r1',
      reusedFromAttemptId: row.reused ? 1 : null, decision: row.decision, reReview: false,
      readyMs: offset(row.startedAgo) - 1_000, startedMs: offset(row.startedAgo), completedMs: offset(row.completedAgo!), inputTokens: null, outputTokens: null }));
  return { version: 1, scope: 'live_window', runId: 'pr13c', revision: '9e13341', schema: { appliedMigrations: 97, absentTables: [] },
    window: { startedAt: new Date(Date.parse(NOW) - durationMs).toISOString(), endedAt: NOW, durationMs, collectedAt: NOW, collectedAfterEndMs: 0 },
    database: { target: 'primary', inRecovery: false, readOnly: true, isolation: 'repeatable read', replicaCaughtUp: null, writeXidAssigned: false },
    identity: { promptVersion: 'p1', rulesVersion: 'r1', inputPolicyHash: hash, comparisonPolicyHash: hash, fullReviewPolicyHash: hash,
      reviewMode: 'enforce', secondGateRequired: true, concurrency: 2, settingsUpdatedMs: null,
      models: { first: identity('first'), second: [identity('second')], fallbacks: [] } },
    stageModes: [], modelCapacity: null, attempts, votes: [],
    candidates: candidates.map((_, index) => ({ id: index + 1, state: 'approved' as const, decidedBy: 'auto' as const, appliedAttemptId: null })),
    ai2Calls: { chains: 0, calls: 0, failed: 0, unattributedChains: 0 }, readiness: { witnesses: 0, sampleCandidateIds: [] },
    safety: { duplicatePublications: 0, humanDecisionOverrides: 'unverified', leaseViolations: 'unverified' }, budget: { status: 'unverified' }, quality: null };
}

const ledgerWindow = (dispatched: number, settled: number, units = settled) =>
  ({ dispatched, settled, indeterminate: 0, released: 0, settledUnits: units });
function raw() {
  const ledger = (windows: Record<'1h' | '24h', ReturnType<typeof ledgerWindow>>, waiting = 0, oldest: string | null = null) =>
    ({ windows, waiting, waitingOldestAt: oldest, active: 1 });
  return { at: NOW,
    ai1: { windows: structuredClone(AI1_EXPECTED) as Record<string, Record<string, number>>, backoff: 1, human: 2, humanOldestAt: ago(125) },
    ai2: { windows: structuredClone(AI2_EXPECTED) as Record<string, Record<string, number>>, ready: 4, readyOldestAt: ago(100), backoff: 3,
      human: 2, humanCandidates: 1, humanOldestAt: ago(90.5) },
    publish: { windows: { '1h': { published: 1, transitions: 2, withdrawn: 1 }, '24h': { published: 2, transitions: 3, withdrawn: 1 } }, approved: 7 },
    fetch: { ready: 5, readyOldestAt: ago(50), backoff: 2, inFlight: 1, human: 0, humanOldestAt: null },
    ledger: { first: ledger({ '1h': ledgerWindow(1, 1), '24h': ledgerWindow(2, 1) }, 1, ago(7)),
      second: ledger({ '1h': ledgerWindow(1, 0), '24h': ledgerWindow(1, 0) }),
      background: ledger({ '1h': ledgerWindow(2, 2, 1), '24h': ledgerWindow(2, 2, 1) }, 1, ago(3)) } };
}
const stage = (status: PipelineCompletions, key: string) => status.stages.find(row => row.key === key)!;
const metric = (status: PipelineCompletions, key: string, name: string) => stage(status, key).metrics.find(row => row.key === name)!;
const waiting = (status: PipelineCompletions, key: string, name: string) => stage(status, key).queue.find(row => row.key === name)!;
const valued = (status: PipelineCompletions) => status.stages.flatMap(row => [...row.metrics, ...row.queue]).filter(row => row.state === 'value');

describe('AI1 처리 지표 정의 — 측정 도구와의 대응', () => {
  for (const [window, durationMs] of [['1h', 3_600_000], ['24h', 86_400_000]] as const) it(`같은 사례에서 ${window} 호출·제외 분류가 측정 도구 report 와 같다`, () => {
    const report = reportLiveCapacityWindow(liveArtifact(durationMs)), expected = AI1_EXPECTED[window];
    expect({ calls: report.calls.ai1.calls, failed: report.calls.ai1.failed, cancelled: report.calls.ai1.cancelled,
      rules: report.exclusions.rules, reuse: report.exclusions.reuse, superseded: report.exclusions.superseded,
      handoff: report.exclusions.humanHandoff }).toEqual({ calls: expected.calls, failed: expected.failed, cancelled: expected.cancelled,
      rules: expected.rules, reuse: expected.reuse, superseded: expected.superseded, handoff: expected.handoff });
    // 측정 도구가 이 사례를 시각 이상으로 버리지 않았다(대응 비교가 실제로 모든 행을 거쳤다)
    expect(report.clockAnomalies).toBe(0);
  });
});

describe('buildPipelineCompletions', () => {
  it('읽지 못하면 값 칸을 0 이 아니라 미확인으로 두고 설계상 미계산·해당 없음은 그대로 둔다', () => {
    const status = buildPipelineCompletions(null);
    expect(status.observedAt).toBeNull();
    expect(valued(status)).toEqual([]);
    expect(status.stages.flatMap(row => row.metrics).every(row => row.values === null)).toBe(true);
    expect(metric(status, 'ai1', 'calls').state).toBe('unknown');
    expect(metric(status, 'fetch', 'unique').state).toBe('deferred');
    expect(metric(status, 'fetch', 'calls').state).toBe('none');
    expect(waiting(status, 'ai1', 'ready').state).toBe('deferred');
    expect(buildPipelineCompletions({ ...raw(), at: 'not-a-time' }).observedAt).toBeNull();
  });
  it('고유 완료·재심사·반복 세대·호출·재사용·표를 섞지 않고 창별로 옮긴다', () => {
    const status = buildPipelineCompletions(raw());
    expect(status.observedAt).toBe(NOW);
    expect(metric(status, 'ai1', 'unique').values).toEqual({ '1h': 3, '24h': 6 });
    expect(metric(status, 'ai1', 'reReview').values).toEqual({ '1h': 0, '24h': 1 });
    expect(metric(status, 'ai1', 'repeat').values).toEqual({ '1h': 1, '24h': 1 });
    expect(metric(status, 'ai1', 'calls').values).toEqual({ '1h': 6, '24h': 9 });
    expect(metric(status, 'ai1', 'reuse').values).toEqual({ '1h': 1, '24h': 1 });
    expect(metric(status, 'ai1', 'rules').values).toEqual({ '1h': 1, '24h': 1 });
    expect(metric(status, 'ai1', 'ledgerDispatched').values).toEqual({ '1h': 1, '24h': 2 });
    expect(metric(status, 'ai2', 'unique').values).toEqual({ '1h': 2, '24h': 4 });
    expect(metric(status, 'ai2', 'votes').values).toEqual({ '1h': 2, '24h': 4 });
    expect(metric(status, 'ai2', 'calls').values).toEqual({ '1h': 3, '24h': 8 });
    expect(metric(status, 'ai2', 'unattributed').values).toEqual({ '1h': 2, '24h': 1 });
    expect(metric(status, 'ai2', 'reuse').state).toBe('none');
    expect(metric(status, 'publish', 'unique').values).toEqual({ '1h': 1, '24h': 2 });
    expect(metric(status, 'publish', 'transitions').values).toEqual({ '1h': 2, '24h': 3 });
    expect(metric(status, 'background', 'settledUnits').values).toEqual({ '1h': 1, '24h': 1 });
    expect(metric(status, 'background', 'ledgerSettled').values).toEqual({ '1h': 2, '24h': 2 });
    expect(metric(status, 'background', 'unique').state).toBe('deferred');
    // AI1 장부 정산 작업 단위는 따로 내보내지 않는다(도메인 고유 완료와 섞지 않음)
    expect(stage(status, 'ai1').metrics.some(row => row.key === 'settledUnits')).toBe(false);
  });
  it('대기 수와 DB 시계 기준 최장 나이를 분으로 내고, 0 건이면 나이를 비운다', () => {
    const status = buildPipelineCompletions(raw());
    expect(waiting(status, 'ai1', 'human')).toMatchObject({ state: 'value', count: 2, oldestMin: 125 });
    expect(waiting(status, 'ai2', 'ready')).toMatchObject({ count: 4, oldestMin: 100 });
    expect(waiting(status, 'ai2', 'human')).toMatchObject({ count: 2, oldestMin: 90, note: '후보 1 · 결정 기준' });
    expect(waiting(status, 'fetch', 'ready')).toMatchObject({ count: 5, oldestMin: 50 });
    expect(waiting(status, 'fetch', 'human')).toMatchObject({ state: 'value', count: 0, oldestMin: null });
    expect(waiting(status, 'ai1', 'slotWaiting')).toMatchObject({ count: 1, oldestMin: 7 });
    expect(waiting(status, 'ai2', 'slotWaiting')).toMatchObject({ count: 0, oldestMin: null });
    expect(waiting(status, 'background', 'slotActive')).toMatchObject({ count: 1 });
    expect(waiting(status, 'publish', 'approved')).toMatchObject({ count: 7 });
  });
  it('앞뒤가 맞지 않는 구획은 그 구획만 미확인으로 둔다', () => {
    const broken = raw();
    broken.ai1.windows['1h'].unique = 5; // 성공한 결정(4)보다 많은 고유 후보
    let status = buildPipelineCompletions(broken);
    expect(stage(status, 'ai1').metrics.filter(row => !row.key.startsWith('ledger')).every(row => row.state !== 'value')).toBe(true);
    expect(waiting(status, 'ai1', 'human').state).toBe('unknown');
    expect(metric(status, 'ai2', 'votes').state).toBe('value');
    const inverted = raw();
    inverted.ai2.windows['1h'].votes = 5; inverted.ai2.windows['1h'].calls = 9; // 1시간이 24시간보다 크다
    status = buildPipelineCompletions(inverted);
    expect(metric(status, 'ai2', 'votes').state).toBe('unknown');
    expect(metric(status, 'ai1', 'calls').state).toBe('value');
    const fractional = raw();
    fractional.publish.approved = 1.5;
    expect(metric(buildPipelineCompletions(fractional), 'publish', 'unique').state).toBe('unknown');
    const partial = raw() as Record<string, unknown>;
    delete (partial.ledger as Record<string, unknown>).background;
    status = buildPipelineCompletions(partial);
    expect(metric(status, 'ai1', 'ledgerDispatched').state).toBe('unknown');
    expect(waiting(status, 'background', 'slotWaiting').state).toBe('unknown');
    expect(metric(status, 'ai1', 'calls').state).toBe('value');
  });
  it('계산하지 않는 항목은 이유와 주기 계산 설계를 함께 둔다', () => {
    expect(DEFERRED.map(row => row.key)).toEqual(['final', 'fetch', 'background', 'ready']);
    for (const row of DEFERRED) expect(row.reason.length && row.design.length).toBeGreaterThan(0);
  });
});
