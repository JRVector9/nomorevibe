/** relevance 는 검색어가 있을 때만 쓰는 순서다 — 탭에는 없고, 검색 결과의 기본값이다 */
export type HomeSort = "weekly" | "trending" | "recent" | "all-time" | "open" | "relevance";
export const HOME_FIRST_PAGE = 9;
export const HOME_PAGE_SIZE = 9;
/**
 * "더 보기"로 늘릴 수 있는 끝. 상한이 없으면 `?shown=40000` 하나로 3만 행을 읽고 3만 장을 그렸다 —
 * 누구나 주소 하나로 서버를 묶을 수 있었다(2026-10-06 점검). 사람이 더 보기로 닿는 수보다 넉넉하다.
 */
export const HOME_MAX_SHOWN = 198;

export type BrowseState = {
  sort: HomeSort;
  category?: string;
  query?: string;
  builder?: string;
  observedTool?: string;
  shown?: number;
};

export function parseShown(value: string | undefined): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= HOME_FIRST_PAGE) return HOME_FIRST_PAGE;
  return Math.min(count, HOME_MAX_SHOWN);
}

export function parseHomeSort(value: string | undefined): HomeSort {
  if (value === "popular" || value === "featured") return "weekly";
  if (value === "newest") return "recent";
  if (value === "trending" || value === "recent" || value === "all-time" || value === "open" || value === "relevance") {
    return value;
  }
  return "weekly";
}

/** 지금 상태에서 한 가지만 바꾼 주소 — 필터를 겹쳐 걸 수 있어야 한다 */
export function hrefWith(state: BrowseState, patch: Partial<BrowseState> = {}): string {
  const next = { ...state, ...patch };
  const filterChanged = ["sort", "category", "builder", "observedTool", "query"].some((key) => key in patch);
  if (filterChanged && patch.shown === undefined) next.shown = undefined;
  const params = new URLSearchParams();
  if (next.sort !== "weekly" || next.query) params.set("sort", next.sort);
  if (next.category) params.set("category", next.category);
  if (next.builder) params.set("builder", next.builder);
  if (next.observedTool) params.set("observedTool", next.observedTool);
  if (next.query) params.set("q", next.query);
  if (next.shown && next.shown > HOME_FIRST_PAGE) params.set("shown", String(next.shown));
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

export function metricHref(state: BrowseState, metric: string): string {
  const next = hrefWith(state);
  const params = new URLSearchParams(next.startsWith("/?") ? next.slice(2) : "");
  params.set("metric", metric);
  return `/?${params.toString()}`;
}
