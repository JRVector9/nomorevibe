import Link from "next/link";
import { BrowseFilters, parseHomeSort, type HomeSort } from "@/components/BrowseFilters";
import { DiscoveryBoards } from "@/components/DiscoveryBoards";
import { EmptyState } from "@/components/EmptyState";
import { MarketStats } from "@/components/MarketStats";
import { ProductList } from "@/components/ProductCard";
import { RankingTable } from "@/components/RankingTable";
import { categoryCounts } from "@/lib/domain/products/repository";
import { CATEGORIES } from "@/lib/domain/products/schema";
import { marketStats, type MarketStats as MarketStatsData } from "@/lib/domain/products/stats";
import { getVerifiedList, type ProductListItem } from "@/lib/domain/products/view";
import {
  getAllTimeRanking,
  getCurrentSeason,
  getDiscoveryBoards,
  getSeasonHistory,
  getSeasonRanking,
  RANKING_STALE_MS,
  type RankingListItem,
  type SeasonSummary,
} from "@/lib/domain/ranking/view";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

const HOME_LIST_LIMIT = 100;
const KST_DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

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

function remainingTime(endsAt: Date, now: Date): string {
  const milliseconds = endsAt.getTime() - now.getTime();
  if (milliseconds <= 0) return "경계 처리 대기";
  const hours = Math.ceil(milliseconds / 3_600_000);
  if (hours < 24) return `${hours}시간 남음`;
  return `${Math.ceil(hours / 24)}일 남음`;
}

function snapshotAge(refreshedAt: Date | null, now: Date): string {
  if (!refreshedAt) return "스냅샷 집계 대기";
  const age = Math.max(0, now.getTime() - refreshedAt.getTime());
  const minutes = Math.floor(age / 60_000);
  const label = minutes < 1 ? "방금" : minutes < 60 ? `${minutes}분 전` : `${Math.floor(minutes / 60)}시간 전`;
  return `스냅샷 ${label}${age > RANKING_STALE_MS ? " · 오래됨" : ""}`;
}

function SeasonHeader({
  season,
  latestClosed,
  now,
}: {
  season: SeasonSummary;
  latestClosed: SeasonSummary | null;
  now: Date;
}) {
  return (
    <section className="mt-5 rounded-[12px] border border-line bg-bg-card px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-[15px] font-extrabold">{season.key}</h2>
        <span className="text-[13px] text-fg-2">
          {KST_DATE_TIME.format(season.startsAt)} – {KST_DATE_TIME.format(season.endsAt)} KST
        </span>
        <span className="text-[13px] font-semibold text-accent">{remainingTime(season.endsAt, now)}</span>
        <span className="text-[13px] text-fg-3">{snapshotAge(season.refreshedAt, now)}</span>
        <div className="ml-auto flex gap-3 text-[13px] font-semibold">
          <Link href={`/rankings/${season.key}`} className="text-accent hover:underline">현재 규칙 보기</Link>
          {latestClosed && (
            <Link href={`/rankings/${latestClosed.key}`} className="text-fg-2 hover:text-fg">지난 시즌</Link>
          )}
        </div>
      </div>
    </section>
  );
}

export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  const requestedSort = parseHomeSort(params.sort);
  const category = CATEGORIES.find((item) => item === params.category);
  const query = params.q?.trim() || undefined;
  const now = new Date();

  let active: SeasonSummary | null = null;
  let latestClosed: SeasonSummary | null = null;
  let effectiveSort: HomeSort = requestedSort;
  let list: ProductListItem[] | RankingListItem[] = [];
  let boards: Boards | null = null;
  let counts: Record<string, number> = {};
  let stats: MarketStatsData | null = null;
  let total = 0;
  let dbDown = false;

  try {
    active = await getCurrentSeason();
    if (!active) {
      logger.warn("home.ranking_unavailable");
      effectiveSort = "recent";
    }
    const trendWindowHours = active?.policy.trend.windowHours ?? 24;
    const listPromise = active
      ? listFor(effectiveSort, active, category, query)
      : getVerifiedList(HOME_LIST_LIMIT, { sort: "recent", category, query });

    const [loadedBoards, loadedStats, loadedCounts, loadedList, history] = await Promise.all([
      getDiscoveryBoards(),
      marketStats({ windowHours: trendWindowHours }),
      categoryCounts(["verified"]),
      listPromise,
      getSeasonHistory(1),
    ]);
    boards = loadedBoards;
    stats = loadedStats;
    counts = loadedCounts;
    list = loadedList;
    latestClosed = history[0] ?? null;
    total = Object.values(counts).reduce((sum, count) => sum + count, 0);
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

      {active && <SeasonHeader season={active} latestClosed={latestClosed} now={now} />}
      {stats && <MarketStats stats={stats} windowHours={trendWindowHours} />}

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
    </main>
  );
}
