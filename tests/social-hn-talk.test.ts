import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { githubLinkTarget, hnDiscoverUrl, hnLookupUrl, hnTalkPost, HN_LOOKUP_BATCH } from '@/lib/social/hn-talk-source';
import { collectHnTalk, HN_TALK_MIN_POINTS, HN_TALK_WINDOW_MS, type HnTalkCursor } from '@/lib/social/hn-talk';
import type { CappedRequest } from '@/lib/net/fetch';

const mocks = vi.hoisted(() => ({
  record: vi.fn(), missing: vi.fn(), gone: vi.fn(), expire: vi.fn(), settings: null as CrawlSettings | null,
}));
vi.mock('@/lib/social/repository', () => ({
  recordSocialPosts: mocks.record, postsMissingSince: mocks.missing,
  markSocialPostsGone: mocks.gone, deleteExpiredSocialPosts: mocks.expire,
}));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));
// 모의 응답에도 URL 검사는 DNS 를 묻는다 — 공개 IP로 고정하고 나머지 검사는 그대로 탄다(crawl-hn-show.test.ts 와 같다)
vi.mock('node:dns', async original => {
  const actual = await original<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: vi.fn().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]) } };
});

const NOW = new Date('2026-10-20T06:00:00Z');
const context = (hasBudget = () => true) =>
  ({ cursor: null as HnTalkCursor | null, hasBudget, save: vi.fn().mockResolvedValue(undefined), log: vi.fn() });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hit = (id: string, url: string | null, extra: Record<string, unknown> = {}) =>
  ({ objectID: id, created_at_i: 1_792_400_000, url, title: `Post ${id}`, points: 40, num_comments: 7, _tags: ['story'], ...extra });

beforeEach(() => {
  mocks.record.mockReset().mockResolvedValue({ inserted: 1, updated: 0, observed: 1 });
  mocks.missing.mockReset().mockResolvedValue([]);
  mocks.gone.mockReset().mockImplementation(async (ids: number[]) => ids.length);
  mocks.expire.mockReset().mockResolvedValue(0);
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true };
});

it('GitHub 저장소를 가리킨 글만 남기고, Show HN 과 첫 화면 여부를 읽는다', () => {
  expect(hnTalkPost(hit('1', 'https://github.com/Shaongitbd/Doory', { _tags: ['story', 'show_hn', 'front_page'] }))).toEqual({
    externalId: '1', kind: 'show', title: 'Post 1', linkUrl: 'https://github.com/Shaongitbd/Doory', linkTarget: 'repo',
    repositoryKey: 'shaongitbd/doory', postedAt: new Date(1_792_400_000_000), points: 40, comments: 7, frontPage: true,
  });
  expect(hnTalkPost(hit('2', 'https://github.com/golang/go/issues/82345'))).toMatchObject({ kind: 'link', linkTarget: 'issue', repositoryKey: 'golang/go' });
  // 제품 사이트·사용자 페이지는 저장소를 알 수 없다 — 추측하지 않는다
  expect(hnTalkPost(hit('3', 'https://doory.art'))).toBeNull();
  expect(hnTalkPost(hit('4', 'https://github.com/acme'))).toBeNull();
  expect(hnTalkPost(hit('5', null))).toBeNull();
  // 제목 없는 글은 보여 줄 것이 없다
  expect(hnTalkPost(hit('6', 'https://github.com/acme/app', { title: '   ' }))).toBeNull();
  // 점수·댓글이 비어 오면 0으로 둔다
  expect(hnTalkPost(hit('7', 'https://github.com/acme/app', { points: null, num_comments: undefined }))).toMatchObject({ points: 0, comments: 0 });
});

it('저장소 안의 어디를 가리키는지 나눈다', () => {
  expect(githubLinkTarget('https://github.com/acme/app')).toBe('repo');
  expect(githubLinkTarget('https://github.com/acme/app/tree/main/src')).toBe('repo');
  expect(githubLinkTarget('https://github.com/acme/app/blob/main/README.md')).toBe('repo');
  expect(githubLinkTarget('https://github.com/acme/app/pull/12')).toBe('pull');
  expect(githubLinkTarget('https://github.com/acme/app/releases/tag/v1')).toBe('path');
  expect(githubLinkTarget('https://github.com.evil.example/acme/app')).toBeNull();
});

it('검색 주소는 72시간 창·점수 하한·주소 제한을 건다', () => {
  const url = new URL(hnDiscoverUrl(1_792_000_000, HN_TALK_MIN_POINTS, 2));
  expect(url.origin + url.pathname).toBe('https://hn.algolia.com/api/v1/search_by_date');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    query: 'github.com', restrictSearchableAttributes: 'url', tags: 'story',
    numericFilters: `created_at_i>=1792000000,points>=${HN_TALK_MIN_POINTS}`, hitsPerPage: '100', page: '2',
  });
  expect(new URL(hnLookupUrl(['11', '12'])).searchParams.get('tags')).toBe('story,(story_11,story_12)');
  expect(() => hnLookupUrl([])).toThrow('hn_lookup_batch');
  expect(() => hnLookupUrl(Array.from({ length: HN_LOOKUP_BATCH + 1 }, (_, i) => String(i + 1)))).toThrow('hn_lookup_batch');
});

it('창을 다 읽고 남기고, 돌아오지 않은 글은 ID로 다시 물어 없으면 내린다', async () => {
  mocks.missing.mockResolvedValue([{ id: 31, externalId: '900' }, { id: 32, externalId: '901' }]);
  const urls: string[] = [];
  const request: CappedRequest = async url => {
    urls.push(String(url));
    return String(url).includes('search_by_date')
      ? json({ nbPages: 1, hits: [hit('1', 'https://github.com/acme/app'), hit('2', 'https://example.com')] })
      // 901만 돌아온다 — 900은 지워졌다
      : json({ nbPages: 1, hits: [hit('901', 'https://github.com/acme/old')] });
  };
  const ctx = context();
  const outcome = await collectHnTalk(ctx, request, () => NOW);

  expect(outcome).toEqual({ done: true, cursor: { lastRunAt: NOW.toISOString() } });
  expect(mocks.record).toHaveBeenNthCalledWith(1, 'hn', [expect.objectContaining({ externalId: '1' })], NOW, undefined);
  expect(mocks.missing).toHaveBeenCalledWith('hn', new Date(NOW.getTime() - HN_TALK_WINDOW_MS), NOW);
  expect(new URL(urls[1]).searchParams.get('tags')).toBe('story,(story_900,story_901)');
  expect(mocks.record).toHaveBeenNthCalledWith(2, 'hn', [expect.objectContaining({ externalId: '901' })], NOW, undefined);
  expect(mocks.gone).toHaveBeenCalledWith([31], NOW, undefined);
  expect(mocks.expire).toHaveBeenCalledWith(new Date(NOW.getTime() - 90 * 86_400_000), undefined);
  expect(ctx.log).toHaveBeenCalledWith('social.hn_talk_collected', expect.objectContaining({ found: 1, missing: 2, gone: 1, complete: true }));
});

it('여러 페이지면 끝까지 읽는다', async () => {
  const request: CappedRequest = async url => {
    const page = new URL(String(url)).searchParams.get('page');
    return json({ nbPages: 2, hits: [hit(page === '0' ? '1' : '2', `https://github.com/acme/p${page}`)] });
  };
  await collectHnTalk(context(), request, () => NOW);
  expect(mocks.record.mock.calls[0][1].map((post: { externalId: string }) => post.externalId)).toEqual(['1', '2']);
});

it('창을 다 못 읽은 회차는 남기기만 하고 지워진 글 판정은 하지 않는다', async () => {
  const request: CappedRequest = async () => json({ nbPages: 3, hits: [hit('1', 'https://github.com/acme/app')] });
  const ctx = context(() => false);
  const outcome = await collectHnTalk(ctx, request, () => NOW);
  expect(outcome).toEqual({ done: false, cursor: null });
  expect(mocks.record).toHaveBeenCalledTimes(1);
  expect(mocks.missing).not.toHaveBeenCalled();
  expect(mocks.gone).not.toHaveBeenCalled();
  expect(ctx.save).not.toHaveBeenCalled();
});

it('검색이 실패하면 아무것도 쓰지 않는다', async () => {
  const ctx = context();
  const outcome = await collectHnTalk(ctx, async () => json({ error: 'busy' }, 503), () => NOW);
  expect(outcome).toEqual({ done: false, cursor: null });
  expect(mocks.record).not.toHaveBeenCalled();
  expect(ctx.log).toHaveBeenCalledWith('social.hn_talk_failed', { reason: 'http_503', page: 0 });
});

it('다시 묻기가 실패하면 내리지 않는다', async () => {
  mocks.missing.mockResolvedValue([{ id: 31, externalId: '900' }]);
  const request: CappedRequest = async url => String(url).includes('search_by_date')
    ? json({ nbPages: 1, hits: [] }) : json({}, 502);
  await collectHnTalk(context(), request, () => NOW);
  expect(mocks.gone).not.toHaveBeenCalled();
});

it('수집 전체가 꺼져 있으면 요청하지 않는다', async () => {
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: false };
  const request = vi.fn();
  expect(await collectHnTalk(context(), request as unknown as CappedRequest, () => NOW)).toEqual({ done: true });
  expect(request).not.toHaveBeenCalled();
});
