/**
 * 홈 관련도순 검색의 연결 — hybrid-search.ts 의 순위 계산에 공개 목록의 조회를 물린다.
 *
 * 화면(app/page.tsx)과 정답 평가(scripts/search-judged.ts)가 같은 길을 쓴다 — 평가가 화면과 다른 검색을 재지 않게.
 */
import type { Category } from "./schema";
import type { SearchQuery } from "./search";
import type { ResolvedSearch } from "./search-translation";
import { rankSearch, type RankDependencies, type RankedSearch } from "./hybrid-search";
import { countProducts, listProductSlugs, nearestProductSlugs, productDocuments, type ListOptions } from "./repository";
import { onPrimary } from "@/lib/db";
import { logger } from "@/lib/observability/logger";

export type RelevanceFilters = { category?: Category; builder?: string; observedTool?: string; aiLevels?: ListOptions["aiLevels"] };

/**
 * 복제본이 pgvector 를 모르면(패키지 없음 — 2026-10-07 V9-Replica) 벡터 읽기만 주 DB 에서 다시 한다.
 * 58P01 확장 파일 없음 · 42704 타입 없음 · 42883 함수 없음. 다른 오류는 그대로 던진다(낱말 검색으로 내려간다).
 */
const MISSING_ON_REPLICA = new Set(["58P01", "42704", "42883"]);
export async function withPrimaryFallback<T>(load: () => Promise<T>, primary: (load: () => Promise<T>) => Promise<T> = onPrimary): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const code = (error as { code?: unknown; cause?: { code?: unknown } }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
    if (typeof code !== "string" || !MISSING_ON_REPLICA.has(code)) throw error;
    logger.warn("search.vector_read_on_primary", { code });
    return primary(load);
  }
}

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
    nearestSlugs: (vector, limit, minSimilarity) => withPrimaryFallback(() => nearestProductSlugs(vector, base, limit, minSimilarity)),
    documents: productDocuments,
    ...deps,
  });
}

export type RelevanceResult = RankedSearch & {
  /** 이 순위를 낸 낱말 검색 계획 — 뒤쪽 창(relevanceWindow)도 같은 계획으로 이어 받는다 */
  plan: SearchQuery;
  /** 화면에 밝힐 번역 */
  translated: string | null;
};

/**
 * 관련도순 검색 한 번 — 번역을 기다리지 않고 찾되, 처음 들어온 한국어 문장이 원문으로 하나도 걸리지 않으면
 * 그때만 번역을 기다려 한 번 더 찾는다(예전처럼 약 3초). "드라마 평점 차트"는 한국어 낱말이 색인에 없고 뜻이 가까운
 * 정답도 하한(코사인 0.5) 아래라 원문만으로는 0건이었다 — 번역("tv show ratings")이 붙으면 걸린다.
 */
export async function searchRelevance(
  raw: string, resolved: ResolvedSearch, filters: RelevanceFilters,
  translate: () => Promise<ResolvedSearch>,
  rank: typeof rankRelevance = rankRelevance,
): Promise<RelevanceResult> {
  const ranked = await rank(raw, resolved.queries, filters);
  if (ranked.total > 0 || !resolved.translationPending) return { ...ranked, plan: resolved.queries, translated: resolved.translated };
  const waited = await translate();
  if (!waited.translated) return { ...ranked, plan: resolved.queries, translated: null };
  return { ...await rank(raw, waited.queries, filters), plan: waited.queries, translated: waited.translated };
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
