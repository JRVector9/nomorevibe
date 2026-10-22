import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), revalidate: vi.fn(), preview: vi.fn(), start: vi.fn(), apply: vi.fn(), undoStart: vi.fn(), undo: vi.fn(), exceptions: vi.fn(),
  options: vi.fn(), runs: vi.fn(), overview: vi.fn(), takedownSummary: vi.fn(), introCount: vi.fn(),
  staged: vi.fn(), stage: vi.fn(), importPreview: vi.fn(), importStart: vi.fn(), discard: vi.fn(),
  throughput: vi.fn(), expiring: vi.fn(), keepPreview: vi.fn(), keepStart: vi.fn(), autoToday: vi.fn(),
}));
vi.mock('@/lib/operations/dr/epoch', async (original) => ({ ...await original<typeof import('@/lib/operations/dr/epoch')>(), readWriterFence: async () => ({ state: 'active' }) }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/crawl/audit-policy', () => ({
  previewAuditPolicy: mocks.preview, startAuditPolicyRun: mocks.start, applyAuditPolicyChunk: mocks.apply, startAuditPolicyUndo: mocks.undoStart,
  undoAuditPolicyChunk: mocks.undo, policyRunExceptions: mocks.exceptions, policyFilterOptions: mocks.options, listPolicyRuns: mocks.runs,
  auditThroughput: mocks.throughput, expiringKeepCount: mocks.expiring, previewKeepExtend: mocks.keepPreview, startKeepExtendRun: mocks.keepStart,
  AUDIT_BACKLOG_OVERDUE_DAYS: 7, KEEP_EXTEND_WITHIN_DAYS: 30,
}));
vi.mock('@/lib/crawl/audit-second-opinion-upload', () => ({ latestStagedImport: mocks.staged, stageImportLines: mocks.stage, previewImport: mocks.importPreview,
  startImportApply: mocks.importStart, discardImport: mocks.discard, IMPORT_STAGE_MAX_LINES: 500 }));
vi.mock('@/lib/crawl/product-audit', () => ({
  productAuditOverview: mocks.overview, auditDecisionHistory: vi.fn(), auditFindingReasons: vi.fn(), auditRemovalGroups: vi.fn(), heldFindingReasons: vi.fn(),
  listAuditFindings: vi.fn(), listHeldFindings: vi.fn(), GROUP_REMOVE_MAX: 50, GROUP_REMOVE_MIN_CONFIDENCE: 0.95, GROUP_SCOPES: ['held', 'agreed', 'reject'],
}));
vi.mock('@/lib/crawl/audit-second-opinion-auto', () => ({ qwenSecondOpinionStatus: vi.fn() }));
// 오늘 답으로 닫은 수도 DB 를 센다 — 규칙·이름은 실제 모듈 그대로
vi.mock('@/lib/crawl/audit-auto-close', async (original) => ({ ...await original<typeof import('@/lib/crawl/audit-auto-close')>(),
  autoCloseToday: mocks.autoToday }));
vi.mock('@/lib/crawl/translations', () => ({ translationsFor: async () => new Map() }));
vi.mock('@/lib/domain/products/takedown', () => ({ takedownSummary: mocks.takedownSummary, takedownQueue: vi.fn(), takedownHistory: vi.fn() }));
vi.mock('@/lib/domain/products/intro-requests', () => ({ introRequestQueue: vi.fn(), pendingIntroRequestCount: mocks.introCount }));

import AdminAuditPage from '@/app/(operator)/admin/audit/page';
import { applyPolicyChunkAction, discardImportAction, policyRunExceptionsAction, previewAuditPolicyAction, previewImportAction, previewKeepExtendAction,
  stageImportAction, startImportApplyAction, startKeepExtendAction, startPolicyRunAction, startPolicyUndoAction,
  undoPolicyChunkAction } from '@/app/(operator)/admin/audit/policy-actions';
import { ACTION_GROUPS, ACTION_LABELS, targetLabel } from '@/app/(operator)/admin/activity/labels';
import { describePolicyFilter, EMPTY_POLICY_FILTER, policyFilterSchema, policyStartSchema, stratifiedQuotas } from '@/lib/crawl/audit-policy-filter';
import { DEFAULT_AUDIT_HOLD, DEFAULT_QWEN_AUTO } from '@/lib/crawl/settings-schema';

const campaign = { id: 4, startedAt: new Date('2026-10-14T00:00:00Z'), startedBy: 'jr', reason: '감사', promptVersion: 'p', rulesVersion: 'r',
  provider: 'abcllm', model: '[MLX] gpt-oss-120b', reauditKept: false, status: 'running', finishedAt: null, currentProvider: null, currentModel: null };
const progress = (over: Record<string, unknown> = {}) => ({ runId: 9, kind: 'close', action: 'remove', status: 'applying', planned: 10, pending: 5,
  applied: 5, skipped: 0, cancelled: 0, undone: 0, blocked: 0, waiting: null, done: false, ...over });
const filter = { ...EMPTY_POLICY_FILTER, confidenceMin: 0.95, held: 'held' as const, second: 'agreed' as const };
/** 처리 속도(lib/crawl/audit-policy.ts AuditThroughput) — 2026-10-22 프로드와 비슷한 모양: 들어옴 400·닫음 0 */
const throughputOf = (over: Record<string, unknown> = {}) => ({ open: 7_450, held: 2_490, overdue: 6_100, oldestWaitDays: 8,
  days: Array.from({ length: 14 }, (_, index) => ({ day: `2026-10-${String(9 + index).padStart(2, '0')}`, closed: 0, incoming: 400 })),
  closedPerDay: 0, incomingPerDay: 400, daysToClear: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.overview.mockResolvedValue({ campaign, counts: { openReject: 0, openNeedsReview: 0 }, held: 0, hold: DEFAULT_AUDIT_HOLD, qwenAuto: DEFAULT_QWEN_AUTO,
    paused: null, stalled: false, switchTo: null });
  mocks.takedownSummary.mockResolvedValue({ pending: 0, overdue: 0, oldestHours: null, handled24h: { removed: 0, dismissed: 0 }, last30d: { removed: 0, dismissed: 0 },
    lastHour: { requests: 0, owners: 0, senders: 0, noReason: 0, topReason: null } });
  mocks.introCount.mockResolvedValue(0);
  mocks.staged.mockResolvedValue(null);
  mocks.expiring.mockResolvedValue(42);
  mocks.throughput.mockResolvedValue(throughputOf());
  mocks.autoToday.mockResolvedValue({ day: '2026-10-22', kept: 0, held: 0, undone: 0 });
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

  it('처리 속도 — 하루 닫음·들어옴·다 닫는 날(줄지 않으면 얼마나 더 닫아야 하는지)·가장 오래 기다린 것, 곧 끝나는 유지 수', async () => {
    const html = renderToStaticMarkup(await AdminAuditPage({ searchParams: Promise.resolve({ tab: 'policy' }) }));
    expect(html).toContain('처리 속도');
    expect(html).toMatch(/열린 거절 <b[^>]*>7,450<\/b>건/);
    expect(html).toContain('줄지 않음 — 하루 400건 더 닫아야 줄기 시작');
    expect(html).toMatch(/가장 오래 기다린 것 (<!-- -->)?8일/);
    expect(html).toContain('메뉴 배지와 오늘 할 일에 보입니다');
    expect(html).toContain('10-22');
    expect(html).toMatch(/30(<!-- -->)?일 안에 끝나는 유지 <b[^>]*>42<\/b>건/);
    mocks.throughput.mockResolvedValue(throughputOf({ closedPerDay: 900, daysToClear: 15, oldestWaitDays: 3, overdue: 0 }));
    const faster = renderToStaticMarkup(await AdminAuditPage({ searchParams: Promise.resolve({ tab: 'policy' }) }));
    expect(faster).toContain('지금 속도면 약 15일 뒤 다 닫힘');
    expect(faster).not.toContain('메뉴 배지와 오늘 할 일에 보입니다');
  });

  it('m1 자동 닫기 — 오늘(UTC) 자동 유지·숨김 수와 규칙, 자동 실행은 \'m1 자동 …\' 이름으로 목록에 서고 되돌리기 창이 무엇이 돌아가는지 말한다', async () => {
    const auto = (action: 'keep' | 'hold') => ({ by: 'qwen-v2-auto', action, day: '2026-10-22', model: 'qwen3.8-flash-next', promptVersion: '2026-10-21.v2', minConfidence: 0.9 });
    mocks.autoToday.mockResolvedValue({ day: '2026-10-22', kept: 37, held: 512, undone: 3 });
    mocks.overview.mockResolvedValue({ campaign, counts: { openReject: 0, openNeedsReview: 0 }, held: 0, hold: DEFAULT_AUDIT_HOLD, paused: null, stalled: false, switchTo: null,
      qwenAuto: { ...DEFAULT_QWEN_AUTO, auditSecondOpinion: { enabled: true, perTick: 10, scope: 'all', autoClose: true } } });
    mocks.runs.mockResolvedValue([
      { id: 12, kind: 'close', action: 'release', status: 'applied', planned: 512, note: '자동', createdBy: 'qwen-v2-auto', createdAt: new Date('2026-10-22T01:00:00Z'),
        appliedAt: new Date('2026-10-22T01:00:00Z'), undoBy: null, undoneAt: null, filterText: 'Qwen-v2 거절 → 숨김', options: { auto: auto('hold') },
        counts: { applied: 509, undone: 3 }, auto: auto('hold') },
      { id: 11, kind: 'close', action: 'keep', status: 'applied', planned: 37, note: '자동', createdBy: 'qwen-v2-auto', createdAt: new Date('2026-10-22T01:00:00Z'),
        appliedAt: new Date('2026-10-22T01:00:00Z'), undoBy: null, undoneAt: null, filterText: 'Qwen-v2 승인 → 유지', options: { auto: auto('keep') },
        counts: { applied: 37 }, auto: auto('keep') }]);
    const html = renderToStaticMarkup(await AdminAuditPage({ searchParams: Promise.resolve({ tab: 'policy' }) }));
    expect(mocks.autoToday).toHaveBeenCalled();
    const panel = html.slice(html.indexOf('id="audit-auto-close-title"'), html.indexOf('id="audit-policy-runs-title"'));
    expect(panel).toContain('m1 자동 닫기');
    expect(panel).toMatch(/자동 유지 <b[^>]*>37<\/b>/);
    expect(panel).toMatch(/자동 숨김 <b[^>]*>512<\/b>/);
    expect(panel).toMatch(/그중 되돌림 (<!-- -->)?3/);
    expect(panel).toContain('아무것도 내리지 않습니다');
    expect(html).toContain('정책 #12 · m1 자동 숨김 · 2026-10-22(UTC)');
    expect(html).toContain('정책 #11 · m1 자동 유지 · 2026-10-22(UTC)');
    // 못 읽어도 화면은 그린다
    mocks.autoToday.mockRejectedValue(new Error('db'));
    expect(renderToStaticMarkup(await AdminAuditPage({ searchParams: Promise.resolve({ tab: 'policy' }) }))).toContain('m1 자동 닫기');
  });

  it('다른 탭에서는 정책 데이터를 읽지 않는다', async () => {
    await AdminAuditPage({ searchParams: Promise.resolve({ tab: 'history' }) }).catch(() => null);
    expect(mocks.options).not.toHaveBeenCalled();
    expect(mocks.runs).not.toHaveBeenCalled();
    expect(mocks.autoToday).not.toHaveBeenCalled();
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

describe('두 번째 의견 올리기 서버 액션', () => {
  it('로그인·출처·줄 수·실행 번호를 다시 본다 — 맞지 않으면 부르지 않는다', async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await stageImportAction({ runId: null, source: 'qwen-vision-m1', lines: ['{}'], final: true })).toMatchObject({ ok: false, error: expect.stringContaining('권한') });
    expect(await stageImportAction({ runId: null, source: 'nope', lines: ['{}'], final: true })).toMatchObject({ ok: false });
    expect(await stageImportAction({ runId: null, source: 'qwen-vision-m1', lines: Array.from({ length: 501 }, () => '{}'), final: true })).toMatchObject({ ok: false });
    expect(await stageImportAction({ runId: 'x', source: 'qwen-vision-m1', lines: [], final: true })).toMatchObject({ ok: false });
    expect(await stageImportAction({ runId: null, source: 'qwen-vision-m1', lines: [1, 2], final: true })).toMatchObject({ ok: false });
    expect(await startImportApplyAction({ runId: 3, supersede: true, expected: 0 })).toMatchObject({ ok: false });
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.importStart).not.toHaveBeenCalled();
  });

  it('로그인한 사람으로 줄을 넘기고, 대체는 참일 때만 켠다', async () => {
    mocks.stage.mockResolvedValue({ ok: true, runId: 5, status: 'staged', summary: { read: 1, stored: 1 } });
    expect(await stageImportAction({ runId: null, source: 'qwen-vision-m1', lines: ['{"a":1}'], final: true })).toMatchObject({ ok: true, value: { runId: 5 } });
    expect(mocks.stage).toHaveBeenCalledWith({ runId: null, source: 'qwen-vision-m1', lines: ['{"a":1}'], final: true, by: 'jr' });
    mocks.importPreview.mockResolvedValue({ ok: true, preview: { writable: 1 } });
    await previewImportAction(5, 'yes');
    expect(mocks.importPreview).toHaveBeenLastCalledWith({ runId: 5, supersede: false });
    await previewImportAction(5, true);
    expect(mocks.importPreview).toHaveBeenLastCalledWith({ runId: 5, supersede: true });
    mocks.importStart.mockResolvedValue({ ok: true, runId: 5, planned: 2 });
    expect(await startImportApplyAction({ runId: 5, supersede: 'true', expected: 1 })).toMatchObject({ ok: true });
    expect(mocks.importStart).toHaveBeenCalledWith({ runId: 5, supersede: false, expected: 1, by: 'jr' });
    mocks.discard.mockResolvedValue(true);
    expect(await discardImportAction(5)).toEqual({ ok: true, value: { discarded: true } });
  });
});

describe('유지 연장 서버 액션', () => {
  it('기간은 90·180·365일만, 수는 1 이상 — 로그인한 사람으로. 페이지 그대로인 것만이 기본이다', async () => {
    expect(await startKeepExtendAction({ days: 30, expected: 3 })).toMatchObject({ ok: false });
    expect(await startKeepExtendAction({ days: 90, expected: 0 })).toMatchObject({ ok: false });
    expect(mocks.keepStart).not.toHaveBeenCalled();
    mocks.keepStart.mockResolvedValue({ ok: true, runId: 8, planned: 3 });
    expect(await startKeepExtendAction({ days: 180, expected: 3, note: '연장' })).toEqual({ ok: true, value: { runId: 8, planned: 3 } });
    expect(mocks.keepStart).toHaveBeenCalledWith({ days: 180, unchangedOnly: true, expected: 3, note: '연장', by: 'jr' });
    mocks.keepPreview.mockResolvedValue({ eligible: 3 });
    await previewKeepExtendAction(false);
    expect(mocks.keepPreview).toHaveBeenLastCalledWith({ unchangedOnly: false });
    await previewKeepExtendAction(undefined);
    expect(mocks.keepPreview).toHaveBeenLastCalledWith({ unchangedOnly: true });
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
    for (const action of ['audit-policy-apply', 'audit-policy-undo', 'audit-auto-keep', 'audit-auto-hold']) {
      expect(ACTION_LABELS[action]).toBeTruthy();
      expect(grouped.has(action)).toBe(true);
    }
    expect(targetLabel('policy-run:12')).toEqual({ text: '감사 정책 #12', entity: false });
  });
});
