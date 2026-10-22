import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), revalidate: vi.fn(), preview: vi.fn(), start: vi.fn(), apply: vi.fn(), undoStart: vi.fn(), undo: vi.fn(), exceptions: vi.fn(),
  options: vi.fn(), runs: vi.fn(), overview: vi.fn(), takedownSummary: vi.fn(), introCount: vi.fn(),
}));
vi.mock('@/lib/operations/dr/epoch', async (original) => ({ ...await original<typeof import('@/lib/operations/dr/epoch')>(), readWriterFence: async () => ({ state: 'active' }) }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/crawl/audit-policy', () => ({
  previewAuditPolicy: mocks.preview, startAuditPolicyRun: mocks.start, applyAuditPolicyChunk: mocks.apply, startAuditPolicyUndo: mocks.undoStart,
  undoAuditPolicyChunk: mocks.undo, policyRunExceptions: mocks.exceptions, policyFilterOptions: mocks.options, listPolicyRuns: mocks.runs,
}));
vi.mock('@/lib/crawl/product-audit', () => ({
  productAuditOverview: mocks.overview, auditDecisionHistory: vi.fn(), auditFindingReasons: vi.fn(), auditRemovalGroups: vi.fn(), heldFindingReasons: vi.fn(),
  listAuditFindings: vi.fn(), listHeldFindings: vi.fn(), GROUP_REMOVE_MAX: 50, GROUP_REMOVE_MIN_CONFIDENCE: 0.95, GROUP_SCOPES: ['held', 'agreed', 'reject'],
}));
vi.mock('@/lib/crawl/audit-second-opinion-auto', () => ({ qwenSecondOpinionStatus: vi.fn() }));
vi.mock('@/lib/crawl/translations', () => ({ translationsFor: async () => new Map() }));
vi.mock('@/lib/domain/products/takedown', () => ({ takedownSummary: mocks.takedownSummary, takedownQueue: vi.fn(), takedownHistory: vi.fn() }));
vi.mock('@/lib/domain/products/intro-requests', () => ({ introRequestQueue: vi.fn(), pendingIntroRequestCount: mocks.introCount }));

import AdminAuditPage from '@/app/(operator)/admin/audit/page';
import { applyPolicyChunkAction, policyRunExceptionsAction, previewAuditPolicyAction, startPolicyRunAction, startPolicyUndoAction,
  undoPolicyChunkAction } from '@/app/(operator)/admin/audit/policy-actions';
import { ACTION_GROUPS, ACTION_LABELS, targetLabel } from '@/app/(operator)/admin/activity/labels';
import { describePolicyFilter, EMPTY_POLICY_FILTER, policyFilterSchema, policyStartSchema, stratifiedQuotas } from '@/lib/crawl/audit-policy-filter';
import { DEFAULT_AUDIT_HOLD, DEFAULT_QWEN_AUTO } from '@/lib/crawl/settings-schema';

const campaign = { id: 4, startedAt: new Date('2026-10-14T00:00:00Z'), startedBy: 'jr', reason: '감사', promptVersion: 'p', rulesVersion: 'r',
  provider: 'abcllm', model: '[MLX] gpt-oss-120b', reauditKept: false, status: 'running', finishedAt: null, currentProvider: null, currentModel: null };
const progress = (over: Record<string, unknown> = {}) => ({ runId: 9, kind: 'close', action: 'remove', status: 'applying', planned: 10, pending: 5,
  applied: 5, skipped: 0, cancelled: 0, undone: 0, blocked: 0, waiting: null, done: false, ...over });
const filter = { ...EMPTY_POLICY_FILTER, confidenceMin: 0.95, held: 'held' as const, second: 'agreed' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.overview.mockResolvedValue({ campaign, counts: { openReject: 0, openNeedsReview: 0 }, held: 0, hold: DEFAULT_AUDIT_HOLD, qwenAuto: DEFAULT_QWEN_AUTO,
    paused: null, stalled: false, switchTo: null });
  mocks.takedownSummary.mockResolvedValue({ pending: 0, overdue: 0, oldestHours: null, handled24h: { removed: 0, dismissed: 0 }, last30d: { removed: 0, dismissed: 0 },
    lastHour: { requests: 0, owners: 0, senders: 0, noReason: 0, topReason: null } });
  mocks.introCount.mockResolvedValue(0);
  mocks.options.mockResolvedValue({ latestCampaignId: 4, reviewers: [{ key: 'abcllm|[MLX] gpt-oss-120b', provider: 'abcllm', model: '[MLX] gpt-oss-120b', count: 6_965 }],
    sources: [{ source: 'grok-cli-batch', count: 2_755 }] });
  mocks.runs.mockResolvedValue([{ id: 3, kind: 'close', action: 'keep', status: 'applying', planned: 120, note: '적체', createdBy: 'jr',
    createdAt: new Date('2026-10-22T01:00:00Z'), appliedAt: null, undoBy: null, undoneAt: null, filterText: '확신 0.90–0.95 미만 · 보류 아님', options: {},
    counts: { applied: 70, pending: 50 } }]);
});

describe('정책 처리 화면', () => {
  it('정책 처리 탭 — 거르기·자주 쓰는 거르기·실행 목록(남은 것·이어서 적용·되돌리기)을 보인다', async () => {
    const html = renderToStaticMarkup(await AdminAuditPage({ searchParams: Promise.resolve({ tab: 'policy' }) }));
    expect(html).toContain('정책으로 닫기');
    expect(html).toContain('[MLX] gpt-oss-120b');
    expect(html).toContain('grok-cli-batch (2,755)');
    expect(html).toContain('두 모델 모두 거절 · 보류 중');
    expect(html).toContain('정책 #3 · 유지');
    expect(html).toContain('남은 것 50');
    expect(html).toContain('이어서 적용');
    expect(html).toContain('되돌리기…');
    // 적용 단추는 미리보기와 수 적기 전에는 없다
    expect(html).not.toContain('건 내리기</button>');
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('다른 탭에서는 정책 데이터를 읽지 않는다', async () => {
    await AdminAuditPage({ searchParams: Promise.resolve({ tab: 'history' }) }).catch(() => null);
    expect(mocks.options).not.toHaveBeenCalled();
    expect(mocks.runs).not.toHaveBeenCalled();
  });
});

describe('정책 처리 서버 액션', () => {
  it('로그인하지 않았으면 아무것도 부르지 않는다', async () => {
    mocks.admin.mockResolvedValue(null);
    for (const result of [await previewAuditPolicyAction({ filter, action: 'remove' }), await startPolicyRunAction({ filter, action: 'remove', expected: 1, note: '', keepDays: 90 }),
      await applyPolicyChunkAction(9), await startPolicyUndoAction(9), await undoPolicyChunkAction(9), await policyRunExceptionsAction(9)]) {
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('권한') });
    }
    for (const fn of [mocks.preview, mocks.start, mocks.apply, mocks.undoStart, mocks.undo, mocks.exceptions]) expect(fn).not.toHaveBeenCalled();
  });

  it('화면이 보낸 거르기를 다시 읽는다 — 모르는 칸·범위 밖 값·잘못된 실행 번호는 부르지 않는다', async () => {
    expect(await previewAuditPolicyAction({ filter: { ...filter, extra: 1 }, action: 'remove' })).toMatchObject({ ok: false });
    expect(await previewAuditPolicyAction({ filter: { ...filter, confidenceMin: 2 }, action: 'remove' })).toMatchObject({ ok: false });
    expect(await previewAuditPolicyAction({ filter, action: 'delete' })).toMatchObject({ ok: false });
    expect(await startPolicyRunAction({ filter, action: 'remove', expected: 0, note: '', keepDays: 90 })).toMatchObject({ ok: false });
    expect(await startPolicyRunAction({ filter, action: 'keep', expected: 3, note: '', keepDays: 30 })).toMatchObject({ ok: false });
    expect(await applyPolicyChunkAction('9; drop')).toMatchObject({ ok: false });
    expect(await undoPolicyChunkAction(-1)).toMatchObject({ ok: false });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('미리보기는 읽기만, 실행·적용·되돌리기는 로그인한 사람으로 — 다 끝난 묶음에서만 화면을 새로 그린다', async () => {
    mocks.preview.mockResolvedValue({ eligible: 3 });
    expect(await previewAuditPolicyAction({ filter, action: 'remove' }, 'abc')).toEqual({ ok: true, value: { eligible: 3 } });
    expect(mocks.preview).toHaveBeenCalledWith({ filter, action: 'remove', seed: 'abc' });

    mocks.start.mockResolvedValue({ ok: true, runId: 9, planned: 3 });
    expect(await startPolicyRunAction({ filter, action: 'remove', expected: 3, note: '정리', keepDays: 90 })).toEqual({ ok: true, value: { runId: 9, planned: 3 } });
    expect(mocks.start).toHaveBeenCalledWith({ filter, action: 'remove', expected: 3, note: '정리', keepDays: 90, by: 'jr' });

    mocks.apply.mockResolvedValueOnce(progress()).mockResolvedValueOnce(progress({ status: 'applied', pending: 0, applied: 10, done: true }));
    expect(await applyPolicyChunkAction(9)).toMatchObject({ ok: true, value: { pending: 5 } });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(await applyPolicyChunkAction(9)).toMatchObject({ ok: true, value: { done: true } });
    expect(mocks.apply).toHaveBeenLastCalledWith({ runId: 9, by: 'jr' });
    expect(mocks.revalidate).toHaveBeenCalledWith('/admin/audit');

    mocks.undoStart.mockResolvedValue({ ok: false, error: '적용한 실행만 되돌릴 수 있습니다.' });
    expect(await startPolicyUndoAction(9)).toEqual({ ok: false, error: '적용한 실행만 되돌릴 수 있습니다.' });
    expect(mocks.undoStart).toHaveBeenCalledWith({ runId: 9, by: 'jr' });
  });
});

describe('정책 거르기·표본', () => {
  it('거르기 모양 — 빈 거르기는 지나고, 모르는 칸·갈래·출처 글자는 막는다', () => {
    expect(policyFilterSchema.safeParse(EMPTY_POLICY_FILTER).success).toBe(true);
    expect(policyFilterSchema.safeParse({ ...EMPTY_POLICY_FILTER, branches: ['nope'] }).success).toBe(false);
    expect(policyFilterSchema.safeParse({ ...EMPTY_POLICY_FILTER, secondSource: "x'; drop" }).success).toBe(false);
    expect(policyFilterSchema.safeParse({ ...EMPTY_POLICY_FILTER, secondSource: 'qwen-vision-m1' }).success).toBe(true);
    expect(policyStartSchema.safeParse({ filter: EMPTY_POLICY_FILTER, action: 'keep', expected: 5, note: '', keepDays: 365 }).success).toBe(true);
  });

  it('층별 몫 — 갈래마다 수에 비례하고, 남은 것이 있는 갈래는 적어도 한 건, 합은 스무 건(수가 적으면 그 수)', () => {
    expect(stratifiedQuotas({ company: 30, placeholder: 10 })).toEqual({ company: 15, placeholder: 5 });
    const skewed = stratifiedQuotas({ placeholder: 2_000, company: 100, shop: 3, login: 1 });
    expect(Object.values(skewed).reduce((a, b) => a + b, 0)).toBe(20);
    expect(skewed).toMatchObject({ shop: 1, login: 1 });
    expect(skewed.placeholder).toBeGreaterThan(skewed.company);
    expect(stratifiedQuotas({ a: 2, b: 1 })).toEqual({ a: 2, b: 1 });
    expect(stratifiedQuotas({})).toEqual({});
    const many = stratifiedQuotas(Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`k${index}`, 25 - index])));
    expect(Object.values(many).reduce((a, b) => a + b, 0)).toBe(20);
  });

  it('거르기 한 줄 요약과 작업 로그 이름', () => {
    expect(describePolicyFilter(filter, { branch: (key) => key })).toBe('확신 0.95 이상 · 보류 중 · 2차 두 모델 모두 거절(보류에 세는 거절)');
    expect(describePolicyFilter(EMPTY_POLICY_FILTER, { branch: (key) => key })).toBe('열린 거절 전체');
    const grouped = new Set(Object.values(ACTION_GROUPS).flatMap((group) => [...group.actions] as string[]));
    for (const action of ['audit-policy-apply', 'audit-policy-undo']) {
      expect(ACTION_LABELS[action]).toBeTruthy();
      expect(grouped.has(action)).toBe(true);
    }
    expect(targetLabel('policy-run:12')).toEqual({ text: '감사 정책 #12', entity: false });
  });
});
