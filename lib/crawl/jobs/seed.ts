import { createHash } from 'node:crypto';
import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import * as crawl from '@/lib/crawl/repository';
import { normalizeUrl } from '@/lib/net/normalize';
import { getSettings, enabledQueries } from '@/lib/crawl/settings';
import { searchCommits, searchRepositories, SEARCH_PER_PAGE, MAX_SEARCH_PAGES, type CommitSearchResult, type RepositorySearchResult } from '@/lib/crawl/github';
import { recordDiscoveryEvidence } from '@/lib/domain/evidence/agents/repository';
import { parseCommitAttributions, type CommitAttribution } from '@/lib/domain/evidence/agents/commit-attribution';
import { splitSearchWindow, type SearchWindow } from '@/lib/crawl/search-window';

export const MAX_SEED_ATTRIBUTIONS = 8;
export const SEED_BACKLOG_PAUSE = 10_000;
export const SEED_BACKLOG_RESUME = 5_000;
const INCOMPLETE_RETRY_MS = 60 * 60_000;
/** 몇 초짜리 구간을 훑자고 신호마다 검색을 한 번씩 쓰지는 않는다. 이만큼 쌓이면 그때 본다 */
const MIN_CYCLE_SPAN_MS = 60_000;
const MAX_INCOMPLETE_WINDOWS = 128;
type PendingItem = {repo:string; sha:string|null; attributions:(CommitAttribution|null)[]; attributionLimited:boolean};
type PendingPage = {items:PendingItem[]; itemIndex:number; attributionIndex:number; size:number; incomplete:boolean; saturated:boolean; capped:boolean};
type IncompleteWindow = {signal:string; window:SearchWindow; retryAt:string};
/** 차례를 넘길 때 보관하는 신호별 진행 위치. 페이지 경계에서만 저장하므로 pendingPage는 담지 않는다 */
type SignalState = {page:number; window:SearchWindow; pendingWindows:SearchWindow[]; windowIncomplete?:boolean};
export type SeedCursor = {
  signal:string; page:number; queryHash?:string; configHash?:string;
  window?:SearchWindow; cycleWindow?:SearchWindow; pendingWindows?:SearchWindow[];
  retryAt?:string; pendingPage?:PendingPage; windowIncomplete?:boolean;
  incompleteWindows?:IncompleteWindow[]; phase?:'discovery'|'retry';
  backlogPaused?:boolean;
  /** 신호별로 어디까지 봤는지. 차례가 돌아오면 여기서 이어간다 */
  states?:Record<string,SignalState>;
  /** 이번 주기의 창을 다 본 신호. 다시 차례를 주지 않는다 */
  doneSignals?:string[];
  /** 덮은 구간을 따라잡아 더 훑을 것이 없는 상태. 검색하기 전에 새 구간부터 확인한다 */
  waiting?:boolean;
};
const iso = (date:Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const sameWindow = (a:SearchWindow,b:SearchWindow) => a.from === b.from && a.to === b.to;

/** Search finds candidates; stored cursors contain bounded normalized facts, never commit messages. */
export async function seedFrontier(ctx:JobContext<SeedCursor>):Promise<JobOutcome<SeedCursor>> {
  const settings = await getSettings();
  if (!settings.enabled) return {done:true};
  const queries = enabledQueries(settings);
  if (!queries.length) return {done:true};
  const spanMs = settings.discover.windowDays*86_400_000;
  /**
   * 훑을 구간을 from 에서 windowDays 만큼 잘라 낸다. 끝은 지금을 넘지 않는다.
   * 뒤처져 있으면 이 조각을 이어 붙여 따라잡고, 따라잡았으면 지금까지만 본다.
   */
  const chunkFrom = (from:number):SearchWindow => ({from:iso(new Date(from)),to:iso(new Date(Math.min(Date.now(),from+spanMs)))});
  const freshWindow = ():SearchWindow => chunkFrom(Date.now()-spanMs);
  // Sort and every active query participate: an edited configuration cannot replay old page data or retry delays.
  const configHash = createHash('sha256').update(JSON.stringify({queries,sort:settings.discover.sort,windowDays:settings.discover.windowDays})).digest('hex');
  const queryHash = (index:number) => createHash('sha256').update(queries[index].kind+'\0'+queries[index].query+'\0'+settings.discover.windowDays).digest('hex');
  const resumedIndex = queries.findIndex(q => q.label === ctx.cursor?.signal);
  const matches = ctx.cursor?.configHash === configHash && resumedIndex >= 0 && ctx.cursor.queryHash === queryHash(resumedIndex);
  let index = matches ? resumedIndex : 0;
  let initial = matches && ctx.cursor?.cycleWindow ? ctx.cursor.cycleWindow : freshWindow();
  let cursor:SeedCursor = matches ? structuredClone(ctx.cursor!) : {
    signal:queries[0].label,page:1,queryHash:queryHash(0),configHash,window:initial,cycleWindow:initial,pendingWindows:[],incompleteWindows:[],phase:'discovery',states:{},doneSignals:[],
  };
  const counts = await crawl.frontierCounts();
  let backlog = (counts.pending ?? 0) + (counts.fetching ?? 0);
  const shouldPause = () => backlog >= SEED_BACKLOG_PAUSE || (cursor.backlogPaused === true && backlog > SEED_BACKLOG_RESUME);
  if (shouldPause()) {
    cursor.backlogPaused = true;
    await ctx.save(cursor);
    ctx.log('crawl.seed_backlog_paused', { backlog, resumeAt: SEED_BACKLOG_RESUME });
    return { done: false, cursor };
  }
  delete cursor.backlogPaused;
  if (cursor.retryAt && Date.parse(cursor.retryAt) > Date.now()) return {done:false,cursor};
  delete cursor.retryAt;
  let discovered = 0;
  const save = () => ctx.save(cursor);
  const defer = async () => {await save(); return {done:false,cursor};};
  const resetWindow = (next:SearchWindow) => {
    cursor = {...cursor,page:1,window:next,windowIncomplete:false};
    delete cursor.pendingPage;
  };
  const park = () => {
    cursor.states = {...cursor.states,[cursor.signal]:{
      page:cursor.page,window:cursor.window ?? initial,
      pendingWindows:[...(cursor.pendingWindows ?? [])],windowIncomplete:cursor.windowIncomplete,
    }};
  };
  /**
   * 다음 신호에게 차례를 넘긴다.
   *
   * 넓은 검색어는 결과가 1,000건을 넘어 창이 절반씩 계속 쪼개진다. 한 신호를 끝까지 파고들면
   * 뒤 신호는 차례를 받지 못한다 — 실측에서 180일 창이 4분까지 쪼개진 채 1번 신호에 머물러
   * 나머지 여섯 신호가 한 건도 수집되지 않았다. 페이지 하나마다 차례를 넘기고 각 신호가
   * 어디까지 봤는지는 따로 보관한다.
   */
  const rotate = () => {
    park();
    const finished = new Set(cursor.doneSignals ?? []);
    for (let step = 1; step <= queries.length; step++) {
      const next = (index + step) % queries.length;
      if (finished.has(queries[next].label) && step < queries.length) continue;
      index = next; break;
    }
    const saved = cursor.states?.[queries[index].label];
    cursor = {...cursor,signal:queries[index].label,queryHash:queryHash(index),
      page:saved?.page ?? 1,window:saved?.window ?? initial,
      pendingWindows:saved?.pendingWindows ?? [],windowIncomplete:saved?.windowIncomplete};
    delete cursor.pendingPage;
  };
  const clearIncomplete = () => {
    cursor.incompleteWindows = (cursor.incompleteWindows ?? []).filter(entry => !(entry.signal === cursor.signal && sameWindow(entry.window,cursor.window ?? initial)));
  };
  const retainIncomplete = ():boolean => {
    const entries = [...(cursor.incompleteWindows ?? [])];
    const item = {signal:cursor.signal,window:cursor.window ?? initial,retryAt:new Date(Date.now()+INCOMPLETE_RETRY_MS).toISOString()};
    const existing = entries.findIndex(entry => entry.signal === item.signal && sameWindow(entry.window,item.window));
    if (existing >= 0) entries[existing] = item;
    else if (entries.length < MAX_INCOMPLETE_WINDOWS) entries.push(item);
    else {
      // Preserve this current window as well as the full bounded queue; never silently drop coverage.
      cursor.retryAt = item.retryAt;
      cursor.page = 1;
      cursor.windowIncomplete = false;
      ctx.log('crawl.seed_incomplete_queue_full',{windows:entries.length});
      return false;
    }
    cursor.incompleteWindows = entries;
    return true;
  };
  /**
   * 다음 주기를 지난 주기가 덮은 끝에서 시작한다.
   *
   * 지금까지는 주기가 끝나면 무조건 `지금-windowDays … 지금`으로 되돌아갔다. 주기가
   * windowDays보다 빨리 끝나면 같은 구간을 다시 긁고, 느리게 끝나면 그 사이에 푸시된
   * 커밋을 통째로 건너뛰었다. 덮은 끝을 이어받으면 둘 다 생기지 않는다.
   */
  const startNextCycle = ():boolean => {
    const covered = Date.parse(cursor.cycleWindow?.to ?? '');
    const from = Number.isFinite(covered) ? covered : Date.now()-spanMs;
    // 따라잡았다. 새로 쌓일 때까지 기다린다 — 같은 구간을 다시 검색하지 않는다.
    if (from+MIN_CYCLE_SPAN_MS > Date.now()) {cursor.retryAt = iso(new Date(from+MIN_CYCLE_SPAN_MS)); cursor.waiting = true; return false;}
    initial = chunkFrom(from); index = 0;
    cursor = {signal:queries[0].label,page:1,configHash,queryHash:queryHash(0),window:initial,cycleWindow:initial,
      pendingWindows:[],incompleteWindows:cursor.incompleteWindows,phase:'discovery',states:{},doneSignals:[]};
    return true;
  };
  const advance = ():boolean => {
    const pending = [...(cursor.pendingWindows ?? [])];
    const next = pending.shift();
    if (next) {cursor.pendingWindows = pending; resetWindow(next); rotate(); return true;}
    // 이 신호는 이번 주기의 창을 다 봤다. 남은 신호가 있으면 그쪽으로 넘긴다.
    cursor.doneSignals = [...new Set([...(cursor.doneSignals ?? []),cursor.signal])];
    // A persistently capped second must not starve discovery of newly pushed repositories.
    if (cursor.phase === 'retry') return startNextCycle();
    if (queries.some(query => !cursor.doneSignals!.includes(query.label))) {rotate(); return true;}
    const retry = [...(cursor.incompleteWindows ?? [])].sort((a,b) => a.retryAt.localeCompare(b.retryAt))[0];
    if (!retry) return startNextCycle();
    index = queries.findIndex(q => q.label === retry.signal);
    cursor = {signal:retry.signal,page:1,configHash,queryHash:queryHash(index),window:retry.window,cycleWindow:initial,pendingWindows:[],incompleteWindows:cursor.incompleteWindows,phase:'retry',retryAt:retry.retryAt,states:{},doneSignals:[]};
    return true;
  };

  // 지난번에 다 따라잡았다면, 검색을 쓰기 전에 새로 쌓인 구간이 있는지부터 본다.
  // 이 확인 없이 반복하면 이미 덮은 마지막 창을 매 틱 다시 긁는다.
  if (cursor.waiting && !startNextCycle()) return {done:true,cursor};

  for (let visited = 0; visited < settings.discover.pagesPerTick && ctx.hasBudget(); visited++) {
    if (cursor.retryAt && Date.parse(cursor.retryAt) > Date.now()) return defer();
    const signal = queries[index];
    const window = cursor.window ?? initial;
    if (!cursor.pendingPage) {
      const query = `${signal.query} ${signal.kind === 'commits' ? 'committer-date' : 'pushed'}:${window.from}..${window.to}`;
      const result = signal.kind === 'commits'
        ? await searchCommits({query,page:cursor.page,sort:settings.discover.sort})
        : await searchRepositories({query,page:cursor.page,sort:settings.discover.sort});
      if (!result.ok) {
        ctx.log('crawl.seed_failed',{signal:signal.label,error:result.error.kind});
        const reset = result.error.kind === 'rate_limited' ? result.error.resetAt : null;
        cursor.retryAt = new Date(Math.max(Date.now()+60_000,reset?.getTime() ?? 0)).toISOString();
        return defer();
      }
      if (!Array.isArray(result.value.items)) {
        cursor.retryAt = new Date(Date.now()+60_000).toISOString();
        ctx.log('crawl.seed_failed',{signal:signal.label,error:'invalid_response'});
        return defer();
      }
      cursor.pendingPage = {
        items:normalizeItems(result.value.items.slice(0,SEARCH_PER_PAGE)),itemIndex:0,attributionIndex:0,
        size:Math.min(result.value.items.length,SEARCH_PER_PAGE),
        incomplete:result.value.incomplete_results === true || result.value.items.length > SEARCH_PER_PAGE,
        saturated:(result.value.total_count ?? 0) > SEARCH_PER_PAGE*MAX_SEARCH_PAGES,
        capped:cursor.page >= MAX_SEARCH_PAGES && result.value.items.length >= SEARCH_PER_PAGE,
      };
      // Save before side effects so a process restart does not need to repeat a shifting API page.
      await save();
    }
    const page = cursor.pendingPage;
    while (page.itemIndex < page.items.length) {
      if (!ctx.hasBudget()) return defer();
      const item = page.items[page.itemIndex];
      while (page.attributionIndex < item.attributions.length) {
        if (!ctx.hasBudget()) return defer();
        await recordDiscoveryEvidence({
          repositoryKey:item.repo,signalId:signal.label,sourceUrl:`https://github.com/${item.repo}${item.sha ? `/commit/${item.sha}` : ''}`,
          commitSha:item.sha,attribution:item.attributions[page.attributionIndex],
          searchWindowFrom:new Date(window.from),searchWindowTo:new Date(window.to),
          incomplete:page.incomplete || page.saturated || page.capped || item.attributionLimited,
        });
        page.attributionIndex++;
        await save();
      }
      if (!ctx.hasBudget()) return defer();
      const added = await crawl.enqueue([{repo:item.repo,signal:signal.label,builder:null,priority:signal.priority}]);
      discovered += added;
      backlog += added;
      page.itemIndex++; page.attributionIndex = 0;
      if (backlog >= SEED_BACKLOG_PAUSE) {
        cursor.backlogPaused = true;
        ctx.log('crawl.seed_backlog_paused', { backlog, resumeAt: SEED_BACKLOG_RESUME });
        return defer();
      }
      await save();
    }
    delete cursor.pendingPage;
    const incomplete = page.incomplete || page.saturated || page.capped;
    if (incomplete) {
      const pieces = splitSearchWindow(window);
      if (pieces) {
        cursor.pendingWindows = [pieces[1],...(cursor.pendingWindows ?? [])];
        resetWindow(pieces[0]);
        rotate();
        await save();
        continue;
      }
      cursor.windowIncomplete = true;
    }
    // Even at one-second granularity, pages 2..10 remain accessible and may contain new repos.
    if (page.size >= SEARCH_PER_PAGE && cursor.page < MAX_SEARCH_PAGES) {cursor.page++; rotate();}
    else {
      if (cursor.windowIncomplete) {
        ctx.log('crawl.seed_incomplete',{signal:signal.label,window,page:cursor.page});
        if (!retainIncomplete()) return defer();
      } else clearIncomplete();
      // 훑을 것은 없지만(done) 어디까지 덮었는지는 남긴다 — 잃으면 다음 주기가 같은 구간을 다시 긁는다.
      if (!advance()) {ctx.log('crawl.seeded',{discovered,drained:true}); return {done:true,cursor};}
    }
    await save();
  }
  ctx.log('crawl.seeded',{discovered,signal:cursor.signal,page:cursor.page,incompleteWindows:cursor.incompleteWindows?.length ?? 0});
  return {done:false,cursor};
}

function normalizeItems(items:CommitSearchResult['items']|RepositorySearchResult['items']):PendingItem[] {
  const output:PendingItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const repo = 'repository' in item ? item.repository?.full_name : item.full_name;
    if (typeof repo !== 'string' || repo.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) continue;
    if (!('repository' in item) && !isDeploymentUrl(item.homepage)) continue;
    const sha = 'sha' in item && typeof item.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(item.sha) ? item.sha.toLowerCase() : null;
    const message = 'commit' in item && typeof item.commit?.message === 'string' ? item.commit.message : '';
    const parsed = sha ? parseCommitAttributions(message) : [];
    // Known agent names take precedence within the cap; unknown coauthors cannot crowd them out.
    const attributions = [...parsed.filter(a => a.client !== null),...parsed.filter(a => a.client === null)].slice(0,MAX_SEED_ATTRIBUTIONS);
    const key = JSON.stringify([repo,sha,attributions]);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({repo,sha,attributions:attributions.length ? attributions : [null],attributionLimited:parsed.length > MAX_SEED_ATTRIBUTIONS});
  }
  return output;
}
function isDeploymentUrl(homepage:unknown):boolean {
  if (typeof homepage !== 'string') return false;
  const normalized = normalizeUrl(homepage);
  return normalized !== null && new URL(normalized).hostname.includes('.');
}
