import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), redirect: vi.fn(), log: vi.fn(), facets: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/operations/admin-log', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/operations/admin-log')>(), adminLog: mocks.log, adminLogFacets: mocks.facets,
}));

import AdminActivityPage from '@/app/admin/activity/page';
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
    expect(html).not.toMatch(/<form|<button|삭제|지우기/);
  });

  it('갈래·실패만·처리자로 거르고 오래된 쪽으로 넘긴다', async () => {
    await render({ group: 'takedown', failed: '1', actor: 'local', before: '50' });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ failedOnly: true, actor: 'local', before: 50,
      actions: expect.arrayContaining(['takedown-remove', 'product-ban']) }));
    await render({ group: 'constructor', before: '-1' });
    expect(mocks.log).toHaveBeenLastCalledWith(expect.objectContaining({ actions: undefined, before: undefined }));
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
