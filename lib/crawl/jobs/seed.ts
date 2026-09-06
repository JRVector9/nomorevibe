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
const INCOMPLETE_RETRY_MS = 60 * 60_000;
const MAX_INCOMPLETE_WINDOWS = 128;
type PendingItem = {repo:string; sha:string|null; attributions:(CommitAttribution|null)[]; attributionLimited:boolean};
type PendingPage = {items:PendingItem[]; itemIndex:number; attributionIndex:number; size:number; incomplete:boolean; saturated:boolean; capped:boolean};
type IncompleteWindow = {signal:string; window:SearchWindow; retryAt:string};
export type SeedCursor = {
  signal:string; page:number; queryHash?:string; configHash?:string;
  window?:SearchWindow; cycleWindow?:SearchWindow; pendingWindows?:SearchWindow[];
  retryAt?:string; pendingPage?:PendingPage; windowIncomplete?:boolean;
  incompleteWindows?:IncompleteWindow[]; phase?:'discovery'|'retry';
};
const iso = (date:Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const sameWindow = (a:SearchWindow,b:SearchWindow) => a.from === b.from && a.to === b.to;

/** Search finds candidates; stored cursors contain bounded normalized facts, never commit messages. */
export async function seedFrontier(ctx:JobContext<SeedCursor>):Promise<JobOutcome<SeedCursor>> {
  const settings = await getSettings();
  if (!settings.enabled) return {done:true};
  const queries = enabledQueries(settings);
  if (!queries.length) return {done:true};
  const freshWindow = ():SearchWindow => ({from:iso(new Date(Date.now()-settings.discover.windowDays*86_400_000)),to:iso(new Date())});
  // Sort and every active query participate: an edited configuration cannot replay old page data or retry delays.
  const configHash = createHash('sha256').update(JSON.stringify({queries,sort:settings.discover.sort,windowDays:settings.discover.windowDays})).digest('hex');
  const queryHash = (index:number) => createHash('sha256').update(queries[index].kind+'\0'+queries[index].query+'\0'+settings.discover.windowDays).digest('hex');
  const resumedIndex = queries.findIndex(q => q.label === ctx.cursor?.signal);
  const matches = ctx.cursor?.configHash === configHash && resumedIndex >= 0 && ctx.cursor.queryHash === queryHash(resumedIndex);
  let index = matches ? resumedIndex : 0;
  let initial = matches && ctx.cursor?.cycleWindow ? ctx.cursor.cycleWindow : freshWindow();
  let cursor:SeedCursor = matches ? structuredClone(ctx.cursor!) : {
    signal:queries[0].label,page:1,queryHash:queryHash(0),configHash,window:initial,cycleWindow:initial,pendingWindows:[],incompleteWindows:[],phase:'discovery',
  };
  if (cursor.retryAt && Date.parse(cursor.retryAt) > Date.now()) return {done:false,cursor};
  delete cursor.retryAt;
  let discovered = 0;
  const save = () => ctx.save(cursor);
  const defer = async () => {await save(); return {done:false,cursor};};
  const resetWindow = (next:SearchWindow) => {
    cursor = {...cursor,page:1,window:next,windowIncomplete:false};
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
  const advance = ():boolean => {
    const pending = [...(cursor.pendingWindows ?? [])];
    const next = pending.shift();
    if (next) {cursor.pendingWindows = pending; resetWindow(next); return true;}
    if (cursor.phase === 'retry') {
      // A persistently capped second must not starve discovery of newly pushed repositories.
      initial = freshWindow(); index = 0;
      cursor = {signal:queries[0].label,page:1,configHash,queryHash:queryHash(0),window:initial,cycleWindow:initial,pendingWindows:[],incompleteWindows:cursor.incompleteWindows,phase:'discovery'};
      return true;
    }
    index++;
    if (index < queries.length) {
      cursor = {signal:queries[index].label,page:1,configHash,queryHash:queryHash(index),window:initial,cycleWindow:initial,pendingWindows:[],incompleteWindows:cursor.incompleteWindows,phase:'discovery'};
      return true;
    }
    const retry = [...(cursor.incompleteWindows ?? [])].sort((a,b) => a.retryAt.localeCompare(b.retryAt))[0];
    if (!retry) return false;
    index = queries.findIndex(q => q.label === retry.signal);
    cursor = {signal:retry.signal,page:1,configHash,queryHash:queryHash(index),window:retry.window,cycleWindow:initial,pendingWindows:[],incompleteWindows:cursor.incompleteWindows,phase:'retry',retryAt:retry.retryAt};
    return true;
  };

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
      discovered += await crawl.enqueue([{repo:item.repo,signal:signal.label,builder:null,priority:signal.priority}]);
      page.itemIndex++; page.attributionIndex = 0;
      await save();
    }
    delete cursor.pendingPage;
    const incomplete = page.incomplete || page.saturated || page.capped;
    if (incomplete) {
      const pieces = splitSearchWindow(window);
      if (pieces) {
        cursor.pendingWindows = [pieces[1],...(cursor.pendingWindows ?? [])];
        resetWindow(pieces[0]);
        await save();
        continue;
      }
      cursor.windowIncomplete = true;
    }
    // Even at one-second granularity, pages 2..10 remain accessible and may contain new repos.
    if (page.size >= SEARCH_PER_PAGE && cursor.page < MAX_SEARCH_PAGES) cursor.page++;
    else {
      if (cursor.windowIncomplete) {
        ctx.log('crawl.seed_incomplete',{signal:signal.label,window,page:cursor.page});
        if (!retainIncomplete()) return defer();
      } else clearIncomplete();
      if (!advance()) {ctx.log('crawl.seeded',{discovered,drained:true}); return {done:true};}
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
