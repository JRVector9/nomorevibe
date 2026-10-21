import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { blueskyAtUri, blueskyExternalId, blueskyPostKey, blueskyPostUrl } from '@/lib/social/bluesky-link';
import {
  BLUESKY_LOOKUP_BATCH, BLUESKY_MODERATION_DID, blueskyBlockingLabels, blueskyLabelHold, blueskyLink, blueskyLookupUrl, blueskySearchUrl, blueskyTalkPost, nextUntil,
} from '@/lib/social/bluesky-talk-source';
import {
  BLUESKY_BOT_POSTS, BLUESKY_GONE_PURGE_MS, BLUESKY_MAX_REQUESTS, BLUESKY_TALK_WINDOW_MS, BLUESKY_USER_AGENT, collectBlueskyTalk,
  type BlueskyTalkCursor,
} from '@/lib/social/bluesky-talk';
import type { CappedRequest } from '@/lib/net/fetch';

const mocks = vi.hoisted(() => ({
  record: vi.fn(), recheck: vi.fn(), heavy: vi.fn(), bots: vi.fn(), gone: vi.fn(), purge: vi.fn(), expire: vi.fn(),
  settings: null as CrawlSettings | null,
}));
vi.mock('@/lib/social/bluesky-talk-store', () => ({
  recordBlueskyPosts: mocks.record, blueskyPostsToRecheck: mocks.recheck, heavyBlueskyAccounts: mocks.heavy,
  holdBotPosts: mocks.bots, markBlueskyPostsGone: mocks.gone, purgeGoneBlueskyPosts: mocks.purge,
}));
vi.mock('@/lib/social/repository', () => ({ deleteExpiredSocialPosts: mocks.expire }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));
// 모의 응답에도 URL 검사는 DNS 를 묻는다 — 공개 IP로 고정한다(social-hn-talk.test.ts 와 같다)
vi.mock('node:dns', async original => {
  const actual = await original<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: vi.fn().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]) } };
});

const NOW = new Date('2026-10-21T23:30:00.000Z');
const DID = 'did:plc:ltjj43huonogytm4szn5hzkx';
const OTHER = 'did:plc:hzebgrkbc42iyxsrmwsdjnej';
type Raw = Record<string, unknown>;
/** api.bsky.app 이 돌려주는 PostView 모양(2026-10-21 실측) — 본문·핸들·이름·사진까지 그대로 넣어 우리가 버리는지 본다 */
const view = (rkey: string, links: string[], extra: Raw = {}, did = DID): Raw => ({
  uri: `at://${did}/app.bsky.feed.post/${rkey}`, cid: 'bafyreib',
  author: { did, handle: 'someone.bsky.social', displayName: 'Some One', avatar: 'https://cdn.bsky.app/a.jpg', labels: [], createdAt: '2024-01-01T00:00:00Z' },
  record: {
    $type: 'app.bsky.feed.post', createdAt: '2026-10-21T23:10:44.000Z', langs: ['en'], text: 'secret body text github.com/acme/app',
    facets: links.map(uri => ({ index: { byteStart: 0, byteEnd: 10 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] })),
  },
  replyCount: 2, repostCount: 3, likeCount: 4, quoteCount: 9, bookmarkCount: 1, indexedAt: '2026-10-21T23:10:45.507Z', labels: [],
  ...extra,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const context = (cursor: BlueskyTalkCursor | null = null, hasBudget = () => true) =>
  ({ cursor, hasBudget, save: vi.fn().mockResolvedValue(undefined), log: vi.fn() });
const sleep = vi.fn(async () => {});

beforeEach(() => {
  mocks.record.mockReset().mockImplementation(async (posts: unknown[]) => ({ inserted: posts.length, updated: 0, observed: posts.length, held: 0, released: 0 }));
  mocks.recheck.mockReset().mockResolvedValue([]);
  mocks.heavy.mockReset().mockResolvedValue([]);
  mocks.bots.mockReset().mockResolvedValue(0);
  mocks.gone.mockReset().mockImplementation(async (ids: number[]) => ids.length);
  mocks.purge.mockReset().mockResolvedValue(0);
  mocks.expire.mockReset().mockResolvedValue(0);
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true };
  sleep.mockClear();
});

describe('글 주소', () => {
  it('at-uri 를 "<did>/<rkey>" 로 줄이고, 원문·다시 묻기 주소를 거기서 만든다', () => {
    const id = blueskyExternalId(`at://${DID}/app.bsky.feed.post/3mygbhpmh762y`)!;
    expect(id).toBe(`${DID}/3mygbhpmh762y`);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(blueskyAtUri(id)).toBe(`at://${DID}/app.bsky.feed.post/3mygbhpmh762y`);
    expect(blueskyPostUrl(id)).toBe(`https://bsky.app/profile/${DID}/post/3mygbhpmh762y`);
    expect(blueskyPostKey(id)).toBe('3mygbhpmh762y');
    // 게시물이 아닌 기록·모양이 다른 DID·칸에 안 드는 did:web 은 받지 않는다
    expect(blueskyExternalId(`at://${DID}/app.bsky.feed.like/3mygbhpmh762y`)).toBeNull();
    expect(blueskyExternalId('at://did:plc:UPPER/app.bsky.feed.post/3mygbhpmh762y')).toBeNull();
    expect(blueskyExternalId(`at://did:web:${'a'.repeat(60)}.example/app.bsky.feed.post/3mygbhpmh762y`)).toBeNull();
    expect(blueskyPostUrl('javascript:alert(1)')).toBe('https://bsky.app/');
  });

  it('최신 한 쪽은 q=*, 시간 창은 q=github.com 에 밀리초 Z 시각으로 묻는다', () => {
    const latest = new URL(blueskySearchUrl({ sort: 'latest' }));
    expect(latest.origin + latest.pathname).toBe('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts');
    expect(Object.fromEntries(latest.searchParams)).toEqual({ q: '*', domain: 'github.com', sort: 'latest', limit: '100' });
    const windowed = new URL(blueskySearchUrl({ sort: 'top', since: new Date('2026-10-20T23:30:00Z'), until: NOW }));
    expect(Object.fromEntries(windowed.searchParams)).toEqual({
      q: 'github.com', domain: 'github.com', sort: 'top', limit: '100', since: '2026-10-20T23:30:00.000Z', until: '2026-10-21T23:30:00.000Z',
    });
    expect(new URL(blueskyLookupUrl(['at://a', 'at://b'])).searchParams.getAll('uris')).toEqual(['at://a', 'at://b']);
    expect(() => blueskyLookupUrl([])).toThrow('bluesky_lookup_batch');
    expect(() => blueskyLookupUrl(Array.from({ length: BLUESKY_LOOKUP_BATCH + 1 }, (_, i) => `at://${i}`))).toThrow('bluesky_lookup_batch');
  });

  it('다음 쪽은 가장 이른 글 1ms 뒤까지 다시 읽고, 같은 밀리초에 막히면 넘어간다', () => {
    const at = (iso: string) => ({ postedAt: new Date(iso) });
    expect(nextUntil([at('2026-10-21T23:00:08.840Z'), at('2026-10-21T23:00:07.000Z')], null)?.toISOString()).toBe('2026-10-21T23:00:07.001Z');
    expect(nextUntil([at('2026-10-21T23:00:07.000Z')], new Date('2026-10-21T23:00:07.001Z'))?.toISOString()).toBe('2026-10-21T23:00:07.000Z');
    expect(nextUntil([], NOW)).toBeNull();
  });
});

describe('게시물 읽기', () => {
  it('저장소 하나를 가리킨 글은 키를 달고, 본문·핸들·이름은 남기지 않는다', () => {
    const post = blueskyTalkPost(view('3mygbhpmh762y', ['https://github.com/Weaviate/weaviate', 'https://github.com/weaviate_io']), NOW)!;
    expect(post).toEqual({
      externalId: `${DID}/3mygbhpmh762y`, kind: 'link', title: '', linkUrl: 'https://github.com/Weaviate/weaviate', linkTarget: 'repo',
      repositoryKey: 'weaviate/weaviate', postedAt: new Date('2026-10-21T23:10:44.000Z'),
      // 점수 = 좋아요 4 + 재게시 3×2, 댓글 = 답글(인용은 세지 않는다)
      points: 10, comments: 2, frontPage: false, did: DID, labelHold: null, repositories: 1,
    });
    expect(JSON.stringify(post)).not.toMatch(/secret body|someone\.bsky|Some One|cdn\.bsky/);
  });

  it('링크 카드(embed)도 읽고, 같은 저장소의 주소가 여럿이면 저장소 자체를 고른다', () => {
    const card = view('3mygbe6vhcc2z', [], { record: { createdAt: '2026-10-21T23:08:46.315Z', embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://github.com/danielroe/forges', title: 't' } } } });
    expect(blueskyTalkPost(card, NOW)).toMatchObject({ repositoryKey: 'danielroe/forges', linkTarget: 'repo' });
    const media = view('3mygbe6vhcc2a', [], { record: { createdAt: '2026-10-21T23:08:46.315Z',
      embed: { $type: 'app.bsky.embed.recordWithMedia', media: { $type: 'app.bsky.embed.external', external: { uri: 'https://github.com/acme/media' } } } } });
    expect(blueskyTalkPost(media, NOW)).toMatchObject({ repositoryKey: 'acme/media' });
    expect(blueskyLink(['https://github.com/acme/app/issues/7', 'https://github.com/acme/app'])).toEqual({
      linkUrl: 'https://github.com/acme/app', linkTarget: 'repo', repositoryKey: 'acme/app', repositories: 1,
    });
    expect(blueskyLink(['https://github.com/NixOS/nixpkgs/pull/576814'])).toMatchObject({ linkTarget: 'pull', repositoryKey: 'nixos/nixpkgs' });
  });

  it('저장소가 여럿이거나 저장소가 아닌 GitHub 주소는 키 없이 site 로 남기고, 링크가 없으면 버린다', () => {
    expect(blueskyLink(['https://example.com/blog', 'https://github.com/acme/one', 'https://github.com/acme/two'])).toEqual({
      linkUrl: 'https://github.com/acme/one', linkTarget: 'site', repositoryKey: null, repositories: 2,
    });
    expect(blueskyLink(['https://news.ycombinator.com/item?id=1', 'https://github.com/sponsors/acme'])).toEqual({
      linkUrl: 'https://github.com/sponsors/acme', linkTarget: 'site', repositoryKey: null, repositories: 0,
    });
    expect(blueskyLink(['https://acme.github.io/app/'])).toMatchObject({ linkTarget: 'site', repositoryKey: null });
    expect(blueskyTalkPost(view('3mygb000000aa', []), NOW)).toBeNull();
    expect(blueskyTalkPost(view('3mygb000000ab', ['javascript:alert(1)']), NOW)).toBeNull();
  });

  it('게시 시각은 작성·색인 중 이른 쪽이고, 글 ID·작성자가 맞지 않거나 시각이 없으면 버린다', () => {
    const future = view('3mygb000000ac', ['https://github.com/acme/app'], { record: { createdAt: '2027-01-01T00:00:00Z', facets: [{ features: [{ uri: 'https://github.com/acme/app' }] }] } });
    expect(blueskyTalkPost(future, NOW)?.postedAt.toISOString()).toBe('2026-10-21T23:10:45.507Z');
    expect(blueskyTalkPost(view('3mygb000000ad', ['https://github.com/acme/app'], { uri: `at://${OTHER}/app.bsky.feed.post/3mygb000000ad` }), NOW)).toBeNull();
    expect(blueskyTalkPost(view('3mygb000000ae', ['https://github.com/acme/app'], { indexedAt: 'nope', record: { facets: [{ features: [{ uri: 'https://github.com/acme/app' }] }] } }), NOW)).toBeNull();
    expect(blueskyTalkPost({ uri: 1 }, NOW)).toBeNull();
  });
});

describe('라벨', () => {
  const labelled = (post: Raw[], author: Raw[], self: string[] = []) => ({
    labels: post as never, author: { did: DID, labels: author as never },
    record: self.length ? { labels: { values: self.map(val => ({ val })) } } : {},
  });

  it('글·계정·스스로 단 라벨 중 막는 것만 모으고, 취소(neg)·만료된 라벨은 뺀다', () => {
    expect(blueskyBlockingLabels(labelled(
      [{ val: 'porn' }, { val: 'spam', neg: true }, { val: 'gore', exp: '2026-10-01T00:00:00Z' }],
      [{ val: '!no-unauthenticated' }], ['Nudity']), NOW)).toEqual(['porn', '!no-unauthenticated', 'nudity']);
  });

  it('출처 표시 같은 스스로 단 라벨은 막지 않고, 검토 서비스가 단 라벨은 값과 관계없이 막는다', () => {
    // 실측 첫 회차: Bridgy Fed 로 넘어온 계정, 펫 사진 표시
    expect(blueskyBlockingLabels(labelled([{ src: DID, val: 'pet' }], [{ src: DID, val: 'bridged-from-bridgy-fed-activitypub' }]), NOW)).toEqual([]);
    expect(blueskyBlockingLabels(labelled([{ src: BLUESKY_MODERATION_DID, val: 'needs-review' }], []), NOW)).toEqual(['needs-review']);
    expect(blueskyBlockingLabels(labelled([{ src: DID, val: '!hide' }], []), NOW)).toEqual(['!hide']);
  });

  it('로그아웃 비공개 요청 > 성인·검토 라벨 > 그 밖의 라벨 > 봇 계정 순으로 까닭 하나를 단다', () => {
    expect(blueskyLabelHold([])).toBeNull();
    expect(blueskyLabelHold(['bot', 'porn', '!no-unauthenticated'])).toBe('label:!no-unauthenticated');
    expect(blueskyLabelHold(['bot', 'sexual'])).toBe('label:sexual');
    expect(blueskyLabelHold(['bot', 'intolerant'])).toBe('label:intolerant');
    expect(blueskyLabelHold(['bot'])).toBe('label:bot');
  });

  it('스스로 자동 계정이라 밝힌 계정(bot)의 글은 라벨 숨김으로 읽는다', () => {
    const raw = view('3mygbep7nbw22', ['https://github.com/Pikachannel/reply-bots/blob/main/README.md'],
      { author: { did: DID, handle: 'whimsy.example', labels: [{ src: DID, uri: `at://${DID}/app.bsky.actor.profile/self`, val: 'bot', cts: '2025-01-01T00:00:00Z' }] } });
    expect(blueskyTalkPost(raw, NOW)).toMatchObject({ repositoryKey: 'pikachannel/reply-bots', labelHold: 'label:bot' });
  });
});

describe('수집 회차', () => {
  type Route = (url: URL) => Response | Promise<Response>;
  function server(route: Route) {
    const urls: URL[] = [];
    const headers: Record<string, string>[] = [];
    const request: CappedRequest = async (url, init) => { urls.push(new URL(String(url))); headers.push(init.headers); return route(new URL(String(url))); };
    return { request, urls, headers };
  }
  const page = (count: number, start: Date, prefix: string, did = DID) => Array.from({ length: count }, (_, i) => view(`${prefix}${String(i).padStart(4, '0')}aaaa`.slice(0, 13),
    [`https://github.com/acme/r${prefix}${i}`], { indexedAt: new Date(start.getTime() - i * 60_000).toISOString(), record: {
      createdAt: new Date(start.getTime() - i * 60_000).toISOString(), facets: [{ features: [{ uri: `https://github.com/acme/r${prefix}${i}` }] }] } }, did));

  it('최신 한 쪽으로 새 글을 다 읽으면 창을 밀지 않고, 반응 큰 글 셋·다시 묻기·봇·보관을 차례로 한다', async () => {
    mocks.recheck.mockResolvedValue([{ id: 31, external_id: `${DID}/3mygold00000a` }, { id: 32, external_id: `${DID}/3mygold00000b` }]);
    mocks.heavy.mockResolvedValue([OTHER]);
    mocks.bots.mockResolvedValue(4);
    const { request, urls, headers } = server(url => {
      if (url.pathname.endsWith('getPosts')) return json({ posts: [view('3mygold00000b', ['https://github.com/acme/old'])] });
      return json({ posts: url.searchParams.get('sort') === 'top' ? [] : page(3, new Date('2026-10-21T23:20:00Z'), 'n') });
    });
    const ctx = context({ lastRunAt: '2026-10-21T23:00:00.000Z', through: '2026-10-21T23:00:00.000Z' });
    const outcome = await collectBlueskyTalk(ctx, { request, now: () => NOW, sleep });

    expect(outcome).toEqual({ done: true, cursor: { lastRunAt: NOW.toISOString(), through: NOW.toISOString() } });
    expect(urls.map(url => `${url.pathname.split('.').at(-1)}:${url.searchParams.get('q') ?? ''}:${url.searchParams.get('sort') ?? ''}`)).toEqual([
      'searchPosts:*:latest', 'searchPosts:github.com:top', 'searchPosts:github.com:top', 'searchPosts:github.com:top', 'getPosts::',
    ]);
    // 하루씩 셋 — 창(72시간) 밖으로 나가지 않는다
    expect(urls.slice(1, 4).map(url => [url.searchParams.get('since'), url.searchParams.get('until')])).toEqual([
      ['2026-10-20T23:30:00.000Z', '2026-10-21T23:30:00.000Z'], ['2026-10-19T23:30:00.000Z', '2026-10-20T23:30:00.000Z'], ['2026-10-18T23:30:00.000Z', '2026-10-19T23:30:00.000Z'],
    ]);
    expect(headers[0]['user-agent']).toBe(BLUESKY_USER_AGENT);
    expect(sleep).toHaveBeenCalled();
    expect(urls[4].searchParams.getAll('uris')).toEqual([`at://${DID}/app.bsky.feed.post/3mygold00000a`, `at://${DID}/app.bsky.feed.post/3mygold00000b`]);
    expect(mocks.record).toHaveBeenNthCalledWith(1, expect.arrayContaining([expect.objectContaining({ repositoryKey: 'acme/rn0' })]), NOW, undefined);
    expect(mocks.record.mock.calls[0][0]).toHaveLength(3);
    expect(mocks.recheck).toHaveBeenCalledWith(new Date(NOW.getTime() - BLUESKY_TALK_WINDOW_MS), new Date(NOW.getTime() - 7 * 86_400_000), NOW, 300);
    // 돌아온 글은 값을 새로 남기고, 돌아오지 않은 글(31)은 내린다
    expect(mocks.record).toHaveBeenNthCalledWith(2, [expect.objectContaining({ externalId: `${DID}/3mygold00000b` })], NOW, undefined);
    expect(mocks.gone).toHaveBeenCalledWith([31], NOW, undefined);
    expect(mocks.heavy).toHaveBeenCalledWith(new Date(NOW.getTime() - BLUESKY_TALK_WINDOW_MS), BLUESKY_BOT_POSTS);
    expect(mocks.bots).toHaveBeenCalledWith([OTHER], new Date(NOW.getTime() - BLUESKY_TALK_WINDOW_MS), NOW, undefined);
    expect(mocks.purge).toHaveBeenCalledWith(new Date(NOW.getTime() - BLUESKY_GONE_PURGE_MS), undefined);
    expect(mocks.expire).toHaveBeenCalledWith(new Date(NOW.getTime() - 90 * 86_400_000), undefined);
    expect(ctx.log).toHaveBeenCalledWith('social.bluesky_talk_collected', expect.objectContaining({
      found: 3, missing: 2, rechecked: 2, gone: 1, heavy: 1, bots: 4, requests: 5, pages: 1, complete: true, truncated: false,
    }));
    expect(ctx.save).toHaveBeenCalledWith({ lastRunAt: NOW.toISOString(), through: NOW.toISOString() });
  });

  it('쪽이 100건을 다 채우지 않아도 cursor 가 있으면 더 내려가고, cursor 가 없고 덜 찬 쪽에서 멈춘다', async () => {
    // 실측: 검색은 가린 글을 빼고 99건을 주기도 한다 — 그래도 다음 쪽이 있다
    const { request, urls } = server(url => {
      if (url.searchParams.get('sort') === 'top') return json({ posts: [] });
      if (url.searchParams.get('q') === '*') return json({ posts: page(99, new Date('2026-10-21T23:29:00Z'), 'a'), cursor: 'eyJzIjpbXX0' });
      return json({ posts: page(20, new Date(new Date(url.searchParams.get('until')!).getTime() - 1), 'w') });
    });
    const ctx = context({ lastRunAt: '2026-10-21T00:00:00.000Z', through: '2026-10-21T00:00:00.000Z' });
    await collectBlueskyTalk(ctx, { request, now: () => NOW, sleep });
    expect(urls.filter(url => url.searchParams.get('q') === 'github.com' && url.searchParams.get('sort') === 'latest')).toHaveLength(1);
    expect(ctx.log).toHaveBeenCalledWith('social.bluesky_talk_collected', expect.objectContaining({ found: 119, pages: 2, truncated: false, complete: true }));
  });

  it('지난 회차 뒤로 100건이 넘으면 q=github.com 시간 창을 밀어 내려가고, 10쪽에서 멈춘다', async () => {
    let window = 0;
    const { request, urls } = server(url => {
      if (url.searchParams.get('sort') === 'top') return json({ posts: [] });
      if (url.searchParams.get('q') === '*') return json({ posts: page(100, new Date('2026-10-21T23:29:00Z'), 'a') });
      const until = new Date(url.searchParams.get('until')!);
      window += 1;
      return json({ posts: page(100, new Date(until.getTime() - 1), `w${window}`) });
    });
    const ctx = context({ lastRunAt: '2026-10-20T00:00:00.000Z', through: '2026-10-20T00:00:00.000Z' });
    await collectBlueskyTalk(ctx, { request, now: () => NOW, sleep });
    const windows = urls.filter(url => url.searchParams.get('q') === 'github.com' && url.searchParams.get('sort') === 'latest');
    expect(windows).toHaveLength(9);
    expect(windows[0].searchParams.get('since')).toBe('2026-10-19T23:50:00.000Z');
    // 첫 창의 until 은 최신 쪽에서 가장 이른 글(99분 앞) 1ms 뒤
    expect(windows[0].searchParams.get('until')).toBe(new Date(new Date('2026-10-21T23:29:00Z').getTime() - 99 * 60_000 + 1).toISOString());
    expect(ctx.log).toHaveBeenCalledWith('social.bluesky_talk_collected', expect.objectContaining({ pages: 10, truncated: true, complete: false }));
    expect(ctx.save).toHaveBeenCalled();
  });

  it('검색이 막혀도 지운 글 다시 묻기는 하고, 새 글 끝 시각은 옮기지 않는다', async () => {
    mocks.recheck.mockResolvedValue([{ id: 41, external_id: `${DID}/3mygold00000c` }]);
    const { request } = server(url => url.pathname.endsWith('getPosts') ? json({ posts: [] }) : json({ error: 'Forbidden' }, 403));
    const cursor = { lastRunAt: '2026-10-21T23:00:00.000Z', through: '2026-10-21T23:00:00.000Z' };
    const ctx = context(cursor);
    expect(await collectBlueskyTalk(ctx, { request, now: () => NOW, sleep })).toEqual({ done: false, cursor });
    expect(ctx.log).toHaveBeenCalledWith('social.bluesky_talk_failed', { reason: 'http_403', stage: 'latest', page: 0 });
    expect(mocks.gone).toHaveBeenCalledWith([41], NOW, undefined);
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it('429 를 받으면 그 회차의 남은 요청을 하지 않고, 다시 묻기가 실패하면 내리지 않는다', async () => {
    mocks.recheck.mockResolvedValue([{ id: 51, external_id: `${DID}/3mygold00000d` }]);
    const { request, urls } = server(url => url.searchParams.get('sort') === 'top' ? json({}, 429) : json({ posts: [] }));
    const ctx = context();
    await collectBlueskyTalk(ctx, { request, now: () => NOW, sleep });
    expect(urls).toHaveLength(2);
    expect(mocks.gone).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith('social.bluesky_talk_lookup_failed', { reason: 'rate_limited' });
  });

  it('한 회차의 요청은 상한을 넘지 않는다', async () => {
    mocks.recheck.mockResolvedValue(Array.from({ length: 300 }, (_, i) => ({ id: i + 1, external_id: `${DID}/3mygq${String(i).padStart(8, '0')}` })));
    const { request, urls } = server(url => {
      if (url.pathname.endsWith('getPosts')) return json({ posts: [] });
      if (url.searchParams.get('sort') === 'top') return json({ posts: [] });
      return json({ posts: page(100, new Date(new Date(url.searchParams.get('until') ?? '2026-10-21T23:29:00Z').getTime() - 1), `p${urls.length}`) });
    });
    await collectBlueskyTalk(context(), { request, now: () => NOW, sleep });
    expect(urls.length).toBeLessThanOrEqual(BLUESKY_MAX_REQUESTS);
    // 새 글 10쪽 + 반응 큰 글 3 + 다시 묻기 12번(300건) — 상한 30 은 안전판이다
    expect(urls.filter(url => url.pathname.endsWith('getPosts'))).toHaveLength(12);
    expect(urls).toHaveLength(25);
  });

  it('수집 전체가 꺼져 있으면 요청하지 않는다', async () => {
    mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: false };
    const request = vi.fn();
    expect(await collectBlueskyTalk(context(), { request: request as unknown as CappedRequest, now: () => NOW, sleep })).toEqual({ done: true });
    expect(request).not.toHaveBeenCalled();
  });
});
