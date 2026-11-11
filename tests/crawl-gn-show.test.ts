import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { GEEKNEWS_FEED, MAX_TOPICS_PER_TICK, seedFromShowGN, showGnRepository, showGnTopicIds, type ShowGnCursor } from '@/lib/crawl/jobs/gn-show';
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
const feed = (...ids: number[]) => `<feed xmlns="http://www.w3.org/2005/Atom">${ids.map(id => `<entry><title>Show GN: App</title><id>https://news.hada.io/topic?id=${id}</id></entry>`).join('')}</feed>`;
const page = (url = 'https://github.com/acme/app', body = '') => `<div class='topictitle link'><a href='${url}' class='topic-title-link'><h1>Show GN: app</h1></a></div><section id='topic_contents'>${body}</section>`;
const respond = (xml: string, body = page()) => vi.fn<CappedRequest>(async url => new Response(url === GEEKNEWS_FEED ? xml : body));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true };
  mocks.enqueue.mockReset().mockResolvedValue({ added: 1, processed: 1, remainingNew: 99 });
  mocks.sleep.mockResolvedValue(undefined);
});

it('실측 59개 중 Show GN 12개만 고르고 제목 제품 링크와 본문의 같은 프로젝트를 읽는다', () => {
  const ids = showGnTopicIds(fixture('feed.xml'));
  expect(ids).toEqual(['36916', '36925', '36928', '36934', '36942', '36943', '36946', '36947', '36948', '36973', '36977', '36979']);
  const results = Object.fromEntries(ids.map(id => [id, showGnRepository(fixture(`${id}.html`))]));
  expect(results['36916']).toEqual({ ok: true, repo: 'Hyuntae-Jeong/Woodada' });
  expect(results['36947']).toEqual({ ok: true, repo: 'sijunkim/EleDock' });
  expect(results['36977']).toEqual({ ok: true, repo: 'nemorize/officeflare' });
  expect(Object.values(results).filter(row => row.ok && row.repo)).toHaveLength(6);
  expect(Object.values(results).filter(row => row.ok && !row.repo)).toHaveLength(6);
});

it('제목 링크가 우선이며 댓글·다른 github.io 저장소·애매한 본문을 쓰지 않는다', () => {
  expect(showGnRepository(page('https://github.com/acme/app', '<a href="https://github.com/other/no">참고</a>'))).toEqual({ ok: true, repo: 'acme/app' });
  expect(showGnRepository(page('https://ACME.github.io/App/ko/', '<div><a href="https://github.com/acme/App">코드</a></div><a href="https://github.com/other/no">참고</a>'))).toEqual({ ok: true, repo: 'acme/App' });
  expect(showGnRepository(page('https://acme.github.io/App/', '<a href="https://github.com/other/App">참고</a>'))).toEqual({ ok: true, repo: null });
  expect(showGnRepository(page('https://app.example', '') + '<a href="https://github.com/acme/app">댓글</a>')).toEqual({ ok: true, repo: null });
  expect(showGnRepository(page('https://app.example', '<a href="https://github.com/acme/app">소스</a>'))).toEqual({ ok: true, repo: 'acme/app' });
  expect(showGnRepository(page('https://app.example', '<a href="https://github.com/acme/app">소스</a><a href="https://github.com/other/app">예시</a>'))).toEqual({ ok: true, repo: null });
  expect(showGnRepository('<a class="topic-title-link" href="https://github.com/acme/app">outside</a>')).toEqual({ ok: false, reason: 'title_link_missing' });
});

it('손상된 XML·외부 topic id·엔티티 선언을 실패로 남긴다', () => {
  expect(() => showGnTopicIds('<feed>')).toThrow();
  expect(() => showGnTopicIds(feed(1).replace('https://news.hada.io/topic', 'https://evil.example/topic'))).toThrow();
  expect(() => showGnTopicIds('<!DOCTYPE feed [<!ENTITY e "x">]>' + feed(1))).toThrow();
  expect(showGnTopicIds('<feed xmlns="http://www.w3.org/2005/Atom"/>')).toEqual([]);
});

it('구버전 설정에는 기본 켜짐을 채우고 수집/소스 스위치를 모두 지킨다', async () => {
  const old = structuredClone(DEFAULT_CRAWL_SETTINGS) as Partial<CrawlSettings>;
  delete (old.discover as Partial<CrawlSettings['discover']>).showGn;
  expect(crawlSettingsSchema.parse(old).discover.showGn).toEqual({ enabled: true, priority: 120 });
  const request = respond(feed(1));
  mocks.settings!.enabled = false;
  await seedFromShowGN(context(), request);
  mocks.settings!.enabled = true; mocks.settings!.discover.showGn.enabled = false;
  await seedFromShowGN(context(), request);
  expect(request).not.toHaveBeenCalled();
});

it('출처/우선순위/lease를 공통 admission에 넘기고 재실행에는 글 페이지를 읽지 않는다', async () => {
  const ctx = { ...context(), lease: { name: 'gn-show-seed', token: 'test', requestedVersion: 1 } };
  const request = respond(feed(1));
  const first = await seedFromShowGN(ctx, request);
  expect(mocks.enqueue).toHaveBeenCalledWith([{ repo: 'acme/app', signal: 'Show GN', builder: null, priority: 120,
    discoverySource: { source: 'geeknews', topicId: '1', url: 'https://news.hada.io/topic?id=1' } }], mocks.settings!.discover, ctx.lease);
  expect(first.cursor).toEqual({ seenUntil: 1, pending: [] });
  await seedFromShowGN(context(first.cursor), request);
  expect(request.mock.calls.map(call => call[0])).toEqual([GEEKNEWS_FEED, 'https://news.hada.io/topic?id=1', GEEKNEWS_FEED]);
  expect(mocks.sleep).toHaveBeenCalledWith(1_000, undefined, { signal: undefined });
  expect(request.mock.calls[0][1].headers['user-agent']).not.toContain('@');
  expect(mocks.progress).toHaveBeenCalledWith(expect.objectContaining({ lane: 'geeknews', signal: 'Show GN' }));
});

it('수용 한도에 막힌 글은 페이지를 다시 읽지 않고 다음 틱에 재입장한다', async () => {
  mocks.enqueue.mockResolvedValueOnce({ added: 0, processed: 0, remainingNew: 0, blockedBy: 'rate_cap' });
  const first = await seedFromShowGN(context(), respond(feed(1)));
  expect(first.cursor?.pending).toEqual([{ id: '1', repo: 'acme/app' }]);
  const request = respond(feed()); // RSS에서 빠져도 진행
  await seedFromShowGN(context(first.cursor), request);
  expect(request).toHaveBeenCalledTimes(1);
  expect(mocks.enqueue).toHaveBeenCalledTimes(2);
});

it.each([404, 429, 500])('HTTP %s 글만 남기고 다른 글과 다음 틱 재시도를 계속한다', async status => {
  const request = vi.fn<CappedRequest>(async url => new Response(url === GEEKNEWS_FEED ? feed(1, 2) : page(), { status: url.endsWith('id=1') ? status : 200 }));
  const first = await seedFromShowGN(context(), request);
  expect(first).toMatchObject({ done: false, cursor: { pending: [{ id: '1' }] }, degraded: { code: 'topic_failed' } });
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  const second = await seedFromShowGN(context(first.cursor), respond(feed()));
  expect(second.cursor?.pending).toEqual([]);
});

it('타임아웃과 마크업 변경은 관측 가능한 사유를 남기고 번호를 완료 처리하지 않는다', async () => {
  const request = vi.fn<CappedRequest>(async url => {
    if (url.endsWith('id=1')) throw new DOMException('timeout', 'TimeoutError');
    return new Response(url === GEEKNEWS_FEED ? feed(1, 2) : '<html>changed</html>');
  });
  const ctx = context(); const outcome = await seedFromShowGN(ctx, request);
  expect(outcome.cursor?.pending.map(row => row.id)).toEqual(['1', '2']);
  expect(ctx.log).toHaveBeenCalledWith('crawl.show_gn_failed', { topicId: '1', reason: 'timeout' });
  expect(ctx.log).toHaveBeenCalledWith('crawl.show_gn_failed', { topicId: '2', reason: 'title_link_missing' });
  expect(outcome.degraded).toMatchObject({ code: 'topic_failed', cause: 'title_link_missing' });
  expect(mocks.progress).toHaveBeenCalledWith(expect.objectContaining({ counts: expect.objectContaining({ pagesVisited: 0, examined: 0, incomplete: 2 }) }));
});

it('RSS 실패는 잡을 던지지 않고 기존 커서를 보존한다', async () => {
  const cursor = { seenUntil: 1, pending: [{ id: '1' }] };
  const result = await seedFromShowGN(context(cursor), async () => new Response('no', { status: 503 }));
  expect(result).toMatchObject({ cursor, done: false, degraded: { code: 'feed_fetch_failed' } });
});

it('사이트만 있는 글은 한 번 읽어 건너뛴 건수를 남기고 다음 틱에 읽지 않는다', async () => {
  const ctx = context(); const first = await seedFromShowGN(ctx, respond(feed(1), page('https://app.example')));
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(ctx.log).toHaveBeenCalledWith('crawl.show_gn_seeded', expect.objectContaining({ skippedNoRepo: 1 }));
  const request = respond(feed(1)); await seedFromShowGN(context(first.cursor), request);
  expect(request).toHaveBeenCalledTimes(1);
});

it('RSS 1회 + 글 최대 20회, 남은 글은 RSS에서 사라져도 커서로 이어간다', async () => {
  const request = respond(feed(...Array.from({ length: 25 }, (_, i) => i + 1)));
  const first = await seedFromShowGN(context(), request);
  expect(request).toHaveBeenCalledTimes(1 + MAX_TOPICS_PER_TICK);
  expect(first.cursor?.pending).toHaveLength(5);
  const next = respond(feed()); await seedFromShowGN(context(first.cursor), next);
  expect(next).toHaveBeenCalledTimes(6);
});

it('중단/예산 소진에는 새 페이지를 요청하지 않는다', async () => {
  const request = respond(feed(1)); const ctx = context();
  ctx.hasBudget = () => false;
  await seedFromShowGN(ctx, request);
  expect(request).not.toHaveBeenCalled();
});
