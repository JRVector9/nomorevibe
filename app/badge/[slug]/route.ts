import { NextResponse } from "next/server";
import { BADGE_CONTENT_TYPE, verifiedBadgeSvg } from "@/lib/domain/products/badge";
import { findBySlug } from "@/lib/domain/products/repository";
import { withRoute } from "@/lib/http/handler";

type Params = { params: Promise<{ slug: string }> };

/**
 * README용 배지 — 검증된 제품에만 내준다.
 *
 * 메이커가 등록해서 얻는 것이 상세 페이지 하나였다. 배지는 메이커에게는 신뢰 표시이고
 * 우리에게는 백링크다. 검증된 제품만 달 수 있으니 검증할 이유도 된다.
 *
 * 검증되지 않았거나 내려간 제품은 404다 — 배지가 없는 것이 곧 정보다.
 */
export const GET = withRoute("products.badge", async (_req: Request, { params }: Params) => {
  const { slug: raw } = await params;
  // 마크다운에서 이미지처럼 읽히도록 .svg를 붙여 부를 수 있게 한다
  const slug = raw.endsWith(".svg") ? raw.slice(0, -4) : raw;

  const product = await findBySlug(slug);
  if (!product || product.status !== "verified") {
    return NextResponse.json({ error: "검증된 제품에만 배지를 내줍니다" }, { status: 404 });
  }

  return new NextResponse(verifiedBadgeSvg(), {
    headers: {
      "content-type": BADGE_CONTENT_TYPE,
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
});
