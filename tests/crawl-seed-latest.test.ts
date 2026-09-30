import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { seedFrontier, LATEST_SCAN_INTERVAL_MS, type SeedCursor } from '@/lib/crawl/jobs/seed';

const mocks = vi.hoisted(() => ({ enqueue:vi.fn(), counts:vi.fn(), search:vi.fn(), record:vi.fn(), settings:null as CrawlSettings|null }));
vi.mock('@/lib/crawl/repository', () => ({ enqueue:mocks.enqueue, frontierCounts:mocks.counts }));
vi.mock('@/lib/crawl/github', () => ({ searchCommits:mocks.search, searchRepositories:mocks.search, SEARCH_PER_PAGE:100, MAX_SEARCH_PAGES:10 }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings:async () => mocks.settings, enabledQueries:(s:CrawlSettings) => s.discover.queries.filter(q => q.enabled) }));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({ recordDiscoveryEvidenceBatch:mocks.record }));

const one = { label:'Claude', kind:'commits' as const, query:'Claude', enabled:true, builder:null, priority:100 };
const page = (full = false) => ({ ok:true, value:{ items:Array.from({length:full ? 100 : 1}, (_,i) => ({repository:{full_name:`a/r${i}`}})), total_count:full ? 500_000 : 1 } });
const ctx = (cursor:SeedCursor|null = null) => ({ cursor, hasBudget:() => true, save:vi.fn().mockResolvedValue(undefined), log:vi.fn() });
const range = (query:string) => query.split('committer-date:')[1];
const oldWindow = { from:'2026-09-15T00:00:00Z', to:'2026-09-18T00:00:00Z' };
async function oldCursor():Promise<SeedCursor> {
  mocks.settings!.discover.sort = 'relevance';
  mocks.search.mockResolvedValue(page(true));
  const cursor = (await seedFrontier(ctx())).cursor!;
  mocks.search.mockClear(); mocks.record.mockClear(); mocks.enqueue.mockClear();
  mocks.settings!.discover.sort = 'recent';
  return { ...cursor, page:4, window:oldWindow, cycleWindow:oldWindow, pendingWindows:[], states:{}, doneSignals:[] };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  mocks.enqueue.mockReset().mockImplementation(async (rows:unknown[]) => rows.length);
  mocks.record.mockReset().mockResolvedValue(undefined);
  mocks.search.mockReset(); mocks.counts.mockReset().mockResolvedValue({ pending:0 });
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled:true,
    discover:{ ...DEFAULT_CRAWL_SETTINGS.discover, sort:'recent', pagesPerTick:1, queries:[one] } };
});
afterEach(() => vi.useRealTimers());

it('defaults to latest activity and explores the newer half first while retaining the older half', async () => {
  expect(DEFAULT_CRAWL_SETTINGS.discover.sort).toBe('recent');
  mocks.search.mockResolvedValue(page(true));
  const first = (await seedFrontier(ctx())).cursor!;
  const original = range(mocks.search.mock.calls[0][0].query).split('..');
  expect(first.window!.to).toBe(original[1]);
  expect(first.pendingWindows).toEqual([{from:original[0],to:expect.any(String)}]);
  expect(Date.parse(first.window!.from) - Date.parse(first.pendingWindows![0].to)).toBe(1000);
  await seedFrontier(ctx(first));
  expect(range(mocks.search.mock.calls[1][0].query)).toBe(`${first.window!.from}..${first.window!.to}`);
});

it('searches the latest range before old work, preserving the old coverage on a sort-only change', async () => {
  const old = await oldCursor();
  mocks.settings!.discover.pagesPerTick = 2;
  mocks.search.mockResolvedValue(page(true));
  const result = (await seedFrontier(ctx(old))).cursor!;
  expect(mocks.search.mock.calls).toHaveLength(2);
  expect(range(mocks.search.mock.calls[0][0].query)).toBe('2026-09-28T00:00:00Z..2026-10-01T00:00:00Z');
  expect(mocks.search.mock.calls[1][0]).toMatchObject({sort:'recent',page:1});
  expect(range(mocks.search.mock.calls[1][0].query)).toBe(`${oldWindow.from}..${oldWindow.to}`);
  expect(result.cycleWindow).toEqual(oldWindow);
  expect(result.latestScan).toMatchObject({waiting:true,cycleWindow:{to:'2026-10-01T00:00:00Z'}});
  // The preview's capped first page does not mark the old complete scan as covered.
  expect(result.window!.from).not.toBe(oldWindow.from);
  expect(result.pendingWindows![0].from).toBe(oldWindow.from);
  expect(mocks.record.mock.calls[0][0].every((r:{incomplete:boolean}) => r.incomplete)).toBe(true);
});

it('with one page per tick alternates latest and full coverage, then uses idle preview turns for old work', async () => {
  let cursor = await oldCursor();
  mocks.settings!.discover.queries.push({...one,label:'Codex',query:'Codex'});
  // Regenerate a valid two-query historical cursor before aging it.
  mocks.settings!.discover.sort = 'relevance';
  cursor = (await seedFrontier(ctx())).cursor!;
  cursor = {...cursor,window:oldWindow,cycleWindow:oldWindow,states:{},pendingWindows:[]};
  mocks.settings!.discover.sort = 'recent'; mocks.search.mockClear();
  for (let i=0;i<4;i++) cursor = (await seedFrontier(ctx(cursor))).cursor!;
  const queries = mocks.search.mock.calls.map(([p]) => p.query);
  expect(range(queries[0])).toContain('2026-10-01');
  expect(range(queries[1])).toContain('2026-09-18');
  expect(range(queries[2])).toContain('2026-10-01');
  expect(range(queries[3])).not.toContain('2026-10-01');
});

it('does not repeat the latest preview before its interval, then refreshes it while retaining old work', async () => {
  let cursor = await oldCursor();
  mocks.settings!.discover.pagesPerTick = 2;
  mocks.search.mockResolvedValue(page(true));
  cursor = (await seedFrontier(ctx(cursor))).cursor!;
  mocks.search.mockClear();
  cursor = (await seedFrontier(ctx(cursor))).cursor!;
  expect(mocks.search.mock.calls.every(([p]) => !range(p.query).includes('2026-10-01'))).toBe(true);
  vi.advanceTimersByTime(LATEST_SCAN_INTERVAL_MS);
  mocks.search.mockClear();
  cursor = (await seedFrontier(ctx(cursor))).cursor!;
  expect(range(mocks.search.mock.calls[0][0].query)).toContain('2026-10-01T01:00:00Z');
  expect(cursor.cycleWindow).toEqual(oldWindow);
});

it('saves both cursors before side effects and resumes the preview page after a database error', async () => {
  const old = await oldCursor();
  mocks.settings!.discover.pagesPerTick = 2;
  mocks.search.mockResolvedValue(page());
  let saved:SeedCursor|null = null;
  mocks.record.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(seedFrontier({...ctx(old),save:async value => {saved=structuredClone(value);}})).rejects.toThrow('database unavailable');
  expect(saved).toMatchObject({cycleWindow:oldWindow,latestScan:{pendingPage:{itemIndex:0}}});
  expect(mocks.enqueue).not.toHaveBeenCalled();
  await seedFrontier(ctx(saved));
  // One initial preview search and one old search; the saved preview is replayed without fetching again.
  expect(mocks.search).toHaveBeenCalledTimes(2);
  expect(mocks.enqueue).toHaveBeenCalledTimes(2);
});

it('a shared auth cooldown preserves both cursors and prevents a second search in the tick', async () => {
  const old = await oldCursor();
  mocks.settings!.discover.pagesPerTick = 2;
  const resetAt = new Date(Date.now()+15*60_000);
  mocks.search.mockResolvedValue({ok:false,error:{kind:'auth_unavailable',reason:'expired',resetAt}});
  const result = (await seedFrontier(ctx(old))).cursor!;
  expect(result.cycleWindow).toEqual(oldWindow);
  expect(result.latestScan).toMatchObject({page:1,retryAt:resetAt.toISOString()});
  await seedFrontier(ctx(result));
  expect(mocks.search).toHaveBeenCalledTimes(1);
});

it('inherits backlog hysteresis so a fresh preview cannot bypass a paused queue', async () => {
  const old = {...await oldCursor(),backlogPaused:true};
  mocks.settings!.discover.pagesPerTick = 2;
  mocks.counts.mockResolvedValue({pending:6000});
  const result = (await seedFrontier(ctx(old))).cursor!;
  expect(result.latestScan?.backlogPaused).toBe(true);
  expect(mocks.search).not.toHaveBeenCalled();
  mocks.counts.mockResolvedValue({pending:5000}); mocks.search.mockResolvedValue(page());
  await seedFrontier(ctx(result));
  expect(mocks.search).toHaveBeenCalled();
});

it('sort changes reorder saved subwindows newest first without losing any old range', async () => {
  const old = await oldCursor();
  const older = {from:'2026-09-15T00:00:00Z',to:'2026-09-16T00:00:00Z'};
  const newer = {from:'2026-09-16T00:00:01Z',to:'2026-09-18T00:00:00Z'};
  mocks.settings!.discover.pagesPerTick = 2;
  mocks.search.mockResolvedValue(page());
  const result = (await seedFrontier(ctx({...old,window:older,pendingWindows:[newer]}))).cursor!;
  expect(range(mocks.search.mock.calls[1][0].query)).toBe(`${newer.from}..${newer.to}`);
  // Newer range completed; the older range remains next to be searched, not dropped.
  expect(result.window).toEqual(older);
  expect(result.cycleWindow).toEqual(oldWindow);
});

it('one-page alternation also respects the shared auth wait before selecting old work', async () => {
  const old = await oldCursor();
  mocks.search.mockResolvedValue({ok:false,error:{kind:'auth_unavailable',resetAt:new Date(Date.now()+600_000)}});
  const first = (await seedFrontier(ctx(old))).cursor!;
  expect(first.latestTurn).toBe(false);
  const waiting = (await seedFrontier(ctx(first))).cursor!;
  expect(waiting).toEqual(first);
  expect(mocks.search).toHaveBeenCalledTimes(1);
});

it('marks a full preview page incomplete even below the 1000-result split threshold', async () => {
  const old = await oldCursor();
  mocks.settings!.discover.pagesPerTick = 2;
  mocks.search.mockResolvedValue({ok:true,value:{...page(true).value,total_count:200,incomplete_results:false}});
  await seedFrontier(ctx(old));
  expect(mocks.record.mock.calls[0][0]).toHaveLength(100);
  expect(mocks.record.mock.calls[0][0].every((r:{incomplete:boolean}) => r.incomplete)).toBe(true);
});
