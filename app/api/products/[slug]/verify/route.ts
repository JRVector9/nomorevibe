import { NextResponse } from "next/server";
import { verifyProduct } from "@/lib/domain/products/verify";
import { errorResponse, tooManyRequests } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { trackServer } from "@/lib/analytics/server";

type Params = { params: Promise<{ slug: string }> };

export const POST = withRoute("products.verify", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  // verify도 우리 서버가 임의 URL을 fetch하는 입구이므로 rate limit 대상
  if (!(await rateLimit(`verify:${clientIp(req)}`, 20, 60 * 60 * 1000))) return tooManyRequests();

  const result = await verifyProduct(slug);
  // 방문 분석: 요청(있는 제품만)·이번에 통과·주인 없던 제품을 가져감. 토큰·주소는 싣지 않는다
  const context = { request: req, identity: "auto" } as const;
  if (result.ok || result.error.kind !== "not_found") trackServer("verify_requested", { product_slug: slug }, context);
  if (!result.ok) return errorResponse(result.error);
  if (!result.value.already) {
    trackServer("verify_succeeded", { product_slug: result.value.slug, method: result.value.method }, context);
    if (result.value.claimed) trackServer("product_claimed", { product_slug: result.value.slug, method: "skill_verify" }, context);
  }
  return NextResponse.json(result.value);
});
