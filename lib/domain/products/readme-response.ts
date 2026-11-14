/** 상세 README 상자가 브라우저에서 받는 값(/api/products/[slug]/readme) — 그릴 앞부분(마크다운)과 원문 주소들 */
export type ReadmeResponse =
  | { state: "available"; markdown: string; truncated: boolean; empty: boolean; sourceUrl: string; repositoryRootUrl: string }
  | { state: "unavailable" | "too_large"; sourceUrl: string | null }
  | { state: "none" };
