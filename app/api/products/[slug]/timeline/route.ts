import { NextResponse } from "next/server";
import { timelineUpdate, type TimelineAllResponse } from "@/components/product-detail/client-data";
import { getPublicProductUpdates } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { errorResponse } from "@/lib/http/respond";

type Params = { params: Promise<{ slug: string }> };

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/**
 * 상세 업데이트 '전체'(2026-11-15 사람 결정) — 서버 HTML·부가 자료 API 는 최신 세 줄만 싣고, '전체'를 누르면 브라우저가
 * 이 같은 출처 API 로 보이는 업데이트를 모두 받는다. 상세와 같은 조건·순서(detail-view.ts visibleUpdateWhere·visibleUpdateOrder)이고
 * 한 줄이 그리는 칸(날짜·제목·출처 링크)만 돌려준다. 공개 API 읽기 관문을 그대로 거치고, 상세와 같은 짧은 읽기 캐시를 쓴다. 엣지에 담지 않는다.
 * 메이커 업데이트 쓰기(../updates, POST)와 경로를 나눈다 — 그 파일이 공개 상세 조회(server-only)를 끌어오지 않게.
 */
export const GET = withRoute("products.timeline", async (req: Request, { params }: Params) => {
  const refused = await guardPublicApiRead(req, "products.timeline");
  if (refused) return refused;
  const { slug } = await params;
  const rows = await publicRead("detail", ["timeline", slug], async () => (await getPublicProductUpdates(slug))?.map(timelineUpdate) ?? null);
  if (!rows) return errorResponse({ kind: "not_found" });
  return NextResponse.json({ rows } satisfies TimelineAllResponse, { headers: NO_STORE });
});
