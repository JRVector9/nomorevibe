import { localizeProductList } from "@/lib/i18n/products";
import { Suspense } from "react";
import type { Metadata, ResolvingMetadata } from "next";
import { pageTitle } from "@/lib/copy/brand";
import { LOCALES } from "@/lib/i18n/locales";
import { localizedAlternates, localizedOpenGraph } from "@/lib/i18n/metadata";
import { redirect } from "next/navigation";
import { after } from "next/server";
import Link from "next/link";
import { BrowseFilters } from "@/components/BrowseFilters";
import {
  aiLevelTotals,
  type AiLevelCount,
  type HomeSort,
  browseTitle,
  categoryHref,
  categoryRedirect,
  chipCategories,
  HOME_FIRST_PAGE,
  HOME_MAX_SHOWN,
  metricHref,
  parseCategory,
  parseHomeSort,
  parseShown,
  shownWindow,
} from "@/components/home/browse-state";
import { ActiveList } from "@/components/home/ActiveList";
import { CompactRow } from "@/components/home/CompactRow";
import { CompactCard } from "@/components/home/CompactCard";
import { StarGrowthSummary } from "@/components/home/StarGrowthSummary";
import { starGrowthNote } from "@/components/home/star-growth-copy";
import { IntroLine } from "@/components/home/IntroLine";
import { LaunchBand } from "@/components/home/LaunchBand";
import { listHomeNews } from "@/lib/news/repository";
import { NewsList } from "@/components/home/NewsList";
import { PopularTiers } from "@/components/home/PopularTiers";
import { MethodologyDialog } from "@/components/home/MethodologyDialog";
import { ProjectGrid } from "@/components/home/ProjectGrid";
import { ToolsBoard } from "@/components/home/ToolsBoard";
import { aiLevelCounts, categoryCounts, countProducts } from "@/lib/domain/products/repository";
import { getStarGrowthPage, type StarGrowthPage } from "@/lib/domain/products/star-growth";
import { resolveSearchQuery, warmQueryTranslation } from "@/lib/domain/products/search-translation";
import { relevanceWindow, searchRelevance } from "@/lib/domain/products/relevance";
import type { SearchQuery } from "@/lib/domain/products/search";
import type { Category } from "@/lib/domain/products/schema";
import { translatedCategory } from "@/components/home/i18n";
import { getRequestLocale } from "@/lib/i18n/server";
import { getDictionary, getTranslator } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { formatNumber, formatDate, formatDateTime } from "@/lib/i18n/format";
import {
  getNewThisWeek,
  countNewThisWeek,
  getPublicList,
  getPublicListBySlugs,
  getUnclaimedList,
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
import {
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

/** 최근 등록순 목록('최근 등록'·'저장소 있음')은 저장소 확인을 마친 제품만 — 한 곳에서 정해 목록과 개수가 같은 조건을 쓴다(repoCheckedForNewest) */
const newestOnly = (sort: HomeSort) => sort === "recent" || sort === "open" ? true : undefined;

function firstValue(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function listFor(
  sort: HomeSort,
  active: SeasonSummary | null,
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
  if (sort === "trending" && active) {
    return getSeasonRanking({ ...options, limit, seasonKey: active.key, order: "trending" })
      .then((result) => result.items);
  }
  if (sort === "all-time") return getPublicList(limit, { ...options, sort: "stars", offset });
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
 * 결과 0건 화면의 '이런 검색어는 어떠세요' — 검색 기록에 여러 번 찾은 말이 모자라면 이것으로 채운다(UX-24).
 * 지금 목록에서 결과가 나오는 흔한 목적의 말들이다.
 */
export const FALLBACK_SUGGESTIONS = ["가계부", "회의록 요약", "PDF 합치기", "할 일 관리", "이미지 생성", "코드 리뷰"] as const;
const SUGGESTION_COUNT = 6;

/** 검색 기록에서 고른 말 앞에 두고 정해 둔 말로 채운다 — 대소문자·빈칸만 다른 말과 지금 친 말은 뺀다 */
export function searchSuggestions(fromLog: readonly string[], query: string | undefined, limit = SUGGESTION_COUNT, fallback: readonly string[] = FALLBACK_SUGGESTIONS): string[] {
  const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  const seen = new Set(query ? [key(query)] : []);
  const picked: string[] = [];
  for (const text of [...fromLog, ...fallback]) {
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
  filtered,
  hasUnclaimed,
  query,
  suggestions = [],
  categories = [],
  headingLevel = 3,
  locale, t, labels,
}: {
  locale: Locale;
  t: Translator<"browse">;
  labels: Translator<"labels">;
  sort: HomeSort;
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
          <Heading>{query ? t("empty.query", { query }) : t("empty.filtered")}</Heading>
          <p>{t(query ? "empty.queryHint" : "empty.filterHint")}</p>
          <SuggestionChips title={t("empty.searchIdeas")} heading={headingLevel === 2 ? "h3" : "h4"}
            items={suggestions.map((text) => ({ href: localePath(locale, `/?q=${encodeURIComponent(text)}`), label: text }))} />
          <SuggestionChips title={t("empty.categoryIdeas")} heading={headingLevel === 2 ? "h3" : "h4"}
            items={categories.map((category) => ({ href: categoryHref(category, {}, locale), label: translatedCategory(category, labels) }))} />
        </div>
      </div>
    );
  }

  if (sort === "trending") {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <Heading>{t("empty.ranking")}</Heading>
          <p>{t("empty.rankingHint")}</p>
          <Link prefetch={false} href={localePath(locale, "/?sort=recent")} className="secondary">{t("empty.recentLink")}</Link>
        </div>
      </div>
    );
  }

  if (hasUnclaimed) return null;

  return (
    <div className="projects-grid">
      <div className="empty-state">
        <Heading>{t("empty.noProjects")}</Heading>
        <p><Link href={localePath(locale, "/launch")} className="font-semibold text-accent">{t("empty.launchHint", { command: "/nomorevibe" })}</Link>
        </p>
      </div>
    </div>
  );
}

/** 집계 기준 창에 넘기는 집계 — 기준 시각은 이 창에서만 KST 를 밝힌다(UX-28) */
function serializePulse(pulse: Pulse, now: Date, locale: Locale = "ko") {
  return {
    ...pulse,
    asOf: pulse.asOf.toISOString(),
    asOfLabel: `${formatDateTime(pulse.asOf, now, locale)} KST`,
  };
}

export type HomeParams = Awaited<Props["searchParams"]>;

/**
 * 정식 주소(canonical, SEO-04) — 보기 조건을 떼고 자기 언어 경로를 쓴다. 준비된 언어끼리 같은 대체 주소를 낸다.
 * alternates 는 얕게 병합돼 레이아웃의 RSS 알림(types)이 지워지므로 같은 값을 함께 단다(app/layout.tsx).
 */
export function canonicalAlternates(path: string, locale: Locale = "ko", readyLocales: readonly Locale[] = LOCALES): NonNullable<Metadata["alternates"]> {
  return { ...localizedAlternates(locale, path, readyLocales), types: { "application/rss+xml": `${siteOrigin()}/feed.xml` } };
}

/** Search stays noindex; view parameters share the unfiltered language canonical. */
export async function generateMetadata({ searchParams }: Props, parent: ResolvingMetadata): Promise<Metadata> {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "browse");
  const params = await searchParams;
  const newOnly = firstValue(params.new) === "1";
  const query = newOnly ? undefined : firstValue(params.q)?.trim().slice(0, 200) || undefined;
  const readyLocales = query ? [] : LOCALES;
  const title = newOnly ? pageTitle(t("new.title")) : browseTitle({ query }, locale, t);
  return {
    title,
    ...(query ? { robots: { index: false, follow: true } } : {}),
    alternates: canonicalAlternates("/", locale, readyLocales),
    openGraph: { ...(await parent)?.openGraph, ...localizedOpenGraph(locale, readyLocales), title, url: localePath(locale, "/") },
  };
}

/**
 * 옛 주소 /?category=finance 는 대소문자를 가리지 않고 정식 주소 /c/finance 로 보낸다(UX-40, 계약 C4).
 * 나머지 조건(정렬·검색어 등)은 그대로 따라간다.
 */
export default async function HomePage({ searchParams }: Props) {
  const locale = await getRequestLocale();
  const params = await searchParams;
  const moved = firstValue(params.new) === "1" ? null : categoryRedirect(params, locale);
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
  const locale = await getRequestLocale();
  const [t, labels] = await Promise.all([getTranslator(locale, "browse"), getTranslator(locale, "labels")]);
  const query = firstValue(params.q)?.trim().slice(0, 200) || undefined;
  const newOnly = firstValue(params.new) === "1";
  const key = newOnly ? `new|${firstValue(params.page) ?? ""}` : [query, params.category, params.sort, params.builder, params.observedTool, params.ai, params.saved].map((value) => firstValue(value) ?? "").join("|");
  const category = parseCategory(firstValue(params.category));
  const title = newOnly ? t("new.title") : query ? t("home.searchTitle", { query }) : category ? t("home.categoryTitle", { category: translatedCategory(category, labels) }) : undefined;
  return (
    <Suspense key={key} fallback={<FeedSkeleton title={title} busy={t(!newOnly && query ? "home.searching" : "home.loading")} label={t("home.projects")} />}>
      <HomeContent params={params} />
    </Suspense>
  );
}

/** 신규 모두 보기는 일반 최신순·필터와 독립된 목록이다. 기간은 매 요청 서버에서 정한다. */
async function NewRepositories({ pageParam }: { pageParam: SearchValue }) {
  const locale = await getRequestLocale();
  const [t, dictionary] = await Promise.all([getTranslator(locale, "browse"), getDictionary(locale, "browse")]);
  const count = (n: number) => formatNumber(n, locale);
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
  items = await localizeProductList(items,locale);
  const href = (next: number) => localePath(locale, `/?${new URLSearchParams({ new: "1", page: String(next) })}`);
  return (
    <I18nProvider locale={locale} dictionaries={{ browse: dictionary }} now={now.toISOString()}><main className="wrap">
      <section id="new" className="row-section" aria-labelledby="new-title">
        <div className="row-head">
          <div>
            <h1 id="new-title" className="row-title">{t("new.title")}</h1>
            <p className="row-note">{t("new.note", { stars: count(NEW_THIS_WEEK_MIN_STARS) })}</p>
            <p className="row-note">{t("new.period", { start: formatDate(weekStart, now, locale), end: formatDate(asOf, now, locale) })}</p>
            {!failed && <p className="row-note">{t("new.count", { count: count(total) })}</p>}
          </div>
          <Link prefetch={false} href={localePath(locale, "/")} className="row-more">{t("nav.home")}</Link>
        </div>
        {failed ? <p>{t("error.list")} {t("error.retry")}</p>
          : items.length === 0 ? <p>{t("new.empty", { stars: count(NEW_THIS_WEEK_MIN_STARS) })}</p>
            : <div className="compact-grid">{items.map((product, index) => <CompactCard key={product.slug} product={product} trailing="listed" priority={index < 3} headingLevel={2} />)}</div>}
        {!failed && pages > 1 && <nav className="row-head" aria-label={t("new.pages")}>
          {page > 1 && <Link prefetch={false} href={href(page - 1)}>{t("nav.previous")}</Link>}
          <span>{count(page)} / {count(pages)}</span>
          {page < pages && <Link prefetch={false} href={href(page + 1)}>{t("nav.next")}</Link>}
        </nav>}
      </section>
    </main></I18nProvider>
  );
}

/** 목록을 찾는 동안 — 카드 9장(첫 쪽 분량)의 골격. 검색·분야면 결과 화면과 같은 제목을 두어 다 찾았을 때 자리가 튀지 않게 */
function FeedSkeleton({ title, busy, label }: { title?: string; busy: string; label: string }) {
  return (
    <main className="wrap">
      <section id="projects" aria-labelledby={title ? "projects-title" : undefined} aria-label={title ? undefined : label} aria-busy="true" className="feed">
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
  const locale = await getRequestLocale();
  const [t, labels, dictionary] = await Promise.all([getTranslator(locale, "browse"), getTranslator(locale, "labels"), getDictionary(locale, "browse")]);
  const count = (n: number) => formatNumber(n, locale);
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
  let growth: StarGrowthPage | null = null;
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

  /** 홈 띠와 weekly 피드는 같은 닫힌 8시간 회차 reader를 쓴다. */
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
  const seasonLoad = requestedSort === "trending" ? publicRead("count", ["season"], () => getCurrentSeason()) : Promise.resolve(null);
  // 관련도순은 번역을 기다리지 않는다 — 의미 검색이 한국어 문장을 그대로 잰다(search-translation.ts warmQueryTranslation)
  const searchLoad = resolveSearchQuery(query, { waitForTranslation: requestedSort !== "relevance" });
  const countsLoad = publicRead("count", ["categories"], () => categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true }));
  const verifiedLoad = requestedSort === "trending" ? publicRead("count", ["verified"], () => countProducts({ statuses: ["verified"], excludeDown: true })) : Promise.resolve(0);
  // '만든 방식' 칩의 수 — 못 세도 목록은 선다(칩은 수 없이)
  const aiCountsLoad = publicRead("count", ["ai-levels"], () => aiLevelCounts()).catch(() => null);
  for (const load of [seasonLoad, searchLoad, countsLoad, verifiedLoad]) load.catch(() => {});

  try {
    active = await seasonLoad;
    if (!active && requestedSort === "trending") {
      logger.warn("home.ranking_unavailable");
      effectiveSort = "recent";
    }
    /**
     * 한국어로 목적을 치면 영어 목록에 닿지 않는다. 그대로 찾아 보고 몇 건 안 되면 영어 낱말로
     * 옮겨 한 번 더 찾는다 — 옮긴 말은 결과 위에 밝힌다(search-translation.ts).
     */
    const search = await searchLoad;
    translatedQuery = search.translated;
    if (query && search.translationPending) after(() => warmQueryTranslation(query));
    const options = { category, query: search.queries, builder, observedTool, aiLevels, excludeDown: true };
    const listOptions = {
      ...options,
      hasRepository: effectiveSort === "open" ? true : undefined,
      repoChecked: newestOnly(effectiveSort),
    };
    const verifiedTotal = await verifiedLoad;
    const minimumProducts = (active?.policy ?? DEFAULT_RANKING_POLICY).eligibility.minimumProducts;
    rankingReady = !needsUnclaimedFill(verifiedTotal, minimumProducts);
    const publicCatalogue = effectiveSort !== "trending";
    // 저장 목록 보기는 브라우저가 후보를 거르므로 창을 밀지 않고 앞에서부터 받는다
    const requestedLimit = savedOnly ? Math.max(Math.min(shown, HOME_MAX_SHOWN), SAVED_INITIAL_CANDIDATES) : shown;
    const growthLoad = effectiveSort === "weekly" ? getStarGrowthPage({
      category, query: search.queries, builder, observedTool, aiLevels, now, includeFacets: true,
      limit: Math.min(requestedLimit, HOME_MAX_SHOWN), ...(savedOnly ? {} : { end: shown }),
    }) : null;
    growthLoad?.catch(() => {});
    // 집계 바탕에서 선택 분야·AI를 빼고 반대 facet을 유지해 칩 수를 만든다.
    const rankedSlugs = !publicCatalogue && active
      ? (await publicRead("list", ["home-facet-rankings", effectiveSort, active.key, verifiedTotal],
        () => listFor(effectiveSort, active, undefined, undefined, undefined, undefined, undefined, verifiedTotal)))
        .map((product) => product.slug)
      : undefined;
    const facetOptions = { ...listOptions, category: undefined, aiLevels: undefined,
      ...(rankedSlugs ? { statuses: ["verified"] as const, slugs: rankedSlugs } : { statuses: ["verified", "seeded"] as const }) };
    const facetLoad = growthLoad ? growthLoad.then((result) => [result.facets?.categories ?? {}, result.facets?.aiLevels ?? []] as const)
      : Promise.all([
        publicRead("count", ["browse-categories-v2", effectiveSort, active?.key, facetOptions],
          () => categoryCounts({ ...facetOptions, statuses: [...facetOptions.statuses] })),
        publicRead("count", ["browse-ai-levels-v2", effectiveSort, active?.key, facetOptions],
          () => aiLevelCounts({ ...facetOptions, statuses: [...facetOptions.statuses] })).catch(() => null),
      ]);
    facetLoad.catch(() => {});
    /**
     * 관련도순 검색은 낱말 검색과 의미 검색을 섞고 앞 30개를 재정렬한다(lib/domain/products/relevance.ts).
     * 순위와 전체 수를 30초 동안 웹 여러 대가 함께 쓴다 — "더 보기"가 같은 순위를 이어 받는다.
     */
    const filters = { category, builder, observedTool, aiLevels };
    const relevanceLoad = query && effectiveSort === "relevance"
      ? publicRead("list", ["relevance", query, search.queries, filters],
        () => searchRelevance(query, search, filters, () => resolveSearchQuery(query, { waitForTranslation: true })))
      : null;
    relevanceLoad?.catch(() => {});
    approximate = relevanceLoad !== null;
    // 같은 정렬·거르기·구간이면 30초 동안 한 번만 읽는다(lib/domain/products/public-reads.ts)
    const loadList = (limit: number, offset: number) => growthLoad ? growthLoad.then((result) => result.items)
      : relevanceLoad
        ? publicRead("list", ["relevance-rows", query, search.queries, filters, limit, offset], async () => {
          const ranked = await relevanceLoad;
          return getPublicListBySlugs(await relevanceWindow(ranked, ranked.plan, filters, offset, limit));
        })
        : publicRead("list", ["home-fixed-tabs-v2", effectiveSort, active?.key ?? null, listOptions, limit, offset],
          () => listFor(effectiveSort, active, category, search.queries, builder, observedTool, aiLevels, limit, offset));
    const spanOf = (count: number) => savedOnly ? { start: 0, count: Math.min(requestedLimit, count) } : shownWindow(shown, count);
    const matchingLoad = growthLoad ? growthLoad.then((result) => result.total)
      : relevanceLoad ? relevanceLoad.then((ranked) => ranked.total)
      : publicRead("count", ["matching", listOptions], () => countProducts({ statuses: ["verified", "seeded"], ...listOptions }));
    // 창이 앞을 접을 수 있으면(HOME_MAX_SHOWN 초과) 어디서부터 받을지가 개수에 달려 있어 기다린다
    const windowed = !growthLoad && publicCatalogue && requestedLimit > HOME_MAX_SHOWN;
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
    growth = growthLoad ? await growthLoad : null;
    const span = growth ? { start: growth.offset, count: growth.items.length } : publicCatalogue ? spanOf(matchingTotal) : { start: 0, count: verifiedTotal };
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
  const [stripData, freshData, aiCounts] = await Promise.all([stripLoad, newLoad, aiCountsLoad]);
  const [localizedList, localizedUnclaimed, localizedStrip, fresh] = await Promise.all([
    localizeProductList(list,locale), localizeProductList(unclaimed,locale),
    localizeProductList(stripData?.items ?? [],locale), localizeProductList(freshData,locale),
  ]);
  list = localizedList;
  unclaimed = localizedUnclaimed;
  const strip = stripData ? { ...stripData, items: localizedStrip } : null;

  const state = { ...browseState, sort: effectiveSort };
  const savedCandidates = savedOnly ? [...list, ...unclaimed] : list;
  // 0건 안내(EmptyReason 의 걸러서 0건)가 뜨는 때 — 아래 '주인을 기다리는' 목록이 붙으면 없다고 말하지 않는다
  const empty = !dbDown && !savedOnly && list.length === 0 && unclaimed.length === 0;
  // 검색어로 0건이면 찾아볼 말을 준다 — 검색 기록에서 여러 번 찾은 말, 모자라면 정해 둔 말(UX-24)
  const suggestions = empty && query
    ? searchSuggestions(await publicRead("count", ["popular-searches"], () => popularSearches(SUGGESTION_COUNT)).catch(() => []), query, SUGGESTION_COUNT, [t("suggestion.budget"), t("suggestion.meeting"), t("suggestion.pdf"), t("suggestion.tasks"), t("suggestion.images"), t("suggestion.review")])
    : [];
  const browseCategories = empty && filtered ? chipCategories(counts).filter((item) => item !== category).slice(0, 8) : [];
  const feedTitle = query ? t("home.searchTitle", { query }) : category ? t("home.categoryTitle", { category: translatedCategory(category, labels) }) : t("home.feedTitle");
  // 소개 줄이 없는 검색·분야 화면은 목록 제목이 화면의 제목(h1)이다 — 카드 제목은 그 바로 아래 단계(A11Y-05)
  const FeedTitle = scoped ? "h1" : "h2";
  const cardHeading = scoped ? 2 : 3;
  /**
   * 목록이 화면 첫 그림인가 — 8시간 급상승 띠가 위에 없을 때(검색·분야·거르기). 그때만 첫 줄 세 장(넓은 화면의 한 줄)을
   * 먼저 받는다(PERF-03). 띠가 위에 있으면 첫 그림은 띠의 것이라 목록 그림이 그 받기와 다투지 않게 둔다.
   */
  const feedPriority = !filtered && (strip?.items.length ?? 0) > 0 ? 0 : FEED_PRIORITY_TILES;

  return (
    <I18nProvider locale={locale} dictionaries={{ browse: dictionary }} now={now.toISOString()}><main className="wrap">
      {!scoped && <IntroLine pulse={pulse} total={total} state={state} />}
      {!filtered && (
        <CompactRow id="rising" priority title={t("growth.title")} note={<>{starGrowthNote(strip?.snapshot ?? null, locale, t)} · <Link prefetch={false} href={metricHref(state, "star-growth", locale)} scroll={false}>{t("nav.methodology")}</Link></>}
          summary={(strip?.items.length ?? 0) === 0 ? <p className="row-note" role="status">{!strip
            ? t("growth.unavailable")
            : strip.snapshot.status === "warming"
              ? t("growth.baseline")
              : strip.snapshot.status === "no-results"
                ? t("growth.empty")
                : t("growth.delayed")}</p> : undefined}
          more={{ href: strip ? `/rising?${new URLSearchParams({ cycle: strip.snapshot.asOf })}` : "/rising", label: t("nav.all") }}
          items={strip?.items ?? []} trailing="category" />
      )}

      <section id="projects" aria-labelledby="projects-title" className="feed">
        <div className="row-head">
          <div>
            <FeedTitle id="projects-title" className="row-title">{feedTitle}</FeedTitle>
            {/* 목록이 영어라 한국어 검색어는 영어 낱말로 한 번 더 찾는다. 무엇으로 찾았는지 밝힌다 */}
            {translatedQuery && <p className="row-note">{t("home.translatedSearch", { query: translatedQuery })}</p>}
            {effectiveSort === "weekly" && <>
              <p className="row-note">{starGrowthNote(growth?.snapshot ?? null, locale, t)} · <Link prefetch={false} href={metricHref(state, "star-growth", locale)} scroll={false}>{t("nav.methodology")}</Link></p>
              {growth?.snapshot.status === "ready" && <p className="row-note">{t("growth.cycle", { asOf: formatDateTime(growth.snapshot.asOf, now, locale), next: formatDateTime(growth.snapshot.nextCycle, now, locale) })}</p>}
            </>}
            {effectiveSort === "recent" && <p className="row-note">{t("home.recentNote")}</p>}
            {effectiveSort === "all-time" && <p className="row-note">{t("home.starsNote")}</p>}
          </div>
        </div>

        <BrowseFilters
          state={state}
          counts={facetCounts}
          categoryOrderCounts={counts}
          countsKnown={!dbDown}
          aiCounts={facetAiCounts}
          total={total}
          resultCount={resultCount}
          approximate={approximate}
        />

        {dbDown ? (
          <div className="projects-grid">
            <div className="empty-state">
              <h3>{t("error.list")}</h3>
              <p>{t("error.retry")}</p>
            </div>
          </div>
        ) : effectiveSort === "weekly" && growth?.snapshot.status !== "ready" && growth?.snapshot.reason !== "filtered-out" ? (
          <div className="projects-grid"><div className="empty-state"><StarGrowthSummary snapshot={growth?.snapshot ?? null} now={now} /></div></div>
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
            locale={locale} t={t} labels={labels}
            sort={effectiveSort}
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
            <h2>{t("home.unclaimed")}</h2>
            <div className="mt-3">
              <ProjectGrid now={now.toISOString()} products={unclaimed} browseState={state} totalCount={unclaimedTotal} start={unclaimedStart} />
            </div>
          </section>
        )}
      </section>

      {!scoped && (
        <Suspense fallback={<section className="popular-section" id="popular"><h2>{t("popular.title")}</h2></section>}>
          <PopularTiers personal={firstValue(params.personal) === "1"} />
        </Suspense>
      )}
      {!filtered && (
        <CompactRow id="new" title={t("new.title")} note={t("new.note", { stars: count(NEW_THIS_WEEK_MIN_STARS) })}
          more={{ href: "/?new=1", label: t("nav.all") }} items={fresh} trailing="listed" />
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
        <MethodologyDialog pulse={serializePulse(pulse, now, locale)} aiLevels={aiLevelTotals(aiCounts)} starGrowth={growth?.snapshot ?? (filtered ? undefined : strip?.snapshot ?? null)} />
      </Suspense>
    </main></I18nProvider>
  );
}
