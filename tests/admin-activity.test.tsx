import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), redirect: vi.fn(), log: vi.fn(), facets: vi.fn(), local: vi.fn(), operator: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin, adminLocalLoginEnabled: mocks.local, localOperatorName: mocks.operator, OPERATOR_NAME_MAX: 40 }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/operations/admin-log', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/operations/admin-log')>(), adminLogFacets: mocks.facets,
}));
vi.mock('@/app/admin/activity/query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/admin/activity/query')>(), activityLog: mocks.log,
}));

import AdminActivityPage from '@/app/admin/activity/page';
import { actionLabel, targetLabel } from '@/app/admin/activity/labels';
import { normalizeTarget } from '@/app/admin/activity/query';
import { isScriptRow, summaryLine } from '@/app/admin/activity/summary';
import { actorKind, settingsChanges } from '@/lib/operations/admin-log';

const row = (id: number, patch: Record<string, unknown> = {}) => ({
  id, actor: 'local', actorKind: 'local', ip: '203.0.113.7', userAgent: 'Mozilla/5.0', action: 'takedown-remove', target: `slug-${id}`,
  detail: { requestReason: '내려 주세요' }, ok: true, error: null, createdAt: new Date('2026-10-05T07:32:54Z'), ...patch,
});
const render = async (searchParams: Record<string, string> = {}) =>
  renderToStaticMarkup(await AdminActivityPage({ searchParams: Promise.resolve(searchParams) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.local.mockReturnValue(false);
  mocks.operator.mockResolvedValue(null);
  mocks.log.mockResolvedValue([row(3), row(2, { action: 'settings-save', target: 'crawl_settings', actorKind: 'github', actor: 'jr', ip: null,
    detail: { changes: [{ path: 'judge.minStars', before: 0, after: 7 }] } }), row(1, { ok: false, error: 'not_found', action: 'product-ban' })]);
  mocks.facets.mockResolvedValue({ actions: [{ action: 'takedown-remove', count: 1 }, { action: 'settings-save', count: 1 }, { action: 'product-ban', count: 1 }],
    actors: [{ actor: 'local', count: 2 }, { actor: 'jr', count: 1 }] });
});

describe('작업 로그 화면', () => {
  it('로그아웃 상태면 기록을 읽기 전에 로그인으로 보낸다', async () => {
    mocks.admin.mockResolvedValue(null);
    mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
    await expect(render()).rejects.toThrow('redirect:/admin/login');
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('누가·어디서·무엇을·결과를 보이고, 고치거나 지우는 수단이 없다', async () => {
    const html = await render();
    expect(html).toContain('요청으로 내림');
    expect(html).toContain('로컬 로그인');
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('judge.minStars: 0 → 7');
    expect(html).toContain('실패');
    expect(html).toContain('not_found');
    expect(html).not.toMatch(/삭제|지우기/);
    // 폼·버튼은 대상 찾기(GET) 하나뿐이다 — 로컬 로그인이 아니면 이름 칸도 없다
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html.match(/<button[^>]*>[^<]*/g)).toEqual([expect.stringMatching(/type="submit".*>찾기$/)]);
    expect(html).toMatch(/<form[^>]*action="\/admin\/activity"/);
  });

  it('브라우저 정보는 아이콘 툴팁으로 접고, 내용은 한 줄 요약 뒤에 펼친다', async () => {
    const html = await render();
    expect(html).toMatch(/title="203\.0\.113\.7 · Mozilla\/5\.0"/);
    expect(html).toContain('<details');
    expect(html).toContain('href="/admin/export?view=activity&amp;format=csv"');
  });

  it('스크립트 일괄 줄은 "스크립트" 배지와 "N건 · 이유"로, 테이블 이름은 한국어로 보인다', async () => {
    mocks.log.mockResolvedValue([row(9, { actor: 'claude-code', actorKind: 'local', ip: null, userAgent: null, action: 'ban-spam-campaign',
      target: 'products', detail: { count: 237, slugs: Array.from({ length: 237 }, (_, i) => `s${i}`), reason: '악성코드 유포 캠페인' } })]);
    const html = await render();
    expect(html).toContain('스크립트');
    expect(html).toContain('237건 · 악성코드 유포 캠페인');
    expect(html).toContain('스팸 캠페인 일괄 차단');
    expect(html).toContain('제품 여러 건');
    expect(html).not.toContain('>products<');
  });

  it('로컬 로그인이면 "내 이름" 칸을 둔다', async () => {
    mocks.local.mockReturnValue(true);
    mocks.operator.mockResolvedValue('지우');
    const html = await render();
    expect(html).toContain('내 이름');
    expect(html).toMatch(/name="name"[^>]*value="지우"|value="지우"[^>]*name="name"/);
  });

  it('갈래·실패만·처리자·대상으로 거르고 오래된 쪽으로 넘긴다', async () => {
    const html = await render({ group: 'takedown', failed: '1', actor: 'local', before: '50', target: ' https://github.com/Acme/Tool.git ' });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ failedOnly: true, actor: 'local', before: 50, target: 'Acme/Tool',
      actions: expect.arrayContaining(['takedown-remove', 'product-ban']) }));
    // 대상 칸에 지금 대상이, 쪽 넘김 링크에도 대상이 이어진다
    expect(html).toContain('value="Acme/Tool"');
    expect(html).toContain('target=Acme%2FTool');
    await render({ group: 'constructor', before: '-1' });
    expect(mocks.log).toHaveBeenLastCalledWith(expect.objectContaining({ actions: undefined, before: undefined }));
  });

  it('id 열(serial, int4) 범위를 넘는 before 는 버린다 — DB 가 범위 오류로 화면을 깨뜨린다', async () => {
    await render({ before: '99999999999' });
    expect(mocks.log).toHaveBeenLastCalledWith(expect.objectContaining({ before: undefined }));
    await render({ before: '2147483647' });
    expect(mocks.log).toHaveBeenLastCalledWith(expect.objectContaining({ before: 2147483647 }));
  });
});

describe('작업 로그 도우미', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('설정은 바뀐 경로만 전과 후로 남긴다 — 배열은 통째로', () => {
    expect(settingsChanges({ a: { b: 1, c: [1, 2] }, d: true }, { a: { b: 2, c: [1, 2] }, d: true, e: 'new' })).toEqual([
      { path: 'a.b', before: 1, after: 2 }, { path: 'e', before: null, after: 'new' },
    ]);
    expect(settingsChanges({ q: [{ x: 1 }] }, { q: [{ x: 2 }] })).toEqual([{ path: 'q', before: [{ x: 1 }], after: [{ x: 2 }] }]);
  });

  it('로컬 로그인이 켜졌을 때의 local 만 로컬로 본다', () => {
    vi.stubEnv('ADMIN_LOCAL_LOGIN', '0');
    expect(actorKind('local')).toBe('github');
    vi.stubEnv('ADMIN_LOCAL_LOGIN', '1');
    expect(actorKind('local')).toBe('local');
    expect(actorKind('jr')).toBe('github');
  });
});

describe('작업 로그 표기', () => {
  it('대상 — GitHub 주소는 owner/repo 로 줄이고, 테이블 이름·접두어는 한국어로', () => {
    expect(normalizeTarget('https://github.com/acme/tool/')).toBe('acme/tool');
    expect(normalizeTarget('  my-slug ')).toBe('my-slug');
    expect(normalizeTarget(undefined)).toBe('');
    expect(targetLabel('crawl_candidates')).toEqual({ text: '수집 후보 여러 건', entity: false });
    expect(targetLabel('campaign:3')).toEqual({ text: '감사 #3', entity: false });
    expect(targetLabel('export:review')).toEqual({ text: '내보내기 · 심사 큐', entity: false });
    expect(targetLabel('acme/tool')).toEqual({ text: 'acme/tool', entity: true });
  });

  it('스크립트가 남기는 작업에도 이름이 있다', () => {
    for (const action of ['requeue-evidence-gated', 'ban-spam-campaign', 'relabel-repo-deleted', 'requeue-rejected-under-new-policy',
      'reconcile-crawl-duplicate', 'export', 'operator-name']) expect(actionLabel(action)).not.toBe(action);
  });

  it('여러 건 줄은 건수와 이유만, 원시 id 목록은 보이지 않는다', () => {
    const base = { ip: null, userAgent: null };
    expect(summaryLine({ ...base, detail: { count: 3, ids: [1, 2, 3], from: 'source_refresh_failed', to: 'repo_deleted' } }))
      .toBe('3건 · source_refresh_failed → repo_deleted');
    expect(summaryLine({ ...base, detail: { requeued: 12, planned: 20 } })).toBe('12건');
    expect(summaryLine({ ...base, detail: { ids: [5, 6], changed: 2 } })).toBe('2건');
    expect(summaryLine({ ...base, detail: {} })).toBe('—');
    expect(isScriptRow(base)).toBe(true);
    expect(isScriptRow({ ip: '203.0.113.7', userAgent: null })).toBe(false);
  });
});
