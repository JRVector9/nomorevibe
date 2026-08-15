import { NextResponse } from "next/server";
import { verifyProduct } from "@/lib/domain/products/verify";
import { errorResponse, tooManyRequests } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";
import { rateLimit, clientIp } from "@/lib/rate-limit";

type Params = { params: Promise<{ slug: string }> };

export const POST = withRoute("products.verify", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  // verify도 우리 서버가 임의 URL을 fetch하는 입구이므로 rate limit 대상
  if (!rateLimit(`verify:${clientIp(req)}`, 20, 60 * 60 * 1000)) return tooManyRequests();

  const result = await verifyProduct(slug);
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json(result.value);
});
