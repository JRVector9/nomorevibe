import { after } from "next/server";
import { Suspense } from "react";
import Link from "next/link";
import { BrowseFilters, metricHref, parseHomeSort, parseShown, type HomeSort } from "@/components/BrowseFilters";
import { ActiveList } from "@/components/home/ActiveList";
import { CompactRow } from "@/components/home/CompactRow";
import { IntroLine } from "@/components/home/IntroLine";
import { LaunchBand } from "@/components/home/LaunchBand";
import { listHomeNews } from "@/lib/news/repository";
import { NewsList } from "@/components/home/NewsList";
import { PopularTiers } from "@/components/home/PopularTiers";
import { MethodologyDialog } from "@/components/home/MethodologyDialog";
import { ProjectGrid } from "@/components/home/ProjectGrid";
import { ToolsBoard } from "@/components/home/ToolsBoard";
import { categoryCounts, countProducts, RISING_MAX_STARS } from "@/lib/domain/products/repository";
import { resolveSearchQuery } from "@/lib/domain/products/search-translation";
import type { SearchQuery } from "@/lib/domain/products/search";
import { CATEGORIES } from "@/lib/domain/products/schema";
import {
  getNewThisWeek,
  getPublicList,
  getUnclaimedList,
  getVerifiedList,
  NEW_THIS_WEEK_MIN_STARS,
  type ProductListItem,
} from "@/lib/domain/products/view";
import { recordSearch } from "@/lib/domain/products/search-log";
import {
  completedWindows,
  emptyHomePulse,
  formatAsOfKst,
  getHomePulse,
  type HomePulse as Pulse,
} from "@/lib/domain/products/home-pulse";
import {
  getAllTimeRanking,
  getCurrentSeason,
  getSeasonRanking,
  type RankingListItem,
  type SeasonSummary,
} from "@/lib/domain/ranking/view";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { logger } from "@/lib/observability/logger";
import { getSettings as getCrawlSettings } from "@/lib/crawl/settings";
import { agentClientLabel } from "@/lib/domain/evidence/agents/view";

export const dynamic = "force-dynamic";

// Saved IDs are filtered in the browser; preserve the existing candidate pool.
const SAVED_INITIAL_CANDIDATES = 100;

type SearchValue = string | string[] | undefined;
type Props = {
  searchParams: Promise<{
    sort?: SearchValue;
    category?: SearchValue;
    q?: SearchValue;
    builder?: SearchValue;
    observedTool?: SearchValue;
    shown?: SearchValue;
    saved?: SearchValue;
    personal?: SearchValue;
  }>;
};

function firstValue(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function listFor(
  sort: HomeSort,
  active: SeasonSummary,
  category: (typeof CATEGORIES)[number] | undefined,
  query: SearchQuery | undefined,
  builder: string | undefined,
  observedTool: string | undefined,
  limit: number,
): Promise<ProductListItem[] | RankingListItem[]> {
  const options = { category, query, builder, observedTool };
  if (sort === "open") {
    return getPublicList(limit, { ...options, sort: "recent", hasRepository: true });
  }
  if (sort === "weekly") {
    return getSeasonRanking({ ...options, limit, seasonKey: active.key, order: "rank" })
      .then((result) => result.items);
  }
  if (sort === "trending") {
    return getSeasonRanking({ ...options, limit, seasonKey: active.key, order: "trending" })
      .then((result) => result.items);
  }
  if (sort === "all-time") return getAllTimeRanking({ ...options, limit });
  return getPublicList(limit, { ...options, sort: sort === "relevance" ? "relevance" : "recent" });
}

/**
 * 미클레임 구획을 붙일지.
 *
 * 기준은 "검증된 제품이 몇 개나 모였느냐"지 지금 화면에 몇 줄이 떴느냐가 아니다. 순위
 * 목록은 policy.leaderboard.limit(기본 10)에서 잘리고 그 상한은 언제나 minimumProducts
 * (기본 20) 이하라(policy.ts의 superRefine), 목록 길이로 재면 조건이 늘 참이 되어 구획이
 * 영영 빠지지 않는다. 필터가 걸린 화면도 전역 수를 본다 — 카테고리 하나가 비었다고
 * 시장에 제품이 모자란 것은 아니다.
 */
export function needsUnclaimedFill(verifiedTotal: number, minimumProducts: number): boolean {
  return verifiedTotal < minimumProducts;
}

/**
 * 검증 제품이 모자라 방문 순위를 세울 수 없는 동안 순위 탭이 대신 보여주는 공개 목록의 순서.
 *
 * 2026-10-02 운영: 공개 25,757건에 검증 0 — 기본 탭 '추천'과 '관심 많은 순'이 늘 "아직 순위에 오른
 * 제품이 없습니다"였다. 그동안은 GitHub 이 주는 숫자로 채운다: 추천은 마지막 확인 사이에 스타가 는 순
 * (스타 2천 미만 — 그 위는 스타 구간이 따로 보여준다), 관심 많은 순은 스타 많은 순. 기준은
 * needsUnclaimedFill 과 같다 — 순위가 서는 순간 둘 다 원래 자리로 돌아간다.
 */
export type FallbackSort = "rising" | "stars";
export function fallbackSort(sort: HomeSort, verifiedTotal: number, minimumProducts: number): FallbackSort | null {
  if (!needsUnclaimedFill(verifiedTotal, minimumProducts)) return null;
  return sort === "weekly" ? "rising" : sort === "all-time" ? "stars" : null;
}

/**
 * 빈 화면은 이유마다 다른 말을 해야 한다.
 *
 * 순위 정렬에서 결과가 없는 것은 제품이 없다는 뜻이 아니다 — 순위는 검증된 제품의 유효
 * 방문으로만 매기므로, 제품이 34개 있어도 그 방문이 없으면 비어 보인다. 거기에 "아직
 * 등록된 제품이 없습니다"라고 적으면 등록부터 하라고 잘못 안내하게 된다.
 *
 * 아래에 미클레임 목록이 붙는 화면에서는 "없습니다"라고 말할 수 없다 — 화면이 제 말을
 * 반박한다. 순위가 비었다는 설명만 그 목록과 어긋나지 않는다. 미클레임 제품은 애초에
 * 순위에 들어가지 않기 때문이다.
 */
function EmptyReason({
  sort,
  fallback,
  filtered,
  hasUnclaimed,
}: {
  sort: HomeSort;
  fallback: FallbackSort | null;
  filtered: boolean;
  hasUnclaimed: boolean;
}) {
  if (filtered && !hasUnclaimed) {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <h3>조건에 맞는 제품이 없습니다</h3>
          <p>다른 검색어나 필터로 다시 찾아보세요.</p>
          <Link href="/" className="secondary">전체 보기</Link>
        </div>
      </div>
    );
  }

  // 순위 대신 보여주는 목록이 비었다 — 순위 이야기를 하면 화면과 어긋난다
  if (fallback) {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <h3>아직 스타 변화를 확인한 프로젝트가 없습니다</h3>
          <p>GitHub 스타를 하루 간격으로 다시 확인하면 나타납니다.</p>
          <Link href="/?sort=recent" className="secondary">최신순으로 보기</Link>
        </div>
      </div>
    );
  }

  if (sort !== "recent" && sort !== "open") {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <h3>아직 순위에 오른 제품이 없습니다</h3>
          <p>검증된 제품에 유효 방문이 쌓이면 나타납니다.</p>
          <Link href="/?sort=recent" className="secondary">최신순으로 보기</Link>
        </div>
      </div>
    );
  }

  if (hasUnclaimed) return null;

  return (
    <div className="projects-grid">
      <div className="empty-state">
        <h3>아직 등록된 제품이 없습니다</h3>
        <p>
          <Link href="/launch" className="font-semibold text-accent">/nomorevibe</Link>
          {" "}로 첫 번째 제품을 등록해보세요.
        </p>
      </div>
    </div>
  );
}

function serializePulse(pulse: Pulse) {
  return {
    ...pulse,
    asOf: pulse.asOf.toISOString(),
    asOfLabel: formatAsOfKst(pulse.asOf),
  };
}

type HomeParams = Awaited<Props["searchParams"]>;

/**
 * 검색어가 있으면 결과를 기다리지 않고 틀부터 보낸다(스트리밍).
 *
 * 한국어 검색어는 처음 한 번 영어로 옮기느라(게이트웨이) 결과가 늦다 — 옮기는 동안 검색창까지 빈 화면이었다.
 * 2026-09-26 운영 실측: 처음 치는 한국어 질의는 첫 바이트까지 2.4~3.5초, 같은 질의 두 번째(캐시)는 0.7~1.6초,
 * 영어는 0.8~1.0초. 검색창(SiteHeader)은 레이아웃이라 이 틀과 함께 먼저 나가고, 결과는 다 찾으면 이어서 온다.
 * 검색어가 없으면 예전처럼 다 그린 뒤에 보낸다 — 번역이 없어 기다릴 것이 짧다.
 */
export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  const query = firstValue(params.q)?.trim().slice(0, 200) || undefined;
  if (!query) return HomeContent({ params });
  return (
    <Suspense fallback={<SearchPending query={query} />}>
      <HomeContent params={params} />
    </Suspense>
  );
}

/** 검색 결과를 찾는 동안 — 결과 화면과 같은 머리를 두어 다 찾았을 때 자리가 튀지 않게 */
function SearchPending({ query }: { query: string }) {
  return (
    <main className="wrap">
      <section id="projects" aria-labelledby="projects-title" aria-busy="true" className="feed">
        <div className="row-head">
          <div>
            <h2 id="projects-title" className="row-title">“{query}” 검색 결과</h2>
            <p className="row-note">찾는 중입니다…</p>
          </div>
        </div>
      </section>
    </main>
  );
}

export async function HomeContent({ params }: { params: HomeParams }) {
  const sortParam = firstValue(params.sort);
  const query = firstValue(params.q)?.trim().slice(0, 200) || undefined;
  // A plain header search should cover the public catalogue. Preserve an explicitly
  // selected sort, but do not limit an unqualified search to ranked products.
  const requestedSort = sortParam ? parseHomeSort(sortParam) : query ? "relevance" : "weekly";
  const categoryParam = firstValue(params.category);
  const category = CATEGORIES.find((item) => item === categoryParam);
  const builder = firstValue(params.builder)?.trim() || undefined;
  const toolParam = firstValue(params.observedTool)?.trim().slice(0, 80);
  // 직접 주소로도 숨겨 둔 관찰 사실을 거르지 않는다. 설정을 못 읽으면 공개하지 않는다.
  const displayTools = toolParam ? await getCrawlSettings().then(settings => settings.agentEvidence.displayObservedFacts).catch(() => false) : false;
  const observedTool = toolParam && displayTools ? agentClientLabel(toolParam) : undefined;
  const shown = parseShown(firstValue(params.shown));
  const savedOnly = firstValue(params.saved) === "1";
  const now = new Date();
  const browseState = { sort: requestedSort, category, query, builder, observedTool, shown };

  let active: SeasonSummary | null = null;
  let effectiveSort: HomeSort = requestedSort;
  let list: ProductListItem[] | RankingListItem[] = [];
  let unclaimed: ProductListItem[] = [];
  let counts: Record<string, number> = {};
  let pulse = emptyHomePulse(now);
  let total = 0;
  let resultCount = 0;
  let unclaimedTotal = 0;
  let dbDown = false;
  let translatedQuery: string | null = null;
  let fallback: FallbackSort | null = null;
  let rankingReady = true;
  let stripShown = 0;

  /**
   * 상단 집계·소식은 제품 목록과 서로의 결과를 쓰지 않는다 — 먼저 띄워 두고 목록 조회와 겹친다.
   * 차례로 기다리면 목록 조회가 집계 쿼리 6개가 끝난 뒤에야 시작한다.
   *
   * allSettled 로 받는 이유: 목록 쪽이 먼저 던져 여기까지 늦게 와도 처리되지 않은 거부가 남지 않고,
   * 하나가 실패해도 다른 하나는 쓴다.
   */
  const asideLoad = Promise.allSettled([getHomePulse(now), listHomeNews()]);

  /** 첫 화면의 급상승 띠 — 필터·검색이 없을 때만. 피드의 '추천'(대체 목록)은 띠 다음부터 이어 받는다 */
  const RISING_STRIP = 5;
  const filtered = Boolean(query || category || builder || observedTool);
  const stripLoad = filtered ? Promise.resolve<ProductListItem[]>([]) : getPublicList(RISING_STRIP, { sort: "rising", rising: true }).catch(() => []);
  const newLoad = filtered ? Promise.resolve<ProductListItem[]>([]) : getNewThisWeek(5, completedWindows(now).weekStart).catch(() => []);

  /*
   * 서로 기다릴 필요가 없는 것은 함께 시작한다 — 시즌·검색어 해석·카테고리 개수·검증 수(2026-10-06: 시즌을 받은 뒤에야
   * 개수를 세 홈이 한 왕복 더 기다렸다). 먼저 실패한 것이 처리되지 않은 거절로 남지 않게 잡아 두고, 아래 await 가 다시 던진다.
   */
  const seasonLoad = getCurrentSeason();
  const searchLoad = resolveSearchQuery(query);
  const countsLoad = categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true });
  const verifiedLoad = countProducts({ statuses: ["verified"], excludeDown: true });
  for (const load of [seasonLoad, searchLoad, countsLoad, verifiedLoad]) load.catch(() => {});

  try {
    active = await seasonLoad;
    if (!active) {
      logger.warn("home.ranking_unavailable");
      effectiveSort = requestedSort === "weekly" || requestedSort === "trending" ? "recent" : requestedSort;
    }
    /**
     * 한국어로 목적을 치면 영어 목록에 닿지 않는다. 그대로 찾아 보고 몇 건 안 되면 영어 낱말로
     * 옮겨 한 번 더 찾는다 — 옮긴 말은 결과 위에 밝힌다(search-translation.ts).
     */
    const search = await searchLoad;
    translatedQuery = search.translated;
    const options = { category, query: search.queries, builder, observedTool, excludeDown: true };
    /**
     * 순위 탭의 개수는 순위가 서지 않을 때(fallbackSort)만 쓴다 — 그때 '추천'은 스타가 는 제품만 센다.
     * 순위가 서면 이 값은 쓰이지 않으므로 검증 수를 기다리지 않고 함께 센다.
     */
    const listOptions = {
      ...options,
      hasRepository: effectiveSort === "open" ? true : undefined,
      rising: effectiveSort === "weekly" ? true : undefined,
    };
    const verifiedTotal = await verifiedLoad;
    const minimumProducts = (active?.policy ?? DEFAULT_RANKING_POLICY).eligibility.minimumProducts;
    rankingReady = !needsUnclaimedFill(verifiedTotal, minimumProducts);
    fallback = fallbackSort(effectiveSort, verifiedTotal, minimumProducts);
    const publicCatalogue = effectiveSort === "recent" || effectiveSort === "open" || effectiveSort === "relevance" || fallback !== null;
    const requestedLimit = savedOnly ? Math.max(shown, SAVED_INITIAL_CANDIDATES) : shown;
    const loadList = (limit: number, offset: number) => fallback
      ? getPublicList(limit, { ...listOptions, sort: fallback, offset })
      : active
        ? listFor(effectiveSort, active, category, search.queries, builder, observedTool, limit)
        : publicCatalogue
          ? getPublicList(limit, { ...listOptions, sort: effectiveSort === "relevance" ? "relevance" : "recent" })
          : getVerifiedList(limit, { ...options, sort: "recent" });
    const matchingLoad = countProducts({ statuses: ["verified", "seeded"], ...listOptions });
    /*
     * 목록이 개수를 기다리는 것은 띠를 나눌지 정할 때뿐이다(거르기 없음 · 추천 대체 목록). 나머지는 LIMIT 이 이미 막으니
     * 개수와 함께 받는다 — 넓은 검색에서 개수(214ms)를 기다린 뒤 목록(183ms)을 받던 것을 겹친다.
     */
    const stripPossible = !filtered && !savedOnly && fallback === "rising";
    const earlyList = stripPossible ? null : loadList(publicCatalogue ? requestedLimit : verifiedTotal, 0);
    earlyList?.catch(() => {});
    const [loadedCounts, matchingTotal] = await Promise.all([countsLoad, matchingLoad]);
    counts = loadedCounts;
    total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    // Public lists load only what is visible. Rankings retain their separate eligibility.
    // 급상승 띠가 앞 5개를 보여 준 '추천'은 그 뒤부터 이어 받는다 — 띠와 피드가 겹치지 않게
    // 저장 목록 보기(savedOnly)는 브라우저가 거르므로 띠의 다섯을 건너뛰면 그 안의 저장 제품이 사라진다
    // 급상승이 띠 하나를 채우고도 남을 때만 띠와 피드를 나눈다 — 다섯 이하면 띠가 다 가져가 피드가 '없다'고 말한다
    stripShown = stripPossible && matchingTotal > RISING_STRIP ? RISING_STRIP : 0;
    const limit = publicCatalogue ? Math.min(requestedLimit, Math.max(0, matchingTotal - stripShown)) : verifiedTotal;
    list = earlyList ? (await earlyList).slice(0, limit) : await loadList(limit, stripShown);
    resultCount = publicCatalogue ? Math.max(0, matchingTotal - stripShown) : list.length;

    if (!publicCatalogue && !rankingReady) {
      unclaimedTotal = await countProducts({ statuses: ["seeded"], ...options });
      unclaimed = await getUnclaimedList(Math.min(requestedLimit, unclaimedTotal), options);
    }
  } catch (error) {
    logger.error("home.list_failed", { error });
    dbDown = true;
  }

  /**
   * 검색 기록은 응답을 보낸 뒤에 남긴다(after) — 기록이 화면을 늦추지 않는다.
   * DB 가 죽어 목록을 못 불러온 때(dbDown)는 결과 0건이 아니라 "재지 못한 것"이라 남기지 않는다.
   */
  if (query && !dbDown) {
    const found = resultCount;
    const keywords = translatedQuery;
    const narrowed = Boolean(category || builder || observedTool);
    /**
     * 걸린 시간은 이 화면이 만들어지기 시작한 때(now)부터 기록하는 때까지다 — 검색 쿼리만이
     * 아니라 사람이 기다린 시간이다. 시계는 기록하는 쪽이 읽는다(렌더는 시계를 읽지 않는다).
     */
    after(() => recordSearch({ query, keywords, results: found, filtered: narrowed, startedAt: now }));
  }

  const [pulseResult, newsResult] = await asideLoad;
  if (pulseResult.status === "fulfilled") pulse = pulseResult.value;
  const news = newsResult.status === "fulfilled" ? newsResult.value : [];
  const asideFailure = [pulseResult, newsResult]
    .find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (asideFailure) logger.warn("home.pulse_unavailable", { error: asideFailure.reason });
  const [strip, fresh] = await Promise.all([stripLoad, newLoad]);

  const state = { ...browseState, sort: effectiveSort };
  const savedCandidates = savedOnly ? [...list, ...unclaimed] : list;

  return (
    <main className="wrap">
      {!query && <IntroLine pulse={pulse} state={state} />}
      {!filtered && (fallback !== "rising" || stripShown > 0) && (
        <CompactRow id="rising" title="지금 뜨는 프로젝트" note={`마지막 확인 사이 GitHub 스타가 가장 많이 늘었습니다 · 스타 ${RISING_MAX_STARS.toLocaleString("ko-KR")} 미만`}
          more={fallback === "rising" ? { href: "#projects", label: `${resultCount.toLocaleString("ko-KR")}개 모두 보기` } : { href: "/?sort=weekly#projects", label: "모두 보기" }}
          items={strip} trailing="category" />
      )}

      <section id="projects" aria-labelledby="projects-title" className="feed">
        <div className="row-head">
          <div>
            <h2 id="projects-title" className="row-title">{query ? `“${query}” 검색 결과` : "발견할 가치가 있는 프로젝트"}</h2>
            {/* 목록이 영어라 한국어 검색어는 영어 낱말로 한 번 더 찾는다. 무엇으로 찾았는지 밝힌다 */}
            {translatedQuery && <p className="row-note">영어로 “{translatedQuery}”도 함께 찾았습니다.</p>}
            {/* 순위 대신 보여주는 목록은 무엇으로 줄 세웠는지 밝힌다 — 숫자의 기준이 보여야 한다 */}
            {!query && fallback === "rising" && <p className="row-note">마지막 확인 사이 GitHub 스타가 늘어난 순 · <Link href={metricHref(state, "rising")} scroll={false}>집계 기준</Link></p>}
            {!query && fallback === "stars" && <p className="row-note">GitHub 스타가 많은 순.</p>}
          </div>
        </div>

        <BrowseFilters
          state={state}
          counts={counts}
          total={total}
          resultCount={resultCount}
          listLabel={fallback === "rising" ? "스타 증가 순" : fallback === "stars" ? "스타 많은 순" : undefined}
        />

        {dbDown ? (
          <div className="projects-grid">
            <div className="empty-state">
              <h3>일시적으로 목록을 불러올 수 없습니다</h3>
              <p>잠시 후 다시 시도해주세요.</p>
            </div>
          </div>
        ) : savedOnly || list.length > 0 ? (
          <ProjectGrid
            key={`${effectiveSort}-${category ?? ""}-${builder ?? ""}-${observedTool ?? ""}-${query ?? ""}-${savedOnly ? "saved" : "all"}`}
            totalCount={resultCount}
            products={savedCandidates}
            browseState={state}
            initialOnlySaved={savedOnly}
          />
        ) : (
          <EmptyReason
            sort={effectiveSort}
            fallback={fallback}
            filtered={filtered}
            hasUnclaimed={unclaimed.length > 0}
          />
        )}

        {!savedOnly && unclaimed.length > 0 && (
          <section className="unclaimed-block">
            <h2>주인을 기다리는 제품</h2>
            <div className="mt-3">
              <ProjectGrid products={unclaimed} browseState={state} totalCount={unclaimedTotal} />
            </div>
          </section>
        )}
      </section>

      {!query && (
        <Suspense fallback={<section className="popular-section" id="popular"><h2>많이 쓰이는 프로젝트</h2></section>}>
          <PopularTiers personal={firstValue(params.personal) === "1"} />
        </Suspense>
      )}
      {!filtered && (
        <CompactRow id="new" title="이번 주 새로 나온 프로젝트" note={`최근 7일에 처음 공개된 프로젝트 중 스타 ${NEW_THIS_WEEK_MIN_STARS} 이상`}
          more={{ href: "/?sort=recent", label: "최신순 모두 보기" }} items={fresh} trailing="listed" />
      )}
      {!query && (
        <div className="two-col">
          <ToolsBoard tools={pulse.tools} state={state} />
          <ActiveList active={pulse.active} projects={pulse.updates.projects} />
        </div>
      )}
      {!query && <NewsList news={news} />}
      {!query && <LaunchBand />}

      <Suspense>
        <MethodologyDialog pulse={serializePulse(pulse)} rankingFallback={!rankingReady} />
      </Suspense>
    </main>
  );
}
