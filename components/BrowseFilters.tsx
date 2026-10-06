import Link from "next/link";
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
 * 탭과 분야 알약은 주소가 상태다. JS 없이 GET으로 동작하고, 공유·뒤로가기가 따라온다.
 */

const TABS = [
  { key: "weekly", label: "추천" },
  { key: "recent", label: "최신" },
  { key: "all-time", label: "관심 많은 순" },
] as const;

function resultLabel(state: BrowseState): string {
  if (state.query || state.category || state.builder || state.observedTool) return "검색 결과";
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
  resultCount,
  listLabel,
}: {
  state: BrowseState;
  counts: Record<string, number>;
  total: number;
  resultCount: number;
  /** 순위 탭이 다른 목록을 대신 보여줄 때 그 목록의 이름 — 정렬 이름과 내용이 어긋나면 안 된다 */
  listLabel?: string;
}) {
  const narrowed = Boolean(state.query || state.category || state.builder || state.observedTool);
  const label = listLabel && !narrowed ? listLabel : resultLabel(state);
  const categories = CATEGORIES.filter((category) => (counts[category] ?? 0) > 0 || state.category === category)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));

  return (
    <div>
      <div className="filter-top">
        <div className="tabs" role="tablist" aria-label="프로젝트 정렬">
          {TABS.map(({ key, label }) => {
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
                {label}
              </Link>
            );
          })}
        </div>
        <nav className="chips chips-filter" aria-label="분야">
          <Link prefetch={false} href={hrefWith(state, { category: undefined })} className={`chip${state.category ? "" : " chip-dark"}`} aria-current={state.category ? undefined : "true"}>전체</Link>
          {categories.map((category) => (
            <Link prefetch={false} key={category} href={hrefWith(state, { category })} className={`chip${state.category === category ? " chip-dark" : ""}`} aria-current={state.category === category ? "true" : undefined}>
              {CATEGORY_LABELS[category]} <span className="chip-count">{(counts[category] ?? 0).toLocaleString("ko-KR")}</span>
            </Link>
          ))}
        </nav>
      </div>
      <div className="filter-summary">
        <span>
          {label} {resultCount}개
          {total > 0 && !narrowed ? ` · 공개 ${total}개` : ""}
        </span>
        {narrowed && (
          <Link prefetch={false} href={hrefWith(state, { category: undefined, builder: undefined, observedTool: undefined, query: undefined })} className="clear-filters show">
            필터 초기화
          </Link>
        )}
      </div>
    </div>
  );
}
