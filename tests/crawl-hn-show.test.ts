import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { repoFromUrl, seedFromShowHN, SHOW_HN_SIGNAL, type ShowHnCursor } from '@/lib/crawl/jobs/hn-show';
import type { CappedRequest } from '@/lib/net/fetch';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), settings: null as CrawlSettings | null }));
vi.mock('@/lib/crawl/repository', () => ({ enqueue: mocks.enqueue }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));

const context = (cursor: ShowHnCursor | null = null, hasBudget = () => true) =>
  ({ cursor, hasBudget, save: vi.fn().mockResolvedValue(undefined), log: vi.fn() });

/** fetchCapped 의 주입점. 응답 본문만 흉내 낸다 */
const respond = (body: unknown, status = 200): CappedRequest => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hit = (id: string, at: number, url: string | null) => ({ objectID: id, created_at_i: at, url, title: 'Show HN: x' });

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(1);
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true };
});

it('제출 주소가 레포를 가리킬 때만 레포 이름을 낸다', () => {
  expect(repoFromUrl('https://github.com/tmokmss/my-ambient-agents')).toBe('tmokmss/my-ambient-agents');
  expect(repoFromUrl('https://www.github.com/acme/app/tree/main/src')).toBe('acme/app');
  expect(repoFromUrl('https://github.com/acme/app.git')).toBe('acme/app');
  expect(repoFromUrl('https://github.com/acme/app?tab=readme')).toBe('acme/app');
  // 제품 사이트는 레포를 알 수 없다 — 추측하지 않는다
  expect(repoFromUrl('https://opentrailpaper.com')).toBeNull();
  // 사용자 페이지·예약 경로는 레포가 아니다
  expect(repoFromUrl('https://github.com/acme')).toBeNull();
  expect(repoFromUrl('https://github.com/sponsors/acme')).toBeNull();
  expect(repoFromUrl('https://github.com/acme/..')).toBeNull();
  expect(repoFromUrl(null)).toBeNull();
  // github.com 을 흉내 낸 주소에 속지 않는다
  expect(repoFromUrl('https://github.com.evil.example/acme/app')).toBeNull();
  expect(repoFromUrl('https://evil.example/github.com/acme/app')).toBeNull();
});

it('레포를 가리키는 게시물만 프론티어에 넣고, 읽은 지점까지 커서를 올린다', async () => {
  const request = vi.fn(respond({ nbPages: 1, hits: [
    hit('3', 300, 'https://github.com/acme/app'),
    hit('2', 200, 'https://opentrailpaper.com'),
    hit('1', 100, 'https://github.com/acme/tool'),
  ] }));
  const outcome = await seedFromShowHN(context({ seenUntil: 50 }), request);
  expect(mocks.enqueue.mock.calls.flatMap(([e]) => e)).toEqual([
    { repo: 'acme/tool', signal: SHOW_HN_SIGNAL, builder: null, priority: 120 },
    { repo: 'acme/app', signal: SHOW_HN_SIGNAL, builder: null, priority: 120 },
  ]);
  expect(outcome).toMatchObject({ done: true, cursor: { seenUntil: 300 } });
  // 경계 초부터 다시 조회한다 — 같은 초에 남은 글을 놓치지 않는다 (이미 본 것은 ID로 거른다)
  expect(String(request.mock.calls[0][0])).toContain('created_at_i%3E%3D50');
});

it('밀려 있으면 오래된 페이지부터 당겨 건너뛰는 구간을 만들지 않는다', async () => {
  const pages: Record<string, unknown> = {
    '0': { nbPages: 3, hits: [hit('n', 900, 'https://github.com/acme/newest')] },
    '2': { nbPages: 3, hits: [hit('o', 110, 'https://github.com/acme/oldest')] },
  };
  const request: CappedRequest = async (url) => {
    const page = new URL(url).searchParams.get('page')!;
    return new Response(JSON.stringify(pages[page] ?? { nbPages: 3, hits: [] }), { status: 200 });
  };
  const outcome = await seedFromShowHN(context({ seenUntil: 100 }), request);
  // 최신(900)이 아니라 가장 오래된 것(110)까지만 올라간다
  expect(outcome).toMatchObject({ done: false, cursor: { seenUntil: 110 } });
  expect(mocks.enqueue.mock.calls.flatMap(([e]) => e).map((x) => x.repo)).toEqual(['acme/oldest']);
});

it('수집이나 Show HN 스위치가 꺼져 있으면 요청하지 않는다', async () => {
  const request = vi.fn(respond({ nbPages: 1, hits: [] }));
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: false };
  expect(await seedFromShowHN(context(), request)).toEqual({ done: true });
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true,
    discover: { ...DEFAULT_CRAWL_SETTINGS.discover, showHn: { enabled: false, priority: 120 } } };
  expect(await seedFromShowHN(context(), request)).toEqual({ done: true });
  expect(request).not.toHaveBeenCalled();
});

it('응답이 깨졌거나 실패하면 커서를 올리지 않는다', async () => {
  for (const bad of [respond('not json', 200), respond({ hits: 'nope' }), respond({}, 500)]) {
    mocks.enqueue.mockClear();
    const outcome = await seedFromShowHN(context({ seenUntil: 77 }), vi.fn(bad));
    expect(outcome).toMatchObject({ done: false, cursor: { seenUntil: 77 } });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  }
});

it('예산이 끊기면 처리한 곳까지만 커서를 올린다', async () => {
  let budget = true;
  mocks.enqueue.mockImplementation(async () => { budget = false; return 1; });
  const request = vi.fn(respond({ nbPages: 1, hits: [
    hit('1', 100, 'https://github.com/acme/one'),
    hit('2', 200, 'https://github.com/acme/two'),
  ] }));
  const outcome = await seedFromShowHN(context({ seenUntil: 0 }, () => budget), request);
  expect(outcome).toMatchObject({ done: false, cursor: { seenUntil: 100 } });
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
});

type Post = { id: string; at: number; url: string };
/**
 * 알골리아 search_by_date 흉내. numericFilters(쉼표는 "그리고")를 지키고 최신순으로 주며,
 * page*hitsPerPage < 1000 까지만 넘겨준다 — 1,000건 너머를 주지 않는 실제 API 상한까지 재현한다.
 * 같은 초의 게시물은 넣은 순서를 지킨다(안정 정렬).
 */
function algolia(posts: Post[]): CappedRequest {
  return async (url) => {
    const params = new URL(url).searchParams;
    const filters = (params.get('numericFilters') ?? '').split(',').filter(Boolean).map((filter) => {
      const [, op, value] = /^created_at_i(>=|<=|>|<|=)(\d+)$/.exec(filter)!;
      return (at: number) => ({ '>=': at >= +value, '<=': at <= +value, '>': at > +value, '<': at < +value, '=': at === +value })[op]!;
    });
    const matched = posts.filter((post) => filters.every((keep) => keep(post.at))).sort((a, b) => b.at - a.at);
    const perPage = Number(params.get('hitsPerPage')), page = Number(params.get('page'));
    const reachable = matched.slice(0, 1000);
    const hits = reachable.slice(page * perPage, (page + 1) * perPage).map((post) => hit(post.id, post.at, post.url));
    return new Response(JSON.stringify({ nbHits: matched.length, nbPages: Math.ceil(reachable.length / perPage), hits }), { status: 200 });
  };
}
const post = (i: number, at: number): Post => ({ id: `p${i}`, at, url: `https://github.com/acme/r${i}` });
const enqueuedRepos = (): string[] => mocks.enqueue.mock.calls.flatMap(([entries]) => entries).map((entry) => entry.repo);

/** 끝났다고 할 때까지 틱을 돌린다. 30분마다 도는 실제 스케줄을 몰아서 재현한다 */
async function drain(request: CappedRequest, cursor: ShowHnCursor, ticks = 60): Promise<ShowHnCursor> {
  for (let tick = 0; tick < ticks; tick++) {
    const outcome = await seedFromShowHN(context(cursor), request);
    cursor = outcome.cursor ?? cursor;
    if (outcome.done) return cursor;
  }
  throw new Error(`${ticks}틱 안에 끝나지 않았다`);
}

it('같은 초의 게시물 중 하나만 넣고 끊겨도, 다음 틱이 나머지를 읽는다', async () => {
  const request = algolia([
    { id: 'A', at: 500, url: 'https://github.com/acme/a' },
    { id: 'B', at: 500, url: 'https://github.com/acme/b' },
  ]);
  let budget = true;
  mocks.enqueue.mockImplementation(async (entries: unknown[]) => { budget = false; return entries.length; });
  const first = await seedFromShowHN(context({ seenUntil: 100 }, () => budget), request);
  expect(first.done).toBe(false);
  expect(enqueuedRepos()).toEqual(['acme/a']);

  mocks.enqueue.mockImplementation(async (entries: unknown[]) => entries.length);
  const second = await seedFromShowHN(context(first.cursor!), request);
  // 같은 초를 다시 읽되 이미 넣은 A는 거른다
  expect(enqueuedRepos()).toEqual(['acme/a', 'acme/b']);
  expect(second.done).toBe(true);
});

it('같은 초의 게시물이 페이지 경계에 갈라져도 놓치지 않고, 이미 본 것뿐인 페이지에 갇히지 않는다', async () => {
  // p49·p50 이 같은 초다. 최신순으로 99·100번째라 0페이지 끝과 1페이지 처음으로 갈라진다
  const posts = Array.from({ length: 150 }, (_, i) => post(i, 1000 + (i <= 49 ? i : i - 1)));
  await drain(algolia(posts), { seenUntil: 900 });
  expect(new Set(enqueuedRepos())).toEqual(new Set(posts.map((p) => `acme/r${p.id.slice(1)}`)));
});

it('1,000건 넘게 밀려도 가장 오래된 게시물까지 모두 넣는다', async () => {
  // 알골리아는 최신 1,000건까지만 넘겨준다. 나누지 않으면 가장 오래된 100건은 읽을 수 없다
  const posts = Array.from({ length: 1100 }, (_, i) => post(i, 10_000 + i));
  await drain(algolia(posts), { seenUntil: 9_000 });
  const repos = enqueuedRepos();
  expect(new Set(repos).size).toBe(1100);
  expect(repos).toContain('acme/r0');
});

it('훑는 사이 새 글이 올라와 페이지가 밀리면, 밀린 페이지로 커서를 올리지 않는다', async () => {
  const posts = Array.from({ length: 300 }, (_, i) => post(i, 1000 + i));
  const listing = algolia(posts);
  let arrived = false;
  // 첫 조회(0페이지) 직후 새 글이 하나 올라온다 — 301건이 되어 가장 오래된 글이 3페이지로 밀린다
  const request: CappedRequest = async (url, init) => {
    const response = await listing(url, init);
    if (!arrived) { arrived = true; posts.push(post(300, 5000)); }
    return response;
  };
  await drain(request, { seenUntil: 900 });
  expect(new Set(enqueuedRepos()).size).toBe(301);
  expect(enqueuedRepos()).toContain('acme/r0');
});
