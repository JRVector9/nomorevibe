import Link from "next/link";
import {
  aiFilterCounts,
  categoryCountsForAi,
  hrefWith,
  resultLine,
  sortLabel,
  type AiLevelCount,
  type BrowseState,
  type HomeSort,
} from "@/components/home/browse-state";
import { formatCount } from "@/lib/format/number";
import { AI_FILTER_LABELS, AI_FILTERS } from "@/lib/domain/evidence/ai-level-labels";
import { CATEGORY_LABELS } from "@/lib/domain/products/labels";
import { CATEGORIES } from "@/lib/domain/products/schema";
import { hiddenByDefault } from "@/lib/domain/products/visibility";

export type { BrowseState, HomeSort } from "@/components/home/browse-state";
export { hrefWith, metricHref, parseHomeSort, parseShown } from "@/components/home/browse-state";

/**
 * 목록을 좁히는 줄.
 *
 * 탭과 분야 알약은 주소가 상태다. JS 없이 GET으로 동작하고, 공유·뒤로가기가 따라온다.
 */

const TABS: readonly HomeSort[] = ["weekly", "recent", "all-time"];

/**
 * 분야 알약에 올릴 분야 — 개수 순, 기본 목록에서 빼는 분야(개인 프로필, 계약 C3)는 칩에도 없다.
 * 고른 분야는 개수가 0이어도 남긴다(지금 어디에 있는지 보여야 한다).
 */
export function chipCategories(counts: Record<string, number>, selected?: string): string[] {
  return CATEGORIES.filter((category) => !hiddenByDefault(category) && ((counts[category] ?? 0) > 0 || selected === category))
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
}

export function BrowseFilters({
  state,
  counts,
  aiCounts = null,
  total,
  resultCount,
  listLabel,
  approximate = false,
  rankingReady = true,
}: {
  state: BrowseState;
  counts: Record<string, number>;
  /** 분야·단계마다의 공개 수 — 못 읽었으면 null(칩은 두고 수만 숨긴다) */
  aiCounts?: readonly AiLevelCount[] | null;
  total: number;
  resultCount: number;
  /** 순위 탭이 다른 목록을 대신 보여줄 때 그 목록의 이름 — 정렬 이름과 내용이 어긋나면 안 된다 */
  listLabel?: string;
  /** 결과 수가 관련도순 검색(섞은 수)이라 '약 n개'로 써야 하는지 */
  approximate?: boolean;
  /** 순위가 섰는지 — 서기 전 '추천' 탭은 '지금 뜨는' 목록을 대신 보여 준다 */
  rankingReady?: boolean;
}) {
  const narrowed = Boolean(state.query || state.category || state.builder || state.observedTool || state.ai);
  // 분야 알약 수는 전체 공개 수다 — 검색어·도구 흔적으로 좁힌 결과와 다른 수라 그동안은 숨긴다(UX-12)
  const countable = !(state.query || state.builder || state.observedTool);
  // '만든 방식'과 분야는 서로의 칩 수를 좁힌다 — 같은 집계(분야×단계) 하나로 세어 누른 목록의 수와 맞는다
  const showCounts = countable && !(state.ai && !aiCounts);
  const categoryCounts = state.ai && aiCounts ? categoryCountsForAi(aiCounts, state.ai) : counts;
  const aiChipCounts = countable && aiCounts ? aiFilterCounts(aiCounts, state.category) : null;
  // 알약의 차례·목록은 전체 수로 정한다 — 만든 방식을 켜고 끌 때 분야 알약이 사라지거나 자리를 바꾸지 않게
  const categories = chipCategories(counts, state.category);
  // 검색어가 있으면 기본 순서(관련도)를 맨 앞 탭으로 둔다 — 없으면 아무 탭도 켜지지 않았다(UX-12)
  const tabs: readonly HomeSort[] = state.query ? ["relevance", ...TABS] : TABS;

  return (
    <div>
      <div className="filter-top">
        <div className="tabs" role="tablist" aria-label="프로젝트 정렬">
          {tabs.map((key) => {
            const active = state.sort === key;
            return (
              <Link prefetch={false}
                key={key}
                href={hrefWith(state, { sort: key })}
                className={`tab${active ? " active" : ""}`}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
              >
                {sortLabel(key, rankingReady)}
              </Link>
            );
          })}
        </div>
        {/* 만든 방식 — 고른 칩을 다시 누르면 푼다. 근거 단계 이름만 쓰고 근거(PR·커밋·파일)는 내지 않는다(2026-10-10 운영자 결정) */}
        <nav className="chips chips-ai" aria-label="만든 방식">
          {AI_FILTERS.map((filter) => {
            const active = state.ai === filter;
            return (
              <Link prefetch={false} key={filter} href={hrefWith(state, { ai: active ? undefined : filter })} className={`chip${active ? " chip-dark" : ""}`} aria-current={active ? "true" : undefined}>
                {AI_FILTER_LABELS[filter]}
                {aiChipCounts && <> <span className="chip-count">{formatCount(aiChipCounts[filter])}</span></>}
              </Link>
            );
          })}
        </nav>
        <nav className="chips chips-filter" aria-label="분야">
          <Link prefetch={false} href={hrefWith(state, { category: undefined })} className={`chip${state.category ? "" : " chip-dark"}`} aria-current={state.category ? undefined : "true"}>전체</Link>
          {categories.map((category) => (
            <Link prefetch={false} key={category} href={hrefWith(state, { category })} className={`chip${state.category === category ? " chip-dark" : ""}`} aria-current={state.category === category ? "true" : undefined}>
              {CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS]}
              {showCounts && <> <span className="chip-count">{formatCount(categoryCounts[category] ?? 0)}</span></>}
            </Link>
          ))}
        </nav>
      </div>
      <div className="filter-summary">
        <span>
          {resultLine(state, resultCount, { approximate, listLabel })}
          {total > 0 && !narrowed ? ` · 공개 ${formatCount(total)}개` : ""}
        </span>
        {narrowed && (
          // 관련도는 검색어가 있을 때만 있는 순서라, 검색어를 지우면 기본 순서로 돌린다
          <Link prefetch={false} href={hrefWith(state, { category: undefined, builder: undefined, observedTool: undefined, ai: undefined, query: undefined, ...(state.sort === "relevance" ? { sort: "weekly" as const } : {}) })} className="clear-filters show">
            필터 초기화
          </Link>
        )}
      </div>
    </div>
  );
}
