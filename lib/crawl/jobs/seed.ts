import { m3DiscoveryQueries } from '@/lib/crawl/korean-discovery/contracts';
import { createHash } from 'node:crypto';
import { logger } from '@/lib/observability/logger';
import type { DiscoveryAdmission } from '@/lib/crawl/discovery-admission';
import { readReviewBacklog, reviewBacklogAdmission } from '@/lib/crawl/review-backlog';
import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { sharedDiscoverySearch, enqueueDiscoveryBatch } from '@/lib/crawl/shared-discovery';
import { runDiscoveryBudget, type DiscoveryLane } from '@/lib/crawl/discovery-budget';
import { recordDiscoveryProgress, type DiscoveryProgressInput } from '@/lib/crawl/discovery-progress';
import { normalizeUrl } from '@/lib/net/normalize';
import { getSettings, enabledQueries } from '@/lib/crawl/settings';
import type { CrawlSettings } from '@/lib/crawl/settings-schema';
import { searchCommits, searchRepositories, SEARCH_PER_PAGE, MAX_SEARCH_PAGES, type CommitSearchResult, type RepositorySearchResult } from '@/lib/crawl/github';
import { recordDiscoveryEvidenceBatch } from '@/lib/domain/evidence/agents/repository';
import { isStorableLabel, parseCommitAttributions, type CommitAttribution } from '@/lib/domain/evidence/agents/commit-attribution';
import { splitSearchWindow, type SearchWindow } from '@/lib/crawl/search-window';

export const MAX_SEED_ATTRIBUTIONS = 8;
const INCOMPLETE_RETRY_MS = 60 * 60_000;
/** 몇 초짜리 구간을 훑자고 신호마다 검색을 한 번씩 쓰지는 않는다. 이만큼 쌓이면 그때 본다 */
const MIN_CYCLE_SPAN_MS = 60_000;
const MAX_INCOMPLETE_WINDOWS = 128;
type PendingItem = {repo:string; sha:string|null; attributions:(CommitAttribution|null)[]; attributionLimited:boolean};
type PendingPage = {items:PendingItem[]; itemIndex:number; size:number; incomplete:boolean; saturated:boolean; capped:boolean};
type IncompleteWindow = {signal:string; window:SearchWindow; retryAt:string};
/** 차례를 넘길 때 보관하는 신호별 진행 위치. 페이지 경계에서만 저장하므로 pendingPage는 담지 않는다 */
type SignalState = {page:number; window:SearchWindow; pendingWindows:SearchWindow[]; windowIncomplete?:boolean; lastServedAt?:number};
type SearchCursor = {
  signal:string; page:number; queryHash?:string; configHash?:string;
  querySignatures?:Record<string,string>; searchSort?:CrawlSettings['discover']['sort'];
  coverageVersion?:2;
  window?:SearchWindow; cycleWindow?:SearchWindow; pendingWindows?:SearchWindow[];
  retryAt?:string; retryKind?:string; pendingPage?:PendingPage; windowIncomplete?:boolean;
  incompleteWindows?:IncompleteWindow[]; phase?:'discovery'|'retry';
  /** Legacy marker is cleared while retaining saved page/window progress. */
  backlogPaused?:boolean;
  admissionThrottled?:boolean;
  /** 신호별로 어디까지 봤는지. 차례가 돌아오면 여기서 이어간다 */
  states?:Record<string,SignalState>;
  /** 이번 주기의 창을 다 본 신호. 다시 차례를 주지 않는다 */
  doneSignals?:string[];
  /** 덮은 구간을 따라잡아 더 훑을 것이 없는 상태. 검색하기 전에 새 구간부터 확인한다 */
  waiting?:boolean;
};
export type SeedCursor = SearchCursor & {
  /** Both paths retain complete fixed ranges independently. */
  latestScan?: SearchCursor;
  latestTurn?: boolean;
  laneProgress?: Partial<Record<DiscoveryLane,number>>;
};
export const LATEST_SCAN_INTERVAL_MS = 60 * 60_000;
/** Allow delayed search indexing without replaying the entire three-day preview. */
export const LATEST_SCAN_OVERLAP_MS = 5 * 60_000;
export const LATEST_SCAN_LAG_MS = 24 * 60 * 60_000;
const iso = (date:Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const sameWindow = (a:SearchWindow,b:SearchWindow) => a.from === b.from && a.to === b.to;

/** Search finds candidates; stored cursors contain bounded normalized facts, never commit messages. */
export async function seedFrontier(ctx:JobContext<SeedCursor>):Promise<JobOutcome<SeedCursor>> {
  let settings = await getSettings();
  if (!settings.enabled) return {done:true};
  settings = { ...settings, discover: { ...settings.discover, queries: m3DiscoveryQueries(settings.discover.queries) } };
  const snapshot = await readReviewBacklog();
  const admission = reviewBacklogAdmission(snapshot, settings.discover.maxNewPerHour, settings.discover.maxReviewBacklog);
  ctx.log('crawl.seed_admission', { ...snapshot, throttled:admission.throttled,
    newAllowance:Number.isFinite(admission.remainingNew) ? admission.remainingNew : null,
    configuredPages:settings.discover.pagesPerTick,effectivePages:admission.remainingNew === 0 ? 0 : settings.discover.pagesPerTick,
    maxReviewBacklog:settings.discover.maxReviewBacklog,
    queueCapped:!snapshot.timedOut && snapshot.queuedRepositories >= settings.discover.maxReviewBacklog,
    rateCapped:snapshot.recentNew >= Math.floor(settings.discover.maxNewPerHour / 12),measurementUnknown:Boolean(snapshot.timedOut) });
  if (admission.remainingNew === 0) {
    const current = ctx.cursor;
    await recordDiscoveryProgress({worker:discoveryWorker(),lane:'full',signal:current?.signal ?? enabledQueries(settings)[0]?.label ?? 'GitHub',
      window:current?.window,page:current?.page,counts:{},blockedBy:snapshot.timedOut ? 'measurement_unknown'
        : snapshot.queuedRepositories >= settings.discover.maxReviewBacklog ? 'queue_cap' : 'rate_cap'});
    return { done:false, cursor:ctx.cursor ?? undefined };
  }
  const savedLatest = ctx.cursor?.latestScan;
  const unfinishedLatest = savedLatest && (!savedLatest.waiting || savedLatest.coverageVersion !== 2
    || savedLatest.pendingPage || savedLatest.pendingWindows?.length || savedLatest.incompleteWindows?.length);
  if (settings.discover.sort !== 'recent' && !unfinishedLatest) {
    const historical = ctx.cursor ? { ...ctx.cursor } : null;
    if (historical) { delete historical.latestScan; delete historical.latestTurn; }
    return seedSearchCycle({ ...ctx, cursor: historical }, settings, admission);
  }
  const covered = Date.parse(ctx.cursor?.cycleWindow?.to ?? '');
  // 전체 수집이 하루 이상 뒤처진 경우 최신 탐색을 먼저 배정한다. 전체 수집도 매 틱 진행한다.
  // A full cursor's target date is not completed coverage; retain every unfinished latest range.
  if ((!Number.isFinite(covered) || covered >= Date.now() - LATEST_SCAN_LAG_MS) && !unfinishedLatest) {
    const historical = ctx.cursor ? { ...ctx.cursor } : null;
    if (historical) { delete historical.latestScan; delete historical.latestTurn; }
    return seedSearchCycle({ ...ctx, cursor: historical }, settings, admission);
  }
  const { latestScan, latestTurn, laneProgress: priorProgress, ...historical } = ctx.cursor!;
  let full: SearchCursor = historical;
  let latest: SearchCursor | undefined = latestScan;
  const laneProgress = {...priorProgress};
  if (latest && latest.coverageVersion !== 2) {
    // Legacy latest cursors only previewed page one. Replay that fixed window,
    // keeping historical progress, before claiming full coverage under v2.
    latest = {...latest,page:1,window:latest.cycleWindow ?? latest.window,pendingWindows:[],
      states:{},doneSignals:[],incompleteWindows:[],coverageVersion:2};
    delete latest.pendingPage; delete latest.retryAt; delete latest.waiting;
  }
  let nextLane:DiscoveryLane = latestTurn === false ? 'full' : 'latest';
  const savedSnapshot = (): SeedCursor => ({ ...full, admissionThrottled:admission.throttled, latestScan: latest, latestTurn:nextLane === 'latest',laneProgress });
  const waiting = (cursor:SearchCursor|undefined) => Boolean(cursor?.retryAt && Date.parse(cursor.retryAt) > Date.now());
  const sharedWait = (cursor:SearchCursor|undefined) => waiting(cursor) && !cursor?.waiting &&
    (cursor?.retryKind === 'rate_limited' || cursor?.retryKind === 'auth_unavailable'
      || (!cursor?.retryKind && cursor?.phase !== 'retry' && !cursor?.incompleteWindows?.length));
  // An authentication/quota wait is shared; a finished preview or an occupied page is not.
  if (sharedWait(latest) || sharedWait(full)) return {done:false,cursor:savedSnapshot()};
  let latestDone = latest?.waiting === true, fullDone = full.waiting === true;
  const budget = await runDiscoveryBudget({pages:settings.discover.pagesPerTick,nextLane,
    latestReady:!waiting(latest),fullReady:!waiting(full),lastProgressAt:laneProgress,deadlineAt:ctx.deadlineAt,
    run:async (lane,pages,deadlineAt) => {
      let usedPages = 0, completedPages = 0;
      // Save the following turn before I/O so a restart cannot keep the first lane forever.
      nextLane = lane === 'latest' ? 'full' : 'latest';
      const outcome = await seedSearchCycle({...ctx,cursor:lane === 'latest' ? latest ?? null : full,deadlineAt,
        hasBudget:() => ctx.hasBudget() && (deadlineAt === undefined || Date.now() < deadlineAt),
        log:(event,fields) => {
          if (event === 'crawl.seeded' || event === 'crawl.seed_latest_scanned') {
            usedPages += typeof fields?.pagesVisited === 'number' ? fields.pagesVisited : 0;
            completedPages += typeof fields?.pagesCompleted === 'number' ? fields.pagesCompleted : 0;
          }
          ctx.log(event,fields);
        },save:async value => {
          if (lane === 'latest') latest = {...value,coverageVersion:2}; else full = value;
          await ctx.save(savedSnapshot());
        },
      },{...settings,discover:{...settings.discover,pagesPerTick:pages}},admission,lane === 'latest');
      if (lane === 'latest') {latest = outcome.cursor ? {...outcome.cursor,coverageVersion:2} : latest;latestDone = outcome.done;}
      else {full = outcome.cursor ?? full;fullDone = outcome.done;}
      if (completedPages > 0) laneProgress[lane] = Date.now();
      const current = lane === 'latest' ? latest : full;
      return {usedPages,blocked:admission.remainingNew <= 0 || sharedWait(current),idle:outcome.done || waiting(current)};
    }});
  nextLane = budget.nextLane;
  ctx.log('crawl.seed_budget',{latestPages:budget.used.latest,fullPages:budget.used.full,donatedPages:budget.donated});
  await ctx.save(savedSnapshot());
  return { done: fullDone && latestDone, cursor: savedSnapshot() };
}

const discoveryWorker = () => process.env.SERVICE_INSTANCE_ID ?? process.env.HOSTNAME ?? 'crawler';

/** Both cursors own complete fixed windows, including all pages and split retries. */
async function seedSearchCycle(ctx:JobContext<SearchCursor>, settings:CrawlSettings, admission:DiscoveryAdmission, latestOnly = false):Promise<JobOutcome<SearchCursor>> {
  const queries = enabledQueries(settings);
  if (!queries.length) return {done:true};
  const spanMs = settings.discover.windowDays*86_400_000;
  /**
   * 훑을 구간을 from 에서 windowDays 만큼 잘라 낸다. 끝은 지금을 넘지 않는다.
   * 뒤처져 있으면 이 조각을 이어 붙여 따라잡고, 따라잡았으면 지금까지만 본다.
   */
  const chunkFrom = (from:number):SearchWindow => ({from:iso(new Date(from)),to:iso(new Date(Math.min(Date.now(),from+spanMs)))});
  const freshWindow = ():SearchWindow => chunkFrom(Date.now()-spanMs);
  /**
   * Sort and every active query participate: an edited configuration cannot replay old page data or retry delays.
   *
   * 신호에서는 검색 결과와 커서를 가르는 것(라벨·종류·검색어)만 넣는다. 신호 객체를 통째로 넣던 때는 우선순위·
   * requireEvidence 처럼 검색과 무관한 칸 하나만 고쳐도 주기가 처음부터 다시 돌았다 — 2026-10-02 설정 저장 한 번에
   * 발견이 1~2시간 멈추고 발행이 시간당 177건에서 7건으로 떨어졌다.
   */
  const hashFor = (sort:CrawlSettings['discover']['sort']) => createHash('sha256').update(JSON.stringify({
    queries:queries.map(q => [q.label,q.kind,q.query]),sort,windowDays:settings.discover.windowDays})).digest('hex');
  /** 위 해시 이전의 커서가 든 값(신호 전체). 설정이 그대로면 배포 뒤에도 이어 간다 */
  const legacyHashFor = (sort:CrawlSettings['discover']['sort']) => createHash('sha256').update(JSON.stringify({queries,sort,windowDays:settings.discover.windowDays})).digest('hex');
  const hashedWith = (sort:CrawlSettings['discover']['sort']) => ctx.cursor?.configHash !== undefined
    && (ctx.cursor.configHash === hashFor(sort) || ctx.cursor.configHash === legacyHashFor(sort));
  const configHash = hashFor(settings.discover.sort);
  const queryHash = (index:number) => createHash('sha256').update(queries[index].kind+'\0'+queries[index].query+'\0'+settings.discover.windowDays).digest('hex');
  const resumedIndex = queries.findIndex(q => q.label === ctx.cursor?.signal);
  // 정렬만 바뀌면 미완 날짜 구간은 보존하되 페이지를 1부터 재탐색한다. 다른 정렬의 페이지를 섞지 않는다.
  const sortChanged = hashedWith(settings.discover.sort === 'recent' ? 'relevance' : 'recent');
  const matches = (hashedWith(settings.discover.sort) || sortChanged) && resumedIndex >= 0 && ctx.cursor!.queryHash === queryHash(resumedIndex);
  let index = matches ? resumedIndex : 0;
  let initial = matches && ctx.cursor?.cycleWindow ? ctx.cursor.cycleWindow : freshWindow();
  let cursor:SearchCursor = matches ? { ...structuredClone(ctx.cursor!), configHash } : {
    signal:queries[0].label,page:1,queryHash:queryHash(0),configHash,window:initial,cycleWindow:initial,pendingWindows:[],incompleteWindows:[],phase:'discovery',states:{},doneSignals:[],
  };
  if (!matches && ctx.cursor?.cycleWindow && Number.isFinite(Date.parse(ctx.cursor.cycleWindow.from))
    && Number.isFinite(Date.parse(ctx.cursor.cycleWindow.to))) {
    // Query ownership may change without changing the remaining queries. Keep
    // their verified per-query progress. Legacy cursors retain the fixed cycle
    // but restart unverifiable pages, rather than abandoning the old date range.
    const prior=ctx.cursor;
    initial=prior.cycleWindow!;
    const signatures=Object.fromEntries(queries.map((q,i)=>[q.label,queryHash(i)]));
    const unchanged=(label:string)=>prior.querySignatures?.[label] === signatures[label];
    const states=Object.fromEntries(Object.entries(prior.states ?? {}).filter(([label])=>unchanged(label)));
    if (unchanged(prior.signal) && prior.searchSort === settings.discover.sort) {
      states[prior.signal]={page:prior.page,window:prior.window ?? initial,pendingWindows:prior.pendingWindows ?? [],windowIncomplete:prior.windowIncomplete};
    }
    index=resumedIndex>=0 ? resumedIndex : 0;
    const active=states[queries[index].label];
    cursor={signal:queries[index].label,page:active?.page ?? 1,queryHash:queryHash(index),configHash,
      cycleWindow:initial,window:active?.window ?? initial,pendingWindows:active?.pendingWindows ?? [],
      windowIncomplete:active?.windowIncomplete,states,doneSignals:(prior.doneSignals ?? []).filter(unchanged),
      incompleteWindows:(prior.incompleteWindows ?? []).filter(entry=>queries.some(q=>q.label===entry.signal)),
      phase:'discovery',coverageVersion:prior.coverageVersion};
    if (unchanged(prior.signal) && cursor.signal === prior.signal && prior.searchSort === settings.discover.sort)
      cursor.pendingPage=prior.pendingPage;
    ctx.log('crawl.seed_queries_changed',{preservedWindow:initial,retainedSignals:Object.keys(states).length});
  }
  cursor.querySignatures=Object.fromEntries(queries.map((q,i)=>[q.label,queryHash(i)]));
  cursor.searchSort=settings.discover.sort;
  if (matches && sortChanged) {
    cursor.configHash = configHash; cursor.page = 1;
    delete cursor.pendingPage; delete cursor.retryAt;
    const reorder = (state:SignalState):SignalState => {
      const windows = [state.window, ...state.pendingWindows];
      if (settings.discover.sort === 'recent') windows.sort((a,b) => b.to.localeCompare(a.to));
      return { page:1, window:windows[0], pendingWindows:windows.slice(1), windowIncomplete:false };
    };
    cursor.states = Object.fromEntries(Object.entries(cursor.states ?? {}).map(([label,state]) => [label,reorder(state)]));
    const active = reorder({ page:cursor.page, window:cursor.window ?? initial, pendingWindows:cursor.pendingWindows ?? [] });
    Object.assign(cursor, active);
    ctx.log('crawl.seed_sort_changed', { sort: settings.discover.sort, preservedWindow: cursor.cycleWindow });
  }
  delete cursor.backlogPaused;
  cursor.admissionThrottled = admission.throttled;
  if (cursor.retryAt && Date.parse(cursor.retryAt) > Date.now()) return {done:false,cursor};
  delete cursor.retryAt; delete cursor.retryKind;
  let discovered = 0, searchRequests = 0, pagesVisited = 0, pagesCompleted = 0, cacheHits = 0, examined = 0, existing = 0;
  let returned = 0, filtered = 0, pageDuplicates = 0;
  // Record actual insertions even when a rate/budget boundary leaves a partial page.
  // Each invocation emits one summary; latest and historical scans keep separate events.
  const summarize = (drained = false) => ctx.log(latestOnly ? 'crawl.seed_latest_scanned' : 'crawl.seeded',
    {discovered,searchRequests,pagesVisited,pagesCompleted,cacheHits,examined,existing,returned,filtered,pageDuplicates,drained,window:cursor.cycleWindow,signal:cursor.signal,page:cursor.page,
      incompleteWindows:cursor.incompleteWindows?.length ?? 0});
  const save = () => ctx.save(cursor);
  const measure = (counts:DiscoveryProgressInput['counts'], extra:Partial<Pick<DiscoveryProgressInput,'blockedBy'|'completedThrough'>> = {}) =>
    recordDiscoveryProgress({worker:discoveryWorker(),lane:latestOnly ? 'latest' : 'full',signal:cursor.signal,
      window:cursor.window ?? initial,page:cursor.page,counts,...extra});
  const defer = async () => {await save(); summarize(); return {done:false,cursor};};
  const resetWindow = (next:SearchWindow) => {
    cursor = {...cursor,page:1,window:next,windowIncomplete:false};
    delete cursor.pendingPage;
  };
  const park = () => {
    cursor.states = {...cursor.states,[cursor.signal]:{
      page:cursor.page,window:cursor.window ?? initial,
      pendingWindows:[...(cursor.pendingWindows ?? [])],windowIncomplete:cursor.windowIncomplete,lastServedAt:Date.now(),
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
    const choices:Array<{index:number;servedAt:number;step:number}> = [];
    for (let step = 1; step <= queries.length; step++) {
      const next = (index + step) % queries.length;
      if (finished.has(queries[next].label)) continue;
      choices.push({index:next,servedAt:cursor.states?.[queries[next].label]?.lastServedAt ?? 0,step});
    }
    choices.sort((a,b) => a.servedAt-b.servedAt || a.step-b.step);
    index = choices[0]?.index ?? index;
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
    if (from+(latestOnly ? LATEST_SCAN_INTERVAL_MS : MIN_CYCLE_SPAN_MS) > Date.now()) {cursor.retryAt = iso(new Date(from+(latestOnly ? LATEST_SCAN_INTERVAL_MS : MIN_CYCLE_SPAN_MS))); cursor.waiting = true; return false;}
    // Historical coverage remains authoritative, including capped/incomplete previews.
    // Only the preview advances: keep a small indexing overlap, bounded by windowDays
    // after long downtime. Saved pages and unfinished signals finish before this runs.
    initial = latestOnly ? {from:iso(new Date(Math.max(Date.now()-spanMs,from-LATEST_SCAN_OVERLAP_MS))),to:iso(new Date())} : chunkFrom(from); index = 0;
    cursor = {admissionThrottled:admission.throttled,signal:queries[0].label,page:1,configHash,queryHash:queryHash(0),window:initial,cycleWindow:initial,
      pendingWindows:[],incompleteWindows:cursor.incompleteWindows,phase:'discovery',states:{},doneSignals:[],
      querySignatures:cursor.querySignatures,searchSort:cursor.searchSort,coverageVersion:cursor.coverageVersion};
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
    cursor = {admissionThrottled:admission.throttled,signal:retry.signal,page:1,configHash,queryHash:queryHash(index),window:retry.window,cycleWindow:initial,pendingWindows:[],incompleteWindows:cursor.incompleteWindows,phase:'retry',retryAt:retry.retryAt,states:{},doneSignals:[],querySignatures:cursor.querySignatures,searchSort:cursor.searchSort,coverageVersion:cursor.coverageVersion};
    return true;
  };

  // 지난번에 다 따라잡았다면, 검색을 쓰기 전에 새로 쌓인 구간이 있는지부터 본다.
  // 이 확인 없이 반복하면 이미 덮은 마지막 창을 매 틱 다시 긁는다.
  if (cursor.waiting && !startNextCycle()) return {done:true,cursor};

  for (let visited = 0; visited < settings.discover.pagesPerTick && admission.remainingNew > 0 && ctx.hasBudget(); visited++) {
    if (cursor.retryAt && Date.parse(cursor.retryAt) > Date.now()) return defer();
    const signal = queries[index];
    const window = cursor.window ?? initial;
    if (!cursor.pendingPage) {
      const query = `${signal.query} is:public ${signal.kind === 'commits' ? 'committer-date' : 'pushed'}:${window.from}..${window.to}`;
      const requestsBefore = searchRequests;
      const result = await sharedDiscoverySearch<CommitSearchResult | RepositorySearchResult>({
        kind:signal.kind,query,page:cursor.page,sort:settings.discover.sort,scope:'public-v1',lease:ctx.lease,cleanup:true,
      }, async () => {
        searchRequests++;
        const params = {query,page:cursor.page,sort:settings.discover.sort};
        const search = signal.kind === 'commits' ? searchCommits : searchRepositories;
        return ctx.deadlineAt !== undefined || ctx.signal
          ? search(params,{deadlineAt:ctx.deadlineAt,signal:ctx.signal}) : search(params);
      });
      pagesVisited++;
      if (result.ok && result.cached) cacheHits++;
      if (!result.ok) {
        ctx.log('crawl.seed_failed',{signal:signal.label,error:result.error.kind});
        const reset = result.error.kind === 'discovery_busy' ? result.error.retryAt
          : result.error.kind === 'rate_limited' || result.error.kind === 'auth_unavailable' ? result.error.resetAt : null;
        cursor.retryAt = new Date(Math.max(Date.now()+60_000,reset?.getTime() ?? 0)).toISOString();
        cursor.retryKind = result.error.kind;
        await measure({searchRequests:searchRequests-requestsBefore},{blockedBy:result.error.kind === 'auth_unavailable' ? 'auth' : 'api_wait'});
        return defer();
      }
      if (!Array.isArray(result.value.items)) {
        cursor.retryAt = new Date(Date.now()+60_000).toISOString();
        cursor.retryKind = 'invalid_response';
        ctx.log('crawl.seed_failed',{signal:signal.label,error:'invalid_response'});
        await measure({searchRequests:searchRequests-requestsBefore},{blockedBy:'api_wait'});
        return defer();
      }
      const raw = result.value.items.slice(0,SEARCH_PER_PAGE);
      const normalized = normalizeItems(raw);
      returned += raw.length; filtered += normalized.filtered; pageDuplicates += normalized.duplicates;
      // Detailed query dimensions go to structured logs, keeping the bounded job
      // observation free for admission state and the aggregate summaries.
      logger.info('crawl.seed_page',{job:'crawl-seed',signal:signal.label,kind:signal.kind,scan:latestOnly ? 'latest' : 'historical',
        window,page:cursor.page,returned:raw.length,eligible:normalized.items.length,
        filtered:normalized.filtered,pageDuplicates:normalized.duplicates});
      cursor.pendingPage = {
        items:normalized.items,itemIndex:0,
        size:Math.min(result.value.items.length,SEARCH_PER_PAGE),
        incomplete:result.value.incomplete_results === true || result.value.items.length > SEARCH_PER_PAGE,
        saturated:(result.value.total_count ?? 0) > SEARCH_PER_PAGE*MAX_SEARCH_PAGES,
        capped:cursor.page >= MAX_SEARCH_PAGES && result.value.items.length >= SEARCH_PER_PAGE,
      };
      await measure({searchRequests:searchRequests-requestsBefore,pagesVisited:1,cacheHits:result.cached ? 1 : 0,
        returned:raw.length,pageDuplicates:normalized.duplicates,incomplete:cursor.pendingPage.incomplete ? 1 : 0});
      // Save before side effects so a process restart does not need to repeat a shifting API page.
      await save();
    }
    const page = cursor.pendingPage;
    /**
     * 페이지의 남은 항목을 근거 한 번, 프론티어 한 번으로 넣는다.
     *
     * 항목마다 근거 → 커서 → 프론티어 → 커서를 쓰면 한 페이지에 400번 가까이 DB를 오간다.
     * 커서는 두 저장이 끝난 뒤 페이지 경계에서만 옮긴다 — 커서가 먼저 페이지를 넘기고 저장이
     * 실패하면 그 페이지는 다시 읽히지 않는다. 반대로 저장 뒤 커서를 못 옮기면 같은 페이지를
     * 다시 넣을 뿐이고, 두 저장 모두 이미 있는 행은 건너뛰므로 겹치지 않는다.
     * 프론티어 enqueue 는 트랜잭션을 받지 않으므로 근거 트랜잭션에서 리스를 확인하고 근거를 먼저
     * 넣는다 (종전 순서 그대로 — 근거 없는 레포가 프론티어에 먼저 오르지 않는다).
     * 압력이 있을 때 실제 새 삽입의 남은 몫만큼 자른다. 중복은 몫을 쓰지 않으며 미완 페이지는 그대로 이어 받는다.
     */
    while (page.itemIndex < page.items.length) {
      if (!ctx.hasBudget() || admission.remainingNew <= 0) return defer();
      const batch = page.items.slice(page.itemIndex,page.itemIndex+admission.remainingNew);
      await recordDiscoveryEvidenceBatch(batch.flatMap(item => storableAttributions(item).map(attribution => ({
        repositoryKey:item.repo,signalId:signal.label,sourceUrl:`https://github.com/${item.repo}${item.sha ? `/commit/${item.sha}` : ''}`,
        commitSha:item.sha,attribution,
        searchWindowFrom:new Date(window.from),searchWindowTo:new Date(window.to),
        incomplete:page.incomplete || page.saturated || page.capped || item.attributionLimited,
      }))),ctx.lease);
      const committed = await enqueueDiscoveryBatch(batch.map(item => ({repo:item.repo,signal:signal.label,builder:null,priority:signal.priority})),
        {maxNewPerHour:settings.discover.maxNewPerHour,maxReviewBacklog:settings.discover.maxReviewBacklog},ctx.lease);
      const {added,processed} = committed;
      discovered += added;
      examined += processed;
      existing += processed-added;
      logger.info('crawl.seed_batch',{job:'crawl-seed',signal:signal.label,kind:signal.kind,scan:latestOnly ? 'latest' : 'historical',
        window,page:cursor.page,examined:processed,discovered:added,existing:processed-added});
      admission.remainingNew = Math.min(admission.remainingNew-added, committed.remainingNew);
      page.itemIndex += processed;
      await measure({examined:processed,discovered:added,existing:processed-added},
        admission.remainingNew <= 0 ? {blockedBy:committed.blockedBy} : {});
      if (!processed) return defer();
      if (admission.remainingNew <= 0 && page.itemIndex < page.items.length) return defer();
    }
    delete cursor.pendingPage;
    pagesCompleted++;
    const incomplete = page.incomplete || page.saturated || page.capped;
    if (incomplete) {
      const pieces = splitSearchWindow(window);
      if (pieces) {
        const [next, later] = settings.discover.sort === 'recent' ? [pieces[1], pieces[0]] : pieces;
        cursor.pendingWindows = [later,...(cursor.pendingWindows ?? [])];
        resetWindow(next);
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
        await measure({}, {blockedBy:'incomplete'});
        if (!retainIncomplete()) return defer();
      } else clearIncomplete();
      if (!cursor.windowIncomplete && !cursor.pendingWindows?.length
        && !cursor.incompleteWindows?.some(entry => entry.signal === signal.label)) {
        await measure({}, {completedThrough:initial.to});
      }
      // 훑을 것은 없지만(done) 어디까지 덮었는지는 남긴다 — 잃으면 다음 주기가 같은 구간을 다시 긁는다.
      if (!advance()) {summarize(true); return {done:true,cursor};}
    }
    await save();
  }
  summarize();
  return {done:false,cursor};
}

/** 예전 파서가 저장한 커서의 표기도 저장이 받는 것만 남긴다. 다 빠지면 파싱 때처럼 표기 없는 근거 한 건 */
function storableAttributions(item:PendingItem):(CommitAttribution|null)[] {
  const kept = item.attributions.filter(attribution => attribution === null || isStorableLabel(attribution.label));
  return kept.length ? kept : [null];
}
function normalizeItems(items:CommitSearchResult['items']|RepositorySearchResult['items']) {
  const output:PendingItem[] = [];
  let filtered = 0, duplicates = 0;
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') {filtered++; continue;}
    const repo = 'repository' in item ? item.repository?.full_name : item.full_name;
    if (typeof repo !== 'string' || repo.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {filtered++; continue;}
    if (!('repository' in item) && !isDeploymentUrl(item.homepage)) {filtered++; continue;}
    const sha = 'sha' in item && typeof item.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(item.sha) ? item.sha.toLowerCase() : null;
    const message = 'commit' in item && typeof item.commit?.message === 'string' ? item.commit.message : '';
    const parsed = sha ? parseCommitAttributions(message) : [];
    // Known agent names take precedence within the cap; unknown coauthors cannot crowd them out.
    const attributions = [...parsed.filter(a => a.client !== null),...parsed.filter(a => a.client === null)].slice(0,MAX_SEED_ATTRIBUTIONS);
    const key = JSON.stringify([repo.toLowerCase(),sha,attributions]);
    if (seen.has(key)) {duplicates++; continue;}
    seen.add(key);
    output.push({repo,sha,attributions:attributions.length ? attributions : [null],attributionLimited:parsed.length > MAX_SEED_ATTRIBUTIONS || ('_discovery_attributionLimited' in item && item._discovery_attributionLimited === true)});
  }
  return {items:output,filtered,duplicates};
}
function isDeploymentUrl(homepage:unknown):boolean {
  if (typeof homepage !== 'string') return false;
  const normalized = normalizeUrl(homepage);
  return normalized !== null && new URL(normalized).hostname.includes('.');
}
