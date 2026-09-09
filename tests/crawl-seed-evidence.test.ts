import { beforeEach, expect, it, vi } from 'vitest';
import { ADDITIONAL_AGENT_DISCOVERY_QUERIES, DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { seedFrontier, type SeedCursor } from '@/lib/crawl/jobs/seed';
const mocks = vi.hoisted(() => ({enqueue:vi.fn(), counts:vi.fn(), search:vi.fn(), record:vi.fn(), settings:null as CrawlSettings|null}));
vi.mock('@/lib/crawl/repository', () => ({enqueue:mocks.enqueue,frontierCounts:mocks.counts}));
vi.mock('@/lib/crawl/github', () => ({searchCommits:mocks.search,searchRepositories:mocks.search,SEARCH_PER_PAGE:100,MAX_SEARCH_PAGES:10}));
vi.mock('@/lib/crawl/settings', () => ({getSettings:async () => mocks.settings,enabledQueries:(settings:CrawlSettings) => settings.discover.queries.filter(q => q.enabled)}));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({recordDiscoveryEvidence:mocks.record}));
const commit = (repo:string, message = 'fix\n\nCo-authored-by: Codex <private@example.com>') => ({repository:{full_name:repo},sha:'a'.repeat(40),commit:{message}});
const page = (items: unknown[], more = {}) => ({ok:true,value:{items,...more}});
const context = (cursor:SeedCursor|null = null, hasBudget = () => true) => ({cursor,hasBudget,save:vi.fn().mockResolvedValue(undefined),log:vi.fn()});
beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(1); mocks.record.mockReset().mockResolvedValue(undefined); mocks.search.mockReset();
  mocks.counts.mockReset().mockResolvedValue({ pending: 0, fetching: 0 });
  mocks.settings = {...DEFAULT_CRAWL_SETTINGS,enabled:true,discover:{...DEFAULT_CRAWL_SETTINGS.discover,pagesPerTick:1,queries:[{label:'Codex hint',kind:'commits',query:'Co-authored-by: Codex',enabled:true,builder:'Codex',priority:90}]}};
});
it('pauses within a saved page at 10000 and resumes below 5000 without refetching', async () => {
  mocks.counts.mockResolvedValue({ pending: 9998, fetching: 1 });
  mocks.search.mockResolvedValue(page([commit('acme/one'),commit('acme/two')]));
  const first = await seedFrontier(context());
  expect(first.cursor).toMatchObject({ backlogPaused:true,pendingPage:{itemIndex:1} });
  mocks.counts.mockResolvedValue({ pending: 5001 });
  const waiting = await seedFrontier(context(first.cursor!));
  expect(waiting.cursor).toEqual(first.cursor);
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  mocks.counts.mockResolvedValue({ pending: 5000 });
  const resumed = await seedFrontier(context(waiting.cursor!));
  expect(resumed.done).toBe(true);
  expect(mocks.search).toHaveBeenCalledTimes(1);
  expect(mocks.enqueue.mock.calls.flatMap(([items]) => items).map(item => item.repo)).toEqual(['acme/one','acme/two']);
});
it('does not turn a search hint into a project builder', async () => {
  mocks.search.mockResolvedValue(page([commit('acme/app')]));
  await seedFrontier(context());
  expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({repo:'acme/app',builder:null})]);
});
it.each(ADDITIONAL_AGENT_DISCOVERY_QUERIES)('$label finds candidates without assigning a builder', async query => {
  mocks.settings!.discover.queries = [{...query}];
  mocks.search.mockResolvedValue(page(query.kind === 'commits' ? [commit('acme/app')] : [{full_name:'acme/app',homepage:'https://app.example'}]));
  await seedFrontier(context());
  expect(mocks.enqueue).toHaveBeenCalledWith([{repo:'acme/app',signal:query.label,priority:query.priority,builder:null}]);
});
it('persists normalized pending items and resumes within a page after budget expiry', async () => {
  mocks.search.mockResolvedValue(page([commit('acme/one'),commit('acme/two')]));
  let budget = true;
  mocks.record.mockImplementationOnce(async () => {budget = false;});
  const first = await seedFrontier(context(null,() => budget));
  expect(first.done).toBe(false);
  expect(mocks.record).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(first.cursor)).not.toContain('private@example.com');
  expect(JSON.stringify(first.cursor)).not.toContain('Co-authored-by:');
  budget = true;
  const resumed = await seedFrontier(context(first.cursor!));
  expect(resumed.done).toBe(true);
  expect(mocks.search).toHaveBeenCalledTimes(1);
  expect(mocks.record.mock.calls.map(([input]) => input.repositoryKey)).toEqual(['acme/one','acme/two']);
  expect(mocks.enqueue.mock.calls.flatMap(([items]) => items).map(item => item.repo)).toEqual(['acme/one','acme/two']);
});
it('caps a hostile commit attribution block and marks truncated evidence incomplete', async () => {
  const names = Array.from({length:50},(_,i) => `Co-authored-by: Person ${i} <private${i}@example.com>`).join('\n');
  mocks.search.mockResolvedValue(page([commit('acme/app',`fix\n\n${names}`)]));
  await seedFrontier(context());
  expect(mocks.record.mock.calls.length).toBeLessThanOrEqual(8);
  expect(mocks.record.mock.calls.every(([input]) => input.incomplete)).toBe(true);
});
it('durably retains a zero-result incomplete minimal window and waits before retrying', async () => {
  mocks.search.mockResolvedValue(page([], {incomplete_results:true,total_count:0}));
  const first = await seedFrontier(context());
  const second = await seedFrontier(context({...first.cursor!,window:{from:'2026-09-01T00:00:00Z',to:'2026-09-01T00:00:00Z'},pendingWindows:[]}));
  expect(second.done).toBe(false);
  expect(second.cursor?.incompleteWindows).toEqual([expect.objectContaining({window:{from:'2026-09-01T00:00:00Z',to:'2026-09-01T00:00:00Z'}})]);
  expect(second.cursor?.retryAt).toBeTruthy();
  const count = mocks.search.mock.calls.length;
  await seedFrontier(context(second.cursor!));
  expect(mocks.search).toHaveBeenCalledTimes(count);
  expect(mocks.record).not.toHaveBeenCalled();
});
it('continues accessible pages of an unsplittable incomplete window before retrying it', async () => {
  mocks.search.mockResolvedValue(page(Array.from({length:100},() => commit('acme/app')),{incomplete_results:true,total_count:1200}));
  const first = await seedFrontier(context());
  const next = await seedFrontier(context({...first.cursor!,window:{from:'2026-09-01T00:00:00Z',to:'2026-09-01T00:00:00Z'},pendingWindows:[],page:1}));
  expect(next.cursor).toMatchObject({page:2});
});
it('invalidates retry delay on query or sort configuration edits', async () => {
  mocks.search.mockResolvedValue({ok:false,error:{kind:'rate_limited',resetAt:new Date(Date.now()+86400000)}});
  const first = await seedFrontier(context());
  mocks.settings!.discover.sort = 'recent';
  mocks.search.mockResolvedValue(page([commit('acme/new')]));
  const second = await seedFrontier(context(first.cursor!));
  expect(second.done).toBe(true);
  expect(mocks.search).toHaveBeenCalledTimes(2);
  expect(mocks.search.mock.calls[1][0]).toMatchObject({sort:'recent',page:1});
});
it('retains unresolved windows across other signals and resumes fresh discovery after a retry', async () => {
  mocks.settings!.discover.queries.push({label:'Kimi',kind:'commits',query:'Kimi',enabled:true,builder:null,priority:80});
  mocks.search.mockResolvedValue(page([], {incomplete_results:true}));
  // 1번 신호가 창을 쪼개면 남은 절반을 자기 상태에 보관하고 차례를 넘긴다
  const first = await seedFrontier(context());
  expect(first.cursor?.signal).toBe('Kimi');
  expect(first.cursor?.states?.['Codex hint'].pendingWindows).toHaveLength(1);
  // 더 쪼갤 수 없는 창은 미완으로 남기고 다시 1번 신호에게 차례를 넘긴다
  const minimum = {from:'2026-09-01T00:00:00Z',to:'2026-09-01T00:00:00Z'};
  const pending = await seedFrontier(context({...first.cursor!,window:minimum,pendingWindows:[]}));
  expect(pending.cursor?.signal).toBe('Codex hint');
  expect(pending.cursor?.incompleteWindows).toMatchObject([{signal:'Kimi',window:minimum}]);
  // 1번 신호가 보관해 둔 절반을 마저 본다 (Kimi는 이번 주기를 마쳤으므로 차례가 가지 않는다)
  mocks.search.mockResolvedValue(page([]));
  const drained = await seedFrontier(context(pending.cursor!));
  expect(drained.cursor).toMatchObject({signal:'Codex hint',phase:'discovery'});
  // 모든 신호가 주기를 마치면 미완으로 남겨둔 창을 다시 본다
  const finishedOther = await seedFrontier(context(drained.cursor!));
  expect(finishedOther.cursor).toMatchObject({phase:'retry',signal:'Kimi',window:minimum});
  // 미완 창까지 마치면 덮을 것이 없다 — 새로 쌓일 때까지 검색하지 않고 기다린다
  const retried = await seedFrontier(context({...finishedOther.cursor!,retryAt:new Date(0).toISOString()}));
  expect(retried.cursor).toMatchObject({incompleteWindows:[],waiting:true});
  // 시간이 지나 덮지 않은 구간이 생기면 첫 신호부터 새 주기를 연다
  const searches = mocks.search.mock.calls.length;
  const nextCycle = await seedFrontier(context({...retried.cursor!,retryAt:new Date(0).toISOString(),
    cycleWindow:{from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z'}}));
  expect(nextCycle.cursor).toMatchObject({phase:'discovery',incompleteWindows:[]});
  // 새 주기의 첫 검색은 첫 신호로, 지난 주기가 덮은 끝에서 시작한다
  expect(mocks.search.mock.calls[searches][0].query)
    .toBe('Co-authored-by: Codex committer-date:2026-01-02T00:00:00Z..2026-01-05T00:00:00Z');
});
it('retries a failed database write at the saved attribution offset without refetching', async () => {
  mocks.search.mockResolvedValue(page([commit('acme/app','fix\n\nCo-authored-by: Codex <a@example.com>\nCo-authored-by: Claude <b@example.com>')]));
  let saved:SeedCursor|null = null;
  const ctx = {...context(),save:vi.fn(async (cursor:SeedCursor) => {saved = structuredClone(cursor);})};
  mocks.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(seedFrontier(ctx)).rejects.toThrow('DB unavailable');
  expect(saved).toMatchObject({pendingPage:{attributionIndex:1,itemIndex:0}});
  mocks.record.mockResolvedValue(undefined);
  await seedFrontier(context(saved));
  expect(mocks.search).toHaveBeenCalledTimes(1);
  expect(mocks.record.mock.calls.map(([input]) => input.attribution.client)).toEqual(['codex','claude-code','claude-code']);
});
