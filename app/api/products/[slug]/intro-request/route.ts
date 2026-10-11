import { NextResponse } from "next/server";
import { requestIntroCorrection } from "@/lib/domain/products/intro-requests";
import { takedownRequesterHash } from "@/lib/domain/products/takedown";
import { INTRO_REQUEST_RECEIVED, introRequestMessage } from "@/lib/domain/products/takedown-view";
import { errorResponse, tooManyRequests, badJson } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";
import { rateLimit, clientIp, trustedClientIp } from "@/lib/rate-limit";

type Params = { params: Promise<{ slug: string }> };

/** 제품·보낸이마다 1시간에 받는 수 — 내려달라는 요청과 같다 */
const INTRO_REQUESTS_PER_HOUR = 5;

/**
 * 소개 수정 요청 접수(2026-10-08 UX 감사 UX-18).
 *
 * 내려달라는 요청(../takedown)과 다른 길이다 — 그 표에 행을 만들지 않으므로 검색엔진 노출과 CDN 에 아무 영향이 없다.
 * 소유 증명은 요구하지 않는다(처리는 사람이 한다). 무엇이 틀렸는지는 꼭 적어야 받는다. 연락처는 받지 않는다(D5).
 */
export const POST = withRoute("products.intro_request", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  // 한도를 제품별로 건다 — 신뢰 프록시가 없으면 모두 한 버킷이라, 한 사람이 다른 제품의 요청까지 막지 않게(takedown 과 같은 까닭)
  if (!(await rateLimit(`intro-request:${slug}:${clientIp(req)}`, INTRO_REQUESTS_PER_HOUR, 60 * 60 * 1000))) {
    return tooManyRequests();
  }

  let raw: unknown;
  try {
    const parsed: unknown = JSON.parse((await req.text()) || "{}");
    raw = parsed && typeof parsed === "object" ? (parsed as { message?: unknown }).message : undefined;
  } catch {
    return badJson();
  }
  const checked = introRequestMessage(raw);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const result = await requestIntroCorrection(slug, checked.message, takedownRequesterHash(trustedClientIp(req)));
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json({ slug, received: true, message: INTRO_REQUEST_RECEIVED });
});
