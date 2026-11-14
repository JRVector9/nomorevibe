import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { readModelRegistry } from '@/lib/llm/model-registry';
import type { HumanModelSource } from '@/lib/operations/human-model-source';
import type { ModelAssignmentRow } from '@/lib/llm/capacity-helpers';

const mocks = vi.hoisted(() => ({ source: vi.fn(), probe: vi.fn(), preview: vi.fn(), setHumanReview: vi.fn() }));
vi.mock('@/lib/operations/human-model-source', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/operations/human-model-source')>(), readHumanModelSource: mocks.source,
}));
vi.mock('@/lib/operations/admin-models-human', () => ({ configuredHumanModelsProbe: mocks.probe }));
vi.mock('@/lib/operations/admin-workspace-preview', () => ({ adminWorkspaceReadOnly: mocks.preview }));
vi.mock('@/app/(operator)/admin/review/human-review-actions', () => ({ setHumanReview: mocks.setHumanReview }));
vi.mock('@/app/(operator)/admin/models/StageModelPoolsForm', () => ({
  StageModelPoolsForm: (props: { stageIds: string[]; readOnly: boolean; pools: unknown }) =>
    <div data-pool-stages={props.stageIds.join(',')} data-read-only={String(props.readOnly)} data-preserved-pools={JSON.stringify(props.pools)} />,
}));
vi.mock('@/app/(operator)/admin/models/assignments/AssignmentForm', () => ({
  AssignmentForm: (props: { initial: { assignmentId: string } | null; readOnly?: boolean; prefill?: { stage: string } }) =>
    <div data-assignment-form={props.initial?.assignmentId ?? props.prefill?.stage} data-read-only={String(!!props.readOnly)} />,
}));

import { HumanModelSettings } from '@/app/(operator)/admin/flow/HumanModelSettings';
import { HumanModelEditor } from '@/app/(operator)/admin/models/human/HumanModelEditor';
import { resolveHumanModelSelection } from '@/lib/operations/human-model-source';

const registry = readModelRegistry();
const selected = registry.models.find(model => model.key === 'gpu3090:review')!;
const pools = { 'human-review': [selected.key], 'split-confirm': ['m3:review'] };
let source: HumanModelSource;
const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async (props: ComponentProps<typeof HumanModelEditor> = {}) => renderToStaticMarkup(await HumanModelEditor(props));
const assignment: ModelAssignmentRow = {
  assignmentId: 'human-model', stage: 'human', deviceId: 'gpu3090', registryKey: selected.key, transport: 'direct', rank: 1,
  role: 'primary', vote: false, mode: 'live', model: selected.model, routeId: 'route', provider: 'local-direct', maxSlots: 1,
  evidenceKey: 'evidence', version: 3, note: null, updatedBy: 'operator', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockReturnValue(false);
  const selection = resolveHumanModelSelection(pools['human-review'], false, null, registry);
  source = {
    settings: { ...DEFAULT_CRAWL_SETTINGS, enabled: true, humanReview: { enabled: false, generation: 7 }, stageModelPools: pools },
    models: registry.models, pools, defaults: {}, assignments: [],
    options: { stages: [], registry: [], devices: [], transportLabels: { gateway: '장비 표지', direct: '엔진 직접', 'local-direct': '로컬 직접', cli: 'CLI' }, rankMax: 8, confirmWord: '배정' },
    source: selection.source, humanUsesTable: false, tableOn: false, unknown: false, effectiveModels: selection.effectiveModels,
    effectiveKeys: selection.effectiveKeys, version: 'form-version', selection, saveBlocked: false,
  };
  mocks.source.mockImplementation(async () => source);
  mocks.probe.mockResolvedValue([{ key: selected.key, provider: selected.provider, ready: true, ms: 1 }]);
});

describe('home human-review settings reuse the canonical decision path', () => {
  it('embeds the canonical editor, scopes to the human delegate and forwards read-only authority', async () => {
    const panel = await HumanModelSettings({ readOnly: true });
    const editor = panel.props.children[1];
    expect(editor.type).toBe(HumanModelEditor);
    expect(editor.props).toEqual({ scope: 'human-review', readOnly: true });
    expect(panel.props.children[0].props.children).toContain('기존 최종 발행 검사');
  });

  it('shows the selected model and enable switch on the home panel, keeping unrelated pools intact', async () => {
    const html = await render({ scope: 'human-review' });
    expect(html).toContain('human-model-editor--panel');
    expect(plain(html)).toContain(`사람 검토를 ${selected.displayName}에 맡기기`);
    expect(html).toContain('role="switch" aria-checked="false"');
    expect(html).not.toMatch(/role="switch"[^>]* disabled(?:=|\s|>)/);
    expect(html).toContain('data-pool-stages="human-review"');
    expect(html).toContain('&quot;split-confirm&quot;:[&quot;m3:review&quot;]');
    expect(html).not.toContain('id="split-confirm"');
    expect(plain(html)).toContain('근거와 확신 기준을 충족한 승인은 기존 최종 발행 검사로 이어집니다.');
    expect(plain(html)).toContain('판단 보류·낮은 확신·실패는 사람 큐에 남습니다.');
    expect(mocks.probe).toHaveBeenCalledWith(source.effectiveKeys, source.selection);
  });

  it('edits/adds the actual assignment rows when the assignment table is the runtime source', async () => {
    const selection = resolveHumanModelSelection(pools['human-review'], true, [assignment], registry);
    source = { ...source, selection, source: selection.source, tableOn: true, humanUsesTable: true,
      assignments: [assignment], effectiveModels: selection.effectiveModels, effectiveKeys: selection.effectiveKeys };
    expect(source.source).toBe('table');
    const html = await render({ scope: 'human-review' });
    expect(html).toContain('data-assignment-form="human-model" data-read-only="false"');
    expect(html).toContain('data-assignment-form="human" data-read-only="false"');
    expect(html).not.toContain('data-pool-stages');
    expect(plain(html)).toContain('배정 표가 실제 출처이므로 사람 위임 검수 풀의 기존 값은 실행에 쓰지 않습니다.');
  });

  it('preserves the advanced editor default and its other helper settings', async () => {
    const html = await render();
    expect(html).not.toContain('human-model-editor--panel');
    expect(html).toContain('data-pool-stages="human-review,split-confirm,split-tiebreak,held-review-retry"');
    expect(html).toContain('id="split-confirm"');
  });

  it.each(['explicit', 'workspace'])('keeps %s read-only mode from probing or enabling a delegate', async mode => {
    mocks.preview.mockReturnValue(mode === 'workspace');
    const html = await render({ scope: 'human-review', readOnly: mode === 'explicit' });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(html).toMatch(/role="switch"[^>]* disabled(?:=|\s|>)/);
    expect(html).toContain('data-read-only="true"');
  });

  it('does not substitute defaults or open editing when the model source is unreadable', async () => {
    source = { ...source, unknown: true, saveBlocked: true, source: 'unknown', effectiveModels: [], effectiveKeys: [] };
    const html = await render({ scope: 'human-review' });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(plain(html)).toContain('설정 출처를 읽지 못해 저장할 수 없습니다.');
    expect(html).toMatch(/role="switch"[^>]* disabled(?:=|\s|>)/);
    expect(html).toContain('data-read-only="true"');
  });

  it('explains the global stop instead of claiming an enabled delegate is already processing', async () => {
    source = { ...source, settings: { ...source.settings, enabled: false, humanReview: { enabled: true, generation: 7 } } };
    const html = await render({ scope: 'human-review' });
    expect(plain(html)).toContain('수집·검수 전체가 꺼져 있습니다. 자동 위임을 켜도 전체 실행이 재개되기 전에는 후보를 판단하지 않습니다.');
  });

  it('shows an unavailable state without a control when the source read fails', async () => {
    mocks.source.mockRejectedValue(new Error('read_failed'));
    const html = await render({ scope: 'human-review' });
    expect(plain(html)).toContain('사람 위임 모델 설정을 읽지 못했습니다. 저장할 수 없습니다.');
    expect(html).not.toContain('role="switch"');
  });
});
