import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { after } from "next/server";
import Link from "next/link";
import { BrowseFilters, chipCategories, metricHref, parseHomeSort, parseShown, type HomeSort } from "@/components/BrowseFilters";
import {
  aiLevelTotals,
  type AiLevelCount,
  browseTitle,
  categoryHref,
  categoryRedirect,
  HOME_FIRST_PAGE,
  HOME_MAX_SHOWN,
  parseCategory,
  shownWindow,
} from "@/components/home/browse-state";
import { ActiveList } from "@/components/home/ActiveList";
import { CompactRow } from "@/components/home/CompactRow";
import { CompactCard } from "@/components/home/CompactCard";
import { STAR_GROWTH_TITLE, starGrowthNote } from "@/components/home/StarGrowthSummary";
import { IntroLine } from "@/components/home/IntroLine";
import { LaunchBand } from "@/components/home/LaunchBand";
import { listHomeNews } from "@/lib/news/repository";
import { NewsList } from "@/components/home/NewsList";
import { PopularTiers } from "@/components/home/PopularTiers";
import { MethodologyDialog } from "@/components/home/MethodologyDialog";
import { ProjectGrid } from "@/components/home/ProjectGrid";
import { ToolsBoard } from "@/components/home/ToolsBoard";
import { aiLevelCounts, categoryCounts, countProducts } from "@/lib/domain/products/repository";
import { getStarGrowthPage } from "@/lib/domain/products/star-growth";
import { resolveSearchQuery, warmQueryTranslation } from "@/lib/domain/products/search-translation";
import { relevanceWindow, searchRelevance } from "@/lib/domain/products/relevance";
import type { SearchQuery } from "@/lib/domain/products/search";
import type { Category } from "@/lib/domain/products/schema";
import { categoryLabel } from "@/lib/domain/products/labels";
import {
  getNewThisWeek,
  countNewThisWeek,
  getPublicList,
  getPublicListBySlugs,
  getUnclaimedList,
  getVerifiedList,
  NEW_THIS_WEEK_MIN_STARS,
  type ProductListItem,
} from "@/lib/domain/products/view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { popularSearches, recordSearch } from "@/lib/domain/products/search-log";
import {
  completedWindows,
  emptyHomePulse,
  getHomePulse,
  type HomePulse as Pulse,
} from "@/lib/domain/products/home-pulse";
import { formatCount } from "@/lib/format/number";
import { formatPublicDate, formatPublicDateTime } from "@/lib/format/time";
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
import { AI_FILTER_LEVELS, parseAiFilter, type AiLevel } from "@/lib/domain/evidence/ai-level-labels";
import { siteOrigin } from "@/lib/site";

export const dynamic = "force-dynamic";

// Saved IDs are filtered in the browser; preserve the existing candidate pool.
const SAVED_INITIAL_CANDIDATES = 100;
/** 목록이 화면 첫 그림일 때 먼저 받을 커버 수 — 넓은 화면 한 줄(세 칸) */
const FEED_PRIORITY_TILES = 3;

type SearchValue = string | string[] | undefined;
type Props = {
  searchParams: Promise<{
    sort?: SearchValue;
    category?: SearchValue;
    q?: SearchValue;
    builder?: SearchValue;
    observedTool?: SearchValue;
    ai?: SearchValue;
    shown?: SearchValue;
    saved?: SearchValue;
    personal?: SearchValue;
    new?: SearchValue;
    page?: SearchValue;
  }>;
};

/** 최신순 목록('최신'·'저장소 있음')은 저장소 확인을 마친 제품만 — 한 곳에서 정해 목록과 개수가 같은 조건을 쓴다(repoCheckedForNewest) */
const newestOnly = (sort: HomeSort) => sort === "recent" || sort === "open" ? true : undefined;

function firstValue(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function listFor(
  sort: HomeSort,
  active: SeasonSummary,
  category: Category | undefined,
  query: SearchQuery | undefined,
  builder: string | undefined,
  observedTool: string | undefined,
  aiLevels: readonly AiLevel[] | undefined,
  limit: number,
  offset = 0,
): Promise<ProductListItem[] | RankingListItem[]> {
  const options = { category, query, builder, observedTool, aiLevels };
  if (sort === "open") {
    return getPublicList(limit, { ...options, sort: "recent", hasRepository: true, repoChecked: newestOnly(sort), offset });
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
  return getPublicList(limit, { ...options, sort: sort === "relevance" ? "relevance" : "recent", repoChecked: newestOnly(sort), offset });
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
 * 결과 0건 화면의 '이런 검색어는 어떠세요' — 검색 기록에 여러 번 찾은 말이 모자라면 이것으로 채운다(UX-24).
 * 지금 목록에서 결과가 나오는 흔한 목적의 말들이다.
 */
export const FALLBACK_SUGGESTIONS = ["가계부", "회의록 요약", "PDF 합치기", "할 일 관리", "이미지 생성", "코드 리뷰"] as const;
const SUGGESTION_COUNT = 6;

/** 검색 기록에서 고른 말 앞에 두고 정해 둔 말로 채운다 — 대소문자·빈칸만 다른 말과 지금 친 말은 뺀다 */
export function searchSuggestions(fromLog: readonly string[], query: string | undefined, limit = SUGGESTION_COUNT): string[] {
  const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  const seen = new Set(query ? [key(query)] : []);
  const picked: string[] = [];
  for (const text of [...fromLog, ...FALLBACK_SUGGESTIONS]) {
    if (picked.length >= limit || seen.has(key(text))) continue;
    seen.add(key(text));
    picked.push(text.trim());
  }
  return picked;
}

/** 0건 화면에서 고를 거리 — 칩 한 줄. 제목은 빈 화면 제목의 한 단계 아래 */
function SuggestionChips({ title, items, heading }: { title: string; items: { href: string; label: string }[]; heading: "h3" | "h4" }) {
  if (items.length === 0) return null;
  const Heading = heading;
  return (
    <nav className="empty-suggest" aria-label={title}>
      <Heading>{title}</Heading>
      <ul className="chips">
        {items.map((item) => (
          <li key={item.href}><Link prefetch={false} href={item.href} className="chip">{item.label}</Link></li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * 빈 화면은 이유마다 다른 말을 해야 한다.
 *
 * 순위 정렬에서 결과가 없는 것은 프로젝트가 없다는 뜻이 아니다 — 순위는 검증된 프로젝트의 유효
 * 방문으로만 매기므로, 프로젝트가 34개 있어도 그 방문이 없으면 비어 보인다. 거기에 "아직
 * 등록된 프로젝트가 없습니다"라고 적으면 등록부터 하라고 잘못 안내하게 된다.
 *
 * 아래에 미클레임 목록이 붙는 화면에서는 "없습니다"라고 말할 수 없다 — 화면이 제 말을
 * 반박한다. 순위가 비었다는 설명만 그 목록과 어긋나지 않는다. 미클레임 제품은 애초에
 * 순위에 들어가지 않기 때문이다.
 *
 * 걸러서 0건이면 다음 수를 준다 — 찾을 만한 말과 분야(UX-24). 초기화 링크는 위 결과 줄에 하나만 둔다.
 * 제목 단계는 목록 제목 바로 아래다 — 검색·분야 화면은 목록 제목이 h1 이라 h2(A11Y-05). 크기는 CSS 가 같게 맞춘다.
 */
function EmptyReason({
  sort,
  fallback,
  filtered,
  hasUnclaimed,
  query,
  suggestions = [],
  categories = [],
  headingLevel = 3,
}: {
  sort: HomeSort;
  fallback: FallbackSort | null;
  filtered: boolean;
  hasUnclaimed: boolean;
  query?: string;
  /** 찾아볼 만한 검색어 — 검색어로 0건일 때만 */
  suggestions?: string[];
  /** 둘러볼 분야 — 공개 수가 많은 순 */
  categories?: string[];
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  if (filtered && !hasUnclaimed) {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <Heading>{query ? `“${query}”에 맞는 프로젝트가 없습니다` : "조건에 맞는 프로젝트가 없습니다"}</Heading>
          <p>{query ? "철자를 확인하거나 더 짧고 흔한 말로 찾아보세요." : "다른 분야를 고르거나 필터를 초기화해 보세요."}</p>
          <SuggestionChips title="이런 검색어는 어떠세요" heading={headingLevel === 2 ? "h3" : "h4"}
            items={suggestions.map((text) => ({ href: `/?q=${encodeURIComponent(text)}`, label: text }))} />
          <SuggestionChips title="분야에서 찾아보기" heading={headingLevel === 2 ? "h3" : "h4"}
            items={categories.map((category) => ({ href: categoryHref(category), label: categoryLabel(category) }))} />
        </div>
      </div>
    );
  }

  // 순위 대신 보여주는 목록이 비었다 — 순위 이야기를 하면 화면과 어긋난다
  if (fallback) {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <Heading>아직 스타 변화를 확인한 프로젝트가 없습니다</Heading>
          <p>GitHub 스타는 프로젝트마다 하루가 지난 뒤 차례로 다시 확인합니다(지금은 보통 2~3일 간격). 두 번 확인되면 나타납니다.</p>
          <Link prefetch={false} href="/?sort=recent" className="secondary">최신순으로 보기</Link>
        </div>
      </div>
    );
  }

  if (sort !== "recent" && sort !== "open") {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <Heading>아직 순위에 오른 프로젝트가 없습니다</Heading>
          <p>검증된 프로젝트에 유효 방문이 쌓이면 나타납니다.</p>
          <Link prefetch={false} href="/?sort=recent" className="secondary">최신순으로 보기</Link>
        </div>
      </div>
    );
  }

  if (hasUnclaimed) return null;

  return (
    <div className="projects-grid">
      <div className="empty-state">
        <Heading>아직 등록된 프로젝트가 없습니다</Heading>
        <p>
          <Link href="/launch" className="font-semibold text-accent">/nomorevibe</Link>
          {" "}로 첫 번째 프로젝트를 등록해보세요.
        </p>
      </div>
    </div>
  );
}

/** 집계 기준 창에 넘기는 집계 — 기준 시각은 이 창에서만 KST 를 밝힌다(UX-28) */
function serializePulse(pulse: Pulse, now: Date) {
  return {
    ...pulse,
    asOf: pulse.asOf.toISOString(),
    asOfLabel: `${formatPublicDateTime(pulse.asOf, now)} KST`,
  };
}

export type HomeParams = Awaited<Props["searchParams"]>;

/**
 * 정식 주소(canonical, SEO-04) — 정렬·거르기·더 보기 같은 보기 조건은 떼고 경로만 둔다. 상대 주소는 레이아웃의 metadataBase 가 채운다.
 * alternates 는 얕게 병합돼 레이아웃의 RSS 알림(types)이 지워지므로 같은 값을 함께 단다(app/layout.tsx).
 */
export function canonicalAlternates(path: string): NonNullable<Metadata["alternates"]> {
  return { canonical: path, types: { "application/rss+xml": `${siteOrigin()}/feed.xml` } };
}

/** 검색어·분야로 탭 제목을 정한다(UX-39) — "“가계부” 검색 결과 — nomorevibe" */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = await searchParams;
  if (firstValue(params.new) === "1") return { title: "최근 7일에 생성된 프로젝트", alternates: canonicalAlternates("/") };
  const query = firstValue(params.q)?.trim().slice(0, 200) || undefined;
  // 검색 결과는 색인하지 않는다 — 검색어마다 얇은 목록 페이지가 끝없이 생긴다. 분야는 /c/[category] 정식 주소가 맡는다
  if (query) return { title: browseTitle({ query }), robots: { index: false, follow: true } };
  // 보기 조건이 붙은 주소(?sort=recent·?ai=…·?shown=… 등)는 홈과 같은 제목이라 홈을 정식 주소로 가리킨다
  // 보기 조건이 붙은 주소도, 붙지 않은 홈도 정식 주소는 '/' 하나다(SEO-04)
  return { title: browseTitle({}), alternates: canonicalAlternates("/") };
}

/**
 * 옛 주소 /?category=finance 는 대소문자를 가리지 않고 정식 주소 /c/finance 로 보낸다(UX-40, 계약 C4).
 * 나머지 조건(정렬·검색어 등)은 그대로 따라간다.
 */
export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  const moved = firstValue(params.new) === "1" ? null : categoryRedirect(params);
  if (moved) redirect(moved);
  return HomeScreen({ params });
}

/**
 * 홈과 분야 화면(/c/[category])이 같이 그린다. 리다이렉트·없는 분야는 이것을 부르기 전에 정한다 — 그래야 응답이 흐르기 전에
 * 307·404 를 낼 수 있다.
 *
 * 목록은 기다리지 않고 골격부터 보낸다(스트리밍, UX-38). 의미 검색·분야 목록이 1~2초 걸리는 동안 화면에 아무 반응이 없었다.
 * 한국어 검색어는 처음 한 번 영어로 옮기느라(게이트웨이) 더 늦다 — 2026-09-26 운영 실측: 처음 치는 한국어 질의는 첫 바이트까지
 * 2.4~3.5초, 같은 질의 두 번째(캐시)는 0.7~1.6초, 영어는 0.8~1.0초. 검색창(SiteHeader)은 레이아웃이라 골격과 함께 먼저 나간다.
 *
 * 골격을 경로의 loading.tsx 로 두지 않는다 — 경로 단위 골격은 모든 하위 경로의 응답을 일찍 흘려 보내 없는 주소가 404 대신
 * 200(noindex)이 되고 redirect 가 meta refresh 가 된다(2026-10-09 next start 로 확인).
 * 열쇠: 검색어·분야·정렬·거르기가 바뀌면 새 목록이라 골격을 다시 보인다. '더 보기'(shown)·개인 계정 거르기는 같은 목록을 늘리거나
 * 아래 구획만 바꾸는 것이라 골격으로 덮지 않는다.
 */
export async function HomeScreen({ params }: { params: HomeParams }) {
  const query = firstValue(params.q)?.trim().slice(0, 200) || undefined;
  const newOnly = firstValue(params.new) === "1";
  const key = newOnly ? `new|${firstValue(params.page) ?? ""}` : [query, params.category, params.sort, params.builder, params.observedTool, params.ai, params.saved].map((value) => firstValue(value) ?? "").join("|");
  const category = parseCategory(firstValue(params.category));
  const title = newOnly ? "최근 7일에 생성된 프로젝트" : query ? `“${query}” 검색 결과` : category ? `${categoryLabel(category)} 프로젝트` : undefined;
  return (
    <Suspense key={key} fallback={<FeedSkeleton title={title} busy={!newOnly && query ? "찾는 중입니다…" : "불러오는 중입니다…"} />}>
      <HomeContent params={params} />
    </Suspense>
  );
}

/** 신규 모두 보기는 일반 최신순·필터와 독립된 목록이다. 기간은 매 요청 서버에서 정한다. */
async function NewRepositories({ pageParam }: { pageParam: SearchValue }) {
  const now = new Date();
  const { weekStart, asOf } = completedWindows(now);
  const pageSize = 15;
  const value = firstValue(pageParam);
  const requested = value && /^[1-9][0-9]{0,6}$/.test(value) ? Number(value) : 1;
  const key = ["new-repositories", weekStart, asOf, NEW_THIS_WEEK_MIN_STARS];
  let items: ProductListItem[] = [];
  let total = 0;
  let page = 1;
  let pages = 1;
  let failed = false;
  try {
    total = await publicRead("count", key, () => countNewThisWeek(weekStart, asOf));
    pages = Math.max(1, Math.ceil(total / pageSize));
    page = requested <= pages ? requested : 1;
    const offset = (page - 1) * pageSize;
    items = await publicRead("list", [...key, pageSize, offset], () => getNewThisWeek(pageSize, weekStart, asOf, offset));
  } catch (error) {
    logger.error("home.new_list_failed", { error });
    failed = true;
  }
  const href = (next: number) => `/?${new URLSearchParams({ new: "1", page: String(next) })}`;
  return (
    <main className="wrap">
      <section id="new" className="row-section" aria-labelledby="new-title">
        <div className="row-head">
          <div>
            <h1 id="new-title" className="row-title">최근 7일에 생성된 프로젝트</h1>
            <p className="row-note">GitHub 저장소 생성일 기준 · 스타 {NEW_THIS_WEEK_MIN_STARS} 이상</p>
            <p className="row-note">{formatPublicDate(weekStart, now)} 00시부터 {formatPublicDate(asOf, now)} 00시 전까지 KST · 생성일 최신순</p>
            {!failed && <p className="row-note">스타 기준을 충족한 프로젝트 {formatCount(total)}개 · 홈 상단 신규 집계는 스타 제한 없는 전체 수입니다.</p>}
          </div>
          <Link prefetch={false} href="/" className="row-more">홈으로</Link>
        </div>
        {failed ? <p>일시적으로 목록을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.</p>
          : items.length === 0 ? <p>이 기간에 생성된 스타 {NEW_THIS_WEEK_MIN_STARS} 이상 프로젝트가 없습니다.</p>
            : <div className="compact-grid">{items.map((product, index) => <CompactCard key={product.slug} product={product} trailing="listed" priority={index < 3} headingLevel={2} />)}</div>}
        {!failed && pages > 1 && <nav className="row-head" aria-label="신규 프로젝트 페이지">
          {page > 1 && <Link prefetch={false} href={href(page - 1)}>이전</Link>}
          <span>{page} / {pages}</span>
          {page < pages && <Link prefetch={false} href={href(page + 1)}>다음</Link>}
        </nav>}
      </section>
    </main>
  );
}

/** 목록을 찾는 동안 — 카드 9장(첫 쪽 분량)의 골격. 검색·분야면 결과 화면과 같은 제목을 두어 다 찾았을 때 자리가 튀지 않게 */
function FeedSkeleton({ title, busy }: { title?: string; busy: string }) {
  return (
    <main className="wrap">
      <section id="projects" aria-labelledby={title ? "projects-title" : undefined} aria-label={title ? undefined : "프로젝트 목록"} aria-busy="true" className="feed">
        <div className="row-head">
          <div>
            {title ? <h1 id="projects-title" className="row-title">{title}</h1> : <div className="skeleton-line skeleton-title" aria-hidden="true" />}
            <p className="row-note">{busy}</p>
          </div>
        </div>
        <div className="skeleton-line skeleton-tabs" aria-hidden="true" />
        <div className="projects-grid" aria-hidden="true">
          {Array.from({ length: HOME_FIRST_PAGE }, (_, index) => (
            <div key={index} className="skeleton-card">
              <div className="skeleton-visual" />
              <div className="skeleton-body">
                <div className="skeleton-line" />
                <div className="skeleton-line skeleton-short" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

export async function HomeContent({ params }: { params: HomeParams }) {
  if (firstValue(params.new) === "1") return NewRepositories({ pageParam: params.page });
  const sortParam = firstValue(params.sort);
  const query = firstValue(params.q)?.trim().slice(0, 200) || undefined;
  // A plain header search should cover the public catalogue. Preserve an explicitly
  // selected sort, but do not limit an unqualified search to ranked products.
  const requestedSort = sortParam ? parseHomeSort(sortParam) : query ? "relevance" : "weekly";
  // 분야는 대소문자를 가리지 않는다 — 홈(/)은 그 전에 /c/<분야>로 보냈고, 분야 화면은 정식 값을 넘긴다
  const category = parseCategory(firstValue(params.category)) ?? undefined;
  const builder = firstValue(params.builder)?.trim() || undefined;
  const toolParam = firstValue(params.observedTool)?.trim().slice(0, 80);
  // 직접 주소로도 숨겨 둔 관찰 사실을 거르지 않는다. 설정을 못 읽으면 공개하지 않는다.
  const displayTools = toolParam ? await getCrawlSettings().then(settings => settings.agentEvidence.displayObservedFacts).catch(() => false) : false;
  const observedTool = toolParam && displayTools ? agentClientLabel(toolParam) : undefined;
  // 만든 방식 — 모르는 값은 거르지 않는다(전체 목록)
  const ai = parseAiFilter(firstValue(params.ai)) ?? undefined;
  const aiLevels = ai ? AI_FILTER_LEVELS[ai] : undefined;
  const shown = parseShown(firstValue(params.shown));
  const savedOnly = firstValue(params.saved) === "1";
  const now = new Date();
  const browseState = { sort: requestedSort, category, query, builder, observedTool, ai, shown };

  let active: SeasonSummary | null = null;
  let effectiveSort: HomeSort = requestedSort;
  let list: ProductListItem[] | RankingListItem[] = [];
  let unclaimed: ProductListItem[] = [];
  let counts: Record<string, number> = {};
  let facetCounts: Record<string, number> = {};
  let facetAiCounts: AiLevelCount[] | null = null;
  let pulse = emptyHomePulse(now);
  let total = 0;
  let resultCount = 0;
  let unclaimedTotal = 0;
  let dbDown = false;
  let translatedQuery: string | null = null;
  let fallback: FallbackSort | null = null;
  let rankingReady = true;
  /** 결과 수가 관련도순 검색(낱말·의미 섞음)의 수인가 — 그러면 '관련 결과 약 n개'로 쓴다 */
  let approximate = false;
  /** 창이 접은 앞 항목 수(shownWindow) — 순위 목록은 다 받아 두므로 늘 0 */
  let listStart = 0;
  let unclaimedStart = 0;

  /**
   * 상단 집계·소식은 제품 목록과 서로의 결과를 쓰지 않는다 — 먼저 띄워 두고 목록 조회와 겹친다.
   * 차례로 기다리면 목록 조회가 집계 쿼리 6개가 끝난 뒤에야 시작한다.
   *
   * allSettled 로 받는 이유: 목록 쪽이 먼저 던져 여기까지 늦게 와도 처리되지 않은 거부가 남지 않고,
   * 하나가 실패해도 다른 하나는 쓴다.
   */
  const asideLoad = Promise.allSettled([getHomePulse(now), listHomeNews()]);

  /** 새 급상승은 고정 회차 비교다. 피드의 기존 주간 방문 순위·일평균 대체 목록과 독립적으로 읽는다. */
  const filtered = Boolean(query || category || builder || observedTool || ai);
  /** 검색·분야 화면 — 아래 홈 구획(인기·새로 나온·도구·활발한·소식)은 필터가 걸리지 않은 전체 기준이라 숨긴다(UX-35) */
  const scoped = Boolean(query || category);
  const stripLoad = filtered ? Promise.resolve(null) : getStarGrowthPage({ pageSize: 5, now }).catch((error) => {
    logger.error("home.star_growth_failed", { error });
    return null;
  });
  const newWindow = completedWindows(now);
  const newLoad = filtered ? Promise.resolve<ProductListItem[]>([]) : publicRead("list", ["new-repositories", newWindow.weekStart, newWindow.asOf, NEW_THIS_WEEK_MIN_STARS, 5, 0], () => getNewThisWeek(5, newWindow.weekStart, newWindow.asOf)).catch(() => []);

  /*
   * 서로 기다릴 필요가 없는 것은 함께 시작한다 — 시즌·검색어 해석·카테고리 개수·검증 수(2026-10-06: 시즌을 받은 뒤에야
   * 개수를 세 홈이 한 왕복 더 기다렸다). 먼저 실패한 것이 처리되지 않은 거절로 남지 않게 잡아 두고, 아래 await 가 다시 던진다.
   */
  const seasonLoad = publicRead("count", ["season"], () => getCurrentSeason());
  // 관련도순은 번역을 기다리지 않는다 — 의미 검색이 한국어 문장을 그대로 잰다(search-translation.ts warmQueryTranslation)
  const searchLoad = resolveSearchQuery(query, { waitForTranslation: requestedSort !== "relevance" });
  const countsLoad = publicRead("count", ["categories"], () => categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true }));
  const verifiedLoad = publicRead("count", ["verified"], () => countProducts({ statuses: ["verified"], excludeDown: true }));
  // '만든 방식' 칩의 수 — 못 세도 목록은 선다(칩은 수 없이)
  const aiCountsLoad = publicRead("count", ["ai-levels"], () => aiLevelCounts()).catch(() => null);
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
    if (query && search.translationPending) after(() => warmQueryTranslation(query));
    const options = { category, query: search.queries, builder, observedTool, aiLevels, excludeDown: true };
    /**
     * 순위 탭의 개수는 순위가 서지 않을 때(fallbackSort)만 쓴다 — 그때 '추천'은 스타가 는 제품만 센다.
     * 순위가 서면 이 값은 쓰이지 않으므로 검증 수를 기다리지 않고 함께 센다.
     */
    const listOptions = {
      ...options,
      hasRepository: effectiveSort === "open" ? true : undefined,
      rising: effectiveSort === "weekly" ? true : undefined,
      repoChecked: newestOnly(effectiveSort),
    };
    const verifiedTotal = await verifiedLoad;
    const minimumProducts = (active?.policy ?? DEFAULT_RANKING_POLICY).eligibility.minimumProducts;
    rankingReady = !needsUnclaimedFill(verifiedTotal, minimumProducts);
    fallback = fallbackSort(effectiveSort, verifiedTotal, minimumProducts);
    const publicCatalogue = effectiveSort === "recent" || effectiveSort === "open" || effectiveSort === "relevance" || fallback !== null;
    // 각 facet을 대체할 수 있도록 분야·AI 자체는 집계 바탕에서 뺀다.
    // 방문 순위는 전체 자격 목록의 slug만 사용해 공개 전체와 다른 대상도 맞춘다.
    const rankedSlugs = !publicCatalogue && active
      ? (await publicRead("list", ["home-facet-rankings", effectiveSort, active.key, verifiedTotal],
        () => listFor(effectiveSort, active!, undefined, undefined, undefined, undefined, undefined, verifiedTotal)))
        .map((product) => product.slug)
      : undefined;
    const facetOptions = { ...listOptions, category: undefined, aiLevels: undefined,
      rising: publicCatalogue ? listOptions.rising : undefined,
      ...(rankedSlugs ? { statuses: ["verified"] as const, slugs: rankedSlugs } : { statuses: ["verified", "seeded"] as const }) };
    const facetLoad = Promise.all([
      publicRead("count", ["browse-categories-v1", effectiveSort, active?.key, facetOptions],
        () => categoryCounts({ ...facetOptions, statuses: [...facetOptions.statuses] })),
      publicRead("count", ["browse-ai-levels-v1", effectiveSort, active?.key, facetOptions],
        () => aiLevelCounts({ ...facetOptions, statuses: [...facetOptions.statuses] })).catch(() => null),
    ]);
    facetLoad.catch(() => {});
    // 저장 목록 보기는 브라우저가 후보를 거르므로 창을 밀지 않고 앞에서부터 받는다
    const requestedLimit = savedOnly ? Math.max(Math.min(shown, HOME_MAX_SHOWN), SAVED_INITIAL_CANDIDATES) : shown;
    /**
     * 관련도순 검색은 낱말 검색과 의미 검색을 섞고 앞 30개를 재정렬한다(lib/domain/products/relevance.ts).
     * 순위와 전체 수를 30초 동안 웹 여러 대가 함께 쓴다 — "더 보기"가 같은 순위를 이어 받는다.
     */
    const filters = { category, builder, observedTool, aiLevels };
    const relevanceLoad = query && effectiveSort === "relevance" && !fallback
      ? publicRead("list", ["relevance", query, search.queries, filters],
        () => searchRelevance(query, search, filters, () => resolveSearchQuery(query, { waitForTranslation: true })))
      : null;
    relevanceLoad?.catch(() => {});
    approximate = relevanceLoad !== null;
    // 같은 정렬·거르기·구간이면 30초 동안 한 번만 읽는다(lib/domain/products/public-reads.ts)
    const loadList = (limit: number, offset: number) => relevanceLoad
      ? publicRead("list", ["relevance-rows", query, search.queries, filters, limit, offset], async () => {
        const ranked = await relevanceLoad;
        return getPublicListBySlugs(await relevanceWindow(ranked, ranked.plan, filters, offset, limit));
      })
      : publicRead("list", ["home", effectiveSort, fallback, active?.key ?? null, listOptions, limit, offset], () => fallback
      ? getPublicList(limit, { ...listOptions, sort: fallback, offset })
      : active
        ? listFor(effectiveSort, active, category, search.queries, builder, observedTool, aiLevels, limit, offset)
        : publicCatalogue
          ? getPublicList(limit, { ...listOptions, sort: effectiveSort === "relevance" ? "relevance" : "recent", offset })
          : getVerifiedList(limit, { ...options, sort: "recent" }));
    const spanOf = (count: number) => savedOnly ? { start: 0, count: Math.min(requestedLimit, count) } : shownWindow(shown, count);
    const matchingLoad = relevanceLoad
      ? relevanceLoad.then((ranked) => ranked.total)
      : publicRead("count", ["matching", listOptions], () => countProducts({ statuses: ["verified", "seeded"], ...listOptions }));
    // 창이 앞을 접을 수 있으면(HOME_MAX_SHOWN 초과) 어디서부터 받을지가 개수에 달려 있어 기다린다
    const windowed = publicCatalogue && requestedLimit > HOME_MAX_SHOWN;
    const earlyList = windowed ? null : loadList(publicCatalogue ? requestedLimit : verifiedTotal, 0);
    earlyList?.catch(() => {});
    const [loadedCounts, matchingTotal, [loadedFacetCounts, loadedFacetAiCounts]] = await Promise.all([countsLoad, matchingLoad, facetLoad]);
    facetCounts = loadedFacetCounts;
    facetAiCounts = loadedFacetAiCounts;
    // 0건이라 번역을 기다려 다시 찾았으면 그 번역을 밝힌다
    if (relevanceLoad) translatedQuery = (await relevanceLoad).translated;
    counts = loadedCounts;
    total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    // Public lists load only what is visible. Rankings retain their separate eligibility.
    const span = publicCatalogue ? spanOf(matchingTotal) : { start: 0, count: verifiedTotal };
    listStart = span.start;
    list = earlyList ? (await earlyList).slice(0, span.count) : await loadList(span.count, span.start);
    resultCount = publicCatalogue ? matchingTotal : list.length;

    if (!publicCatalogue && !rankingReady) {
      unclaimedTotal = await publicRead("count", ["unclaimed", options], () => countProducts({ statuses: ["seeded"], ...options }));
      const unclaimedSpan = spanOf(unclaimedTotal);
      unclaimedStart = unclaimedSpan.start;
      unclaimed = await publicRead("list", ["unclaimed", options, unclaimedSpan], () => getUnclaimedList(unclaimedSpan.count, { ...options, offset: unclaimedSpan.start }));
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
    const narrowed = Boolean(category || builder || observedTool || ai);
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
  const [strip, fresh, aiCounts] = await Promise.all([stripLoad, newLoad, aiCountsLoad]);

  const state = { ...browseState, sort: effectiveSort };
  const savedCandidates = savedOnly ? [...list, ...unclaimed] : list;
  // 0건 안내(EmptyReason 의 걸러서 0건)가 뜨는 때 — 아래 '주인을 기다리는' 목록이 붙으면 없다고 말하지 않는다
  const empty = !dbDown && !savedOnly && list.length === 0 && unclaimed.length === 0;
  // 검색어로 0건이면 찾아볼 말을 준다 — 검색 기록에서 여러 번 찾은 말, 모자라면 정해 둔 말(UX-24)
  const suggestions = empty && query
    ? searchSuggestions(await publicRead("count", ["popular-searches"], () => popularSearches(SUGGESTION_COUNT)).catch(() => []), query)
    : [];
  const browseCategories = empty && filtered ? chipCategories(counts).filter((item) => item !== category).slice(0, 8) : [];
  const feedTitle = query ? `“${query}” 검색 결과` : category ? `${categoryLabel(category)} 프로젝트` : "발견할 가치가 있는 프로젝트";
  // 소개 줄이 없는 검색·분야 화면은 목록 제목이 화면의 제목(h1)이다 — 카드 제목은 그 바로 아래 단계(A11Y-05)
  const FeedTitle = scoped ? "h1" : "h2";
  const cardHeading = scoped ? 2 : 3;
  /**
   * 목록이 화면 첫 그림인가 — '지금 뜨는' 띠가 위에 없을 때(검색·분야·거르기·대체 목록). 그때만 첫 줄 세 장(넓은 화면의 한 줄)을
   * 먼저 받는다(PERF-03). 띠가 위에 있으면 첫 그림은 띠의 것이라 목록 그림이 그 받기와 다투지 않게 둔다.
   */
  const feedPriority = !filtered && (strip?.items.length ?? 0) > 0 ? 0 : FEED_PRIORITY_TILES;

  return (
    <main className="wrap">
      {!scoped && <IntroLine pulse={pulse} total={total} state={state} />}
      {!filtered && (
        <CompactRow id="rising" priority title={STAR_GROWTH_TITLE} note={<>{starGrowthNote(strip?.snapshot ?? null)} · <Link prefetch={false} href={metricHref(state, "star-growth")} scroll={false}>집계 기준</Link></>}
          summary={(strip?.items.length ?? 0) === 0 ? <p className="row-note" role="status">{!strip
            ? "급상승 집계를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요."
            : strip.snapshot.status === "warming"
              ? "8시간 전 회차의 비교 관측을 준비하고 있습니다. 두 회차가 확보되면 증가량순으로 보여드립니다."
              : strip.snapshot.status === "no-results"
                ? "이번 회차에 표시할 급상승 프로젝트가 없습니다."
                : "급상승 관측이 지연되고 있습니다. 집계 기준에서 상태를 확인해 주세요."}</p> : undefined}
          more={{ href: strip ? `/rising?${new URLSearchParams({ cycle: strip.snapshot.asOf })}` : "/rising", label: "모두 보기" }}
          items={strip?.items ?? []} trailing="category" />
      )}

      <section id="projects" aria-labelledby="projects-title" className="feed">
        <div className="row-head">
          <div>
            <FeedTitle id="projects-title" className="row-title">{feedTitle}</FeedTitle>
            {/* 목록이 영어라 한국어 검색어는 영어 낱말로 한 번 더 찾는다. 무엇으로 찾았는지 밝힌다 */}
            {translatedQuery && <p className="row-note">영어로 “{translatedQuery}”도 함께 찾았습니다.</p>}
            {/* 순위 대신 보여주는 목록은 무엇으로 줄 세웠는지 밝힌다 — 숫자의 기준이 보여야 한다 */}
            {!query && fallback === "rising" && <p className="row-note">최근 두 확인 사이 하루 평균 GitHub 스타가 늘어난 순 · <Link prefetch={false} href={metricHref(state, "rising")} scroll={false}>집계 기준</Link></p>}
            {!query && fallback === "stars" && <p className="row-note">GitHub 스타가 많은 순.</p>}
          </div>
        </div>

        <BrowseFilters
          state={state}
          counts={facetCounts}
          categoryOrderCounts={counts}
          aiCounts={facetAiCounts}
          total={total}
          resultCount={resultCount}
          listLabel={fallback === "rising" ? "지금 뜨는" : fallback === "stars" ? "스타 많은 순" : undefined}
          approximate={approximate}
          rankingReady={rankingReady}
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
            now={now.toISOString()}
            key={`${effectiveSort}-${category ?? ""}-${builder ?? ""}-${observedTool ?? ""}-${ai ?? ""}-${query ?? ""}-${savedOnly ? "saved" : "all"}`}
            totalCount={resultCount}
            products={savedCandidates}
            browseState={state}
            initialOnlySaved={savedOnly}
            start={listStart}
            approximate={approximate}
            priorityCount={feedPriority}
            cardHeading={cardHeading}
          />
        ) : (
          <EmptyReason
            sort={effectiveSort}
            fallback={fallback}
            filtered={filtered}
            hasUnclaimed={unclaimed.length > 0}
            query={query}
            suggestions={suggestions}
            categories={browseCategories}
            headingLevel={cardHeading}
          />
        )}

        {!savedOnly && unclaimed.length > 0 && (
          <section className="unclaimed-block">
            <h2>주인을 기다리는 프로젝트</h2>
            <div className="mt-3">
              <ProjectGrid now={now.toISOString()} products={unclaimed} browseState={state} totalCount={unclaimedTotal} start={unclaimedStart} />
            </div>
          </section>
        )}
      </section>

      {!scoped && (
        <Suspense fallback={<section className="popular-section" id="popular"><h2>많이 쓰이는 프로젝트</h2></section>}>
          <PopularTiers personal={firstValue(params.personal) === "1"} />
        </Suspense>
      )}
      {!filtered && (
        <CompactRow id="new" title="최근 7일에 생성된 프로젝트" note={`GitHub 저장소 생성일 기준 · 스타 ${NEW_THIS_WEEK_MIN_STARS} 이상`}
          more={{ href: "/?new=1", label: "모두 보기" }} items={fresh} trailing="listed" />
      )}
      {!scoped && (
        <div className="two-col">
          <ToolsBoard tools={pulse.tools} state={state} />
          <ActiveList active={pulse.active} projects={pulse.updates.projects} />
        </div>
      )}
      {!scoped && <NewsList news={news} now={now} />}
      {!query && <LaunchBand />}

      <Suspense>
        <MethodologyDialog pulse={serializePulse(pulse, now)} rankingFallback={!rankingReady} aiLevels={aiLevelTotals(aiCounts)} starGrowth={filtered ? undefined : strip?.snapshot ?? null} />
      </Suspense>
    </main>
  );
}
