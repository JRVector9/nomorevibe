import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute } }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => ({ agentEvidence: { enabled: true } }) }));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({ refreshRepositoryAgentEvidence: mocks.refresh }));
import { refreshAgentEvidenceJob } from '@/lib/jobs/products/agent-evidence-refresh';
beforeEach(() => { vi.clearAllMocks(); });
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
