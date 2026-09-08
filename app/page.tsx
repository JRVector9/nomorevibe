import { Suspense } from "react";
import Link from "next/link";
import { BrowseFilters, parseHomeSort, parseShown, type HomeSort } from "@/components/BrowseFilters";
import { HomeAside } from "@/components/home/HomeAside";
import { HomeHero } from "@/components/home/HomeHero";
import { HomePulse } from "@/components/home/HomePulse";
import { Icon } from "@/components/home/icons";
import { MethodologyDialog } from "@/components/home/MethodologyDialog";
import { ProjectGrid } from "@/components/home/ProjectGrid";
import { categoryCounts, listBuilders } from "@/lib/domain/products/repository";
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

const HOME_LIST_LIMIT = 100;

type SearchValue = string | string[] | undefined;
type Props = {
  searchParams: Promise<{
    sort?: SearchValue;
    category?: SearchValue;
    q?: SearchValue;
    builder?: SearchValue;
    shown?: SearchValue;
    saved?: SearchValue;
  }>;
};

function firstValue(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function listFor(
  sort: HomeSort,
  active: SeasonSummary,
  category: (typeof CATEGORIES)[number] | undefined,
  query: string | undefined,
  builder: string | undefined,
): Promise<ProductListItem[] | RankingListItem[]> {
  const options = { category, query, builder, limit: HOME_LIST_LIMIT };
  if (sort === "open") {
    return getPublicList(HOME_LIST_LIMIT, { sort: "recent", category, query, builder, hasRepository: true });
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
  return getPublicList(HOME_LIST_LIMIT, { sort: "recent", category, query, builder });
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
  const query = firstValue(params.q)?.trim() || undefined;
  // A plain header search should cover the public catalogue. Preserve an explicitly
  // selected sort, but do not limit an unqualified search to ranked products.
  const requestedSort = sortParam ? parseHomeSort(sortParam) : query ? "recent" : "weekly";
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
  let dbDown = false;

  try {
    pulse = await getHomePulse(now);
    builders = await listBuilders(["verified", "seeded"]);
  } catch (error) {
    logger.warn("home.pulse_unavailable", { error });
  }

  try {
    active = await getCurrentSeason();
    if (!active) {
      logger.warn("home.ranking_unavailable");
      effectiveSort = requestedSort === "weekly" || requestedSort === "trending" ? "recent" : requestedSort;
    }
    const publicCatalogue = effectiveSort === "recent" || effectiveSort === "open";
    const listPromise = active
      ? listFor(effectiveSort, active, category, query, builder)
      : publicCatalogue
        ? getPublicList(HOME_LIST_LIMIT, {
            sort: "recent",
            category,
            query,
            builder,
            hasRepository: effectiveSort === "open" ? true : undefined,
          })
        : getVerifiedList(HOME_LIST_LIMIT, { sort: "recent", category, query, builder });

    const [loadedCounts, loadedList] = await Promise.all([
      categoryCounts(publicCatalogue ? ["verified", "seeded"] : ["verified"]),
      listPromise,
    ]);
    counts = loadedCounts;
    list = loadedList;
    total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    /**
     * 검증된 제품이 시즌을 채울 만큼 없으면 첫 화면이 두어 개로 끝난다.
     *
     * 그 아래에 우리가 대신 올린 제품을 따로 이어 붙인다. 랭킹에 섞지 않고 구획을 나누므로
     * "검증된 것만 겨룬다"는 원칙은 그대로다. 검증된 제품이 차오르면 이 구획은 저절로 빠진다.
     */
    const minimumProducts = (active?.policy ?? DEFAULT_RANKING_POLICY).eligibility.minimumProducts;
    if (needsUnclaimedFill(total, minimumProducts)) {
      unclaimed = await getUnclaimedList(HOME_LIST_LIMIT - list.length, { category, query, builder });
      const seen = new Set(list.map((item) => item.slug));
      unclaimed = unclaimed.filter((item) => !seen.has(item.slug));
    }
  } catch (error) {
    logger.error("home.list_failed", { error });
    dbDown = true;
  }

  const state = { ...browseState, sort: effectiveSort };
  const filtered = Boolean(query || category || builder);
  const savedCandidates = savedOnly ? [...list, ...unclaimed] : list;

  return (
    <main className="wrap">
      <HomeHero />
      <HomePulse pulse={pulse} state={state} />

      <div className="content-layout">
        <section id="projects" aria-labelledby="projects-title">
          <div className="feed-head">
            <div>
              <h2 id="projects-title">발견할 가치가 있는 프로젝트</h2>
              <p>AI로 만들고, 사람이 다듬은 새로운 서비스들.</p>
            </div>
            <Link className="all-link" href="/">
              전체 보기 <Icon name="arrow-right" size={14} />
            </Link>
          </div>

          <BrowseFilters
            state={state}
            counts={counts}
            total={total}
            builders={builders}
            resultCount={list.length}
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
              <p>우리가 찾아서 올렸고 아직 주인이 나타나지 않은 제품입니다. 랭킹에는 들어가지 않습니다.</p>
              <div className="mt-3">
                <ProjectGrid products={unclaimed} browseState={state} />
              </div>
            </section>
          )}

          <div className="principle-box">
            <Icon name="sparkles" size={24} />
            <div>
              <strong>AI 기능이 없어도, AI로 만들었다면.</strong>
              문서 뷰어, 타이머, 쇼핑몰도 좋습니다. 여기서 중요한 건 무엇으로 만들었는가입니다.
            </div>
          </div>
        </section>

        <HomeAside />
      </div>

      <Suspense>
        <MethodologyDialog pulse={serializePulse(pulse)} />
      </Suspense>
    </main>
  );
}
