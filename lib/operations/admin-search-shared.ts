/**
 * 관리자 전역 검색의 순수한 부분 — 상수·타입·주소 만들기. 브라우저 쪽 검색 창(CommandSearch)도 가져오므로
 * DB 를 읽는 모듈(admin-search.ts)과 나눈다: 클라이언트가 그 모듈을 가져오면 DB 드라이버(fs·net·tls)가 번들에 끌려 들어와 빌드가 깨진다.
 */
export const ADMIN_SEARCH_MIN = 2;
export type AdminSearchProduct = { slug: string; name: string; url: string; repoUrl: string | null; status: string; href: string; publicHref: string; logHref: string };
export type AdminSearchCandidate = { id: number; repo: string; state: string; productUrl: string | null; href: string; logHref: string };
export type AdminSearchTarget = { target: string; count: number; lastAt: Date; href: string };
export type AdminSearchResult = { q: string; products: AdminSearchProduct[]; candidates: AdminSearchCandidate[]; targets: AdminSearchTarget[] };

/** 찾는 글자 — 앞뒤 공백을 떼고 100자까지. 너무 짧으면 null(모든 행이 걸린다) */
export function searchTerm(raw: string | null | undefined): string | null {
  const term = (raw ?? "").trim().slice(0, 100);
  return [...term].length >= ADMIN_SEARCH_MIN ? term : null;
}

/** 작업 로그를 그 대상으로 거른 화면 */
export const activityHref = (target: string) => `/admin/activity?target=${encodeURIComponent(target)}`;

/**
 * 후보가 있는 심사 큐 화면 — 그 저장소로 거르고 그 줄을 고른다. 심사 큐의 기본 보기는 아직 결론이 안 난 것(new·approved·보류)이라
 * 거부·발행된 후보는 그 보기로 보낸다.
 */
export function candidateHref(candidate: { id: number; repo: string; state: string }): string {
  const params = new URLSearchParams();
  if (candidate.state === "rejected" || candidate.state === "published") params.set("state", candidate.state);
  params.set("q", candidate.repo);
  params.set("focus", String(candidate.id));
  return `/admin/review?${params}#review-list`;
}
