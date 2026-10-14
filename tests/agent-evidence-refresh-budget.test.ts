import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute } }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => ({ agentEvidence: { enabled: true } }) }));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({ refreshRepositoryAgentEvidence: mocks.refresh }));
import { refreshAgentEvidenceJob } from '@/lib/jobs/products/agent-evidence-refresh';
beforeEach(() => { mocks.execute.mockReset(); mocks.refresh.mockReset(); });
afterEach(() => vi.useRealTimers());
it('retains the repository pagination position when the budget expires before a scan can be persisted', async () => {
  // 재개 대상 → 일반 대기 → (스캔 뒤) 제품 연결 대기 → 근거 대기 후보 풀기 순으로 조회한다
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ repository_key: 'kiaquila/capsule-zero' }])
    .mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  mocks.refresh.mockResolvedValue({ scan: null, observations: [], cached: false, errorCode: 'budget_exhausted', retryAt: null });
  const save = vi.fn(), log = vi.fn();
  const result = await refreshAgentEvidenceJob({ cursor: { afterRepository: 'before/last' }, save, log, hasBudget: () => true });
  expect(result).toEqual({ done: false, cursor: { afterRepository: 'before/last' } });
  expect(save).toHaveBeenCalledWith({ afterRepository: 'before/last' });
  expect(log).toHaveBeenCalledWith('agent_evidence.deferred', expect.objectContaining({ repositoryKey: 'kiaquila/capsule-zero', state: 'pending', errorCode: 'budget_exhausted' }));
});

it('pauses the agent scan job at the auth-pool retry time', async () => {
  const now = new Date('2026-10-14T04:49:00.000Z');
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ repository_key: 'kiaquila/capsule-zero' }])
    .mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const retryAt = new Date(Date.now() + 60_000);
  mocks.refresh.mockResolvedValue({ scan: null, observations: [], cached: false, errorCode: 'unavailable', retryAt });
  const save = vi.fn(), log = vi.fn();

  const result = await refreshAgentEvidenceJob({ cursor: { afterRepository: 'before/last' }, save, log, hasBudget: () => true });

  expect(result).toEqual({ done: false, cursor: { afterRepository: 'before/last', retryAfter: retryAt.toISOString(),
    providerFailure: { repositoryKey: 'kiaquila/capsule-zero', code: 'unavailable',
      firstFailureAt: now.toISOString(), lastFailureAt: now.toISOString(), failures: 1 } } });
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith(result.cursor);
});

it.each([
  { state: 'failed', errorCode: null, failed: true },
  { state: 'partial', errorCode: 'timeout', failed: true },
  { state: 'partial', errorCode: null, failed: false },
])('retains a safe failure flag when a persisted scan is $state with error $errorCode', async ({ state, errorCode, failed }) => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ repository_key: 'example/repository' }])
    .mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  mocks.refresh.mockResolvedValue({ scan: { id: 42, state }, observations: [], cached: false, errorCode, retryAt: null });
  const save = vi.fn(), log = vi.fn();

  await refreshAgentEvidenceJob({ cursor: null, save, log, hasBudget: () => true });

  const scanned = log.mock.calls.find(([event]) => event === 'agent_evidence.scanned');
  expect(scanned?.[1]).toMatchObject({ failed });
  // Match runner's numeric/boolean observation projection; state/errorCode are discarded.
  const retained = Object.fromEntries(Object.entries(scanned?.[1] ?? {}).filter(([,value]) =>
    typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'));
  expect(retained.failed).toBe(failed);
  expect(retained).not.toHaveProperty('errorCode');
  expect(retained).not.toHaveProperty('state');
});
