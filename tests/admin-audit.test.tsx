import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), redirect: vi.fn(), revalidate: vi.fn(),
  overview: vi.fn(), findings: vi.fn(), start: vi.fn(), cancel: vi.fn(), remove: vi.fn(), keep: vi.fn(),
  groups: vi.fn(), removeMany: vi.fn(), translations: vi.fn(), log: vi.fn(),
  takedownSummary: vi.fn(), takedownQueue: vi.fn(), takedownHistory: vi.fn(),
}));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/crawl/product-audit', () => ({
  productAuditOverview: mocks.overview, listAuditFindings: mocks.findings, startProductAudit: mocks.start,
  cancelProductAudit: mocks.cancel, removeAuditedProduct: mocks.remove, keepAuditedProduct: mocks.keep,
  auditRemovalGroups: mocks.groups, removeAuditedProducts: mocks.removeMany,
  GROUP_REMOVE_MAX: 50, GROUP_REMOVE_MIN_CONFIDENCE: 0.95,
}));
vi.mock('@/lib/crawl/translations', () => ({ translationsFor: mocks.translations }));
vi.mock('@/lib/operations/admin-log', () => ({ recordAdminAction: mocks.log, recordAdminActions: mocks.log }));
// 내려달라는 요청 집계도 DB를 읽는다 — CI 단위 테스트에는 DB가 없다
vi.mock('@/lib/domain/products/takedown', () => ({
  takedownSummary: mocks.takedownSummary, takedownQueue: mocks.takedownQueue, takedownHistory: mocks.takedownHistory,
}));

import AdminAuditPage from '@/app/admin/audit/page';
import { cancelAudit, decideAuditFinding, removeAuditGroup, restartStalledAudit, startAudit } from '@/app/admin/audit/actions';
import { REVIEW_PROMPT_VERSION } from '@/lib/crawl/agent-review-contract';

const campaign = {
  id: 7, startedAt: new Date('2026-09-18T12:00:00Z'), startedBy: 'jr', reason: '첫 감사', promptVersion: '2026-09-18.2',
  rulesVersion: '2026-09-18.1', provider: 'abcllm', model: '[MLX] gpt-oss-120b', reauditKept: false, status: 'running', finishedAt: null,
};
const counts = { total: 100, reviewed: 40, reject: 3, needsReview: 1, openReject: 3, openNeedsReview: 1, removed: 0, kept: 0, failed: 0, skipped: 0 };
const finding = (id: number, slug: string) => ({
  id, slug, name: `이름 ${slug}`, url: `https://${slug}.test`, category: 'Productivity',
  reason: 'pageText shows only a sign-in form', confidence: 0.95, reviewedAt: new Date('2026-09-18T12:30:00Z'), owned: false,
});
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
  mocks.overview.mockResolvedValue({ campaign, counts, paused: null, stalled: false });
  mocks.findings.mockResolvedValue([finding(11, 'login-wall'), finding(12, 'docs-site'), finding(13, 'agency')]);
  mocks.groups.mockResolvedValue([]);
  mocks.translations.mockResolvedValue(new Map());
  mocks.takedownSummary.mockResolvedValue(takedowns(0));
  mocks.takedownQueue.mockResolvedValue([]);
  mocks.takedownHistory.mockResolvedValue([]);
});

describe('내릴 후보 화면', () => {
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
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toMatch(/type="checkbox"[^>]*name="reauditKept"/);
    expect(forms(html).find((form) => form.includes('type="checkbox"'))).not.toContain('name="slug"');
    // 다른 폼으로 값을 실어 보내는 form 속성(재검수 화면의 일괄 차단 방식)도 없다
    expect(html).not.toMatch(/\sform="/);
    expect(html).not.toMatch(/전체 선택|모두 선택|일괄|선택 차단|모두 내리기|선택한 것/);
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
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    // 판단 보류에는 묶음이 없다
    mocks.groups.mockClear();
    expect(await render({ view: 'needs_review' })).not.toContain('묶어 내리기');
    expect(mocks.groups).not.toHaveBeenCalled();
  });

  it('심사 글이 바뀌어 멈춘 감사는 "진행 중"이 아니라 "멈춤 · 사람 필요"이고, 중단 → 새 감사 버튼 하나를 둔다', async () => {
    mocks.overview.mockResolvedValue({ campaign, counts, paused: '두 글의 판단을 섞지 않도록 멈췄습니다', stalled: true });
    const html = await render();
    expect(html).toContain('멈춤 · 사람 필요');
    expect(html).not.toMatch(/>진행 중</);
    expect(html).toContain('이 감사 중단 → 새 감사 시작');
    // 따로 노는 "이 감사 중단" 폼은 두지 않는다
    expect(html).not.toContain('멈춰도 아무것도 내려가지 않고');
    expect(html).toContain('멈춘 감사가 열려 있습니다');
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

  it('끝난 감사 뒤에는 재감사를 열 수 있다', async () => {
    mocks.overview.mockResolvedValue({ campaign: { ...campaign, status: 'done' }, counts, paused: null, stalled: false });
    const html = await render();
    expect(html).toMatch(/<button type="submit"[^>]*>재감사 시작<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>재감사 시작/);
    expect(html).not.toContain('이 감사 중단');
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
    expect(mocks.removeMany).toHaveBeenCalledWith({ items: [{ itemId: 100, slug: 's-0' }, { itemId: 101, slug: 's-1' }], by: 'jr' });
    expect(mocks.log).toHaveBeenCalledWith('jr', [
      expect.objectContaining({ action: 'audit-remove', target: 's-0', ok: true, detail: expect.objectContaining({ group: 'Commerce', bulk: 2 }) }),
      expect.objectContaining({ action: 'audit-remove', target: 's-1', ok: false }),
    ]);
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

  it('재감사는 체크박스를 켰을 때만 유지 판정까지 다시 본다', async () => {
    mocks.start.mockResolvedValue({ ok: true, campaignId: 8, enrolled: 10, keptSkipped: 2 });
    await startAudit(null, decision([['reason', '기준이 엄격해짐']]));
    expect(mocks.start).toHaveBeenLastCalledWith({ startedBy: 'jr', reason: '기준이 엄격해짐', reauditKept: false });
    await startAudit(null, decision([['reason', '기준이 엄격해짐'], ['reauditKept', 'on']]));
    expect(mocks.start).toHaveBeenLastCalledWith({ startedBy: 'jr', reason: '기준이 엄격해짐', reauditKept: true });
  });
});
