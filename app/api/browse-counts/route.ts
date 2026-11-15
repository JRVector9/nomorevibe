import { NextResponse } from "next/server";
import { aiLevelTotals } from "@/components/home/browse-state";
import { homeListFromParams, homeListOptions, listFor, readHomeList } from "@/components/home/home-list";
import type { AiLevel } from "@/lib/domain/evidence/ai-level-labels";
import { getHomePulse, type HomePulse } from "@/lib/domain/products/home-pulse";
import { getPopularFacets, getPopularPage, type PopularFacets } from "@/lib/domain/products/popular";
import { publicRead } from "@/lib/domain/products/public-reads";
import { parsePopularParams } from "@/lib/domain/products/stars";
import { publicPaginationBlocked } from "@/lib/web/public-pagination";
import { aiLevelCounts, categoryCounts, countProducts } from "@/lib/domain/products/repository";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/** 홈·분야 화면의 수 — 공개 수·분야 알약의 수·지금 목록의 결과 수 */
export type BrowseCountsResponse = { total: number; counts: Record<string, number>; resultCount: number };
/** 집계 기준 창(?metric=)의 분야별 수·AI 단계별 수 */
export type MethodCountsResponse = { aiLevels: Record<AiLevel, number> | null; categories: HomePulse["categories"] };

/** /popular 의 구간별 수·지금 목록 수·거르기 알약 수 */
export type PopularCountsResponse = { totals: number[]; total: number; facets: PopularFacets | null };

/**
 * 공개 수·분류별 수·AI 수(2026-11-15 공개 HTML 이름·요약만, 문서 2·4.2장) — 서버 HTML·RSC 데이터에 싣지 않고 화면 JS 가 이 같은 출처 API 로 받는다.
 * 홈 화면(app/(public)/[locale]/(content)/page.tsx)과 같은 읽기·같은 열쇠다. 검색어(?q=)가 있는 화면은 알약 수를 숨기므로 받지 않는다.
 *  - 기본: total·counts(현재 목록 자격의 분야별 수)·resultCount(현재 목록의 수)
 *  - part=method: 집계 기준 창의 AI 단계별 수·분야별 공개 수
 *  - part=popular&</popular 의 tier·personal·ai·category·sort·page>: 구간 탭·알약·목록 제목의 수(/popular 와 같은 읽기·같은 열쇠)
 */
export const GET = withRoute("products.counts", async (req: Request) => {
  const refused = await guardPublicApiRead(req, "products.counts");
  if (refused) return refused;
  const params = new URL(req.url).searchParams;
  if (params.get("part") === "method") {
    const [ai, pulse] = await Promise.all([
      publicRead("count", ["ai-levels"], () => aiLevelCounts()).catch(() => null),
      getHomePulse(new Date()).catch(() => null),
    ]);
    return NextResponse.json({ aiLevels: aiLevelTotals(ai), categories: pulse?.categories ?? [] } satisfies MethodCountsResponse, { headers: NO_STORE });
  }
  if (params.get("part") === "popular") {
    const query = Object.fromEntries(params.entries());
    if (publicPaginationBlocked(query, "page")) return NextResponse.json({ error: "page_out_of_range" }, { status: 400, headers: NO_STORE });
    const state = parsePopularParams(query);
    const filters = { personal: state.personal, ai: state.ai, category: state.category };
    const [result, facets] = await Promise.all([
      publicRead("list", ["popular-page", state.tier, filters, state.sort, state.page], () => getPopularPage(state.tier, filters, state.sort, state.page)),
      publicRead("count", ["popular-facets", state.tier, filters], () => getPopularFacets(state.tier, filters)).catch(() => null),
    ]);
    return NextResponse.json({ totals: result.totals, total: result.total, facets } satisfies PopularCountsResponse, { headers: NO_STORE });
  }
  const { sort, active, filters, verifiedTotal } = await homeListFromParams(params);
  const { listOptions } = homeListOptions(sort, filters);
  const publicCatalogue = sort !== "trending";
  const rankedSlugs = !publicCatalogue && active
    ? (await publicRead("list", ["home-facet-rankings", sort, active.key, verifiedTotal],
      () => listFor(sort, active, undefined, undefined, undefined, undefined, undefined, verifiedTotal)))
      .map((product) => product.slug)
    : undefined;
  const facetOptions = { ...listOptions, category: undefined,
    ...(rankedSlugs ? { statuses: ["verified"] as const, slugs: rankedSlugs } : { statuses: ["verified", "seeded"] as const }) };
  const [all, counts, resultCount] = await Promise.all([
    publicRead("count", ["categories"], () => categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true })),
    publicRead("count", ["browse-categories-v2", sort, active?.key, facetOptions], () => categoryCounts({ ...facetOptions, statuses: [...facetOptions.statuses] })),
    publicCatalogue
      ? publicRead("count", ["matching", listOptions], () => countProducts({ statuses: ["verified", "seeded"], ...listOptions }))
      : readHomeList(sort, active, filters, verifiedTotal, 0).then((rows) => rows.length),
  ]);
  const total = Object.values(all).reduce((sum, count) => sum + count, 0);
  return NextResponse.json({ total, counts, resultCount } satisfies BrowseCountsResponse, { headers: NO_STORE });
});
