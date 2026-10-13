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
  countsKnown = true,
  total,
  resultCount,
  listLabel,
  approximate = false,
}: {
  state: BrowseState;
  counts: Record<string, number>;
  /** 공개 전체 집계로 분야 순서를 고정한다. 숫자는 현재 목록 자격의 counts를 쓴다. */
  categoryOrderCounts?: Record<string, number>;
  countsKnown?: boolean;
  total: number;
  resultCount: number;
  /** 순위 탭이 다른 목록을 대신 보여줄 때 그 목록의 이름 — 정렬 이름과 내용이 어긋나면 안 된다 */
  listLabel?: string;
  /** 결과 수가 관련도순 검색(섞은 수)이라 '약 n개'로 써야 하는지 */
  approximate?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const labels = useTranslations("labels");
  const count = (n: number) => formatNumber(n, locale);
  const narrowed = Boolean(state.query || state.category || state.builder || state.observedTool || state.ai);
  // 검색·도구·빌더 상태에서는 기존 정책대로 수를 숨긴다.
  const countable = countsKnown && !(state.query || state.builder || state.observedTool);
  const showCounts = countable;
  // 알약의 차례·목록은 전체 수로 정한다 — 만든 방식을 켜고 끌 때 분야 알약이 사라지거나 자리를 바꾸지 않게
  const categories = chipCategories(categoryOrderCounts);
  // 검색어가 있으면 기본 순서(관련도)를 맨 앞 탭으로 둔다 — 없으면 아무 탭도 켜지지 않았다(UX-12)
  const tabs: readonly HomeSort[] = state.query ? ["relevance", ...TABS] : TABS;

  return (
    <div>
      <div className="filter-top">
        <div className="tabs" role="tablist" aria-label={t("filter.sort")}>
          {tabs.map((key) => {
            const active = state.sort === key;
            return (
              <Link prefetch={false}
                key={key}
                href={hrefWith(state, { sort: key }, locale)}
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
        <nav className="chips chips-filter" aria-label={t("filter.category")}>
          <Link prefetch={false} href={hrefWith(state, { category: undefined }, locale)} className={`chip${state.category ? "" : " chip-dark"}`} aria-current={state.category ? undefined : "true"}>{t("filter.all")}</Link>
          {categories.map((category) => {
            const active = state.category === category;
            const label = <>{translatedCategory(category, labels)}{showCounts && <> <span className="chip-count">{count(counts[category] ?? 0)}</span></>}</>;
            if (!active && showCounts && (counts[category] ?? 0) === 0) return <span key={category} className="chip" aria-disabled="true">{label}</span>;
            return <Link prefetch={false} key={category} href={hrefWith(state, { category: active ? undefined : category }, locale)} className={`chip${active ? " chip-dark" : ""}`} aria-current={active ? "true" : undefined}>{label}</Link>;
          })}
        </nav>
      </div>
      <div className="filter-summary">
        <span>
          {resultLine(state, resultCount, { approximate, listLabel, locale, t, labels })}
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
