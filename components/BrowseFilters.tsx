import Link from "next/link";
import { AutoSubmitSelect } from "@/components/home/AutoSubmitSelect";
import {
  hrefWith,
  type BrowseState,
} from "@/components/home/browse-state";
import { CATEGORY_LABELS } from "@/lib/domain/products/labels";
import { CATEGORIES } from "@/lib/domain/products/schema";

export type { BrowseState, HomeSort } from "@/components/home/browse-state";
export { hrefWith, metricHref, parseHomeSort, parseShown } from "@/components/home/browse-state";

/**
 * 목록을 좁히는 줄.
 *
 * 탭과 셀렉트는 주소가 상태다. JS 없이 GET으로 동작하고, 공유·뒤로가기가 따라온다.
 */

const TABS = [
  { key: "weekly", label: "추천" },
  { key: "recent", label: "최신" },
  { key: "all-time", label: "관심 많은 순" },
  { key: "open", label: "저장소 있음" },
] as const;

function resultLabel(state: BrowseState): string {
  if (state.query || state.category || state.builder) return "검색 결과";
  if (state.sort === "weekly") return "에디터 추천";
  if (state.sort === "recent") return "최신";
  if (state.sort === "all-time") return "관심 많은 순";
  if (state.sort === "open") return "저장소 있음";
  if (state.sort === "trending") return "급상승";
  return "검색 결과";
}

export function BrowseFilters({
  state,
  counts,
  total,
  builders,
  resultCount,
}: {
  state: BrowseState;
  counts: Record<string, number>;
  total: number;
  builders?: string[];
  resultCount: number;
}) {
  const narrowed = Boolean(state.query || state.category || state.builder);
  const categories = CATEGORIES.filter((category) => (counts[category] ?? 0) > 0 || state.category === category);
  const toolOptions = builders ?? [];

  return (
    <div>
      <div className="filter-top">
        <div className="tabs" role="tablist" aria-label="프로젝트 정렬">
          {TABS.map(({ key, label }) => {
            const active = state.sort === key;
            return (
              <Link
                key={key}
                href={hrefWith(state, { sort: key })}
                className={`tab${active ? " active" : ""}`}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
              >
                {label}
              </Link>
            );
          })}
        </div>
        <form action="/" method="get" className="selects">
          {state.sort !== "weekly" && <input type="hidden" name="sort" value={state.sort} />}
          {state.query && <input type="hidden" name="q" value={state.query} />}
          <label className="sr-only" htmlFor="home-category">카테고리</label>
          <AutoSubmitSelect id="home-category" name="category" defaultValue={state.category ?? ""}>
            <option value="">모든 카테고리</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </option>
            ))}
          </AutoSubmitSelect>
          <label className="sr-only" htmlFor="home-builder">제작 도구</label>
          <AutoSubmitSelect id="home-builder" name="builder" defaultValue={state.builder ?? ""}>
            <option value="">모든 제작 도구</option>
            {toolOptions.map((builder) => (
              <option key={builder} value={builder}>{builder}</option>
            ))}
          </AutoSubmitSelect>
          <noscript><button type="submit" className="filter-apply">적용</button></noscript>
        </form>
      </div>
      <div className="filter-summary">
        <span>
          {resultLabel(state)} {resultCount}개
          {total > 0 && !narrowed ? ` · 공개 ${total}개` : ""}
        </span>
        {narrowed && (
          <Link href={hrefWith(state, { category: undefined, builder: undefined, query: undefined })} className="clear-filters show">
            필터 초기화
          </Link>
        )}
      </div>
    </div>
  );
}
