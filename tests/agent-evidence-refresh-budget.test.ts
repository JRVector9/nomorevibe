import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute } }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => ({ agentEvidence: { enabled: true } }) }));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({ refreshRepositoryAgentEvidence: mocks.refresh }));
import { refreshAgentEvidenceJob } from '@/lib/jobs/products/agent-evidence-refresh';
beforeEach(() => { vi.clearAllMocks(); });
it('retains the repository pagination position when the budget expires before a scan can be persisted', async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ repository_key: 'kiaquila/capsule-zero' }]);
  mocks.refresh.mockResolvedValue({ scan: null, observations: [], cached: false, errorCode: 'budget_exhausted', retryAt: null });
  const save = vi.fn(), log = vi.fn();
  const result = await refreshAgentEvidenceJob({ cursor: { afterRepository: 'before/last' }, save, log, hasBudget: () => true });
  expect(result).toEqual({ done: false, cursor: { afterRepository: 'before/last' } });
  expect(save).toHaveBeenCalledWith({ afterRepository: 'before/last' });
  expect(log).toHaveBeenCalledWith('agent_evidence.deferred', expect.objectContaining({ repositoryKey: 'kiaquila/capsule-zero', state: 'pending', errorCode: 'budget_exhausted' }));
});
