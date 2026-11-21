import "server-only";
import { parseCategory, parseHomeSort, type HomeSort } from "@/components/home/browse-state";
import { getSettings as getCrawlSettings } from "@/lib/crawl/settings";
import { agentClientLabel } from "@/lib/domain/evidence/agents/view";
import { AI_FILTER_LEVELS, parseAiFilter, type AiLevel } from "@/lib/domain/evidence/ai-level-labels";
import { countProducts } from "@/lib/domain/products/repository";
import { publicRead } from "@/lib/domain/products/public-reads";
import type { Category } from "@/lib/domain/products/schema";
import type { SearchQuery } from "@/lib/domain/products/search";
import { getPublicList, getUnclaimedList, type ProductListItem } from "@/lib/domain/products/view";
import { getCurrentSeason, getSeasonRanking, type RankingListItem, type SeasonSummary } from "@/lib/domain/ranking/view";

/**
 * 홈·분야 목록 읽기(2026-11-15 공개 HTML 이름·요약만) — 화면(app/(public)/[locale]/(content)/page.tsx)과 카드 API(list=home)가
 * 같은 읽기·같은 열쇠를 쓴다. 화면은 첫 쪽만 이름·요약으로 그리고, 더 보기(?shown=)로 늘린 뒷카드는 API 가 같은 목록에서 잘라 준다.
 */

/** 최근 등록순 목록('최근 등록'·'저장소 있음')은 저장소 확인을 마친 제품만 — 목록과 개수가 같은 조건을 쓴다(repoCheckedForNewest) */
export const newestOnly = (sort: HomeSort) => sort === "recent" || sort === "open" ? true : undefined;

export type HomeListFilters = {
  category: Category | undefined;
  query: SearchQuery | undefined;
  builder: string | undefined;
  observedTool: string | undefined;
  aiLevels: readonly AiLevel[] | undefined;
};

export function listFor(
  sort: HomeSort,
  active: SeasonSummary | null,
  category: Category | undefined,
  query: SearchQuery | undefined,
  builder: string | undefined,
  observedTool: string | undefined,
  aiLevels: readonly AiLevel[] | undefined,
  limit: number,
  offset = 0,
): Promise<ProductListItem[] | RankingListItem[]> {
  const options = { category, query, builder, observedTool, aiLevels };
  if (sort === "open") {
    return getPublicList(limit, { ...options, sort: "recent", hasRepository: true, repoChecked: newestOnly(sort), offset });
  }
  if (sort === "trending" && active) {
    return getSeasonRanking({ ...options, limit, seasonKey: active.key, order: "trending" })
      .then((result) => result.items);
  }
  if (sort === "all-time") return getPublicList(limit, { ...options, sort: "stars", offset });
  return getPublicList(limit, { ...options, sort: sort === "relevance" ? "relevance" : "recent", repoChecked: newestOnly(sort), offset });
}

/** 목록·개수가 함께 쓰는 거르기 값 — 열쇠가 같아야 화면과 API 가 같은 읽기를 나눠 쓴다 */
export function homeListOptions(sort: HomeSort, filters: HomeListFilters) {
  const options = { category: filters.category, query: filters.query, builder: filters.builder, observedTool: filters.observedTool, aiLevels: filters.aiLevels, excludeDown: true };
  return {
    options,
    listOptions: { ...options, hasRepository: sort === "open" ? true : undefined, repoChecked: newestOnly(sort) },
  };
}

/** 같은 정렬·거르기·구간이면 30초 동안 한 번만 읽는다(lib/domain/products/public-reads.ts) */
export function readHomeList(sort: HomeSort, active: SeasonSummary | null, filters: HomeListFilters, limit: number, offset: number) {
  const { listOptions } = homeListOptions(sort, filters);
  return publicRead("list", ["home-fixed-tabs-v2", sort, active?.key ?? null, listOptions, limit, offset],
    () => listFor(sort, active, filters.category, filters.query, filters.builder, filters.observedTool, filters.aiLevels, limit, offset));
}

/** 순위 화면 아래 '주인을 기다리는' 목록 */
export function readUnclaimedList(sort: HomeSort, filters: HomeListFilters, span: { start: number; count: number }) {
  const { options } = homeListOptions(sort, filters);
  return publicRead("list", ["unclaimed", options, span], () => getUnclaimedList(span.count, { ...options, offset: span.start }));
}

/**
 * 카드 API(list=home)가 받은 주소 값으로 화면과 같은 정렬·거르기를 다시 정한다 — 검색어(?q=)는 받지 않는다
 * (검색 결과는 질의마다 결과라 화면이 이름·요약으로 다 그린다, 문서 4.2).
 */
export async function homeListFromParams(params: URLSearchParams): Promise<{ sort: HomeSort; active: SeasonSummary | null; filters: HomeListFilters; verifiedTotal: number }> {
  const sortParam = params.get("sort") ?? undefined;
  const requestedSort = sortParam ? parseHomeSort(sortParam) : "ai";
  const category = parseCategory(params.get("category") ?? undefined) ?? undefined;
  const builder = params.get("builder")?.trim() || undefined;
  const toolParam = params.get("observedTool")?.trim().slice(0, 80);
  const displayTools = toolParam ? await getCrawlSettings().then((settings) => settings.agentEvidence.displayObservedFacts).catch(() => false) : false;
  const observedTool = toolParam && displayTools ? agentClientLabel(toolParam) : undefined;
  const ai = requestedSort === "ai" || requestedSort === "recent" || requestedSort === "all-time" ? undefined : parseAiFilter(params.get("ai") ?? undefined) ?? undefined;
  const aiLevels = requestedSort === "ai" ? AI_FILTER_LEVELS.made : ai ? AI_FILTER_LEVELS[ai] : undefined;
  let sort: HomeSort = requestedSort;
  const active = sort === "trending" ? await publicRead("count", ["season"], () => getCurrentSeason()) : null;
  if (sort === "trending" && !active) sort = "recent";
  const verifiedTotal = requestedSort === "trending" ? await publicRead("count", ["verified"], () => countProducts({ statuses: ["verified"], excludeDown: true })) : 0;
  return { sort, active, filters: { category, query: [], builder, observedTool, aiLevels }, verifiedTotal };
}
