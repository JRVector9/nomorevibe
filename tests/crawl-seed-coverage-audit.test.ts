import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { seedFrontier, type SeedCursor } from '@/lib/crawl/jobs/seed';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';

const fixture = vi.hoisted(() => ({ settings:null as CrawlSettings|null, search:vi.fn(), progress:vi.fn(), enqueue:vi.fn() }));
vi.mock('@/lib/observability/logger', () => ({logger:{info:vi.fn(),warn:vi.fn()}}));
vi.mock('@/lib/crawl/settings', () => ({getSettings:async()=>fixture.settings,
  enabledQueries:(settings:CrawlSettings)=>settings.discover.queries.filter(q=>q.enabled)}));
vi.mock('@/lib/crawl/github', () => ({searchCommits:fixture.search,searchRepositories:fixture.search,SEARCH_PER_PAGE:100,MAX_SEARCH_PAGES:10}));
vi.mock('@/lib/crawl/review-backlog', async original => ({...await original<typeof import('@/lib/crawl/review-backlog')>(),
  readReviewBacklog:async()=>({recentNew:0,queuedRepositories:0,downstreamRepositories:0})}));
vi.mock('@/lib/crawl/shared-discovery', () => ({sharedDiscoverySearch:async (_input:unknown,load:()=>Promise<unknown>)=>load(),
  enqueueDiscoveryBatch:async (items:unknown[])=>{fixture.enqueue(items);return {added:0,processed:items.length,remainingNew:250};}}));
vi.mock('@/lib/crawl/discovery-progress', () => ({recordDiscoveryProgress:fixture.progress}));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({recordDiscoveryEvidenceBatch:vi.fn()}));

const query = (label:string) => ({label,kind:'commits' as const,query:label,enabled:true,builder:null,priority:100});
const empty = () => ({ok:true,value:{items:[],incomplete_results:false,total_count:0}});
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
const old = {from:'2026-10-01T00:00:00Z',to:'2026-10-04T00:00:00Z'};
const context = (cursor:SeedCursor|null=null) => ({cursor,hasBudget:()=>true,save:vi.fn(),log:vi.fn()});
function legacy():SeedCursor {
  const d=fixture.settings!.discover;
  const signatures=Object.fromEntries(d.queries.map(q=>[q.label,hash(q.kind+'\0'+q.query+'\0'+d.windowDays)]));
  return {signal:d.queries[0].label,page:1,window:old,cycleWindow:old,pendingWindows:[],states:{},doneSignals:[],
    configHash:hash(JSON.stringify({queries:d.queries.map(q=>[q.label,q.kind,q.query]),sort:d.sort,windowDays:d.windowDays})),
    queryHash:signatures[d.queries[0].label],querySignatures:signatures,searchSort:d.sort};
}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
  fixture.search.mockReset().mockImplementation(async()=>empty());fixture.progress.mockReset();fixture.enqueue.mockReset();
  fixture.settings={...DEFAULT_CRAWL_SETTINGS,enabled:true,discover:{...DEFAULT_CRAWL_SETTINGS.discover,
    sort:'relevance',pagesPerTick:2,queries:[query('slow'),query('fast')]}};
});
afterEach(()=>vi.useRealTimers());

it('advances a healthy query beyond the old dates while a peer keeps failing',async()=>{
  fixture.search.mockImplementation(async p=>p.query.startsWith('slow ') ? {ok:false,error:{kind:'invalid_response'}} : empty());
  let cursor=legacy();
  for(let n=0;n<5;n++) cursor=(await seedFrontier(context(cursor))).cursor!;
  const healthy=fixture.search.mock.calls.filter(([p])=>p.query.startsWith('fast '));
  expect(healthy.some(([p])=>p.query.includes('2026-10-04T00:00:00Z..2026-10-07T00:00:00Z'))).toBe(true);
});

it('opens a new date range for every woken query before making a search',async()=>{
  let cursor=(await seedFrontier(context())).cursor!;
  const finished=fixture.search.mock.calls.map(([p])=>p.query);
  expect(finished).toHaveLength(2);
  vi.advanceTimersByTime(60_000);
  fixture.search.mockClear();
  cursor=(await seedFrontier(context(cursor))).cursor!;
  const resumed=fixture.search.mock.calls.map(([p])=>p.query);
  expect(resumed).toHaveLength(2);
  expect(resumed.every(q=>!finished.includes(q))).toBe(true);
  expect(new Set(resumed.map(q=>q.split('committer-date:')[1]))).toEqual(new Set(['2026-11-13T00:00:00Z..2026-11-13T00:01:00Z']));
});

it('keeps completed coverage below an unfinished pending split during retry selection',async()=>{
  fixture.settings!.discover.queries=[query('slow')];
  fixture.settings!.discover.pagesPerTick=1;
  const cursor=legacy();
  const minimum={from:old.from,to:old.from};
  cursor.window=minimum;
  cursor.pendingWindows=[{from:'2026-10-01T00:00:01Z',to:old.to}];
  cursor.incompleteWindows=[{signal:'slow',window:minimum,retryAt:new Date(0).toISOString()}];
  fixture.search.mockResolvedValue(empty());
  const next=(await seedFrontier(context(cursor))).cursor!;
  expect(next.incompleteWindows).toEqual([]);
  expect(fixture.progress.mock.calls.some(([p])=>p.completedThrough===old.to)).toBe(false);
});

it('retains disabled queries and their unresolved ranges when adopting the fresh latest cursor',async()=>{
  fixture.settings!.discover.queries=[query('fast')];
  fixture.settings!.discover.sort='recent';
  const base=legacy();
  const covered={from:'2026-11-10T00:00:00Z',to:'2026-11-13T00:00:00Z'};
  const incomplete={signal:'disabled',window:{from:old.from,to:old.from},retryAt:'2026-11-14T00:00:00Z'};
  const retired={page:2,window:incomplete.window,cycleWindow:old,pendingWindows:[],phase:'retry' as const};
  const settled:SeedCursor={...base,cursorVersion:3,coverageVersion:2,window:covered,cycleWindow:covered,
    waiting:true,retryAt:'2026-11-13T01:00:00Z',states:{},
    querySignatures:{...base.querySignatures,disabled:hash('commits\0disabled\0'+fixture.settings!.discover.windowDays)}};
  const cursor={...base,latestScan:{...settled,states:{disabled:retired},incompleteWindows:[incomplete]},
    latestHead:{...settled,incompleteWindows:[]},latestTurn:true};
  const result=(await seedFrontier(context(cursor))).cursor!;
  expect(result.latestHead).toBeUndefined();
  expect(result.latestScan?.states?.disabled).toEqual(retired);
  expect(result.latestScan?.incompleteWindows).toContainEqual(incomplete);
  fixture.settings!.discover.queries.push(query('disabled'));
  vi.advanceTimersByTime(60*60_000);
  fixture.search.mockClear();
  let resumed=result;
  for(let tick=0;tick<4;tick++) resumed=(await seedFrontier(context(resumed))).cursor!;
  expect(fixture.search.mock.calls.some(([p])=>p.page===2 && p.query===`disabled is:public committer-date:${old.from}..${old.from}`)).toBe(true);
});

it('does not consume the latest head archive when a disabled query still owns a partial page',async()=>{
  fixture.settings!.discover.queries=[query('fast')];
  fixture.settings!.discover.sort='recent';
  const base=legacy();
  const covered={from:'2026-11-10T00:00:00Z',to:'2026-11-13T00:00:00Z'};
  const partial={items:[{repo:'a/saved',sha:null,attributions:[null],attributionLimited:false}],
    itemIndex:0,size:1,incomplete:false,saturated:false,capped:false};
  const settled:SeedCursor={...base,cursorVersion:3,coverageVersion:2,window:covered,cycleWindow:covered,
    waiting:true,retryAt:'2026-11-13T01:00:00Z',states:{},
    querySignatures:{...base.querySignatures,disabled:hash('commits\0disabled\0'+fixture.settings!.discover.windowDays)}};
  const cursor={...base,latestScan:{...settled,states:{disabled:{page:2,window:old,cycleWindow:old,pendingWindows:[],pendingPage:partial}}},
    latestHead:{...settled,states:{disabled:{page:1,window:covered,cycleWindow:covered,pendingWindows:[]}}}};
  const result=(await seedFrontier(context(cursor))).cursor!;
  expect(result.latestHead).toBeDefined();
  expect(result.latestScan?.states?.disabled?.pendingPage).toEqual(partial);
  expect(result.latestHead?.states?.disabled?.window).toEqual(covered);
});

it('keeps both bounded retry archives when their union would exceed the queue limit',async()=>{
  fixture.settings!.discover.queries=[query('fast')];
  fixture.settings!.discover.sort='recent';
  const base=legacy();
  const covered={from:'2026-11-10T00:00:00Z',to:'2026-11-13T00:00:00Z'};
  const settled:SeedCursor={...base,cursorVersion:3,coverageVersion:2,window:covered,cycleWindow:covered,
    waiting:true,retryAt:'2026-11-13T01:00:00Z',states:{}};
  const archived=Array.from({length:128},(_,i)=>({signal:'disabled',
    window:{from:new Date(i*1000).toISOString(),to:new Date(i*1000).toISOString()},retryAt:'2026-11-14T00:00:00Z'}));
  const headRetry=[{signal:'fast',window:old,retryAt:'2026-11-14T00:00:00Z'}];
  const result=(await seedFrontier(context({...base,latestScan:{...settled,incompleteWindows:archived},
    latestHead:{...settled,incompleteWindows:headRetry}}))).cursor!;
  expect(result.latestScan?.incompleteWindows).toEqual(archived);
  expect(result.latestHead?.incompleteWindows).toEqual(headRetry);
});
