import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { repoFromUrl, seedFromShowHN, SHOW_HN_SIGNAL, type ShowHnCursor } from '@/lib/crawl/jobs/hn-show';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), settings: null as CrawlSettings | null }));
vi.mock('@/lib/crawl/repository', () => ({ enqueue: mocks.enqueue }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));

const context = (cursor: ShowHnCursor | null = null, hasBudget = () => true) =>
  ({ cursor, hasBudget, save: vi.fn().mockResolvedValue(undefined), log: vi.fn() });

/** fetchCapped 의 주입점. 응답 본문만 흉내 낸다 */
const respond = (body: unknown, status = 200) => async () =>
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
  // 이미 읽은 지점 이후만 조회한다
  expect(String(request.mock.calls[0][0])).toContain('created_at_i%3E50');
});

it('밀려 있으면 오래된 페이지부터 당겨 건너뛰는 구간을 만들지 않는다', async () => {
  const pages: Record<string, unknown> = {
    '0': { nbPages: 3, hits: [hit('n', 900, 'https://github.com/acme/newest')] },
    '2': { nbPages: 3, hits: [hit('o', 110, 'https://github.com/acme/oldest')] },
  };
  const request = vi.fn(async (url: string | URL) => {
    const page = new URL(String(url)).searchParams.get('page')!;
    return new Response(JSON.stringify(pages[page] ?? { nbPages: 3, hits: [] }), { status: 200 });
  });
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
