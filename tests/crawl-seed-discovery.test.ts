import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { seedFrontier, type SeedCursor } from '@/lib/crawl/jobs/seed';

const mocks = vi.hoisted(() => ({enqueue:vi.fn(), counts:vi.fn(), search:vi.fn(), record:vi.fn(), settings:null as CrawlSettings|null}));
vi.mock('@/lib/crawl/repository', () => ({enqueue:mocks.enqueue,frontierCounts:mocks.counts}));
vi.mock('@/lib/crawl/github', () => ({searchCommits:mocks.search,searchRepositories:mocks.search,SEARCH_PER_PAGE:100,MAX_SEARCH_PAGES:10}));
vi.mock('@/lib/crawl/settings', () => ({getSettings:async () => mocks.settings,enabledQueries:(settings:CrawlSettings) => settings.discover.queries.filter(q => q.enabled)}));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({recordDiscoveryEvidenceBatch:mocks.record}));

const page = (items: unknown[], more = {}) => ({ok:true,value:{items,...more}});
const context = (cursor:SeedCursor|null = null, hasBudget = () => true) => ({cursor,hasBudget,save:vi.fn().mockResolvedValue(undefined),log:vi.fn()});
const topicQuery = {label:'topic:glm',kind:'repositories' as const,query:'topic:glm',enabled:true,builder:null,priority:50};

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(1); mocks.record.mockReset().mockResolvedValue(undefined); mocks.search.mockReset();
  mocks.counts.mockReset().mockResolvedValue({ pending: 0, fetching: 0 });
  mocks.settings = {...DEFAULT_CRAWL_SETTINGS,enabled:true,
    discover:{...DEFAULT_CRAWL_SETTINGS.discover,pagesPerTick:1,queries:[{...topicQuery}]}};
});

/**
 * 레포 검색은 결과에 homepage가 실려 오므로 배포물 없는 레포를 프론티어에 넣기 전에 거른다.
 * 거부의 78%를 만드는 no_homepage를 원천에서 없애는 경로라 회귀를 막는다.
 */
it('레포 검색: 배포 URL 없는 레포는 프론티어에 넣지 않는다', async () => {
  mocks.search.mockResolvedValue(page([
    {full_name:'acme/deployed', homepage:'https://acme.example'},
    {full_name:'acme/no-homepage', homepage:null},
    {full_name:'acme/empty-homepage', homepage:''},
    {full_name:'acme/not-a-url', homepage:'coming soon'},
    {full_name:'acme/hostless', homepage:'http://localhost'},
  ]));
  await seedFrontier(context());
  const enqueued = mocks.enqueue.mock.calls.flatMap(([items]) => items).map(item => item.repo);
  expect(enqueued).toEqual(['acme/deployed']);
});

/** 커밋 검색 결과에는 레포 메타가 없다. homepage를 모른 채 넣고 판정 단계에서 거른다. */
it('커밋 검색: homepage를 알 수 없으므로 그대로 넣는다', async () => {
  mocks.settings!.discover.queries = [{label:'Claude',kind:'commits',query:'Co-authored-by: Claude',enabled:true,builder:null,priority:100}];
  mocks.search.mockResolvedValue(page([{repository:{full_name:'acme/unknown'},sha:'a'.repeat(40),commit:{message:'fix'}}]));
  await seedFrontier(context());
  expect(mocks.enqueue.mock.calls.flatMap(([items]) => items).map(item => item.repo)).toEqual(['acme/unknown']);
});

const signal = (n: number) => ({label:`신호${n}`,kind:'commits' as const,query:`q${n}`,enabled:true,builder:null,priority:100-n});
/** 결과가 1,000건을 넘으면 창이 절반씩 쪼개진다 — 실제로 1번 신호를 붙잡아 두던 조건 */
const saturating = page(Array.from({length:100},(_,i) => ({repository:{full_name:`acme/r${i}`},sha:'a'.repeat(40),commit:{message:'fix'}})), {total_count:500_000});

it('창이 계속 쪼개지는 신호가 나머지 신호를 굶기지 않는다', async () => {
  mocks.settings!.discover.queries = Array.from({length:7},(_,i) => signal(i));
  mocks.search.mockResolvedValue(saturating);
  let cursor = null as SeedCursor | null;
  for (let tick = 0; tick < 7; tick++) cursor = (await seedFrontier(context(cursor))).cursor ?? cursor;
  const searched = new Set(mocks.search.mock.calls.map(([params]) => params.query.split(' ')[0]));
  expect([...searched].sort()).toEqual(['q0','q1','q2','q3','q4','q5','q6']);
});

it('차례가 돌아온 신호는 처음이 아니라 보관해 둔 창에서 이어간다', async () => {
  mocks.settings!.discover.queries = [signal(0), signal(1)];
  mocks.search.mockResolvedValue(saturating);
  const first = await seedFrontier(context());
  const parked = first.cursor!.states!['신호0'];
  expect(parked.pendingWindows).toHaveLength(1);

  const second = await seedFrontier(context(first.cursor!));
  expect(second.cursor?.signal).toBe('신호0');
  expect(second.cursor?.window).toEqual(parked.window);
  // 180일 창을 처음부터 다시 긁지 않는다
  const windows = mocks.search.mock.calls.map(([params]) => params.query.split('committer-date:')[1]);
  expect(windows[0]).not.toBe(windows[2]);
});

const at = (daysAgo: number) => new Date(Date.now()-daysAgo*86_400_000).toISOString().replace(/\.\d{3}Z$/,'Z');
const ranges = () => mocks.search.mock.calls.map(([p]) => p.query.split('committer-date:')[1]);

it('다음 주기는 지난 주기가 덮은 끝에서 시작한다 — 겹치지도 건너뛰지도 않는다', async () => {
  mocks.settings!.discover.queries = [signal(0)];
  mocks.settings!.discover.windowDays = 3;
  mocks.search.mockResolvedValue(page([]));

  // 6일 전까지 덮어 둔 상태에서 재개
  let cursor = (await seedFrontier(context())).cursor!;
  cursor = {...cursor, waiting:true, retryAt:undefined, cycleWindow:{from:at(9), to:at(6)}};
  mocks.search.mockClear();

  for (let tick = 0; tick < 3; tick++) cursor = (await seedFrontier(context(cursor))).cursor ?? cursor;

  const searched = ranges();
  // 덮은 끝(6일 전)에서 시작하고, 조각이 빈틈없이 이어진다
  expect(searched[0].split('..')[0]).toBe(at(6));
  for (let i = 1; i < searched.length; i++) {
    expect(searched[i].split('..')[0]).toBe(searched[i-1].split('..')[1]);
  }
  // 같은 구간을 두 번 검색하지 않는다
  expect(new Set(searched).size).toBe(searched.length);
});

it('따라잡으면 검색을 쓰지 않고 기다린다', async () => {
  mocks.settings!.discover.queries = [signal(0)];
  mocks.search.mockResolvedValue(page([]));
  let cursor = (await seedFrontier(context())).cursor!;
  // 첫 주기는 지금까지 덮었다 → 더 훑을 구간이 없다
  const outcome = await seedFrontier(context(cursor));
  expect(outcome.cursor).toMatchObject({waiting:true});
  const before = mocks.search.mock.calls.length;
  // 대기 시각이 지나도, 덮지 않은 구간이 없으면 검색을 쓰지 않는다
  cursor = {...outcome.cursor!, retryAt:undefined};
  for (let tick = 0; tick < 3; tick++) cursor = (await seedFrontier(context({...cursor, retryAt:undefined}))).cursor ?? cursor;
  expect(mocks.search.mock.calls.length).toBe(before);
});
