import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), redirect: vi.fn(), revalidate: vi.fn(),
  overview: vi.fn(), findings: vi.fn(), start: vi.fn(), cancel: vi.fn(), remove: vi.fn(), keep: vi.fn(),
  groups: vi.fn(), removeMany: vi.fn(), translations: vi.fn(), log: vi.fn(), reasons: vi.fn(), decisions: vi.fn(),
  takedownSummary: vi.fn(), takedownQueue: vi.fn(), takedownHistory: vi.fn(),
  introQueue: vi.fn(), introCount: vi.fn(), introFix: vi.fn(), introResolve: vi.fn(),
  held: vi.fn(), heldReasons: vi.fn(), setHold: vi.fn(), throughput: vi.fn(), qwenStatus: vi.fn(), switchReviewer: vi.fn(), setQwenAuto: vi.fn(),
  screenStatus: vi.fn(),
}));
vi.mock('@/lib/operations/dr/epoch', async original => ({ ...await original<typeof import('@/lib/operations/dr/epoch')>(), readWriterFence: async () => ({ state: 'active' }) })); // PR15e: 웹 쓰기 관문은 dr-web-fence 테스트가 본다(이 fixture 의 요청 흐름 불변)
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/crawl/product-audit', () => ({
  productAuditOverview: mocks.overview, listAuditFindings: mocks.findings, startProductAudit: mocks.start,
  cancelProductAudit: mocks.cancel, removeAuditedProduct: mocks.remove, keepAuditedProduct: mocks.keep,
  auditRemovalGroups: mocks.groups, removeAuditedProducts: mocks.removeMany, auditFindingReasons: mocks.reasons, auditDecisionHistory: mocks.decisions,
  listHeldFindings: mocks.held, heldFindingReasons: mocks.heldReasons, switchAuditReviewer: mocks.switchReviewer,
  GROUP_REMOVE_MAX: 50, GROUP_REMOVE_MIN_CONFIDENCE: 0.95, GROUP_SCOPES: ['held', 'agreed', 'reject'],
}));
// Qwen-v2 자동 단계의 상태도 DB 를 센다
vi.mock('@/lib/crawl/audit-second-opinion-auto', () => ({ qwenSecondOpinionStatus: mocks.qwenStatus }));
vi.mock('@/lib/screen-review/job', () => ({ screenReviewStatus: mocks.screenStatus }));
vi.mock('@/lib/crawl/settings', () => ({ setAuditHold: mocks.setHold, setQwenAutoStep: mocks.setQwenAuto }));
vi.mock('@/lib/crawl/translations', () => ({ translationsFor: mocks.translations }));
// 처리 속도·적체(0116)도 DB 를 센다
vi.mock('@/lib/crawl/audit-policy', () => ({ auditThroughput: mocks.throughput, AUDIT_BACKLOG_OVERDUE_DAYS: 7, KEEP_EXTEND_WITHIN_DAYS: 30,
  expiringKeepCount: async () => 0, listPolicyRuns: async () => [], policyFilterOptions: async () => null }));
vi.mock('@/lib/operations/admin-log', () => ({ recordAdminAction: mocks.log, recordAdminActions: mocks.log }));
// 화면 판별 대기·엇갈림의 수(정책 처리 탭)도 DB 를 센다 — 감사 거절 탭은 Qwen 상태(qwenSecondOpinionStatus.screen)로 받는다
vi.mock('@/lib/crawl/audit-screen-review', () => ({ screenReviewCounts: async () => null }));
// 내려달라는 요청 집계도 DB를 읽는다 — CI 단위 테스트에는 DB가 없다
vi.mock('@/lib/domain/products/takedown', () => ({
  takedownSummary: mocks.takedownSummary, takedownQueue: mocks.takedownQueue, takedownHistory: mocks.takedownHistory,
}));

// 소개 수정 요청(UX-18)도 DB를 읽는다
vi.mock('@/lib/domain/products/intro-requests', () => ({
  introRequestQueue: mocks.introQueue, pendingIntroRequestCount: mocks.introCount, fixIntroFromRequest: mocks.introFix,
  resolveIntroRequest: mocks.introResolve, isIntroRequestOutcome: (value: unknown) => value === 'fixed' || value === 'dismissed',
}));

import AdminAuditPage from '@/app/(operator)/admin/audit/page';
import * as auditActions from '@/app/(operator)/admin/audit/actions';
import { cancelAudit, decideAuditFinding, fixIntroRequest, removeAuditGroup, resolveIntroRequestAction, restartStalledAudit,
  saveAuditHold, startAudit, switchAuditModel } from '@/app/(operator)/admin/audit/actions';
import { saveQwenAutoStep } from '@/app/(operator)/admin/qwen-auto-actions';
import { REVIEW_PROMPT_VERSION } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_AUDIT_HOLD, DEFAULT_QWEN_AUTO } from '@/lib/crawl/settings-schema';

const campaign = {
  id: 7, startedAt: new Date('2026-09-18T12:00:00Z'), startedBy: 'jr', reason: '첫 감사', promptVersion: '2026-09-18.2',
  rulesVersion: '2026-09-18.1', provider: 'abcllm', model: '[MLX] gpt-oss-120b', reauditKept: false, status: 'running', finishedAt: null,
};
const counts = { total: 100, reviewed: 40, reject: 3, needsReview: 1, openReject: 3, openNeedsReview: 1, openAgreed: 2, openSplit: 1,
  openDisagree: 4, openQwenCatalog: 5, removed: 0, kept: 0, failed: 0, skipped: 0 };
/** Qwen-v2 자동 단계 상태(audit-second-opinion-auto.ts QwenAutoStatus) */
const qwenStatusOf = (over: Record<string, unknown> = {}) => ({ model: 'qwen3.8-flash-next', url: 'http://100.77.43.63:8090/v1', promptVersion: '2026-10-21.v2',
  audit: { enabled: true, perTick: 10, lastHour: 12, lastDay: 340, remaining: 2_415, scope: 'all', autoClose: true },
  autoClose: { day: '2026-10-22', kept: 37, held: 512, undone: 0, minConfidence: 0.9 },
  published: { enabled: true, perTick: 10, lastHour: 6, lastDay: 129, keptHour: 4, keptDay: 97, remaining: 3 },
  lastRunAt: '2026-10-21T06:59:00.000Z', lastSuccessAt: '2026-10-21T06:59:00.000Z', lastError: null, givenUp: 0, endpointBackoff: null, ...over });
const finding = (id: number, slug: string, over: Record<string, unknown> = {}) => ({
  id, slug, name: `이름 ${slug}`, url: `https://${slug}.test`, category: 'Productivity',
  reason: 'pageText shows only a sign-in form', confidence: 0.95, reviewedAt: new Date('2026-09-18T12:30:00Z'), owned: false,
  heldAt: null, second: [], ...over,
});
/** 감사 개요 — 보류 수와 보류 설정(product-audit.ts AuditOverview)까지 */
const overviewOf = (over: Record<string, unknown> = {}) => ({ campaign, counts, paused: null, stalled: false, held: 0, hold: DEFAULT_AUDIT_HOLD,
  qwenAuto: DEFAULT_QWEN_AUTO, switchTo: null, ...over });
const QWEN = { provider: 'qwen-direct', model: 'qwen3.8-flash-next' };
/** 제품을 고르는 체크박스 — 보류 설정 폼의 켬·갈래·두 번째 모델 칸은 제품을 싣지 않는다 */
const productCheckboxes = (html: string) => (html.match(/<input type="checkbox"[^>]*>/g) ?? [])
  .filter((box) => !/name="(enabled|secondOpinionReject|category|auditSecondOpinion-enabled|auditSecondOpinion-autoClose|publishedFilter-enabled)"/.test(box));
const takedowns = (pending: number) => ({
  pending, overdue: 0, oldestHours: pending ? 2 : null, handled24h: { removed: 0, dismissed: 0 }, last30d: { removed: 0, dismissed: 0 },
  lastHour: { requests: 0, owners: 0, senders: 0, noReason: 0, topReason: null },
});
const render = async (searchParams: Record<string, string> = {}) =>
  renderToStaticMarkup(await AdminAuditPage({ searchParams: Promise.resolve(searchParams) }));
const forms = (html: string) => html.split('<form').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('</form>')));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.overview.mockResolvedValue(overviewOf());
  mocks.held.mockResolvedValue([]);
  mocks.heldReasons.mockResolvedValue([]);
  mocks.findings.mockResolvedValue([finding(11, 'login-wall'), finding(12, 'docs-site'), finding(13, 'agency')]);
  mocks.groups.mockResolvedValue([]);
  mocks.reasons.mockResolvedValue([
    { id: 11, reason: 'pageText shows only a sign-in form' }, { id: 12, reason: 'a documentation site' }, { id: 13, reason: 'a consulting agency site' },
  ]);
  mocks.translations.mockResolvedValue(new Map());
  mocks.throughput.mockResolvedValue(null);
  mocks.takedownSummary.mockResolvedValue(takedowns(0));
  mocks.takedownQueue.mockResolvedValue([]);
  mocks.takedownHistory.mockResolvedValue([]);
  mocks.decisions.mockResolvedValue([]);
  mocks.introQueue.mockResolvedValue([]);
  mocks.introCount.mockResolvedValue(0);
  mocks.qwenStatus.mockResolvedValue(qwenStatusOf());
  mocks.screenStatus.mockResolvedValue(null);
});

describe('내릴 후보 화면', () => {
  /** 감사 처리 기록(2026-10-11) — 무엇 때문에 내렸는지 사유 갈래·AI 사유와 함께 본다 */
  it('처리 기록 탭은 감사에서 내리고 둔 것을 사유 갈래·AI 사유·누가 언제와 함께 보인다', async () => {
    mocks.decisions.mockResolvedValue([
      { id: 31, slug: 'shop', name: '가게', url: 'https://shop.test', decision: 'removed', by: 'jr', at: new Date('2026-10-11T00:00:00Z'),
        note: null, reason: 'The URL is an e-commerce storefront selling clothing.', confidence: 0.97, campaignId: 3 },
      { id: 32, slug: 'tool', name: '도구', url: 'https://tool.test', decision: 'kept', by: 'jr', at: new Date('2026-10-10T23:00:00Z'),
        note: '실제 앱', reason: 'only a login form', confidence: 0.8, campaignId: 3 },
    ]);
    const html = await render({ tab: 'history' });
    expect(mocks.decisions).toHaveBeenCalled();
    expect(html).toContain('감사 처리');
    expect(html).toContain('최근 2건 · 내림 1 · 유지 1');
    expect(html).toContain('내린 사유: 쇼핑몰·판매 1');
    expect(html).toMatch(/rounded bg-bg-soft[^"]*">쇼핑몰·판매<\/span>/);
    expect(html).toMatch(/rounded bg-bg-soft[^"]*">로그인 화면만<\/span>/);
    expect(html).toContain('e-commerce storefront');
    expect(html).toContain('실제 앱');
    expect(html).toContain('감사 #3');
    expect(html).toContain('href="https://shop.test" target="_blank"');
  });

  /** 사유 갈래(2026-10-11) — 내릴 까닭이 같은 것끼리 몰아 본다. 판단은 바꾸지 않고 묶어 보기만 한다 */
  it('사유 갈래 칩에 수를 적고, 줄마다 갈래를 보이며, 갈래를 고르면 그 항목만 쪽을 넘긴다', async () => {
    const html = await render({ tab: 'audit' });
    expect(html).toContain('aria-label="내릴 사유 갈래"');
    expect(html).toMatch(/aria-current="page"[^>]*>전체 3/);
    for (const label of ['로그인 화면만', '글·문서·강의', '회사·서비스 소개']) expect(html).toContain(`${label} 1`);
    // 0건 갈래는 칩에 없다(보류 설정 칸은 모든 갈래를 보인다)
    const chips = html.slice(html.indexOf('aria-label="내릴 사유 갈래"'), html.indexOf('</nav>', html.indexOf('aria-label="내릴 사유 갈래"')));
    expect(chips).not.toContain('쇼핑몰·판매');
    expect(html).toContain('href="/admin/audit?tab=audit&amp;reason=login"');
    expect(mocks.findings).toHaveBeenLastCalledWith(7, 'reject', { limit: 50, offset: 0, ids: undefined });

    mocks.findings.mockResolvedValue([finding(11, 'login-wall')]);
    const filtered = await render({ tab: 'audit', reason: 'login' });
    expect(mocks.findings).toHaveBeenLastCalledWith(7, 'reject', { limit: 50, offset: 0, ids: [11] });
    expect(filtered).toMatch(/aria-current="page"[^>]*>로그인 화면만 1/);
    expect(filtered).toMatch(/rounded bg-bg-soft[^"]*">로그인 화면만<\/span>/);

    // 모르는 갈래는 거르지 않는다
    await render({ tab: 'audit', reason: 'constructor' });
    expect(mocks.findings).toHaveBeenLastCalledWith(7, 'reject', { limit: 50, offset: 0, ids: undefined });
  });

  it('로그아웃 상태면 감사 기록을 읽기 전에 로그인으로 보낸다', async () => {
    mocks.admin.mockResolvedValue(null);
    mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
    await expect(render()).rejects.toThrow('redirect:/admin/login');
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  /** 한 번 누르면 한 제품 — 고르는 칸도, 모두 고르기도, 한꺼번에 내리는 버튼도 없다 */
  it('일괄로 내리는 수단이 없고, 행동 폼마다 제품 하나만 싣는다', async () => {
    const html = await render();
    const decisions = forms(html).filter((form) => form.includes('name="item"'));
    expect(decisions).toHaveLength(3);
    for (const [index, slug] of ['login-wall', 'docs-site', 'agency'].entries()) {
      expect(decisions[index].match(/name="slug"/g)).toHaveLength(1);
      expect(decisions[index].match(/name="item"/g)).toHaveLength(1);
      expect(decisions[index]).toContain(`value="${slug}"`);
      // 내리기는 바로 보내지 않고 확인 창(ConfirmAction)을 연다 — 폼에는 보내는 단추가 유지뿐이다
      expect(decisions[index]).toMatch(/<button type="button"[^>]*>내리기<\/button>/);
      expect(decisions[index]).not.toContain('value="remove"');
      expect(decisions[index]).toContain('value="keep"');
    }
    // 화면의 체크박스는 "유지 판정도 다시 보기" 하나뿐이다 — 제품을 고르는 칸이 아니다
    expect(productCheckboxes(html)).toHaveLength(1);
    expect(productCheckboxes(html)[0]).toContain('name="reauditKept"');
    expect(forms(html).find((form) => form.includes('type="checkbox"'))).not.toContain('name="slug"');
    // 다른 폼으로 값을 실어 보내는 form 속성(재검수 화면의 일괄 차단 방식)도 없다
    expect(html).not.toMatch(/\sform="/);
    expect(html).not.toMatch(/전체 선택|모두 선택|일괄|선택 차단|모두 내리기|선택한 것/);
  });

  it('줄마다 기다린 날을 보이고, 감사 탭 위에 처리 속도 한 줄(가장 오래 기다린 것·정책 처리로)을 둔다', async () => {
    mocks.throughput.mockResolvedValue({ open: 3, held: 0, overdue: 3, oldestWaitDays: 34, days: [], closedPerDay: 1.5, incomingPerDay: 0.5, daysToClear: 3 });
    const html = await render({ tab: 'audit' });
    // 2026-09-18 12:30 에 답을 받았다 — 오늘(테스트 시각)까지 센 날
    expect(html).toMatch(/대기 (<!-- -->)?[0-9,]+(<!-- -->)?일/);
    expect(html).toContain('지금 속도면 약 3일 뒤 다 닫힘');
    expect(html).toMatch(/가장 오래 기다린 것 (<!-- -->)?34일/);
    expect(html).toContain('href="/admin/audit?tab=policy"');
    // 표는 정책 처리 탭에만
    expect(html).not.toContain('지난 14일 닫은 수와 들어온 수');
  });

  it('주소를 새 탭으로 열고, 지금 분류·AI 사유·확신을 보인다', async () => {
    const html = await render();
    expect(html).toContain('href="https://login-wall.test" target="_blank"');
    expect(html).toContain('Productivity');
    expect(html).toContain('pageText shows only a sign-in form');
    expect(html).toContain('0.95');
    expect(mocks.findings).toHaveBeenCalledWith(7, 'reject', { limit: 50, offset: 0 });
  });

  it('사유는 두 줄로 접고, 미리 옮겨 둔 한국어가 있으면 그것을 보인다', async () => {
    mocks.translations.mockResolvedValue(new Map([['pageText shows only a sign-in form', '로그인 화면만 있다']]));
    const html = await render();
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('로그인 화면만 있다');
    expect(html).toContain('사유 표시 언어');
  });

  it('확신 높은 거부는 분류별 묶음으로 보이고, 묶음은 이름을 훑는 창을 거친다 — 화면에 고르는 칸은 없다', async () => {
    mocks.groups.mockResolvedValue([{ category: 'Commerce', total: 137, items: [
      { id: 21, slug: 'shop-a', name: '가게 A', url: 'https://shop-a.test', confidence: 0.99 },
      { id: 22, slug: 'shop-b', name: '가게 B', url: 'https://shop-b.test', confidence: 0.96 },
    ] }]);
    const html = await render();
    expect(mocks.groups).toHaveBeenCalledWith(7);
    expect(html).toContain('묶어 내리기');
    expect(html).toMatch(/Commerce<\/b><span[^>]*>137건/);
    expect(html).toContain('2건 내리기…');
    expect(productCheckboxes(html)).toHaveLength(1);
    // 판단 보류에는 묶음이 없다
    mocks.groups.mockClear();
    expect(await render({ view: 'needs_review' })).not.toContain('묶어 내리기');
    expect(mocks.groups).not.toHaveBeenCalled();
  });

  it('심사 글이 바뀌어 멈춘 감사는 "진행 중"이 아니라 "멈춤 · 사람 필요"이고, 중단 → 새 감사 버튼 하나를 둔다', async () => {
    mocks.overview.mockResolvedValue(overviewOf({ paused: '두 글의 판단을 섞지 않도록 멈췄습니다', stalled: true }));
    const html = await render();
    expect(html).toContain('멈춤 · 사람 필요');
    expect(html).not.toMatch(/>진행 중</);
    expect(html).toContain('이 감사 중단 → 새 감사 시작');
    // 따로 노는 "이 감사 중단" 폼은 두지 않는다
    expect(html).not.toContain('멈춰도 아무것도 내려가지 않고');
    expect(html).toContain('멈춘 감사가 열려 있습니다');
  });

  it('남은 감사 모델 바꾸기(0112) — 바꿀 수 있을 때만 버튼을 두고, 바꾼 감사는 머리에 "모델 전환: 시작 → 지금 (시각)"과 바꾼 뒤 답한 수를 보인다', async () => {
    expect(await render()).not.toContain('남은 감사 모델 바꾸기');
    mocks.overview.mockResolvedValue(overviewOf({ switchTo: QWEN }));
    const html = await render();
    expect(html).toContain('남은 감사 모델 바꾸기…');
    expect(html).toContain('이 감사 중단');
    expect(html).not.toContain('모델 전환:');

    mocks.overview.mockResolvedValue(overviewOf({ campaign: { ...campaign, currentProvider: 'qwen-direct', currentModel: 'qwen3.8-flash-next',
      switchedAt: new Date('2026-10-21T08:00:00Z'), switchedBy: 'jr' }, counts: { ...counts, answeredByCurrent: 1234 } }));
    mocks.findings.mockResolvedValue([finding(11, 'by-qwen', { aiProvider: 'qwen-direct', confidence: 1 }), finding(12, 'by-gpt', { aiProvider: null })]);
    const switched = await render();
    expect(switched).toContain('모델 전환: gpt-oss-120b → qwen-v2');
    expect(switched).toContain('· jr)');
    expect(switched).toContain('바꾼 뒤 답 1,234건');
    expect(switched).not.toContain('남은 감사 모델 바꾸기…');
    // 줄마다 Qwen 이 낸 답에만 모델 이름을 붙인다
    expect(switched.match(/title="이 답을 낸 감사 모델"[^>]*>qwen-v2</g)).toHaveLength(1);
  });

  it('갈래 그대로 CSV 로 내보낸다', async () => {
    expect(await render({ view: 'needs_review' })).toContain('href="/admin/export?view=audit&amp;format=csv&amp;decision=needs_review"');
  });

  it('판단 보류는 따로 본다', async () => {
    await render({ view: 'needs_review', page: '2' });
    expect(mocks.findings).toHaveBeenCalledWith(7, 'needs_review', { limit: 50, offset: 50 });
  });

  it('진행 상황과 기준을 보이고, 진행 중이면 재감사를 막고 까닭을 말한다', async () => {
    const html = await render();
    expect(html).toContain('감사 #7');
    expect(html).toContain('진행 중');
    expect(html).toContain('2026-09-18.2');
    expect(html).toContain('[MLX] gpt-oss-120b');
    expect(html).toMatch(/검토 <b[^>]*>40<\/b> \/ 100 \(40%\)/);
    expect(html).toContain('이 버튼은 아무것도 내리지 않습니다');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>재감사 시작<\/button>/);
    expect(html).toContain('한 번에 하나만 돕니다');
    expect(html).toContain('이 감사 중단');
  });

  it('기다리는 요청이 있으면 요청 탭부터 열고, 감사 기록은 읽지 않는다', async () => {
    mocks.takedownSummary.mockResolvedValue(takedowns(3));
    const html = await render();
    expect(html).toMatch(/aria-current="page"[^>]*>내려달라는 요청/);
    expect(mocks.takedownQueue).toHaveBeenCalled();
    expect(mocks.findings).not.toHaveBeenCalled();
  });

  it('요청이 있어도 감사 탭이나 보기를 고르면 감사 거절을 연다', async () => {
    mocks.takedownSummary.mockResolvedValue(takedowns(3));
    for (const params of [{ tab: 'audit' }, { view: 'needs_review' }] as Record<string, string>[]) {
      const html = await render(params);
      expect(html).toMatch(/aria-current="page"[^>]*>감사 거절/);
    }
    expect(mocks.takedownQueue).not.toHaveBeenCalled();
    expect(mocks.findings).toHaveBeenCalledTimes(2);
  });

  /** 소개 수정 요청(UX-18) — 내려달라는 요청 아래 따로, 지금 소개와 요청 글을 나란히 */
  it('소개 수정 요청만 기다려도 요청 탭을 열고, 따로 된 목록에 지금 소개·요청·시각·처리 단추를 보인다', async () => {
    mocks.introCount.mockResolvedValue(1);
    mocks.introQueue.mockResolvedValue([{
      id: 5, slug: 'hwp-tool', message: '설치형 CLI 인데 웹 서비스라고 적혀 있습니다', createdAt: '2026-10-11T01:00:00.000Z', ageHours: 3,
      requesterHash: 'abcd1234', product: { name: 'HWP 도구', url: 'https://github.com/acme/hwp', tagline: 'Web service for HWP', status: 'seeded' },
    }]);
    const html = await render();
    expect(html).toMatch(/aria-current="page"[^>]*>내려달라는 요청/);
    expect(html).toMatch(/<span class="td-count">소개 (<!-- -->)?1<\/span>/);
    expect(html).toMatch(/<h2 id="intro-requests-title">소개 수정 요청 (<!-- -->)?1<\/h2>/);
    expect(html).toContain('HWP 도구');
    expect(html).toContain('Web service for HWP');
    expect(html).toContain('설치형 CLI 인데 웹 서비스라고 적혀 있습니다');
    expect(html).toContain('2026-10-11 10:00:00 KST');
    expect(html).toContain('href="/admin/products/hwp-tool"');
    expect(html).toContain('href="/p/hwp-tool"');
    const introForms = forms(html).filter((form) => form.includes('name="id" value="5"'));
    expect(introForms).toHaveLength(2);
    expect(introForms[0]).toMatch(/name="tagline" value="Web service for HWP"/);
    expect(introForms[0]).toContain('>소개 고치기</button>');
    expect(introForms[1]).toMatch(/<button type="submit" value="fixed"[^>]*name="outcome"[^>]*>처리함<\/button>/);
    expect(introForms[1]).toMatch(/<button type="submit" value="dismissed"[^>]*name="outcome"[^>]*>둠<\/button>/);
    expect(mocks.findings).not.toHaveBeenCalled();
  });

  it('내려간 제품의 소개 수정 요청은 고치기 칸 없이 닫기만 둔다', async () => {
    mocks.introCount.mockResolvedValue(1);
    mocks.introQueue.mockResolvedValue([{
      id: 6, slug: 'gone', message: '소개가 틀렸습니다', createdAt: '2026-10-11T01:00:00.000Z', ageHours: 30, requesterHash: null,
      product: { name: '내려간 것', url: 'https://gone.test', tagline: 'old', status: 'banned' },
    }]);
    const html = await render({ tab: 'requests' });
    const introForms = forms(html).filter((form) => form.includes('name="id" value="6"'));
    expect(introForms).toHaveLength(1);
    expect(introForms[0]).not.toContain('name="tagline"');
    expect(html).toContain('지금 고칠 수 없는 제품');
  });

  it('끝난 감사 뒤에는 재감사를 열 수 있다', async () => {
    mocks.overview.mockResolvedValue(overviewOf({ campaign: { ...campaign, status: 'done' } }));
    const html = await render();
    expect(html).toMatch(/<button type="submit"[^>]*>재감사 시작<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>재감사 시작/);
    expect(html).not.toContain('이 감사 중단');
  });
});

describe('감사 보류 화면(0110)', () => {
  it('보류 중인 것이 있으면 그 갈래부터 오래된 것부터 연다 — 줄마다 "보류 중(목록에서 빠짐)"이고 탭에도 수가 붙는다', async () => {
    mocks.overview.mockResolvedValue(overviewOf({ held: 2 }));
    mocks.held.mockResolvedValue([finding(41, 'held-agency', { heldAt: new Date('2026-10-21T01:00:00Z'), reason: 'a consulting agency site' })]);
    mocks.heldReasons.mockResolvedValue([{ id: 41, reason: 'a consulting agency site' }, { id: 42, reason: 'coming soon placeholder' }]);
    const html = await render({ tab: 'audit' });
    expect(mocks.held).toHaveBeenCalledWith({ limit: 50, offset: 0, ids: undefined });
    expect(mocks.findings).not.toHaveBeenCalled();
    expect(mocks.groups).toHaveBeenCalledWith(7, 'held');
    expect(html).toMatch(/aria-current="page"[^>]*>보류 중\(목록에서 빠짐\) (<!-- -->)?2/);
    expect(html).toMatch(/<span class="td-count">보류 (<!-- -->)?2<\/span>/);
    expect(html).toContain('>보류 중(목록에서 빠짐)</span>');
    // 다른 갈래로 가는 주소에는 view 를 싣는다 — 기본 갈래가 보류다
    expect(html).toContain('href="/admin/audit?tab=audit&amp;view=reject"');
    // 패널 — 켬·문턱·허용 갈래·두 번째 모델, 보류 중 수와 갈래별 수
    expect(html).toContain('자동 보류');
    expect(html).toContain('확신 0.95 이상 · 주인 없는 공개 제품 · 갈래 빈 화면·오류·준비 중, 회사·서비스 소개, 남의 플랫폼·목록 페이지, 쇼핑몰·판매');
    expect(html).toContain('두 번째 모델이 승인한 것은 갈래로 걸지 않음');
    expect(html).toContain('두 번째 모델도 거절하면 갈래와 상관없이');
    expect(html).toMatch(/갈래별: (<!-- -->)?빈 화면·오류·준비 중 1 · 회사·서비스 소개 1/);
    // '보류 모두 풀기'(모두·되돌릴 수 없음)는 정책 처리의 고른 보류 풀기로 바뀌었다(0116)
    expect(html).toContain('href="/admin/audit?tab=policy&amp;preset=held"');
    expect(html).toContain('보류 골라 풀기');
    expect(html).not.toContain('>보류 모두 풀기<');
    // 보류 갈래는 CSV 로 내보내지 않는다
    expect(html).not.toContain('format=csv');
  });

  it('보류가 없으면 내릴 후보부터 — 설정 칸은 지금 값으로 그리고, 바꾸기 전에는 저장을 열지 않는다', async () => {
    const html = await render({ tab: 'audit' });
    expect(mocks.held).not.toHaveBeenCalled();
    expect(mocks.findings).toHaveBeenCalledWith(7, 'reject', { limit: 50, offset: 0, ids: undefined, second: undefined });
    const panel = html.slice(html.indexOf('aria-labelledby="audit-hold-title"'), html.indexOf('보류 골라 풀기'));
    expect(panel).toMatch(/name="enabled" checked=""/);
    expect(panel).toMatch(/name="minConfidence" value="0.95"/);
    expect(panel).toMatch(/name="secondOpinionReject" checked=""/);
    for (const key of ['placeholder', 'company', 'platform', 'shop']) expect(panel).toContain(`name="category" checked="" value="${key}"`);
    for (const key of ['login', 'content', 'other']) expect(panel).toContain(`name="category" value="${key}"`);
    // 저장은 확인 창(ConfirmAction)을 거친다 — 바꾼 것이 없으면 열지 않는다
    expect(panel).toMatch(/<button type="button" disabled=""[^>]*>보류 설정 저장…<\/button>/);
    // 보류 갈래 주소는 늘 view=held 를 싣는다
    expect(html).toContain('href="/admin/audit?tab=audit&amp;view=held"');
  });

  it('두 모델 모두 거절·갈림 갈래 — 두 번째 의견으로 거르고, 줄마다 그 의견을 보인다. 모두 거절은 묶어 내리기를 그 무리로', async () => {
    mocks.findings.mockResolvedValue([
      finding(51, 'both', { second: [{ model: 'grok-4-fast', decision: 'reject', confidence: 0.9 }] }),
      finding(52, 'split', { second: [{ model: 'grok-4-fast', decision: 'approve', confidence: 0.8 }] }),
    ]);
    const agreed = await render({ tab: 'audit', view: 'agreed' });
    expect(mocks.findings).toHaveBeenLastCalledWith(7, 'reject', { limit: 50, offset: 0, ids: undefined, second: 'agreed' });
    expect(mocks.reasons).toHaveBeenLastCalledWith(7, 'reject', 'agreed');
    expect(mocks.groups).toHaveBeenLastCalledWith(7, 'agreed');
    expect(agreed).toMatch(/aria-current="page"[^>]*>두 모델 모두 거절 (<!-- -->)?2/);
    expect(agreed).toMatch(/>grok(<!-- -->)?: (<!-- -->)?거절(<!-- -->)? 0.90<\/span>/);
    expect(agreed).toMatch(/>grok(<!-- -->)?: (<!-- -->)?승인(<!-- -->)?<\/span>/);
    expect(agreed).toContain('title="두 번째 의견 · grok-4-fast"');

    mocks.groups.mockClear();
    const split = await render({ tab: 'audit', view: 'split' });
    expect(mocks.findings).toHaveBeenLastCalledWith(7, 'reject', { limit: 50, offset: 0, ids: undefined, second: 'split' });
    expect(split).toMatch(/aria-current="page"[^>]*>갈림 \(2차 승인·카탈로그\) (<!-- -->)?1/);
    // 갈린 것은 사람이 한 건씩 본다 — 묶어 내리기가 없다
    expect(mocks.groups).not.toHaveBeenCalled();
  });

  it('엇갈림·화면 판별 대기 — 줄에 배지를 보이고, 엇갈린 줄은 두 모델의 사유를 펴지 않고도 보인다', async () => {
    mocks.findings.mockResolvedValue([
      finding(71, 'split', { m1Split: true, textLength: 2_400, screenJudged: false, second: [
        { model: 'grok-4.7', decision: 'approve', confidence: 0.9, source: 'grok-cli-batch', reason: 'A usable SaaS landing with sign-up.' },
        { model: 'qwen3.8-flash-next', decision: 'reject', confidence: 0.95, source: 'qwen-v2-auto', reason: 'Only marketing copy.' }] }),
      finding(72, 'thin', { m1Split: false, textLength: 12, screenJudged: false, second: [
        { model: 'qwen3.8-flash-next', decision: 'reject', confidence: 1, source: 'qwen-v2-auto', reason: 'pageText is only the title.' }] }),
      finding(73, 'judged', { m1Split: false, textLength: null, screenJudged: true, second: [] }),
    ]);
    const html = await render({ tab: 'audit', view: 'reject' });
    const row = (slug: string) => html.slice(html.indexOf(`이름 ${slug}`), html.indexOf('</tr>', html.indexOf(`이름 ${slug}`)));
    expect(row('split')).toContain('>엇갈림</span>');
    expect(row('split')).toContain('A usable SaaS landing with sign-up.');
    expect(row('split')).toContain('Only marketing copy.');
    expect(row('split')).not.toContain('화면 판별 대기');
    expect(row('split')).toContain('title="두 번째 의견 · grok-4.7 · grok-cli-batch"');
    // 엇갈리지 않은 줄의 두 번째 의견 사유는 사유를 펼 때만(접힌 첫 화면에는 없다)
    expect(row('thin')).toContain('>화면 판별 대기</span>');
    expect(row('thin')).toMatch(/12(<!-- -->)?자뿐입니다/);
    expect(row('thin')).not.toContain('pageText is only the title.');
    expect(row('thin')).not.toContain('>엇갈림</span>');
    // 화면 판정이 있으면 대기가 아니다
    expect(row('judged')).not.toContain('화면 판별 대기');
  });

  it('Qwen 상태 칸 — 열어 둔 무리(화면 판별 대기·엇갈림)의 수와 정책 처리로 가는 길', async () => {
    mocks.qwenStatus.mockResolvedValue(qwenStatusOf({ screen: { screenWait: 321, screenWaitPublic: 300, split: 45 } }));
    const html = await render({ tab: 'audit' });
    expect(html).toMatch(/화면 판별 대기 <b[^>]*>321<\/b>/);
    expect(html).toMatch(/공개 중 (<!-- -->)?300/);
    expect(html).toMatch(/엇갈림 <b[^>]*>45<\/b>/);
    expect(html).toContain('href="/admin/audit?tab=policy&amp;preset=screen-wait"');
    expect(html).toContain('href="/admin/audit?tab=policy&amp;preset=m1-split"');
    // 수를 못 읽었으면(null) 줄을 그리지 않는다
    mocks.qwenStatus.mockResolvedValue(qwenStatusOf({ screen: null }));
    expect(await render({ tab: 'audit' })).not.toContain('열어 둔 무리');
  });

  it('Qwen 의견 — grok 배지 옆에 qwen 배지, Qwen·grok 의견 다름·Qwen 거절(카탈로그 예외) 갈래로 거른다(묶어 내리기 없음)', async () => {
    mocks.findings.mockResolvedValue([
      finding(61, 'differ', { second: [{ model: 'grok-4.7', decision: 'reject', confidence: 0.9 }, { model: 'qwen3.8-flash-next', decision: 'approve', confidence: 1 }] }),
      finding(62, 'catalog', { reason: 'A curated directory of AI tools.', second: [{ model: 'qwen3.8-flash-next', decision: 'reject', confidence: 0.95 }] }),
    ]);
    const differ = await render({ tab: 'audit', view: 'disagree' });
    expect(mocks.findings).toHaveBeenLastCalledWith(7, 'reject', { limit: 50, offset: 0, ids: undefined, second: 'disagree' });
    expect(mocks.reasons).toHaveBeenLastCalledWith(7, 'reject', 'disagree');
    expect(differ).toMatch(/aria-current="page"[^>]*>Qwen·grok 의견 다름 (<!-- -->)?4/);
    expect(differ).toMatch(/>grok(<!-- -->)?: (<!-- -->)?거절(<!-- -->)? 0.90<\/span>/);
    expect(differ).toMatch(/>qwen(<!-- -->)?: (<!-- -->)?승인(<!-- -->)?<\/span>/);
    expect(differ).toMatch(/>qwen(<!-- -->)?: (<!-- -->)?거절(<!-- -->)? 0.95<\/span>/);
    expect(differ).toContain('title="두 번째 의견 · qwen3.8-flash-next"');
    expect(differ).toContain('href="/admin/audit?tab=audit&amp;view=qwen_catalog"');

    mocks.groups.mockClear();
    const catalog = await render({ tab: 'audit', view: 'qwen_catalog' });
    expect(mocks.findings).toHaveBeenLastCalledWith(7, 'reject', { limit: 50, offset: 0, ids: undefined, second: 'qwen_catalog' });
    expect(catalog).toMatch(/aria-current="page"[^>]*>Qwen 거절\(카탈로그 예외\) (<!-- -->)?5/);
    expect(catalog).toContain('curated list');
    expect(mocks.groups).not.toHaveBeenCalled();
  });

  it('Qwen-v2 자동 단계 — 켬/끔·틱당 수·지난 1시간/24시간·남은 것·마지막 오류를 보이고, 설정 칸을 지금 값으로 그린다', async () => {
    mocks.qwenStatus.mockResolvedValue(qwenStatusOf({ lastError: { code: 'qwen_timeout', detail: null, target: 'audit', at: '2026-10-21T07:00:00.000Z' },
      lastSuccessAt: '2026-10-21T06:59:00.000Z', givenUp: 2 }));
    const qwenAuto = { ...DEFAULT_QWEN_AUTO, auditSecondOpinion: { enabled: true, perTick: 10, scope: 'all' as const, autoClose: true } };
    mocks.overview.mockResolvedValue(overviewOf({ qwenAuto }));
    const html = await render({ tab: 'audit' });
    expect(mocks.qwenStatus).toHaveBeenCalledWith({ auditHold: DEFAULT_AUDIT_HOLD, qwenAuto });
    const panel = html.slice(html.indexOf('aria-label="Qwen-v2 자동 단계"'), html.indexOf('보류 골라 풀기'));
    expect(panel).toMatch(/Qwen-v2 두 번째 의견/);
    expect(panel).toMatch(/지난 1시간 (<!-- -->)?12(<!-- -->)? · 24시간 (<!-- -->)?340/);
    expect(panel).toMatch(/남은 것 <b[^>]*>2,415<\/b>/);
    expect(panel).toMatch(/유지로 닫음 (<!-- -->)?4/);
    expect(panel).toMatch(/남은 것 <b[^>]*>3<\/b>/);
    expect(panel).toContain('qwen3.8-flash-next');
    expect(panel).toContain('2026-10-21.v2');
    expect(panel).toMatch(/마지막 오류: <span class="font-mono">qwen_timeout<\/span>/);
    expect(panel).toContain('감사 두 번째 의견');
    expect(panel).toMatch(/그만 물은 것 (<!-- -->)?2/);
    // 범위·답으로 닫기 — 오늘(UTC) 자동으로 유지·숨긴 수, 실행·되돌리기는 정책 처리로
    expect(panel).toContain('열린 거절 전부');
    expect(panel).toMatch(/답으로 닫기<\/b>/);
    expect(panel).toMatch(/자동 유지 (<!-- -->)?37(<!-- -->)? · (<!-- -->)?자동 숨김 (<!-- -->)?512/);
    expect(panel).toContain('href="/admin/audit?tab=policy"');
    // 스위치는 settings qwenAuto 의 지금 값으로 그린다 — 공개분 거르기는 기본(꺼짐) 그대로
    expect(panel).toMatch(/name="auditSecondOpinion-enabled" checked=""/);
    expect(panel).toMatch(/name="auditSecondOpinion-perTick"[^>]*value="10"/);
    expect(panel).toMatch(/<select name="auditSecondOpinion-scope"[^>]*>[^]*?<option value="all" selected="">열린 거절 전부<\/option>/);
    expect(panel).toMatch(/name="auditSecondOpinion-autoClose" checked=""/);
    expect(panel).toMatch(/name="publishedFilter-enabled"(?! checked)/);
    expect(panel).toMatch(/name="publishedFilter-perTick"[^>]*value="10"/);
    // 바꾸기 전에는 저장을 열지 않는다(확인 창 — 켤 때 사유를 받는다)
    expect(panel.match(/<button type="button" disabled=""[^>]*>저장…<\/button>/g)).toHaveLength(2);
    expect(panel).not.toContain('모두 물러납니다');

    // gpu3090 이 탈 나 모두가 물러나는 중이면 그 시각·코드를 보인다(워커가 적은 운영 관측)
    mocks.qwenStatus.mockResolvedValue(qwenStatusOf({ endpointBackoff: { until: '2026-10-21T07:05:00.000Z', code: 'qwen_http_503', failures: 2 } }));
    const backoff = await render({ tab: 'audit' });
    expect(backoff).toMatch(/모두 물러납니다/);
    expect(backoff).toMatch(/<span class="font-mono">qwen_http_503<\/span>, 연속 (<!-- -->)?2(<!-- -->)?번/);

    // 다른 탭에서는 세지 않는다
    mocks.qwenStatus.mockClear();
    await render({ tab: 'history' });
    expect(mocks.qwenStatus).not.toHaveBeenCalled();
  });
});

describe('화면 판별', () => {
  const screenStatusOf = (over: Record<string, unknown> = {}) => ({ enabled: true, perTick: 2, configured: true, renderHost: '100.70.1.2:8790',
    model: 'qwen3.8-flash-next+vision', shared: true, promptVersion: '2026-10-21.v2+shot1', lastHour: 41, lastDay: 512, approveDay: 250, rejectDay: 262,
    remaining: 406, waitingPublic: 120, givenUp: 3, lastRunAt: '2026-10-22T06:59:00.000Z', lastSuccessAt: '2026-10-22T06:59:00.000Z', lastError: null,
    health: { at: '2026-10-22T06:55:00.000Z', ok: true, version: 'b1f1ba08', sandbox: true, fonts: { ko: true, ja: true, zh: true } },
    backoff: { render: null, model: null }, ...over });

  it('감사 탭에 켬/끔·남은 것·화면 서버 상태(샌드박스·글꼴)와 스위치를 보인다 — 다른 탭에서는 세지 않는다', async () => {
    mocks.screenStatus.mockResolvedValue(screenStatusOf());
    const qwenAuto = { ...DEFAULT_QWEN_AUTO, screenReview: { enabled: true, perTick: 2, autoClose: true } };
    mocks.overview.mockResolvedValue(overviewOf({ qwenAuto }));
    const html = await render({ tab: 'audit' });
    expect(mocks.screenStatus).toHaveBeenCalledWith({ qwenAuto });
    const panel = html.slice(html.indexOf('aria-label="화면 판별"'), html.indexOf('보류 골라 풀기'));
    expect(panel).toMatch(/남은 것 <b[^>]*>406<\/b>\(공개 중 (<!-- -->)?120/);
    expect(panel).toMatch(/승인 (<!-- -->)?250(<!-- -->)? · (<!-- -->)?거절 (<!-- -->)?262/);
    expect(panel).toContain('qwen3.8-flash-next+vision');
    expect(panel).toContain('2026-10-21.v2+shot1');
    expect(panel).toMatch(/샌드박스 (<!-- -->)?켬/);
    expect(panel).toMatch(/한 (<!-- -->)?✓/);
    expect(panel).toMatch(/name="screenReview-enabled" checked=""/);
    expect(panel).toMatch(/name="screenReview-perTick"[^>]*value="2"/);
    expect(panel).toMatch(/name="screenReview-autoClose" checked=""/);

    mocks.screenStatus.mockResolvedValue(screenStatusOf({ health: { at: '2026-10-22T06:55:00.000Z', ok: false, version: null, sandbox: true,
      fonts: { ko: false, ja: true, zh: true } }, backoff: { render: { until: '2026-10-22T07:05:00.000Z', code: 'render_unreachable' }, model: null },
    lastError: { code: 'render_unreachable', stage: 'render', at: '2026-10-22T07:00:00.000Z' } }));
    const broken = await render({ tab: 'audit' });
    expect(broken).toMatch(/그리지 않음/);
    expect(broken).toMatch(/한 (<!-- -->)?✗/);
    expect(broken).toMatch(/물러나는 중: 화면 서버/);
    expect(broken).toMatch(/마지막 오류: <span class="font-mono">render_unreachable<\/span>/);

    mocks.screenStatus.mockClear();
    await render({ tab: 'history' });
    expect(mocks.screenStatus).not.toHaveBeenCalled();
  });
});

describe('내릴 후보 서버 액션', () => {
  const decision = (entries: [string, string][]) => {
    const form = new FormData();
    for (const [key, value] of entries) form.append(key, value);
    return form;
  };

  it('로그인하지 않았으면 아무것도 부르지 않는다', async () => {
    mocks.admin.mockResolvedValue(null);
    expect(await decideAuditFinding(null, decision([['item', '11'], ['slug', 'a'], ['decision', 'remove']]))).toMatchObject({ error: expect.any(String) });
    expect(await startAudit(null, decision([['reason', '다시']]))).toMatchObject({ error: expect.any(String) });
    expect(await cancelAudit()).toMatchObject({ error: expect.any(String) });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('제품을 둘 이상 실은 요청은 내리지 않는다 — 화면 밖에서 만든 요청이어도', async () => {
    const result = await decideAuditFinding(null, decision([
      ['item', '11'], ['slug', 'a'], ['item', '12'], ['slug', 'b'], ['decision', 'remove'],
    ]));
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('내리기와 유지는 로그인한 사람의 이름으로 한 제품에만 적용한다', async () => {
    mocks.remove.mockResolvedValue({ ok: true });
    mocks.keep.mockResolvedValue({ ok: true });
    await decideAuditFinding(null, decision([['item', '11'], ['slug', 'a'], ['decision', 'remove'], ['by', 'forged']]));
    expect(mocks.remove).toHaveBeenCalledWith({ itemId: 11, slug: 'a', by: 'jr' });
    await decideAuditFinding(null, decision([['item', '12'], ['slug', 'b'], ['decision', 'keep'], ['note', '계산기다']]));
    expect(mocks.keep).toHaveBeenCalledWith({ itemId: 12, slug: 'b', by: 'jr', note: '계산기다' });
  });

  it('묶어 내리기 — 로그인·50건 한도를 지키고, 한 건마다 내리기 기록을 남긴다', async () => {
    const group = (count: number) => decision([['group', 'Commerce'], ...Array.from({ length: count }, (_, i) =>
      [['item', String(100 + i)], ['slug', `s-${i}`]] as [string, string][]).flat()]);
    mocks.admin.mockResolvedValueOnce(null);
    expect(await removeAuditGroup(group(2))).toMatchObject({ error: expect.any(String) });
    expect(await removeAuditGroup(group(51))).toMatchObject({ error: expect.stringContaining('50건') });
    expect(mocks.removeMany).not.toHaveBeenCalled();

    mocks.removeMany.mockResolvedValue({ removed: ['s-0'], failed: [{ slug: 's-1', error: '이미 처리됐거나' }] });
    expect(await removeAuditGroup(group(2))).toEqual({ removed: 1, failed: 1 });
    expect(mocks.removeMany).toHaveBeenCalledWith({ items: [{ itemId: 100, slug: 's-0' }, { itemId: 101, slug: 's-1' }], by: 'jr', scope: 'reject' });
    expect(mocks.log).toHaveBeenCalledWith('jr', [
      expect.objectContaining({ action: 'audit-remove', target: 's-0', ok: true, detail: expect.objectContaining({ group: 'Commerce', scope: 'reject', bulk: 2 }) }),
      expect.objectContaining({ action: 'audit-remove', target: 's-1', ok: false }),
    ]);

    // 범위를 실어 보내면 서버가 잠근 뒤 그 범위를 다시 본다 — 모르는 범위는 아무것도 내리지 않는다
    const held = group(1);
    held.set('scope', 'held');
    await removeAuditGroup(held);
    expect(mocks.removeMany).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'held' }));
    const forged = group(1);
    forged.set('scope', 'everything');
    mocks.removeMany.mockClear();
    expect(await removeAuditGroup(forged)).toMatchObject({ error: expect.any(String) });
    expect(mocks.removeMany).not.toHaveBeenCalled();
  });

  it('멈춘 감사 다시 열기 — 그 감사를 바꿔 여는 한 번의 시작이고, 중단과 시작을 각각 남긴다', async () => {
    mocks.start.mockResolvedValueOnce({ ok: false, error: '이미 중단됐거나 지금 글로 도는 감사입니다.' });
    expect(await restartStalledAudit(decision([['campaign', '7'], ['reason', '글 바뀜']]))).toMatchObject({ error: expect.any(String) });
    expect(mocks.log).toHaveBeenLastCalledWith('jr', [expect.objectContaining({ action: 'audit-start', ok: false })]);

    mocks.start.mockResolvedValueOnce({ ok: true, campaignId: 8, enrolled: 10, keptSkipped: 0 });
    expect(await restartStalledAudit(decision([['campaign', '7'], ['reason', `글 ${REVIEW_PROMPT_VERSION}`]]))).toMatchObject({ message: expect.stringContaining('#8') });
    expect(mocks.start).toHaveBeenLastCalledWith({ startedBy: 'jr', reason: `글 ${REVIEW_PROMPT_VERSION}`, reauditKept: false, replacing: 7 });
    expect(mocks.log).toHaveBeenLastCalledWith('jr', [
      expect.objectContaining({ action: 'audit-cancel', target: 'campaign:7' }),
      expect.objectContaining({ action: 'audit-start', target: 'campaign:8' }),
    ]);
  });

  it('남은 감사 모델 바꾸기 — 로그인한 사람으로, 화면이 본 심사자와 사유를 함께 보낸다. 감사를 읽지 못하면 부르지 않는다', async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await switchAuditModel(decision([['campaign', '7'], ['expectedProvider', 'abcllm'], ['expectedModel', '[MLX] gpt-oss-120b'], ['reason', '빨리']])))
      .toMatchObject({ error: expect.any(String) });
    expect(await switchAuditModel(decision([['campaign', 'x'], ['expectedProvider', 'abcllm'], ['expectedModel', 'm'], ['reason', '빨리']])))
      .toMatchObject({ error: expect.stringContaining('새로고침') });
    expect(mocks.switchReviewer).not.toHaveBeenCalled();

    mocks.switchReviewer.mockResolvedValueOnce({ ok: false, error: '그 사이 다른 곳에서 바뀌었습니다.' });
    expect(await switchAuditModel(decision([['campaign', '7'], ['expectedProvider', 'abcllm'], ['expectedModel', '[MLX] gpt-oss-120b'], ['reason', '']])))
      .toEqual({ error: '그 사이 다른 곳에서 바뀌었습니다.' });
    mocks.switchReviewer.mockResolvedValueOnce({ ok: true, from: { provider: 'abcllm', model: '[MLX] gpt-oss-120b' }, to: QWEN, unanswered: 15_300 });
    expect(await switchAuditModel(decision([['campaign', '7'], ['expectedProvider', 'abcllm'], ['expectedModel', '[MLX] gpt-oss-120b'], ['reason', '빨리']])))
      .toEqual({ message: expect.stringContaining('남은 15,300건을 qwen-v2') });
    expect(mocks.switchReviewer).toHaveBeenLastCalledWith({ campaignId: 7, expected: { provider: 'abcllm', model: '[MLX] gpt-oss-120b' },
      reason: '빨리', by: 'jr' });
    expect(mocks.revalidate).toHaveBeenCalledWith('/admin/audit');
  });

  it('보류 설정 — 로그인한 사람으로, 화면이 본 값과 함께 보낸다. 문턱이 0.80 아래면 쓰지 않는다', async () => {
    const expected = JSON.stringify(DEFAULT_AUDIT_HOLD);
    mocks.setHold.mockResolvedValue({ ok: true, auditHold: { ...DEFAULT_AUDIT_HOLD, enabled: false } });
    expect(await saveAuditHold(null, decision([['expected', expected], ['minConfidence', '0.97'], ['category', 'company'], ['category', 'company'],
      ['category', 'constructor'], ['reason', '오탐 확인']]))).toMatchObject({ message: expect.stringContaining('이미 건 보류는 남아') });
    // 감사 보류는 origin/main 모양 그대로 — Qwen-v2 자동 단계는 이 폼이 쓰지 않는다(settings qwenAuto, 따로 setter)
    expect(mocks.setHold).toHaveBeenCalledWith({ next: { enabled: false, minConfidence: 0.97, categories: ['company'], secondOpinionReject: false },
      expected: DEFAULT_AUDIT_HOLD, actor: 'jr', reason: '오탐 확인' });

    mocks.setHold.mockClear();
    expect(await saveAuditHold(null, decision([['expected', expected], ['enabled', 'on'], ['minConfidence', '0.5']]))).toMatchObject({ error: expect.any(String) });
    expect(await saveAuditHold(null, decision([['expected', '{'], ['enabled', 'on'], ['minConfidence', '0.95']]))).toMatchObject({ error: expect.any(String) });
    mocks.admin.mockResolvedValueOnce(null);
    expect(await saveAuditHold(null, decision([['expected', expected], ['minConfidence', '0.95']]))).toMatchObject({ error: expect.any(String) });
    expect(mocks.setHold).not.toHaveBeenCalled();

    mocks.setHold.mockResolvedValue({ ok: false, issues: ['그 사이 다른 곳에서 바뀌었습니다.'] });
    expect(await saveAuditHold(null, decision([['expected', expected], ['enabled', 'on'], ['minConfidence', '0.95']])))
      .toEqual({ error: '그 사이 다른 곳에서 바뀌었습니다.' });
  });

  it('Qwen-v2 자동 단계 스위치 — 로그인한 사람으로, 화면이 본 값·사유와 함께 그 단계만 보낸다', async () => {
    const off = JSON.stringify({ enabled: false, perTick: 10 }), on = JSON.stringify({ enabled: true, perTick: 5 });
    mocks.setQwenAuto.mockResolvedValue({ ok: true, step: 'auditSecondOpinion', before: { enabled: false, perTick: 10 }, after: { enabled: true, perTick: 5 }, dryRun: false });
    expect(await saveQwenAutoStep(null, decision([['step', 'auditSecondOpinion'], ['next', on], ['expected', off], ['reason', '적체 회복']])))
      .toEqual({ message: expect.stringContaining('켰습니다') });
    expect(mocks.setQwenAuto).toHaveBeenCalledWith({ step: 'auditSecondOpinion', next: { enabled: true, perTick: 5 }, expected: { enabled: false, perTick: 10 },
      actor: 'jr', reason: '적체 회복' });
    expect(mocks.revalidate).toHaveBeenCalledWith('/admin/audit');

    mocks.setQwenAuto.mockClear();
    expect(await saveQwenAutoStep(null, decision([['step', 'review'], ['next', on], ['expected', off]]))).toMatchObject({ error: expect.any(String) });
    expect(await saveQwenAutoStep(null, decision([['step', 'auditSecondOpinion'], ['next', '{'], ['expected', off]]))).toMatchObject({ error: expect.any(String) });
    mocks.admin.mockResolvedValueOnce(null);
    expect(await saveQwenAutoStep(null, decision([['step', 'auditSecondOpinion'], ['next', on], ['expected', off]]))).toMatchObject({ error: expect.any(String) });
    expect(mocks.setQwenAuto).not.toHaveBeenCalled();

    // 켜는 바꿈의 사유·compare-and-set 은 setter 가 가른다 — 그 말을 그대로 돌려준다
    mocks.setQwenAuto.mockResolvedValue({ ok: false, issues: ['사람 없이 정하는 일을 켜는 바꿈은 까닭을 적어야 합니다.'] });
    expect(await saveQwenAutoStep(null, decision([['step', 'splitTiebreak'], ['next', on], ['expected', off], ['reason', '']])))
      .toEqual({ error: '사람 없이 정하는 일을 켜는 바꿈은 까닭을 적어야 합니다.' });
  });

  it('보류 모두 풀기 액션은 없다 — 고른 보류 풀기는 정책 처리(policy-actions.ts)의 실행으로 하고 되돌릴 수 있다', () => {
    expect('releaseAuditHolds' in auditActions).toBe(false);
  });

  it('재감사는 체크박스를 켰을 때만 유지 판정까지 다시 본다', async () => {
    mocks.start.mockResolvedValue({ ok: true, campaignId: 8, enrolled: 10, keptSkipped: 2 });
    await startAudit(null, decision([['reason', '기준이 엄격해짐']]));
    expect(mocks.start).toHaveBeenLastCalledWith({ startedBy: 'jr', reason: '기준이 엄격해짐', reauditKept: false });
    await startAudit(null, decision([['reason', '기준이 엄격해짐'], ['reauditKept', 'on']]));
    expect(mocks.start).toHaveBeenLastCalledWith({ startedBy: 'jr', reason: '기준이 엄격해짐', reauditKept: true });
  });
});

describe('소개 수정 요청 서버 액션', () => {
  const form = (entries: [string, string][]) => {
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    return data;
  };

  it('로그인하지 않았으면 아무것도 고치지 않는다', async () => {
    mocks.admin.mockResolvedValue(null);
    expect(await fixIntroRequest(null, form([['id', '5'], ['slug', 'a'], ['tagline', '새 소개']]))).toMatchObject({ error: expect.any(String) });
    expect(await resolveIntroRequestAction(null, form([['id', '5'], ['slug', 'a'], ['outcome', 'fixed']]))).toMatchObject({ error: expect.any(String) });
    expect(mocks.introFix).not.toHaveBeenCalled();
    expect(mocks.introResolve).not.toHaveBeenCalled();
  });

  it('소개 고치기는 로그인한 사람 이름으로 고치고 전·후 소개를 작업 로그에 남긴다', async () => {
    mocks.introFix.mockResolvedValue({ slug: 'a', before: '옛 소개', closed: [5, 7] });
    const result = await fixIntroRequest(null, form([['id', '5'], ['slug', 'a'], ['tagline', '  새 소개  ']]));
    expect(mocks.introFix).toHaveBeenCalledWith(5, '새 소개', 'jr');
    expect(mocks.log).toHaveBeenCalledWith('jr', expect.objectContaining({ action: 'intro-request-edit', target: 'a', ok: true,
      detail: { requestId: 5, closed: [5, 7], before: '옛 소개', after: '새 소개' } }));
    expect(result).toEqual({ message: '소개를 고치고 요청 2건을 닫았습니다.' });
    expect(mocks.revalidate).toHaveBeenCalledWith('/p/a');
  });

  it('빈 소개·너무 긴 소개·번호가 둘인 폼은 고치지 않는다', async () => {
    expect(await fixIntroRequest(null, form([['id', '5'], ['slug', 'a'], ['tagline', '  ']]))).toMatchObject({ error: expect.any(String) });
    expect(await fixIntroRequest(null, form([['id', '5'], ['slug', 'a'], ['tagline', 'x'.repeat(201)]]))).toMatchObject({ error: expect.any(String) });
    expect(await fixIntroRequest(null, form([['id', '5'], ['id', '6'], ['slug', 'a'], ['tagline', '새 소개']]))).toMatchObject({ error: expect.any(String) });
    expect(mocks.introFix).not.toHaveBeenCalled();
  });

  it('이미 처리된 요청이면 실패로 기록하고 알린다', async () => {
    mocks.introFix.mockResolvedValue(null);
    expect(await fixIntroRequest(null, form([['id', '5'], ['slug', 'a'], ['tagline', '새 소개']]))).toMatchObject({ error: expect.any(String) });
    expect(mocks.log).toHaveBeenCalledWith('jr', expect.objectContaining({ action: 'intro-request-edit', ok: false, error: 'stale' }));
  });

  it('처리함·둠은 고른 결과만 받고 작업 로그에 남긴다', async () => {
    mocks.introResolve.mockResolvedValue({ id: 5, slug: 'a' });
    expect(await resolveIntroRequestAction(null, form([['id', '5'], ['slug', 'a'], ['outcome', 'dismissed'], ['note', '맞는 소개']])))
      .toEqual({ message: '두었습니다.' });
    expect(mocks.introResolve).toHaveBeenCalledWith(5, 'dismissed', 'jr', '맞는 소개');
    expect(mocks.log).toHaveBeenCalledWith('jr', expect.objectContaining({ action: 'intro-request-dismissed', target: 'a', ok: true }));

    expect(await resolveIntroRequestAction(null, form([['id', '5'], ['slug', 'a'], ['outcome', 'removed']]))).toMatchObject({ error: expect.any(String) });
    expect(mocks.introResolve).toHaveBeenCalledTimes(1);
  });
});
