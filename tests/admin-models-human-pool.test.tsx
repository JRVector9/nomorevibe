import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ admin: vi.fn(), settings: vi.fn(), save: vi.fn(), ready: vi.fn(), source: vi.fn(),
  requireAssignments: vi.fn(), assignmentFlag: vi.fn(), assignmentRows: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings, setHumanReviewEnabled: mocks.save }));
vi.mock('@/lib/crawl/deepseek-review', () => ({ deepseekReviewReady: mocks.ready }));
vi.mock('@/lib/operations/dr/web-gate', () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/operations/human-model-source', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operations/human-model-source')>('@/lib/operations/human-model-source');
  return { ...actual, readHumanModelSource: mocks.source };
});
vi.mock('@/lib/llm/stage-assignment-snapshot', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm/stage-assignment-snapshot')>('@/lib/llm/stage-assignment-snapshot');
  return { ...actual, requireStageAssignments: mocks.requireAssignments, assignmentReadFlag: mocks.assignmentFlag,
    liveAssignmentRows: mocks.assignmentRows };
});
import { configuredHumanModelsReady, humanReviewModelDisplay } from '@/lib/operations/admin-models-human';
import { resolveHumanModelSelection } from '@/lib/operations/human-model-source';
import { DEFAULT_MODEL_DEFINITIONS, modelRequestName, readModelRegistry, scopedModel } from '@/lib/llm/model-registry';
import type { ModelAssignmentRow } from '@/lib/llm/capacity-helpers';
import { setHumanReview } from '@/app/(operator)/admin/review/human-review-actions';
import { HumanReviewSwitch } from '@/app/(operator)/admin/review/HumanReviewSwitch';
const form = (enabled = 'true') => { const data = new FormData(); data.set('enabled', enabled); data.set('generation', '3'); return data; };
const assignmentRow = (assignmentId: string, rank: number, key: string, model: string): ModelAssignmentRow => ({
  assignmentId, stage: 'human', deviceId: key.split(':')[0], registryKey: key, transport: 'direct', rank,
  role: 'primary', vote: false, mode: 'live', model, routeId: 'route', provider: 'local-direct', maxSlots: 1,
  evidenceKey: 'evidence', version: 1, note: null, updatedBy: 'operator', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const originalTable = process.env.MODEL_ASSIGNMENT_TABLE;
beforeEach(() => {
  vi.resetAllMocks();
  process.env.MODEL_ASSIGNMENT_TABLE = '0';
  mocks.admin.mockResolvedValue({ login: 'operator' }); mocks.save.mockResolvedValue({ ok: true });
  const pool = ['gpu3090:review', 'm3:review'];
  mocks.settings.mockResolvedValue({ stageModelPools: { 'human-review': pool } });
  mocks.ready.mockResolvedValue(true);
  mocks.requireAssignments.mockResolvedValue(undefined);
  mocks.assignmentFlag.mockReturnValue({ source: 'env', enabled: false });
  mocks.assignmentRows.mockReturnValue(null);
  const registry = readModelRegistry();
  const selection = resolveHumanModelSelection(pool, false, null, registry);
  mocks.source.mockResolvedValue({ settings: {}, models: registry.models, pools: { 'human-review': pool }, defaults: {},
    assignments: [], options: { stages: [], registry: [], devices: [], transportLabels: { gateway: '장비 표지', direct: '엔진 직접',
      'local-direct': '로컬 직접', cli: 'CLI' }, rankMax: 8, confirmWord: '배정' }, source: selection.source,
    humanUsesTable: false, tableOn: false, unknown: false, effectiveModels: selection.effectiveModels,
    effectiveKeys: selection.effectiveKeys, version: '0', selection, saveBlocked: false });
});
afterEach(() => {
  if (originalTable === undefined) delete process.env.MODEL_ASSIGNMENT_TABLE;
  else process.env.MODEL_ASSIGNMENT_TABLE = originalTable;
});
it('사람 위임 풀의 Qwen·DeepSeek를 각각 실제 선택 범위에서 확인한다', async () => {
  const seen: string[] = [];
  mocks.ready.mockImplementation(async () => { seen.push(scopedModel('human-review', 'default')); return true; });
  expect(await configuredHumanModelsReady(['gpu3090:review', 'm3:review'])).toBe(true);
  expect(seen).toEqual(['qwen3.8-flash-next', 'deepseek-v4.1-flash-1017']);
});
it('배정 표가 켜져 있으면 저장 풀이 아니라 실제 최저 tier 모델을 확인하고, 끄면 풀로 돌아간다', async () => {
  const pool = ['m3:review'];
  mocks.settings.mockResolvedValue({ stageModelPools: { 'human-review': pool } });
  const gpu = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === 'gpu3090:review')!;
  const m3 = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === 'm3:review')!;
  const rows = [assignmentRow('a1', 1, gpu.key, modelRequestName(gpu)), assignmentRow('a2', 2, m3.key, modelRequestName(m3))];
  mocks.assignmentFlag.mockReturnValue({ source: 'runtime', enabled: true });
  mocks.assignmentRows.mockReturnValue(rows);
  const seen: string[] = [];
  mocks.ready.mockImplementation(async () => { seen.push(scopedModel('human-review', 'default')); return true; });
  expect(await configuredHumanModelsReady(pool)).toBe(true);
  expect(seen).toEqual([modelRequestName(gpu)]);
  mocks.assignmentFlag.mockReturnValue({ source: 'runtime', enabled: false });
  mocks.assignmentRows.mockReturnValue(null);
  seen.length = 0;
  expect(await configuredHumanModelsReady(pool)).toBe(true);
  expect(seen).toEqual([modelRequestName(m3)]);
});
it('풀 일부가 미확인이면 켜지 않고, 확인한 풀을 정식 저장 CAS에 고정한다', async () => {
  mocks.ready.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await setHumanReview(null, form())).toHaveProperty('error'); expect(mocks.save).not.toHaveBeenCalled();
  mocks.ready.mockResolvedValue(true);
  expect(await setHumanReview(null, form())).toHaveProperty('message');
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, expectedGeneration: 3, actor: 'operator',
    expectedModelPoolKeys: ['gpu3090:review', 'm3:review'], expectedModelSourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }));
});
it('끄기는 연결 확인 없이 기존 정식 경로를 사용하고 비관리자는 거절한다', async () => {
  expect(await setHumanReview(null, form('false'))).toHaveProperty('message'); expect(mocks.ready).not.toHaveBeenCalled();
  mocks.admin.mockResolvedValue(null); mocks.save.mockClear();
  expect(await setHumanReview(null, form())).toHaveProperty('error'); expect(mocks.save).not.toHaveBeenCalled();
});
it('선택 모델을 M3 DeepSeek로 잘못 표시하지 않는다', () => {
  const html = renderToStaticMarkup(createElement(HumanReviewSwitch, { enabled: true, generation: 3, ready: true, modelLabel: '선택 모델', modelLocation: '사람 위임 검수 풀' }));
  expect(html).toContain('선택 모델'); expect(html).not.toContain('M3 Ultra'); expect(html).not.toContain('DeepSeek v4.1');
});
it('사람 검토 모델 표시는 저장한 풀, 없으면 레지스트리의 human-review 모델에서 읽는다', () => {
  expect(humanReviewModelDisplay(['gpu3090:review', 'm3:review'])).toEqual({ modelLabel: '선택 모델',
    modelLocation: '사람 위임 검수 풀 · GPU3090 · Qwen · 직접 연결, M3 · DeepSeek' });
  expect(humanReviewModelDisplay([])).toEqual({ modelLabel: 'M3 · DeepSeek', modelLocation: 'm3:review · deepseek-v4.1-flash-1017' });
  const previous = process.env.MODEL_REGISTRY_CONFIG;
  process.env.MODEL_REGISTRY_CONFIG = JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model => model.key === 'm3:review'
    ? { ...model, purposes: ['assist-audit'] } : model.key === 'gpu3090:review' ? { ...model, purposes: [...model.purposes, 'human-review'] } : model) });
  try {
    expect(humanReviewModelDisplay()).toEqual({ modelLabel: 'GPU3090 · Qwen · 직접 연결', modelLocation: 'gpu3090:review · qwen3.8-flash-next' });
  } finally {
    if (previous === undefined) delete process.env.MODEL_REGISTRY_CONFIG; else process.env.MODEL_REGISTRY_CONFIG = previous;
  }
});
