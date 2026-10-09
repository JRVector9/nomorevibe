import { pageTitle } from "@/lib/copy/brand";
import { formatApprox, formatCount } from "@/lib/format/number";
import { CATEGORIES, type Category } from "@/lib/domain/products/categories";
import { categoryLabel } from "@/lib/domain/products/labels";

/** relevance 는 검색어가 있을 때만 쓰는 순서다 — 검색 중에만 '관련도' 탭으로 맨 앞에 선다 */
export type HomeSort = "weekly" | "trending" | "recent" | "all-time" | "open" | "relevance";
export const HOME_FIRST_PAGE = 9;
export const HOME_PAGE_SIZE = 9;
/**
 * 한 화면이 한 번에 그리는 카드의 끝. 상한이 없으면 `?shown=40000` 하나로 3만 행을 읽고 3만 장을 그렸다 —
 * 누구나 주소 하나로 서버를 묶을 수 있었다(2026-10-06 점검). 그 너머는 창을 민다(shownWindow).
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
  return count;
}

/**
 * 더 보기로 늘린 목록 가운데 이번 화면이 그릴 구간 — 끝은 shown(전체를 넘지 않게), 길이는 HOME_MAX_SHOWN 까지.
 * 넘치면 앞에서부터 접는다. 2026-10-06 상한만 두었을 때는 "더 보기 (198 / 33692)"에서 더 늘지 않아
 * 공개 목록 대부분에 닿을 길이 없었다.
 */
export function shownWindow(shown: number, total: number): { start: number; count: number } {
  const end = Math.max(0, Math.min(shown, total));
  const start = Math.max(0, end - HOME_MAX_SHOWN);
  return { start, count: end - start };
}

export function parseHomeSort(value: string | undefined): HomeSort {
  if (value === "popular" || value === "featured") return "weekly";
  if (value === "newest") return "recent";
  if (value === "trending" || value === "recent" || value === "all-time" || value === "open" || value === "relevance") {
    return value;
  }
  return "weekly";
}

/**
 * 분야 주소 — 정식 주소는 소문자 경로 /c/finance 다(2026-10-08 UX 감사 UX-40, 계약 C4).
 * 공유·직접 입력한 ?category=finance 가 대소문자 때문에 조용히 무시되던 것을 막는다. 사이트맵도 이 규칙으로 만든다.
 */
export function categorySlug(category: string): string {
  return category.toLowerCase();
}

/** 대소문자를 무시하고 분야를 읽는다("finance"·"Finance"·" FINANCE "). 모르는 값이면 null */
export function parseCategory(value: string | null | undefined): Category | null {
  const key = value?.trim().toLowerCase();
  if (!key) return null;
  return CATEGORIES.find((category) => categorySlug(category) === key) ?? null;
}

/** 지금 상태에서 한 가지만 바꾼 주소 — 필터를 겹쳐 걸 수 있어야 한다. 분야가 있으면 /c/<분야> 아래로 간다 */
export function hrefWith(state: BrowseState, patch: Partial<BrowseState> = {}): string {
  const next = { ...state, ...patch };
  const filterChanged = ["sort", "category", "builder", "observedTool", "query"].some((key) => key in patch);
  if (filterChanged && patch.shown === undefined) next.shown = undefined;
  const params = new URLSearchParams();
  if (next.sort !== "weekly" || next.query) params.set("sort", next.sort);
  if (next.builder) params.set("builder", next.builder);
  if (next.observedTool) params.set("observedTool", next.observedTool);
  if (next.query) params.set("q", next.query);
  if (next.shown && next.shown > HOME_FIRST_PAGE) params.set("shown", String(next.shown));
  const path = next.category ? `/c/${encodeURIComponent(categorySlug(next.category))}` : "/";
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** 분야 화면의 주소 — 다른 화면(상세의 분야 링크 등)이 /?category= 대신 쓴다 */
export function categoryHref(category: string, patch: Partial<BrowseState> = {}): string {
  return hrefWith({ sort: "weekly" }, { ...patch, category });
}

export function metricHref(state: BrowseState, metric: string): string {
  const next = hrefWith(state);
  const [path, qs = ""] = next.split("?");
  const params = new URLSearchParams(qs);
  params.set("metric", metric);
  return `${path}?${params.toString()}`;
}

type SearchValue = string | string[] | undefined;

/**
 * 옛 주소 /?category=X 가 갈 곳 — /c/<소문자>, 나머지 조건은 그대로 붙인다. category 가 없거나 비었으면 null.
 * 모르는 값도 /c/<값> 으로 보낸다 — 거기서 '없는 분야입니다'를 보인다(조용히 전체 목록을 보이지 않는다).
 */
export function categoryRedirect(params: Record<string, SearchValue>): string | null {
  const raw = Array.isArray(params.category) ? params.category[0] : params.category;
  const value = raw?.trim();
  if (!value) return null;
  const known = parseCategory(value);
  const rest = new URLSearchParams();
  for (const [key, entry] of Object.entries(params)) {
    if (key === "category" || entry === undefined) continue;
    for (const item of Array.isArray(entry) ? entry : [entry]) rest.append(key, item);
  }
  const path = `/c/${encodeURIComponent(known ? categorySlug(known) : value.toLowerCase().slice(0, 40))}`;
  const qs = rest.toString();
  return qs ? `${path}?${qs}` : path;
}

/** 탭 제목 — 검색이면 "“가계부” 검색 결과", 분야면 "금융 프로젝트"(UX-39). 둘 다 없으면 홈 제목 */
export function browseTitle({ query, category }: { query?: string; category?: string }): string {
  return pageTitle(query ? `“${query}” 검색 결과` : null, category ? `${categoryLabel(category)} 프로젝트` : null);
}

/**
 * 결과 수 — 관련도순 검색은 낱말·의미 검색을 섞은 수라 꼬리까지 세어 정확한 수처럼 보이면 안 된다(UX-24).
 * 그래서 100개부터는 유효숫자 두 자리로 "약 1,800"이라 쓴다. 그보다 작으면 반올림해도 같은 수라 그대로 쓴다.
 */
export function formatResultCount(count: number, approximate = false): string {
  return approximate && count >= 100 ? formatApprox(count) : formatCount(count);
}

const SORT_LABELS: Record<HomeSort, string> = {
  weekly: "추천",
  recent: "최신",
  "all-time": "관심 많은 순",
  open: "저장소 있음",
  trending: "방문 증가 순",
  relevance: "관련도",
};

/**
 * 목록 위 결과 줄(UX-27). 검색어가 있으면 '검색 결과'(관련도순은 '관련 결과 약 n개'), 필터만 걸리면 그 필터 이름
 * ("개발 도구 9,157개"), 아무것도 없으면 정렬 이름. 수는 모두 천 단위 쉼표.
 * 순위 탭이 다른 목록을 대신 보여 주면(listLabel) 필터 이름 뒤에 그 이름을 붙인다 — 분야 알약의 전체 수와 다른 까닭이 보이게.
 */
export function resultLine(state: BrowseState, count: number, { approximate = false, listLabel }: { approximate?: boolean; listLabel?: string } = {}): string {
  if (state.query) return approximate ? `관련 결과 ${formatResultCount(count, true)}개` : `검색 결과 ${formatCount(count)}개`;
  const filters = [state.category ? categoryLabel(state.category) : null, state.observedTool, state.builder].filter(Boolean);
  if (filters.length) return `${[...filters, listLabel].filter(Boolean).join(" · ")} ${formatCount(count)}개`;
  return `${listLabel ?? SORT_LABELS[state.sort]} ${formatCount(count)}개`;
}

/** 탭 이름 — 순위가 서기 전 '추천'은 스타가 는 목록을 대신 보여 주므로 그 이름('지금 뜨는')을 쓴다(UX-35) */
export function sortLabel(sort: HomeSort, rankingReady = true): string {
  if (sort === "weekly" && !rankingReady) return "지금 뜨는";
  return SORT_LABELS[sort];
}
