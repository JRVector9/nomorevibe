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
/** Each query owns its dates, partial page and local wait, including while disabled. */
type SignalState = {page:number; window:SearchWindow; cycleWindow?:SearchWindow; pendingWindows:SearchWindow[];
  windowIncomplete?:boolean; lastServedAt?:number; pendingPage?:PendingPage; retryAt?:string; retryKind?:string;
  waiting?:boolean; phase?:'discovery'|'retry'; failures?:number; searchSort?:CrawlSettings['discover']['sort']};
type SearchCursor = {
  signal:string; page:number; queryHash?:string; configHash?:string;
  querySignatures?:Record<string,string>; searchSort?:CrawlSettings['discover']['sort'];
  coverageVersion?:2;
  cursorVersion?:3;
  failures?:number;
  window?:SearchWindow; cycleWindow?:SearchWindow; pendingWindows?:SearchWindow[];
  retryAt?:string; retryKind?:string; pendingPage?:PendingPage; windowIncomplete?:boolean;
  incompleteWindows?:IncompleteWindow[]; phase?:'discovery'|'retry';
  /** Legacy marker is cleared while retaining saved page/window progress. */
  backlogPaused?:boolean;
  admissionThrottled?:boolean;
  /** 신호별로 어디까지 봤는지. 차례가 돌아오면 여기서 이어간다 */
  states?:Record<string,SignalState>;
  /** Legacy v2 barrier, consumed once during migration. */
  doneSignals?:string[];
  /** 덮은 구간을 따라잡아 더 훑을 것이 없는 상태. 검색하기 전에 새 구간부터 확인한다 */
  waiting?:boolean;
};
export type SeedCursor = SearchCursor & {
  /** Both paths retain complete fixed ranges independently. */
  latestScan?: SearchCursor;
  /** At most one fresh head beside the durable delayed latest cursor. */
  latestHead?: SearchCursor;
  latestHeadTurn?: boolean;
  latestTurn?: boolean;
  laneProgress?: Partial<Record<DiscoveryLane,number>>;
};
export const LATEST_SCAN_INTERVAL_MS = 60 * 60_000;
/** Allow delayed search indexing without replaying the entire three-day preview. */
export const LATEST_SCAN_OVERLAP_MS = 5 * 60_000;
export const LATEST_SCAN_LAG_MS = 24 * 60 * 60_000;
const iso = (date:Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const sameWindow = (a:SearchWindow,b:SearchWindow) => a.from === b.from && a.to === b.to;
const signalState = (cursor:SearchCursor, initial:SearchWindow):SignalState => ({
  page:cursor.page,window:cursor.window ?? initial,cycleWindow:cursor.cycleWindow ?? initial,
  pendingWindows:[...(cursor.pendingWindows ?? [])],windowIncomplete:cursor.windowIncomplete,
  pendingPage:cursor.pendingPage,retryAt:cursor.retryAt,retryKind:cursor.retryKind,waiting:cursor.waiting,
  phase:cursor.phase,failures:cursor.failures,searchSort:cursor.searchSort,
});
const sharedRetry = (cursor:SearchCursor) => cursor.retryKind === 'rate_limited' || cursor.retryKind === 'auth_unavailable';
const searchDrained = (cursor:SearchCursor|undefined, labels:string[]) => Boolean(cursor?.waiting
  && !cursor.pendingPage && !cursor.pendingWindows?.length
  && !cursor.incompleteWindows?.some(entry=>labels.includes(entry.signal))
  && (cursor.cursorVersion !== 3 || labels.every(label=>label === cursor.signal || (cursor.states?.[label]?.waiting
    && !cursor.states[label].pendingPage && !cursor.states[label].pendingWindows.length))));

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
  const activeLabels=enabledQueries(settings).map(q=>q.label);
  const unfinishedLatest = ctx.cursor?.latestHead || (savedLatest && (!searchDrained(savedLatest,activeLabels) || savedLatest.coverageVersion !== 2));
  const fullOnly=async ():Promise<JobOutcome<SeedCursor>> => {
    const historical=ctx.cursor ? {...ctx.cursor} : null;
    const retained:Partial<SeedCursor>={};
    for (const key of ['latestScan','latestHead','latestHeadTurn','latestTurn','laneProgress'] as const) {
      if (historical && key in historical) {Object.assign(retained,{[key]:historical[key]});delete historical[key];}
    }
    const outcome=await seedSearchCycle({...ctx,cursor:historical,save:value=>ctx.save({...value,...retained})},settings,admission);
    if (outcome.cursor) return {...outcome,cursor:{...outcome.cursor,...retained}};
    return outcome;
  };
  if (settings.discover.sort !== 'recent' && !unfinishedLatest) {
    return fullOnly();
  }
  const covered = Date.parse(ctx.cursor?.cycleWindow?.to ?? '');
  // 전체 수집이 하루 이상 뒤처진 경우 최신 탐색을 먼저 배정한다. 전체 수집도 매 틱 진행한다.
  // A full cursor's target date is not completed coverage; retain every unfinished latest range.
  if ((!Number.isFinite(covered) || covered >= Date.now() - LATEST_SCAN_LAG_MS) && !unfinishedLatest) {
    return fullOnly();
  }
  const { latestScan, latestHead, latestHeadTurn, latestTurn, laneProgress: priorProgress, ...historical } = ctx.cursor!;
  let full: SearchCursor = historical;
  let latest: SearchCursor | undefined = latestScan;
  let head=latestHead;
  let headTurn=latestHeadTurn ?? true;
  const laneProgress = {...priorProgress};
  if (latest && latest.coverageVersion !== 2) {
    // Legacy latest cursors only previewed page one. Replay that fixed window,
    // keeping historical progress, before claiming full coverage under v2.
    latest = {...latest,page:1,window:latest.cycleWindow ?? latest.window,pendingWindows:[],
      states:{},doneSignals:[],incompleteWindows:[],coverageVersion:2};
    delete latest.pendingPage; delete latest.retryAt; delete latest.waiting;
  }
  const queries=enabledQueries(settings);
  if (!head && latest?.cycleWindow && Date.parse(latest.cycleWindow.to) < Date.now()-LATEST_SCAN_LAG_MS && queries.length) {
    // Retain the entire old cursor, including every gap and partial page. The head
    // uses the existing latest budget; it never asserts continuous coverage.
    head={signal:queries[0].label,page:1,coverageVersion:2};
    ctx.log('crawl.seed_latest_head_opened',{retainedThrough:latest.cycleWindow.to});
  }
  let nextLane:DiscoveryLane = latestTurn === false ? 'full' : 'latest';
  const savedSnapshot = (): SeedCursor => ({ ...full, admissionThrottled:admission.throttled, latestScan: latest, latestHead:head,latestHeadTurn:headTurn,latestTurn:nextLane === 'latest',laneProgress });
  const waiting = (cursor:SearchCursor|undefined) => Boolean(cursor?.retryAt && Date.parse(cursor.retryAt) > Date.now());
  const sharedWait = (cursor:SearchCursor|undefined) => waiting(cursor) && !cursor?.waiting &&
    (cursor?.retryKind === 'rate_limited' || cursor?.retryKind === 'auth_unavailable'
      || (!cursor?.retryKind && cursor?.phase !== 'retry' && !cursor?.incompleteWindows?.length));
  // An authentication/quota wait is shared; a finished preview or an occupied page is not.
  if (sharedWait(latest) || sharedWait(head) || sharedWait(full)) return {done:false,cursor:savedSnapshot()};
  let latestDone = searchDrained(latest,activeLabels) && (!head || searchDrained(head,activeLabels)), fullDone = searchDrained(full,activeLabels);
  const budget = await runDiscoveryBudget({pages:settings.discover.pagesPerTick,nextLane,
    latestReady:!waiting(latest) || Boolean(head && !waiting(head)),fullReady:!waiting(full),lastProgressAt:laneProgress,deadlineAt:ctx.deadlineAt,
    run:async (lane,pages,deadlineAt) => {
      let usedPages = 0, completedPages = 0;
      const useHead=lane === 'latest' && Boolean(head) && !waiting(head) && (headTurn || waiting(latest));
      if (lane === 'latest' && head) headTurn=!useHead;
      // Save the following turn before I/O so a restart cannot keep the first lane forever.
      nextLane = lane === 'latest' ? 'full' : 'latest';
      const outcome = await seedSearchCycle({...ctx,cursor:lane === 'latest' ? (useHead ? head! : latest ?? null) : full,deadlineAt,
        hasBudget:() => ctx.hasBudget() && (deadlineAt === undefined || Date.now() < deadlineAt),
        log:(event,fields) => {
          if (event === 'crawl.seeded' || event === 'crawl.seed_latest_scanned') {
            usedPages += typeof fields?.pagesVisited === 'number' ? fields.pagesVisited : 0;
            completedPages += typeof fields?.pagesCompleted === 'number' ? fields.pagesCompleted : 0;
          }
          ctx.log(event,fields);
        },save:async value => {
          if (lane === 'latest') {
            if (useHead) head={...value,coverageVersion:2};else latest={...value,coverageVersion:2};
          } else full=value;
          await ctx.save(savedSnapshot());
        },
      },{...settings,discover:{...settings.discover,pagesPerTick:pages}},admission,lane === 'latest',useHead);
      if (lane === 'latest') {
        if (useHead) head=outcome.cursor ? {...outcome.cursor,coverageVersion:2} : head;
        else latest=outcome.cursor ? {...outcome.cursor,coverageVersion:2} : latest;
        latestDone=searchDrained(latest,activeLabels) && (!head || searchDrained(head,activeLabels));
      }
      else {full = outcome.cursor ?? full;fullDone = outcome.done;}
      if (completedPages > 0) laneProgress[lane] = Date.now();
      const current = lane === 'latest' ? (useHead ? head : latest) : full;
      const idle=lane === 'latest' && head ? waiting(latest) && waiting(head) : outcome.done || waiting(current);
      return {usedPages,blocked:admission.remainingNew <= 0 || sharedWait(current),idle};
    }});
  nextLane = budget.nextLane;
  const position=(cursor:SearchCursor,label:string) => label === cursor.signal ? cursor : cursor.states?.[label];
  const retainedIncomplete=[...(latest?.incompleteWindows ?? []),...(head?.incompleteWindows ?? [])]
    .filter((entry,index,entries)=>entries.findIndex(other=>other.signal === entry.signal && sameWindow(other.window,entry.window)) === index);
  // Disabled queries still own their saved pages. If both cursors contain one,
  // retain both archives until the query can run and establish continuous coverage.
  // A shallow merge cannot represent two independent partial pages for that query.
  const archivedCollision=head && latest && [...new Set([latest.signal,...Object.keys(latest.states ?? {})])]
    .some(label=>!activeLabels.includes(label) && position(head!,label));
  if (head && latest && !archivedCollision && retainedIncomplete.length <= MAX_INCOMPLETE_WINDOWS
    && searchDrained(latest,activeLabels) && activeLabels.every(label=>{
    const through=position(latest!,label)?.cycleWindow?.to;
    const begins=position(head!,label)?.cycleWindow?.from;
    return through && begins && latest!.querySignatures?.[label] === head!.querySignatures?.[label]
      && latest!.searchSort === head!.searchSort && Date.parse(through) >= Date.parse(begins);
  })) {
    // The delayed cursor has genuinely drained all active queries through now.
    // Adopt the head's partial work while retaining disabled query positions.
    head.states={...latest.states,[latest.signal]:signalState(latest,latest.cycleWindow!),...head.states};
    head.incompleteWindows=retainedIncomplete;
    head.querySignatures={...latest.querySignatures,...head.querySignatures};
    latest=head;head=undefined;headTurn=true;
  }
  ctx.log('crawl.seed_budget',{latestPages:budget.used.latest,fullPages:budget.used.full,donatedPages:budget.donated});
  await ctx.save(savedSnapshot());
  return { done: fullDone && latestDone, cursor: savedSnapshot() };
}

const discoveryWorker = () => process.env.SERVICE_INSTANCE_ID ?? process.env.HOSTNAME ?? 'crawler';

/** Both cursors own complete fixed windows, including all pages and split retries. */
async function seedSearchCycle(ctx:JobContext<SearchCursor>, settings:CrawlSettings, admission:DiscoveryAdmission, latestOnly = false, previewOnly = false):Promise<JobOutcome<SearchCursor>> {
  const queries = enabledQueries(settings);
  if (!queries.length) return {done:true,cursor:ctx.cursor ?? undefined};
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
    // Disabled queries keep their cursor and signature, but receive no execution turn.
    const states=structuredClone(prior.states ?? {});
    if (prior.querySignatures?.[prior.signal]) states[prior.signal]=signalState(prior,initial);
    for (const query of queries) {
      if (!unchanged(query.label)) {
        const range=states[query.label]?.cycleWindow ?? initial;
        states[query.label]={page:1,window:range,cycleWindow:range,pendingWindows:[]};
      }
    }
    index=resumedIndex>=0 ? resumedIndex : 0;
    const active=states[queries[index].label];
    cursor={...active,signal:queries[index].label,page:active?.page ?? 1,queryHash:queryHash(index),configHash,
      cycleWindow:active?.cycleWindow ?? initial,window:active?.window ?? initial,pendingWindows:active?.pendingWindows ?? [],
      states,doneSignals:(prior.doneSignals ?? []).filter(unchanged),
      incompleteWindows:prior.incompleteWindows ?? [],phase:active?.phase ?? 'discovery',
      querySignatures:prior.querySignatures,coverageVersion:prior.coverageVersion,cursorVersion:prior.cursorVersion,
      searchSort:active?.searchSort ?? prior.searchSort};
    ctx.log('crawl.seed_queries_changed',{preservedWindow:initial,retainedSignals:Object.keys(states).length});
  }
  cursor.querySignatures={...cursor.querySignatures,...Object.fromEntries(queries.map((q,i)=>[q.label,queryHash(i)]))};
  // Unvisited queries still own the original fixed range when the first query advances.
  cursor.states={...cursor.states};
  for (const query of queries) {
    cursor.states[query.label] ??= {page:1,window:initial,pendingWindows:[],searchSort:cursor.searchSort};
    cursor.states[query.label].cycleWindow ??= initial;
  }
  if (cursor.cursorVersion !== 3) {
    // v2 completed queries can advance immediately; unfinished queries retain exact positions.
    // A v2 retry phase starts only after every discovery query finished the fixed range.
    const completed=new Set(cursor.doneSignals ?? []);
    if (cursor.phase === 'retry') for (const query of queries) if (query.label !== cursor.signal) completed.add(query.label);
    cursor.states={...cursor.states};
    for (const label of completed) {
      const state={...cursor.states[label],cycleWindow:initial,waiting:true,retryAt:undefined};
      cursor.states[label]=state;
      if (label === cursor.signal) Object.assign(cursor,state);
    }
    cursor.cursorVersion=3;
    delete cursor.doneSignals;
  }
  const activeSortChanged=cursor.searchSort !== undefined && cursor.searchSort !== settings.discover.sort;
  cursor.searchSort=settings.discover.sort;
  if ((matches && sortChanged) || activeSortChanged) {
    cursor.configHash = configHash; cursor.page = 1;
    delete cursor.pendingPage; delete cursor.retryAt;
    const reorder = (state:SignalState):SignalState => {
      const windows = [state.window, ...state.pendingWindows];
      if (settings.discover.sort === 'recent') windows.sort((a,b) => b.to.localeCompare(a.to));
      return { ...state,page:1, window:windows[0], pendingWindows:windows.slice(1), windowIncomplete:false,
        pendingPage:undefined,retryAt:undefined,retryKind:undefined,failures:0,searchSort:settings.discover.sort };
    };
    cursor.states = Object.fromEntries(Object.entries(cursor.states ?? {}).map(([label,state]) => [label,reorder(state)]));
    const active = reorder(signalState(cursor,initial));
    Object.assign(cursor, active);
    ctx.log('crawl.seed_sort_changed', { sort: settings.discover.sort, preservedWindow: cursor.cycleWindow });
  }
  delete cursor.backlogPaused;
  cursor.admissionThrottled = admission.throttled;
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
      window:cursor.window ?? initial,page:cursor.page,counts,...extra,...(previewOnly ? {completedThrough:undefined} : {})});
  const defer = async () => {await save(); summarize(); return {done:false,cursor};};
  const resetWindow = (next:SearchWindow) => {
    cursor = {...cursor,page:1,window:next,windowIncomplete:false};
    delete cursor.pendingPage;
  };
  const park = () => {
    cursor.states = {...cursor.states,[cursor.signal]:{...signalState(cursor,initial),lastServedAt:Date.now()}};
  };
  /** One page per turn; only authentication/quota waits suspend the whole lane. */
  const rotate = ():boolean => {
    park();
    const choices=queries.map((query,next) => ({index:next,state:cursor.states?.[query.label],
      step:(next-index+queries.length-1)%queries.length}));
    const ready=choices.filter(({state}) => !state?.retryAt || Date.parse(state.retryAt) <= Date.now());
    // If all queries sleep, expose the earliest wake-up to the outer lane budget.
    const ordered=ready.length ? ready.sort((a,b) => (a.state?.lastServedAt ?? 0)-(b.state?.lastServedAt ?? 0) || a.step-b.step)
      : choices.sort((a,b) => Date.parse(a.state?.retryAt ?? '')-Date.parse(b.state?.retryAt ?? ''));
    index=ordered[0].index;
    const saved=cursor.states?.[queries[index].label];
    const cycle=saved?.cycleWindow ?? initial;
    // Clear the prior query's optional fields before activating another query.
    cursor={...cursor,signal:queries[index].label,queryHash:queryHash(index),
      page:saved?.page ?? 1,window:saved?.window ?? cycle,cycleWindow:cycle,
      pendingWindows:saved?.pendingWindows ?? [],windowIncomplete:saved?.windowIncomplete,
      pendingPage:saved?.pendingPage,retryAt:saved?.retryAt,retryKind:saved?.retryKind,
      waiting:saved?.waiting,phase:saved?.phase ?? 'discovery',failures:saved?.failures};
    initial=cycle;
    if (saved?.searchSort && saved.searchSort !== settings.discover.sort) {
      const windows=[cursor.window!,...(cursor.pendingWindows ?? [])];
      if (settings.discover.sort === 'recent') windows.sort((a,b)=>b.to.localeCompare(a.to));
      cursor.window=windows[0];cursor.pendingWindows=windows.slice(1);cursor.page=1;
      delete cursor.pendingPage;delete cursor.retryAt;delete cursor.retryKind;cursor.failures=0;
    }
    return ready.length > 0;
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
    if (from+(latestOnly ? LATEST_SCAN_INTERVAL_MS : MIN_CYCLE_SPAN_MS) > Date.now()) {
      const retry=(cursor.incompleteWindows ?? []).filter(entry=>entry.signal === cursor.signal)
        .sort((a,b)=>a.retryAt.localeCompare(b.retryAt))[0];
      if (retry) {
        resetWindow(retry.window);cursor.phase='retry';cursor.waiting=false;cursor.retryAt=retry.retryAt;
        return Date.parse(retry.retryAt) <= Date.now();
      }
      cursor.retryAt=iso(new Date(from+(latestOnly ? LATEST_SCAN_INTERVAL_MS : MIN_CYCLE_SPAN_MS)));
      cursor.waiting=true;return false;
    }
    // Never skip the gap after downtime. The separate latest lane supplies fresh work
    // while each query's historical fixed range advances without a global barrier.
    initial = latestOnly ? {from:iso(new Date(from-LATEST_SCAN_OVERLAP_MS)),to:iso(new Date())} : chunkFrom(from);
    cursor={...cursor,page:1,window:initial,cycleWindow:initial,pendingWindows:[],phase:'discovery',waiting:false};
    delete cursor.pendingPage;delete cursor.retryAt;delete cursor.retryKind;
    return true;
  };
  const advance = ():boolean => {
    const pending = [...(cursor.pendingWindows ?? [])];
    const next = pending.shift();
    if (next) {cursor.pendingWindows = pending; resetWindow(next); return rotate();}
    const retry=(cursor.incompleteWindows ?? []).filter(entry=>entry.signal === cursor.signal)
      .sort((a,b)=>a.retryAt.localeCompare(b.retryAt))[0];
    if (cursor.phase !== 'retry' && retry && Date.parse(retry.retryAt) <= Date.now()) {
      resetWindow(retry.window);cursor.phase='retry';
    } else startNextCycle();
    return rotate();
  };

  if (cursor.retryAt && Date.parse(cursor.retryAt) > Date.now()) {
    if (sharedRetry(cursor)) return {done:false,cursor};
    if (!rotate()) return {done:searchDrained(cursor,queries.map(q=>q.label)),cursor};
  }

  for (let visited = 0; visited < settings.discover.pagesPerTick && admission.remainingNew > 0 && ctx.hasBudget(); visited++) {
    if (cursor.waiting && !startNextCycle()) {
      if (!rotate()) {const done=searchDrained(cursor,queries.map(q=>q.label));summarize(done);return {done,cursor};}
    }
    if (cursor.retryAt && Date.parse(cursor.retryAt) > Date.now()) return defer();
    delete cursor.retryAt;delete cursor.retryKind;
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
      const error=!result.ok ? result.error : !Array.isArray(result.value.items) ? {kind:'invalid_response' as const} : null;
      if (error) {
        cursor.failures=Math.min(32,(cursor.failures ?? 0)+1);
        ctx.log('crawl.seed_failed',{signal:signal.label,error:error.kind,page:cursor.page,window,
          failures:cursor.failures,...(error.kind === 'response_too_large' ?
            {stage:error.stage,limitBytes:error.limitBytes,observedBytes:error.observedBytes} : {})});
        await measure({searchRequests:searchRequests-requestsBefore},{blockedBy:error.kind === 'auth_unavailable' ? 'auth' : 'api_wait'});
        const pieces=error.kind === 'response_too_large' ? splitSearchWindow(window) : null;
        if (pieces) {
          const [next,later]=settings.discover.sort === 'recent' ? [pieces[1],pieces[0]] : pieces;
          cursor.pendingWindows=[later,...(cursor.pendingWindows ?? [])];
          resetWindow(next);
          cursor.failures=0;
        } else {
          const reset=error.kind === 'discovery_busy' ? error.retryAt
            : error.kind === 'rate_limited' || error.kind === 'auth_unavailable' ? error.resetAt : null;
          const delay=error.kind === 'discovery_busy' ? 60_000 : Math.min(15,2**Math.min(4,cursor.failures-1))*60_000;
          cursor.retryAt=new Date(Math.max(Date.now()+delay,reset?.getTime() ?? 0)).toISOString();
          cursor.retryKind=error.kind;
          if (sharedRetry(cursor)) return defer();
        }
        const ready=rotate();
        await save();
        if (!ready) return defer();
        continue;
      }
      // The error branch above also handles malformed successful search envelopes.
      if (!result.ok) return defer();
      cursor.failures=0;
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
        if (!retainIncomplete()) {rotate();await save();continue;}
      } else clearIncomplete();
      if (!cursor.windowIncomplete && !cursor.pendingWindows?.length
        && !cursor.incompleteWindows?.some(entry => entry.signal === signal.label)) {
        await measure({}, {completedThrough:initial.to});
      }
      // 훑을 것은 없지만(done) 어디까지 덮었는지는 남긴다 — 잃으면 다음 주기가 같은 구간을 다시 긁는다.
      if (!advance()) {const done=searchDrained(cursor,queries.map(q=>q.label));summarize(done); return {done,cursor};}
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
