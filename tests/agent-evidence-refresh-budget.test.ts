import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn(), headroom: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute } }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => ({ agentEvidence: { enabled: true } }) }));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({ refreshRepositoryAgentEvidence: mocks.refresh }));
vi.mock('@/lib/crawl/github-headroom', () => ({ readGitHubCoreHeadroom: mocks.headroom }));
// 스캔 모드는 legacy(이 파일은 legacy 틱만 본다). 모드 갈래는 tests/integration/agent-scan-controller.test.ts 가 실제 DB 로 본다
vi.mock('@/lib/domain/evidence/agents/claim-control', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/domain/evidence/agents/claim-control')>(),
  readAgentScanMode: async () => ({ mode: 'legacy', drainingFrom: null }) }));
import { AGENT_EVIDENCE_TICK_MS, refreshAgentEvidenceJob } from '@/lib/jobs/products/agent-evidence-refresh';
beforeEach(() => { mocks.execute.mockReset(); mocks.refresh.mockReset(); mocks.headroom.mockReset(); mocks.headroom.mockResolvedValue(null); });
afterEach(() => vi.useRealTimers());
it('retains the repository pagination position when the budget expires before a scan can be persisted', async () => {
  // 재개 대상 → 일반 대기 → 새 공개 제품 → (스캔 뒤) 제품 연결 대기 순으로 조회한다(근거 대기 후보 풀기는 설정 버전이 없어 건너뛴다)
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

/** 재개 대상 → 일반 대기 → 새 공개 제품 → (스캔 뒤) 제품 연결 대기 순으로 조회한다 */
const queue = (general: string[]) => mocks.execute.mockResolvedValueOnce([])
  .mockResolvedValueOnce(general.map(repository_key => ({ repository_key }))).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
const scanResult = { scan: { id: 1, state: 'partial', startedAt: new Date() }, observations: [], cached: false, errorCode: null, retryAt: null };
const tick = (overrides: Partial<{ cursor: object | null; hasBudget: () => boolean }> = {}) =>
  refreshAgentEvidenceJob({ cursor: null, save: vi.fn(), log: vi.fn(), hasBudget: () => true, ...overrides });

it('asks for an immediate next tick only when a full general page was scanned within the deadline', async () => {
  const page = Array.from({ length: 10 }, (_, i) => `acme/r${i}`);
  queue(page);
  mocks.refresh.mockResolvedValue(scanResult);
  const result = await tick();
  expect(mocks.refresh).toHaveBeenCalledTimes(10);
  expect(result).toEqual({ done: false, cursor: { afterRepository: 'acme/r9' }, continuation: 'ready' });
});

it.each([
  { name: 'empty queue', general: [] as string[] },
  { name: 'completed traversal', general: ['acme/last'] },
])('ends without a continuation on an $name', async ({ general }) => {
  queue(general);
  mocks.refresh.mockResolvedValue(scanResult);
  const result = await tick();
  expect(result).toEqual({ done: true });
  expect(result).not.toHaveProperty('continuation');
});

it('does not continue while a provider retry time is pending', async () => {
  const retryAfter = new Date(Date.now() + 60_000).toISOString();
  const result = await tick({ cursor: { afterRepository: 'acme/a', retryAfter } });
  expect(result).toEqual({ done: false, cursor: { afterRepository: 'acme/a', retryAfter } });
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it('does not continue after a provider failure sets a retry time or a scan is deferred for budget', async () => {
  queue(['acme/a', 'acme/b']);
  mocks.refresh.mockResolvedValueOnce({ ...scanResult, scan: null, errorCode: 'rate_limited', retryAt: new Date(Date.now() + 60_000) });
  expect(await tick()).not.toHaveProperty('continuation');
  queue(['acme/a', 'acme/b']);
  mocks.refresh.mockResolvedValueOnce({ ...scanResult, scan: null, errorCode: 'budget_exhausted' });
  expect(await tick()).not.toHaveProperty('continuation');
});

it('continues after the tick deadline only when it scanned something', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T13:00:00Z'));
  queue(['acme/a', 'acme/b', 'acme/c']);
  // 한 건이 마감의 60%를 쓴다 — 둘째까지 시작하고 셋째는 다음 틱으로 넘긴다
  mocks.refresh.mockImplementation(async () => { vi.setSystemTime(Date.now() + AGENT_EVIDENCE_TICK_MS * 0.6); return scanResult; });
  expect(await tick()).toEqual({ done: false, cursor: { afterRepository: 'acme/b' }, continuation: 'ready' });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  // 수요 조회만으로 예산이 끝난 틱은 이어 하지 않는다
  mocks.refresh.mockClear();
  queue(['acme/a']);
  expect(await tick({ hasBudget: () => false })).toEqual({ done: false, cursor: { afterRepository: '' } });
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it('starts no scan while GitHub core headroom is low and records why', async () => {
  queue(['acme/a', 'acme/b']);
  mocks.headroom.mockResolvedValue({ remaining: 900, limit: 10_000, low: true });
  const log = vi.fn();
  const result = await refreshAgentEvidenceJob({ cursor: { afterRepository: 'acme/0' }, save: vi.fn(), log, hasBudget: () => true });
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(result).toEqual({ done: false, cursor: { afterRepository: 'acme/0' } });
  expect(log).toHaveBeenCalledWith('agent_evidence.github_headroom_low', { remaining: 900, limit: 10_000 });
});

it('stops starting scans once headroom drops during a tick', async () => {
  queue(['acme/a', 'acme/b', 'acme/c']);
  mocks.headroom.mockResolvedValueOnce({ remaining: 6_000, limit: 10_000, low: false })
    .mockResolvedValueOnce({ remaining: 2_000, limit: 10_000, low: true });
  mocks.refresh.mockResolvedValue(scanResult);
  expect(await tick()).toEqual({ done: false, cursor: { afterRepository: 'acme/a' } });
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
