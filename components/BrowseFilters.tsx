"use client";

import Link from "next/link";
import {
  chipCategories,
  hrefWith,
  resultLine,
  sortLabel,
  type BrowseState,
  type HomeSort,
} from "@/components/home/browse-state";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { translatedCategory } from "@/components/home/i18n";
import { FillLine } from "@/components/cards/fill-line";
import { browseCountsQuery, useBrowseCounts } from "@/components/home/browse-counts";

export type { BrowseState, HomeSort } from "@/components/home/browse-state";

/**
 * 목록을 좁히는 줄.
 *
 * 탭과 분야 알약은 주소가 상태다. JS 없이 GET으로 동작하고, 공유·뒤로가기가 따라온다.
 */

const TABS: readonly HomeSort[] = ["ai", "recent", "all-time"];

export function BrowseFilters({
  state,
  counts,
  categoryOrderCounts = counts,
  categoryOrder,
  countsKnown = true,
  total: givenTotal = 0,
  resultCount: givenResult,
  listLabel,
  approximate = false,
  remoteCounts = false,
}: {
  state: BrowseState;
  counts: Record<string, number>;
  /** 공개 전체 집계로 분야 순서를 고정한다. 숫자는 현재 목록 자격의 counts를 쓴다. */
  categoryOrderCounts?: Record<string, number>;
  /** 분야 알약 차례(서버가 chipCategories 로 정한 것) — 주면 categoryOrderCounts 대신 쓴다. 차례만 정하는 집계 수를 브라우저로 넘기지 않는다 */
  categoryOrder?: readonly string[];
  countsKnown?: boolean;
  total?: number;
  /** 검색 결과 수 — 검색어가 있을 때만 서버가 준다. 나머지는 remoteCounts 로 받는다 */
  resultCount?: number;
  /**
   * 공개 수·분야별 수·결과 수를 서버 HTML 에 싣지 않고 /api/browse-counts 로 받는다(2026-11-15 공개 HTML 이름·요약만).
   * 받는 동안 알약 수는 비우고 결과 줄 수 자리는 글자 없는 자리로 둔다.
   */
  remoteCounts?: boolean;
  /** 순위 탭이 다른 목록을 대신 보여줄 때 그 목록의 이름 — 정렬 이름과 내용이 어긋나면 안 된다 */
  listLabel?: string;
  /** 결과 수가 관련도순 검색(섞은 수)이라 '약 n개'로 써야 하는지 */
  approximate?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const labels = useTranslations("labels");
  const count = (n: number) => formatNumber(n, locale);
  const remote = useBrowseCounts(remoteCounts && countsKnown && !state.query ? browseCountsQuery(state) : null);
  const total = remoteCounts ? remote?.total ?? 0 : givenTotal;
  const resultCount = remoteCounts && !state.query ? remote?.resultCount : givenResult;
  const chipCounts = remoteCounts ? remote?.counts ?? {} : counts;
  const narrowed = Boolean(state.query || state.category || state.builder || state.observedTool || state.ai);
  // 검색·도구·빌더 상태에서는 기존 정책대로 수를 숨긴다.
  const countable = countsKnown && !(state.query || state.builder || state.observedTool);
  const showCounts = countable && (!remoteCounts || Boolean(remote));
  // 알약의 차례·목록은 전체 수로 정한다 — 만든 방식을 켜고 끌 때 분야 알약이 사라지거나 자리를 바꾸지 않게
  const categories = categoryOrder ?? chipCategories(categoryOrderCounts);
  // 검색어가 있으면 기본 순서(관련도)를 맨 앞 탭으로 둔다 — 없으면 아무 탭도 켜지지 않았다(UX-12)
  const tabs: readonly HomeSort[] = state.query ? ["relevance", ...TABS] : TABS;

  return (
    <div>
      <div className="filter-top">
        <div className="tabs" role="tablist" aria-label={t("filter.sort")} data-track-filter="sort">
          {tabs.map((key) => {
            const active = state.sort === key;
            return (
              <Link prefetch={false}
                key={key}
                href={hrefWith(state, { sort: key }, locale)}
                data-track-value={key}
                className={`tab${active ? " active" : ""}`}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
              >
                {sortLabel(key, locale, t)}
              </Link>
            );
          })}
        </div>
        <nav className="chips chips-filter" aria-label={t("filter.category")} data-track-filter="category">
          <Link prefetch={false} href={hrefWith(state, { category: undefined }, locale)} data-track-value="all" className={`chip${state.category ? "" : " chip-dark"}`} aria-current={state.category ? undefined : "true"}>{t("filter.all")}</Link>
          {categories.map((category) => {
            const active = state.category === category;
            const label = <>{translatedCategory(category, labels)}{showCounts && <> <span className="chip-count">{count(chipCounts[category] ?? 0)}</span></>}</>;
            if (!active && showCounts && (chipCounts[category] ?? 0) === 0) return <span key={category} className="chip" aria-disabled="true">{label}</span>;
            return <Link prefetch={false} key={category} href={hrefWith(state, { category: active ? undefined : category }, locale)} data-track-value={active ? "all" : category} className={`chip${active ? " chip-dark" : ""}`} aria-current={active ? "true" : undefined}>{label}</Link>;
          })}
        </nav>
      </div>
      <div className="filter-summary" data-track-filter="reset">
        <span>
          {resultCount === undefined ? remote === null ? null : <FillLine width="10em" /> : resultLine(state, resultCount, { approximate, listLabel, locale, t, labels })}
          {total > 0 && !narrowed ? ` · ${t("filter.publicTotal", { count: count(total) })}` : ""}
        </span>
        {narrowed && (
          // 관련도는 검색어가 있을 때만 있는 순서라, 검색어를 지우면 기본 순서로 돌린다
          <Link prefetch={false} href={hrefWith(state, { category: undefined, builder: undefined, observedTool: undefined, ai: undefined, query: undefined, ...(state.sort === "relevance" ? { sort: "ai" as const } : {}) }, locale)} className="clear-filters show">
            {t("filter.reset")}
          </Link>
        )}
      </div>
    </div>
  );
}
