import Link from "next/link";
import { BrowseFilters, parseHomeSort, type HomeSort } from "@/components/BrowseFilters";
import { DiscoveryBoards } from "@/components/DiscoveryBoards";
import { EmptyState } from "@/components/EmptyState";
import { ProductList } from "@/components/ProductCard";
import { RankingTable } from "@/components/RankingTable";
import { categoryCounts } from "@/lib/domain/products/repository";
import { CATEGORIES } from "@/lib/domain/products/schema";
import { getUnclaimedList, getVerifiedList, type ProductListItem } from "@/lib/domain/products/view";
import {
  getAllTimeRanking,
  getCurrentSeason,
  getDiscoveryBoards,
  getSeasonRanking,
  type RankingListItem,
  type SeasonSummary,
} from "@/lib/domain/ranking/view";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

const HOME_LIST_LIMIT = 100;

type Props = { searchParams: Promise<{ sort?: string; category?: string; q?: string }> };
type Boards = Awaited<ReturnType<typeof getDiscoveryBoards>>;

function listFor(
  sort: HomeSort,
  active: SeasonSummary,
  category: (typeof CATEGORIES)[number] | undefined,
  query: string | undefined,
): Promise<ProductListItem[] | RankingListItem[]> {
  const options = { category, query, limit: HOME_LIST_LIMIT };
  if (sort === "weekly") {
    return getSeasonRanking({ ...options, seasonKey: active.key, order: "rank" })
      .then((result) => result.items);
  }
  if (sort === "trending") {
    return getSeasonRanking({ ...options, seasonKey: active.key, order: "trending" })
      .then((result) => result.items);
  }
  if (sort === "all-time") return getAllTimeRanking(options);
  return getVerifiedList(HOME_LIST_LIMIT, { sort: "recent", category, query });
}

/**
 * 빈 화면은 이유마다 다른 말을 해야 한다.
 *
 * 순위 정렬에서 결과가 없는 것은 제품이 없다는 뜻이 아니다 — 순위는 검증된 제품의 유효
 * 방문으로만 매기므로, 제품이 34개 있어도 그 방문이 없으면 비어 보인다. 거기에 "아직
 * 등록된 제품이 없습니다"라고 적으면 등록부터 하라고 잘못 안내하게 된다.
 */
function EmptyReason({ sort, filtered }: { sort: HomeSort; filtered: boolean }) {
  if (filtered) {
    return (
      <EmptyState>
        조건에 맞는 제품이 없습니다.{" "}
        <Link href="/" className="font-semibold text-accent">전체 보기</Link>
      </EmptyState>
    );
  }

  if (sort !== "recent") {
    return (
      <EmptyState>
        아직 순위에 오른 제품이 없습니다. 검증된 제품에 유효 방문이 쌓이면 나타납니다.{" "}
        <Link href="/?sort=recent" className="font-semibold text-accent">최신순으로 보기</Link>
      </EmptyState>
    );
  }

  return (
    <EmptyState>
      아직 등록된 제품이 없습니다.{" "}
      <Link href="/launch" className="font-semibold text-accent">/nomorevibe</Link>{" "}
      로 첫 번째 제품을 등록해보세요.
    </EmptyState>
  );
}

export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  const requestedSort = parseHomeSort(params.sort);
  const category = CATEGORIES.find((item) => item === params.category);
  const query = params.q?.trim() || undefined;
  const now = new Date();

  let active: SeasonSummary | null = null;
  let effectiveSort: HomeSort = requestedSort;
  let list: ProductListItem[] | RankingListItem[] = [];
  let unclaimed: ProductListItem[] = [];
  let boards: Boards | null = null;
  let counts: Record<string, number> = {};
  let total = 0;
  let dbDown = false;

  try {
    active = await getCurrentSeason();
    if (!active) {
      logger.warn("home.ranking_unavailable");
      effectiveSort = "recent";
    }
    const listPromise = active
      ? listFor(effectiveSort, active, category, query)
      : getVerifiedList(HOME_LIST_LIMIT, { sort: "recent", category, query });

    const [loadedBoards, loadedCounts, loadedList] = await Promise.all([
      getDiscoveryBoards(),
      categoryCounts(["verified"]),
      listPromise,
    ]);
    boards = loadedBoards;
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
    if (list.length < minimumProducts) {
      unclaimed = await getUnclaimedList(HOME_LIST_LIMIT - list.length, { category, query });
    }
  } catch (error) {
    logger.error("home.list_failed", { error });
    dbDown = true;
  }

  const trendWindowHours = active?.policy.trend.windowHours ?? 24;

  return (
    <main className="mx-auto max-w-[1280px] px-6 pb-20">
      <section className="pb-2 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">AI로 만든 제품들</h1>
        <p className="mt-1.5 max-w-[68ch] text-fg-2">
          AI로 만들어 배포된 실제 서비스들입니다. 도메인 소유권을 우리가 직접 확인한 제품에는{" "}
          <span className="font-semibold text-up">✓ 검증됨</span>이 붙고, 우리가 찾아서 올렸지만 아직
          주인이 나타나지 않은 제품은 <span className="font-semibold text-fg-2">미클레임</span>으로
          표시합니다.
        </p>
      </section>


      {boards && (
        <section className="mt-5">
          <h2 className="sr-only">발견 보드</h2>
          <DiscoveryBoards boards={boards} now={now} />
        </section>
      )}

      <BrowseFilters state={{ sort: effectiveSort, category, query }} counts={counts} total={total} />

      {dbDown ? (
        <div className="mt-10">
          <EmptyState>일시적으로 목록을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.</EmptyState>
        </div>
      ) : list.length === 0 ? (
        <div className="mt-10">
          <EmptyReason sort={effectiveSort} filtered={Boolean(query || category)} />
        </div>
      ) : effectiveSort === "recent" ? (
        <div className="mt-6"><ProductList products={list} /></div>
      ) : (
        <div className="mt-6">
          <RankingTable
            items={list as RankingListItem[]}
            windowHours={trendWindowHours}
            scoreMode={effectiveSort === "all-time"
              ? "valid_visits"
              : active?.policy.scoring.mode ?? "valid_visits"}
            mode={effectiveSort === "all-time" ? "all-time" : "season"}
          />
        </div>
      )}

      {unclaimed.length > 0 && (
        <section className="mt-10">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[15px] font-extrabold">새로 발견됨</h2>
            <p className="text-[13px] text-fg-3">
              우리가 찾아서 올렸고 아직 주인이 나타나지 않은 제품입니다. 랭킹에는 들어가지 않습니다.
            </p>
          </div>
          <div className="mt-3"><ProductList products={unclaimed} /></div>
        </section>
      )}
    </main>
  );
}
