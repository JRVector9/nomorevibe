/**
 * 홈 관련도순 검색의 연결 — hybrid-search.ts 의 순위 계산에 공개 목록의 조회를 물린다.
 *
 * 화면(app/page.tsx)과 정답 평가(scripts/search-judged.ts)가 같은 길을 쓴다 — 평가가 화면과 다른 검색을 재지 않게.
 */
import type { Category } from "./schema";
import type { SearchQuery } from "./search";
import { rankSearch, type RankDependencies, type RankedSearch } from "./hybrid-search";
import { countProducts, listProductSlugs, nearestProductSlugs, productDocuments } from "./repository";

export type RelevanceFilters = { category?: Category; builder?: string; observedTool?: string };

/** 공개 목록과 같은 바탕 — 검증·시드, 닿지 않는 제품 빼기 */
const scope = (filters: RelevanceFilters) => ({ statuses: ["verified" as const, "seeded" as const], excludeDown: true, ...filters });

/**
 * raw 는 사람이 친 말 그대로(임베딩·재정렬이 읽는다 — bge-m3 는 한국어 문장을 영어 소개와 바로 잰다),
 * plan 은 낱말 검색 계획(번역이 붙었으면 함께).
 */
export function rankRelevance(raw: string, plan: SearchQuery, filters: RelevanceFilters, deps: Partial<RankDependencies> = {}): Promise<RankedSearch> {
  const base = scope(filters);
  return rankSearch(raw, {
    ftsSlugs: (limit) => listProductSlugs({ ...base, query: plan, sort: "relevance", limit }),
    ftsCount: () => countProducts({ ...base, query: plan }),
    ftsMatching: (slugs) => listProductSlugs({ ...base, query: plan, slugs, limit: slugs.length }),
    nearestSlugs: (vector, limit, minSimilarity) => nearestProductSlugs(vector, base, limit, minSimilarity),
    documents: productDocuments,
    ...deps,
  });
}

/**
 * 결과의 [start, start + count) 주소 — 앞쪽(head)은 섞은 순서, 그 뒤는 낱말 검색 순서에서 앞쪽에 나온 것을 뺀 것.
 * 그래서 "더 보기"로 낱말 검색에 걸린 것 모두에 닿고, 같은 제품이 두 번 나오지 않는다.
 */
export async function relevanceWindow(
  ranked: RankedSearch, plan: SearchQuery, filters: RelevanceFilters, start: number, count: number,
): Promise<string[]> {
  const head = ranked.head.slice(start, start + count);
  const rest = start + count - Math.max(start, ranked.head.length);
  if (rest <= 0) return head;
  const tail = await listProductSlugs({
    ...scope(filters), query: plan, sort: "relevance", excludeSlugs: ranked.head,
    offset: Math.max(0, start - ranked.head.length), limit: rest,
  });
  return [...head, ...tail];
}
