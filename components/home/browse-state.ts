export type HomeSort = "weekly" | "trending" | "recent" | "all-time" | "open";
export const HOME_FIRST_PAGE = 6;
export const HOME_PAGE_SIZE = 12;
export const HOME_SHOWN_MAX = 100;

export type BrowseState = {
  sort: HomeSort;
  category?: string;
  query?: string;
  builder?: string;
  shown?: number;
};

export function parseShown(value: string | undefined): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count <= HOME_FIRST_PAGE) return HOME_FIRST_PAGE;
  return Math.min(count, HOME_SHOWN_MAX);
}

export function parseHomeSort(value: string | undefined): HomeSort {
  if (value === "popular" || value === "featured") return "weekly";
  if (value === "newest") return "recent";
  if (value === "trending" || value === "recent" || value === "all-time" || value === "open") {
    return value;
  }
  return "weekly";
}

/** 지금 상태에서 한 가지만 바꾼 주소 — 필터를 겹쳐 걸 수 있어야 한다 */
export function hrefWith(state: BrowseState, patch: Partial<BrowseState> = {}): string {
  const next = { ...state, ...patch };
  const filterChanged = ["sort", "category", "builder", "query"].some((key) => key in patch);
  if (filterChanged && patch.shown === undefined) next.shown = undefined;
  const params = new URLSearchParams();
  if (next.sort !== "weekly") params.set("sort", next.sort);
  if (next.category) params.set("category", next.category);
  if (next.builder) params.set("builder", next.builder);
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
