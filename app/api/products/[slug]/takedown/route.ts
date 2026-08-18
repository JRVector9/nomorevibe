import { NextResponse } from "next/server";
import { requestTakedown } from "@/lib/domain/products/takedown";
import { errorResponse, tooManyRequests, badJson } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";
import { rateLimit, clientIp } from "@/lib/rate-limit";

type Params = { params: Promise<{ slug: string }> };

/**
 * 내려달라는 요청 접수.
 *
 * 소유 증명을 요구하지 않는다 — 내려달라는 사람에게 우리 토큰을 먼저 붙이라고 할 수는 없다.
 * 대신 처리는 어드민이 하고, 여기서는 장난 요청이 큐를 채우지 않게 한도만 건다.
 */
export const POST = withRoute("products.takedown", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  if (!(await rateLimit(`takedown:${clientIp(req)}`, 5, 60 * 60 * 1000))) return tooManyRequests();

  let reason: string | null = null;
  const body = await req.text();
  if (body.trim()) {
    try {
      reason = (JSON.parse(body) as { reason?: string }).reason ?? null;
    } catch {
      return badJson();
    }
  }

  const result = await requestTakedown(slug, reason);
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json({
    slug,
    received: true,
    message: "요청을 받았습니다. 확인 후 내려드리겠습니다.",
  });
});
