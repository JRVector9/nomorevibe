import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { feedSourceSchema, feedSourcesSchema, type FeedSourceConfig } from '@/lib/crawl/feed-source-schema';
import { entryRepository, feedSources, GEEKNEWS_FEED, pageRepository, parseFeedEntries, selectFeedArticles, SHOW_GN_FEED, titleMatches } from '@/lib/crawl/feed-sources';
import { previewFeedSource } from '@/lib/crawl/feed-preview';
import { seedFromShowGN, showGnTopicIds, type ShowGnCursor } from '@/lib/crawl/jobs/gn-show';
import type { CappedRequest } from '@/lib/net/fetch';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), progress: vi.fn(), sleep: vi.fn(), settings: null as CrawlSettings | null }));
vi.mock('@/lib/crawl/shared-discovery', () => ({ enqueueDiscoveryBatch: mocks.enqueue }));
vi.mock('@/lib/crawl/discovery-progress', () => ({ recordDiscoveryProgress: mocks.progress }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.sleep }));
vi.mock('node:dns', async original => {
  const actual = await original<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: vi.fn().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]) } };
});

const fixture = (file: string) => readFileSync(new URL(`./fixtures/geeknews/${file}`, import.meta.url), 'utf8');
const context = (cursor: ShowGnCursor | null = null) => ({ cursor, hasBudget: () => true, save: vi.fn().mockResolvedValue(undefined), log: vi.fn() });
const gnFeed = (...ids: number[]) => `<feed xmlns="http://www.w3.org/2005/Atom">${ids.map(id => `<entry><title>Show GN: App</title><id>https://news.hada.io/topic?id=${id}</id></entry>`).join('')}</feed>`;
const gnPage = (url = 'https://github.com/acme/app') => `<div class='topictitle link'><a href='${url}' class='topic-title-link'>t</a></div><section id='topic_contents'></section>`;
const RSS_URL = 'https://feeds.example/show.rss';
const rss = (...items: { title: string; link: string; date: string; description?: string }[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${
  items.map(item => `<item><title>${item.title}</title><link>${item.link}</link><pubDate>${item.date}</pubDate>${item.description ? `<description><![CDATA[${item.description}]]></description>` : ''}</item>`).join('')}</channel></rss>`;
const ITEMS = [
  { title: 'Show: Repo tool', link: 'https://github.com/beta/tool', date: 'Wed, 11 Nov 2026 10:00:00 GMT' },
  { title: 'Show: Site only', link: 'https://site.example/app', date: 'Wed, 11 Nov 2026 09:00:00 GMT', description: '<p>no code</p>' },
  { title: 'Show: Site with code', link: 'https://gamma.dev/', date: 'Wed, 11 Nov 2026 08:00:00 GMT', description: '<a href="https://github.com/gam/gamma">source</a>' },
  { title: 'Ask: something', link: 'https://github.com/x/ignored', date: 'Wed, 11 Nov 2026 07:00:00 GMT' },
];
const added = (patch: Partial<FeedSourceConfig> = {}): FeedSourceConfig => feedSourceSchema.parse({ id: 'feeds-example-abc123', name: 'Example Show', url: RSS_URL,
  titlePrefix: 'Show:', link: { kind: 'entry-link' }, intervalMinutes: 60, priority: 90, enabled: true, ...patch });
const respond = (bodies: Record<string, string>, fallback = gnPage()) => vi.fn<CappedRequest>(async url => new Response(bodies[url] ?? fallback));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true };
  mocks.enqueue.mockReset().mockResolvedValue({ added: 1, processed: 1, remainingNew: 99 });
  mocks.sleep.mockResolvedValue(undefined);
});

describe('글 목록 수집원 — 설정과 첫 수집원(Show GN)', () => {
  it('Show GN 은 코드의 첫 수집원이고 켜짐·우선순위·AI 흔적은 discover.showGn 이 정한다', () => {
    mocks.settings!.discover.showGn = { enabled: false, priority: 130, requireEvidence: true };
    const [gn, ...rest] = feedSources(mocks.settings!.discover);
    expect(gn).toMatchObject({ id: 'show-gn', name: 'Show GN', url: GEEKNEWS_FEED, titlePrefix: 'Show GN:', enabled: false, priority: 130, requireEvidence: true, legacy: true,
      intervalMinutes: null, article: { kind: 'id-param' } });
    expect(rest).toEqual([]);
    // 옛 설정 행에는 feeds 가 없다 — 빈 목록으로 읽는다
    const old = structuredClone(DEFAULT_CRAWL_SETTINGS) as Partial<CrawlSettings>;
    delete (old.discover as Partial<CrawlSettings['discover']>).feeds;
    expect(crawlSettingsSchema.parse(old).discover.feeds).toEqual([]);
  });

  it('제목 고르기는 Show GN 의 /^Show GN\\s*:/i 와 같은 답을 낸다', () => {
    for (const title of ['Show GN: 앱', 'show gn : 앱', 'Show GN\t:x', 'Show GN x', 'Show GNx:', 'Show  GN: x', ' Show GN:x', 'GN Show: x', 'Show GN'])
      expect(titleMatches(title, 'Show GN:'), title).toBe(/^Show GN\s*:/i.test(title.trim()));
    expect(titleMatches('아무 글', '')).toBe(true);
  });

  it('실측 피드에서 고른 번호·저장소가 예전과 같다(번호 오름차순)', () => {
    expect(showGnTopicIds(fixture('feed.xml'))).toEqual(['36916', '36925', '36928', '36934', '36942', '36943', '36946', '36947', '36948', '36973', '36977', '36979']);
    expect(pageRepository(fixture('36947.html'), SHOW_GN_FEED.link as Extract<FeedSourceConfig['link'], { kind: 'page-title' }>)).toEqual({ ok: true, repo: 'sijunkim/EleDock' });
  });

  it('같은 이름·열쇠를 두 번 넣지 못하고, 이름은 프론티어 신호 길이(40) 안이다', () => {
    expect(feedSourcesSchema.safeParse([added(), added({ name: 'Other' })]).success).toBe(false);
    expect(feedSourcesSchema.safeParse([added(), added({ id: 'other-123456', name: 'example show' })]).success).toBe(false);
    expect(feedSourceSchema.safeParse({ ...added(), name: 'x'.repeat(41) }).success).toBe(false);
    expect(feedSourceSchema.safeParse({ ...added(), url: 'file:///etc/passwd' }).success).toBe(false);
    expect(feedSourceSchema.safeParse({ ...added(), intervalMinutes: 5 }).success).toBe(false);
  });
});

describe('피드 읽기', () => {
  it('RSS 2.0 · RSS 1.0 · Atom 을 읽고, 고른 글은 날짜 오름차순이다', () => {
    const entries = parseFeedEntries(rss(...ITEMS));
    expect(entries.map(entry => entry.title)).toEqual(ITEMS.map(item => item.title));
    expect(entries[2].html).toContain('github.com/gam/gamma');
    const picked = selectFeedArticles(entries, { url: RSS_URL, titlePrefix: 'Show:', link: { kind: 'entry-link' }, article: { kind: 'link' } });
    expect(picked.articles.map(article => article.page)).toEqual(['https://gamma.dev/', 'https://site.example/app', 'https://github.com/beta/tool']);
    expect(picked.selected).toBe(3);
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>c</title></channel><item><title>Show: r</title><link>https://github.com/r/r</link></item></rdf:RDF>`;
    expect(parseFeedEntries(rdf).map(entry => entry.page)).toEqual(['https://github.com/r/r']);
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Show: a &amp; b</title><link rel="alternate" href="https://example.org/p/1"/><published>2026-11-11T00:00:00Z</published></entry></feed>`;
    expect(parseFeedEntries(atom)).toEqual([{ title: 'Show: a & b', links: [ 'https://example.org/p/1' ], page: 'https://example.org/p/1', date: Date.parse('2026-11-11T00:00:00Z'), html: null }]);
  });

  it('글 페이지를 읽는 수집원은 피드와 다른 사이트의 글을 열지 않는다', () => {
    const entries = parseFeedEntries(rss({ title: 'Show: same', link: 'https://feeds.example/post/1', date: 'Wed, 11 Nov 2026 10:00:00 GMT' },
      { title: 'Show: other', link: 'https://elsewhere.example/post/2', date: 'Wed, 11 Nov 2026 11:00:00 GMT' }));
    const picked = selectFeedArticles(entries, { url: RSS_URL, titlePrefix: 'Show:', link: { kind: 'page-title', titleClass: 'post-title', linkClass: 'out', bodyId: null }, article: { kind: 'link' } });
    expect(picked.articles.map(article => article.page)).toEqual(['https://feeds.example/post/1']);
    expect(picked.skipped).toBe(1);
  });

  it('피드 항목의 링크가 제품 — 저장소면 그것, 사이트면 항목 글의 같은 이름 저장소 하나만', () => {
    expect(entryRepository({ link: 'https://github.com/beta/tool', html: null })).toBe('beta/tool');
    expect(entryRepository({ link: 'https://gamma.dev/', html: '<a href="https://github.com/gam/gamma">s</a>' })).toBe('gam/gamma');
    expect(entryRepository({ link: 'https://site.example/app', html: '<a href="https://github.com/other/thing">s</a>' })).toBeNull();
  });
});

describe('한 잡이 수집원을 차례로 돈다', () => {
  it('Show GN 의 상태·신호·출처는 그대로, 더한 수집원은 커서의 feeds 칸에 따로 — 저장소가 있는 글만 넣는다', async () => {
    mocks.settings!.discover.feeds = [added()];
    const request = respond({ [GEEKNEWS_FEED]: gnFeed(1), [RSS_URL]: rss(...ITEMS) });
    const ctx = { ...context(), lease: { name: 'gn-show-seed', token: 't', requestedVersion: 1 } };
    const first = await seedFromShowGN(ctx, request);
    expect(request.mock.calls.map(call => call[0])).toEqual([GEEKNEWS_FEED, 'https://news.hada.io/topic?id=1', RSS_URL]);
    expect(mocks.enqueue.mock.calls.map(call => call[0][0])).toEqual([
      { repo: 'acme/app', signal: 'Show GN', builder: null, priority: 120, discoverySource: { source: 'geeknews', topicId: '1', url: 'https://news.hada.io/topic?id=1' } },
      { repo: 'gam/gamma', signal: 'Example Show', builder: null, priority: 90, discoverySource: { source: 'feed', feed: 'feeds-example-abc123', url: 'https://gamma.dev/' } },
      { repo: 'beta/tool', signal: 'Example Show', builder: null, priority: 90, discoverySource: { source: 'feed', feed: 'feeds-example-abc123', url: 'https://github.com/beta/tool' } },
    ]);
    expect(first).toMatchObject({ done: true, cursor: { seenUntil: 1, pending: [], feeds: { 'feeds-example-abc123': {
      seen: ['https://gamma.dev/', 'https://site.example/app', 'https://github.com/beta/tool'], pending: [] } } } });
    expect(ctx.log).toHaveBeenCalledWith('crawl.feed_seeded', expect.objectContaining({ source: 'feeds-example-abc123', discovered: 2, skippedNoRepo: 1, examined: 3 }));
    expect(mocks.progress).toHaveBeenCalledWith(expect.objectContaining({ lane: 'geeknews', signal: 'Show GN' }));
    expect(mocks.progress).toHaveBeenCalledWith(expect.objectContaining({ lane: 'feed', signal: 'Example Show', counts: expect.objectContaining({ returned: 3, discovered: 2 }) }));

    // 수집원 주기(60분) 안의 다음 회차 — Show GN 은 회차마다, 더한 수집원은 읽지 않는다
    const next = respond({ [GEEKNEWS_FEED]: gnFeed(1), [RSS_URL]: rss(...ITEMS) });
    await seedFromShowGN(context(first.cursor), next);
    expect(next.mock.calls.map(call => call[0])).toEqual([GEEKNEWS_FEED]);
    // 60분이 지나면 다시 읽지만 본 글은 넣지 않는다
    const later = structuredClone(first.cursor!);
    later.feeds!['feeds-example-abc123'].readAt = new Date(Date.now() - 61 * 60_000).toISOString();
    mocks.enqueue.mockClear();
    const third = respond({ [GEEKNEWS_FEED]: gnFeed(1), [RSS_URL]: rss(...ITEMS) });
    await seedFromShowGN(context(later), third);
    expect(third.mock.calls.map(call => call[0])).toEqual([GEEKNEWS_FEED, RSS_URL]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('더한 수집원의 피드가 실패해도 Show GN 은 돈다 — 결과는 제 일 못 함(feed_fetch_failed), 읽은 시각은 그대로', async () => {
    mocks.settings!.discover.feeds = [added()];
    const request = vi.fn<CappedRequest>(async url => url === RSS_URL ? new Response('no', { status: 503 }) : new Response(url === GEEKNEWS_FEED ? gnFeed(1) : gnPage()));
    const ctx = context();
    const outcome = await seedFromShowGN(ctx, request);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ done: false, degraded: { code: 'feed_fetch_failed', cause: 'http_503' } });
    expect(outcome.cursor?.feeds?.['feeds-example-abc123']?.readAt).toBeUndefined();
    expect(ctx.log).toHaveBeenCalledWith('crawl.feed_failed', { source: 'feeds-example-abc123', reason: 'http_503' });
  });

  it('Show GN 을 끄고 더한 수집원만 켜도 돈다 — Show GN 의 칸은 그대로, 지운 수집원의 칸은 지운다', async () => {
    mocks.settings!.discover.showGn.enabled = false;
    mocks.settings!.discover.feeds = [added()];
    const cursor: ShowGnCursor = { seenUntil: 77, pending: [{ id: '70' }], feeds: { gone: { seen: ['x'], pending: [] } } };
    const request = respond({ [RSS_URL]: rss(...ITEMS) });
    const outcome = await seedFromShowGN(context(cursor), request);
    expect(request.mock.calls.map(call => call[0])).toEqual([RSS_URL]);
    expect(outcome.cursor).toMatchObject({ seenUntil: 77, pending: [{ id: '70' }] });
    expect(Object.keys(outcome.cursor!.feeds!)).toEqual(['feeds-example-abc123']);
    // 더한 수집원을 지우면 그 칸이 사라지고 Show GN 커서는 예전 모양으로 돌아온다
    mocks.settings!.discover.showGn.enabled = true; mocks.settings!.discover.feeds = [];
    const back = await seedFromShowGN(context(outcome.cursor!), respond({ [GEEKNEWS_FEED]: gnFeed() }));
    expect(back.cursor).toEqual({ seenUntil: 77, pending: [] });
  });

  it('글 페이지의 제목 링크를 읽는 수집원 — 설정한 class·본문 id 로 저장소를 찾는다', async () => {
    mocks.settings!.discover.showGn.enabled = false;
    mocks.settings!.discover.feeds = [added({ link: { kind: 'page-title', titleClass: 'post-head', linkClass: 'product', bodyId: 'body' } })];
    const post = 'https://feeds.example/post/9';
    const page = `<section class="post-head"><a class="product" href="https://delta.app/">Delta</a></section><div id="body"><a href="https://github.com/del/delta">code</a></div>`
      + `<div class="comments"><a href="https://github.com/spam/delta">x</a></div>`;
    const request = respond({ [RSS_URL]: rss({ title: 'Show: Delta', link: post, date: 'Wed, 11 Nov 2026 10:00:00 GMT' }), [post]: page });
    await seedFromShowGN(context(), request);
    expect(request.mock.calls.map(call => call[0])).toEqual([RSS_URL, post]);
    expect(mocks.enqueue.mock.calls[0][0][0]).toMatchObject({ repo: 'del/delta', signal: 'Example Show', discoverySource: { source: 'feed', url: post } });
  });
});

describe('미리 보기 — 쓰지 않고 센다', () => {
  it('고른 글·하루 수·저장소·사이트만을 세고, 글 페이지는 최근 것부터 상한까지만 읽는다', async () => {
    const posts = Array.from({ length: 4 }, (_, index) => ({ title: `Show: p${index}`, link: `https://feeds.example/post/${index}`,
      date: new Date(Date.UTC(2026, 10, 11, index * 6)).toUTCString() }));
    const pages: Record<string, string> = { [RSS_URL]: rss(...posts, { title: 'Other', link: 'https://feeds.example/x', date: 'Wed, 11 Nov 2026 23:00:00 GMT' }) };
    pages['https://feeds.example/post/3'] = `<div class="t"><a class="l" href="https://github.com/a/three">x</a></div>`;
    pages['https://feeds.example/post/2'] = `<div class="t"><a class="l" href="https://two.example/">x</a></div>`;
    const request = vi.fn<CappedRequest>(async url => url in pages ? new Response(pages[url]) : new Response('gone', { status: 404 }));
    const preview = await previewFeedSource({ url: RSS_URL, titlePrefix: 'Show:', link: { kind: 'page-title', titleClass: 't', linkClass: 'l', bodyId: null } },
      { request, pageLimit: 3 });
    expect(preview).toMatchObject({ ok: true, entries: 5, spanHours: 23, selected: 4, repos: 1, siteOnly: 1, failed: 1, checked: 3, unchecked: 1 });
    expect(request.mock.calls.map(call => call[0])).toEqual([RSS_URL, 'https://feeds.example/post/3', 'https://feeds.example/post/2', 'https://feeds.example/post/1']);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(await previewFeedSource({ url: 'http://127.0.0.1/feed', titlePrefix: '', link: { kind: 'entry-link' } })).toEqual({ ok: false, reason: 'unsafe_url' });
    expect(await previewFeedSource({ url: RSS_URL, titlePrefix: '', link: { kind: 'entry-link' } }, { request: async () => new Response('<html>') }))
      .toEqual({ ok: false, reason: 'invalid_feed' });
  });
});
