import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ values: {} as Record<string, unknown>, audits: [] as Record<string, unknown>[],
  update: vi.fn(), request: vi.fn(), lockSource: vi.fn(), resolveSource: vi.fn() }));
vi.mock('@/lib/crawl/pipeline-stage-context', () => ({ lockPipelineInputStages: async () => {} }));
vi.mock('@/lib/jobs/control', () => ({ requestJob: mocks.request }));
vi.mock('@/lib/operations/admin-log', () => ({ adminAuditRow: async (actor: string, entry: Record<string, unknown>) => ({ actor, ...entry }), settingsChanges: () => [] }));
vi.mock('@/lib/operations/human-model-source', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/operations/human-model-source')>();
  return { ...actual, lockHumanModelSource: mocks.lockSource, resolveHumanModelSelection: mocks.resolveSource };
});
vi.mock('@/lib/operations/dr/epoch', () => ({ writerSiteActive: () => true,
  DrWriterFencedError: class DrWriterFencedError extends Error { constructor() { super('dr_writer_fenced'); } } }));
vi.mock('@/lib/db', async () => {
  const { operationsAudit } = await import('@/lib/db/schema');
  const tx = {
    insert: (table: unknown) => ({ values: (row: Record<string, unknown>) => {
      if (table === operationsAudit) mocks.audits.push(row);
      return { onConflictDoNothing: async () => {}, then: (resolve: (value: unknown) => unknown) => resolve([]) };
    } }),
    select: () => ({ from: () => ({ where: () => ({ for: async () => [{ values: mocks.values }] }) }) }),
    update: () => ({ set: (value: unknown) => { mocks.update(value); return { where: async () => {} }; } }),
  };
  return { db: { transaction: (run: (tx: unknown) => unknown) => run(tx) } };
});
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { setHumanReviewEnabled } from '@/lib/crawl/settings';
import { readModelRegistry } from '@/lib/llm/model-registry';
beforeEach(() => {
  mocks.audits.length = 0; mocks.update.mockReset(); mocks.request.mockReset();
  mocks.lockSource.mockReset().mockResolvedValue({ tableOn: false, tableUnread: false, rows: null, registry: readModelRegistry() });
  mocks.resolveSource.mockReset().mockReturnValue({ source: 'pool', effectiveModels: readModelRegistry().models.filter(model => model.key === 'gpu3090:review'), effectiveKeys: ['gpu3090:review'],
    tableOn: false, eligibleRows: [], targets: [], fingerprint: 'pool-fingerprint' });
  mocks.values = { ...DEFAULT_CRAWL_SETTINGS, stageModelPools: { 'human-review': ['gpu3090:review'] } };
});
it('모델 연결 확인 뒤 풀이 바뀌면 상태 변경 없이 거절 감사 기록을 남긴다', async () => {
  const result = await setHumanReviewEnabled({ enabled: true, expectedGeneration: DEFAULT_CRAWL_SETTINGS.humanReview.generation, actor: 'operator', expectedModelPoolKeys: ['m3:review'] });
  expect(result.ok).toBe(false); expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.audits).toContainEqual(expect.objectContaining({ ok: false, error: 'stale_model_pool' }));
});
it('새 풀을 확인하지 않은 옛 요청도 켜지 못한다', async () => {
  expect((await setHumanReviewEnabled({ enabled: true, expectedGeneration: DEFAULT_CRAWL_SETTINGS.humanReview.generation, actor: 'operator' })).ok).toBe(false);
  expect(mocks.update).not.toHaveBeenCalled();
});
it('실제 선택한 모델·장비를 정식 감사 기록에 남긴다', async () => {
  expect((await setHumanReviewEnabled({ enabled: true, expectedGeneration: DEFAULT_CRAWL_SETTINGS.humanReview.generation, actor: 'operator', expectedModelPoolKeys: ['gpu3090:review'] })).ok).toBe(true);
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.audits).toContainEqual(expect.objectContaining({ action: 'human-review-deepseek', detail: expect.objectContaining({ host: 'gpu3090', modelPool: ['gpu3090:review'],
    models: [expect.objectContaining({ key: 'gpu3090:review', equipment: 'gpu3090', model: 'qwen3.8-flash-next' })] }) }));
});
it('배정 표 지문을 확인하고 실제 표 모델을 감사하며 낡은 사람 풀은 쓰지 않는다', async () => {
  const registry = readModelRegistry();
  const model = registry.models.find(row => row.key === 'gpu3090:review')!;
  const rows = [{ assignmentId: 'table-1', version: 2, rank: 1, registryKey: 'gpu3090:review',
    model: 'qwen3.8-flash-next', provider: 'local-direct', deviceId: 'gpu3090' }];
  mocks.values = { ...DEFAULT_CRAWL_SETTINGS, stageModelPools: { 'human-review': ['stale:review'] } };
  mocks.lockSource.mockResolvedValue({ tableOn: true, tableUnread: false, rows, registry });
  mocks.resolveSource.mockReturnValue({ source: 'table', effectiveModels: [model], effectiveKeys: ['gpu3090:review'],
    tableOn: true, eligibleRows: [], targets: [], fingerprint: 'table-fingerprint' });
  expect((await setHumanReviewEnabled({ enabled: true, expectedGeneration: DEFAULT_CRAWL_SETTINGS.humanReview.generation,
    actor: 'operator' })).ok).toBe(false);
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.audits).toContainEqual(expect.objectContaining({ ok: false, error: 'stale_model_source' }));
  expect((await setHumanReviewEnabled({ enabled: true, expectedGeneration: DEFAULT_CRAWL_SETTINGS.humanReview.generation,
    actor: 'operator', expectedModelSourceFingerprint: 'table-fingerprint' })).ok).toBe(true);
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.audits).toContainEqual(expect.objectContaining({ action: 'human-review-deepseek', detail: expect.objectContaining({
    source: 'table', model: 'gpu3090:review', host: 'gpu3090', modelPool: ['gpu3090:review'],
    models: [expect.objectContaining({ key: 'gpu3090:review', equipment: 'gpu3090', model: 'qwen3.8-flash-next' })],
  }) }));
});
