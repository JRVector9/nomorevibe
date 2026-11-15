import { NextResponse } from "next/server";
import { timelineUpdate, type TimelineAllResponse } from "@/components/product-detail/client-data";
import { createMakerUpdate, makerUpdateCreateSchema } from "@/lib/domain/evidence/maker";
import { getPublicProductUpdates } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { formatIssues } from "@/lib/domain/products/schema";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { errorResponse } from "@/lib/http/respond";
import { allowMakerMutation, authorizeMakerRoute, makerJson } from "../maker-route";

type Params = { params: Promise<{ slug: string }> };

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/**
 * 상세 업데이트 '전체'(2026-11-15 사람 결정) — 서버 HTML·부가 자료 API 는 최신 세 줄만 싣고, '전체'를 누르면 브라우저가
 * 이 같은 출처 API 로 보이는 업데이트를 모두 받는다. 상세와 같은 조건·순서(detail-view.ts visibleUpdateWhere·visibleUpdateOrder)이고
 * 한 줄이 그리는 칸(날짜·제목·출처 링크)만 돌려준다. 공개 API 읽기 관문을 그대로 거치고, 상세와 같은 짧은 읽기 캐시를 쓴다. 엣지에 담지 않는다.
 */
export const GET = withRoute("products.updates", async (req: Request, { params }: Params) => {
  const refused = await guardPublicApiRead(req, "products.updates");
  if (refused) return refused;
  const { slug } = await params;
  const rows = await publicRead("detail", ["updates", slug], async () => (await getPublicProductUpdates(slug))?.map(timelineUpdate) ?? null);
  if (!rows) return errorResponse({ kind: "not_found" });
  return NextResponse.json({ rows } satisfies TimelineAllResponse, { headers: NO_STORE });
});

export const POST = withRoute("products.evidence.updates.create", async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  const limited = await allowMakerMutation(request, auth.product.id, "updates");
  if (limited) return limited;
  const body = await makerJson(request);
  if (!body.ok) return body.response;
  const parsed = makerUpdateCreateSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  const id = await createMakerUpdate({
    slug,
    productId: auth.product.id,
    actor: auth.actor,
    update: parsed.data,
  });
  return NextResponse.json({ slug, id, created: true, source: "maker" }, { status: 201 });
});
