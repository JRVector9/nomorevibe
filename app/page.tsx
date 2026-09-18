import { Suspense } from "react";
import Link from "next/link";
import { BrowseFilters, parseHomeSort, parseShown, type HomeSort } from "@/components/BrowseFilters";
import { HomeAside } from "@/components/home/HomeAside";
import { listHomeNews } from "@/lib/news/repository";
import { HomeHero } from "@/components/home/HomeHero";
import { PopularTiers } from "@/components/home/PopularTiers";
import { HomePulse } from "@/components/home/HomePulse";
import { Icon } from "@/components/home/icons";
import { MethodologyDialog } from "@/components/home/MethodologyDialog";
import { ProjectGrid } from "@/components/home/ProjectGrid";
import { categoryCounts, countProducts, listBuilders } from "@/lib/domain/products/repository";
import { resolveSearchQuery } from "@/lib/domain/products/search-translation";
import type { SearchQuery } from "@/lib/domain/products/search";
import { CATEGORIES } from "@/lib/domain/products/schema";
import {
  getPublicList,
  getUnclaimedList,
  getVerifiedList,
  type ProductListItem,
} from "@/lib/domain/products/view";
import {
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
  limit: number,
): Promise<ProductListItem[] | RankingListItem[]> {
  const options = { category, query, builder, limit };
  if (sort === "open") {
    return getPublicList(limit, { sort: "recent", category, query, builder, hasRepository: true });
  }
  if (sort === "weekly") {
    return getSeasonRanking({ ...options, seasonKey: active.key, order: "rank" })
      .then((result) => result.items);
  }
  if (sort === "trending") {
    return getSeasonRanking({ ...options, seasonKey: active.key, order: "trending" })
      .then((result) => result.items);
  }
  if (sort === "all-time") return getAllTimeRanking(options);
  return getPublicList(limit, { sort: sort === "relevance" ? "relevance" : "recent", category, query, builder });
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
  filtered,
  hasUnclaimed,
}: {
  sort: HomeSort;
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

export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  const sortParam = firstValue(params.sort);
  const query = firstValue(params.q)?.trim().slice(0, 200) || undefined;
  // A plain header search should cover the public catalogue. Preserve an explicitly
  // selected sort, but do not limit an unqualified search to ranked products.
  const requestedSort = sortParam ? parseHomeSort(sortParam) : query ? "relevance" : "weekly";
  const categoryParam = firstValue(params.category);
  const category = CATEGORIES.find((item) => item === categoryParam);
  const builder = firstValue(params.builder)?.trim() || undefined;
  const shown = parseShown(firstValue(params.shown));
  const savedOnly = firstValue(params.saved) === "1";
  const now = new Date();
  const browseState = { sort: requestedSort, category, query, builder, shown };

  let active: SeasonSummary | null = null;
  let effectiveSort: HomeSort = requestedSort;
  let list: ProductListItem[] | RankingListItem[] = [];
  let unclaimed: ProductListItem[] = [];
  let counts: Record<string, number> = {};
  let builders: string[] = [];
  let pulse = emptyHomePulse(now);
  let total = 0;
  let resultCount = 0;
  let unclaimedTotal = 0;
  let dbDown = false;
  let translatedQuery: string | null = null;

  /**
   * 상단 집계·도구 목록은 제품 목록과 서로의 결과를 쓰지 않는다 — 먼저 띄워 두고 목록 조회와 겹친다.
   * 차례로 기다리면 목록 조회가 집계 쿼리 6개가 끝난 뒤에야 시작한다.
   *
   * allSettled 로 받는 이유: 목록 쪽이 먼저 던져 여기까지 늦게 와도 처리되지 않은 거부가 남지 않고,
   * 하나가 실패해도 다른 하나는 쓴다.
   */
  const asideLoad = Promise.allSettled([getHomePulse(now), listBuilders(["verified", "seeded"]), listHomeNews()]);

  try {
    active = await getCurrentSeason();
    if (!active) {
      logger.warn("home.ranking_unavailable");
      effectiveSort = requestedSort === "weekly" || requestedSort === "trending" ? "recent" : requestedSort;
    }
    const publicCatalogue = effectiveSort === "recent" || effectiveSort === "open" || effectiveSort === "relevance";
    /**
     * 한국어로 목적을 치면 영어 목록에 닿지 않는다. 그대로 찾아 보고 몇 건 안 되면 영어 낱말로
     * 옮겨 한 번 더 찾는다 — 옮긴 말은 결과 위에 밝힌다(search-translation.ts).
     */
    const search = await resolveSearchQuery(query);
    translatedQuery = search.translated;
    const options = { category, query: search.queries, builder, excludeDown: true };
    const [loadedCounts, matchingTotal, verifiedTotal] = await Promise.all([
      categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true }),
      countProducts({ statuses: ["verified", "seeded"], ...options, hasRepository: effectiveSort === "open" ? true : undefined }),
      countProducts({ statuses: ["verified"], excludeDown: true }),
    ]);
    counts = loadedCounts;
    total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const requestedLimit = savedOnly ? Math.max(shown, SAVED_INITIAL_CANDIDATES) : shown;
    // Public lists load only what is visible. Rankings retain their separate eligibility.
    const limit = publicCatalogue ? Math.min(requestedLimit, matchingTotal) : verifiedTotal;
    list = active
      ? await listFor(effectiveSort, active, category, search.queries, builder, limit)
      : publicCatalogue
        ? await getPublicList(limit, { ...options, sort: effectiveSort === "relevance" ? "relevance" : "recent", hasRepository: effectiveSort === "open" ? true : undefined })
        : await getVerifiedList(limit, { ...options, sort: "recent" });
    resultCount = publicCatalogue ? matchingTotal : list.length;

    const minimumProducts = (active?.policy ?? DEFAULT_RANKING_POLICY).eligibility.minimumProducts;
    if (!publicCatalogue && needsUnclaimedFill(verifiedTotal, minimumProducts)) {
      unclaimedTotal = await countProducts({ statuses: ["seeded"], ...options });
      unclaimed = await getUnclaimedList(Math.min(requestedLimit, unclaimedTotal), options);
    }
  } catch (error) {
    logger.error("home.list_failed", { error });
    dbDown = true;
  }

  const [pulseResult, buildersResult, newsResult] = await asideLoad;
  if (pulseResult.status === "fulfilled") pulse = pulseResult.value;
  if (buildersResult.status === "fulfilled") builders = buildersResult.value;
  const news = newsResult.status === "fulfilled" ? newsResult.value : [];
  const asideFailure = [pulseResult, buildersResult, newsResult]
    .find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (asideFailure) logger.warn("home.pulse_unavailable", { error: asideFailure.reason });

  const state = { ...browseState, sort: effectiveSort };
  const filtered = Boolean(query || category || builder);
  const savedCandidates = savedOnly ? [...list, ...unclaimed] : list;

  return (
    <main className="wrap">
      {!query && <>
      <HomeHero />
      <HomePulse pulse={pulse} state={state} />
      <Suspense fallback={<section className="popular-section"><h2>많이 쓰이는 프로젝트</h2></section>}>
        <PopularTiers personal={firstValue(params.personal) === "1"} />
      </Suspense>
      </>}

      <div className={`content-layout${query ? " search-results-layout" : ""}`}>
        <section id="projects" aria-labelledby="projects-title">
          <div className="feed-head">
            <div>
              <h2 id="projects-title">{query ? `“${query}” 검색 결과` : "발견할 가치가 있는 프로젝트"}</h2>
              {/* 목록이 영어라 한국어 검색어는 영어 낱말로 한 번 더 찾는다. 무엇으로 찾았는지 밝힌다 */}
              {translatedQuery && <p>영어로 “{translatedQuery}”도 함께 찾았습니다.</p>}
              {!query && <p>AI로 만들고, 사람이 다듬은 새로운 서비스들.</p>}
            </div>
            <Link className="all-link" href="/?sort=recent">
              전체 보기 <Icon name="arrow-right" size={14} />
            </Link>
          </div>

          <BrowseFilters
            state={state}
            counts={counts}
            total={total}
            builders={builders}
            resultCount={resultCount}
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
              key={`${effectiveSort}-${category ?? ""}-${builder ?? ""}-${query ?? ""}-${savedOnly ? "saved" : "all"}`}
              totalCount={resultCount}
              products={savedCandidates}
              browseState={state}
              initialOnlySaved={savedOnly}
            />
          ) : (
            <EmptyReason
              sort={effectiveSort}
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

          {!query && <div className="principle-box">
            <Icon name="sparkles" size={24} />
            <div>
              <strong>AI 기능이 없어도, AI로 만들었다면.</strong>
              문서 뷰어, 타이머, 쇼핑몰도 좋습니다. 여기서 중요한 건 무엇으로 만들었는가입니다.
            </div>
          </div>}
        </section>

        {!query && <HomeAside news={news} />}
      </div>

      <Suspense>
        <MethodologyDialog pulse={serializePulse(pulse)} />
      </Suspense>
    </main>
  );
}
