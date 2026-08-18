import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { findBySlug } from "@/lib/domain/products/repository";
import {
  recordClick,
  isBotAgent,
  visitorId,
  VISITOR_COOKIE,
  visitorCookieOptions,
} from "@/lib/domain/products/clicks";
import { withRoute } from "@/lib/http/handler";
import { siteOrigin } from "@/lib/site";

type Params = { params: Promise<{ slug: string }> };

/**
 * 제품으로 나가는 문.
 *
 * 목록에서 제품 주소로 바로 걸면 누가 무엇을 눌렀는지 알 수 없다. 한 번 거쳐 가게 해서
 * 세고 보낸다. JS 없이도 동작하고, 세는 쪽이 서버라 클라이언트가 조작할 수 없다.
 *
 * 차단된 제품은 내보내지 않는다 — 목록에서 내린 것을 링크로 우회할 수 있으면 내린 의미가 없다.
 *
 * 세지 않는 경우가 둘 있다. 봇이거나(랭킹이 크롤 빈도순이 되면 안 된다), 기록이 실패한
 * 경우다. 어느 쪽이든 이동은 그대로 시킨다 — 사용자는 제품으로 가는 중이다.
 */
export const GET = withRoute("products.go", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") {
    return NextResponse.redirect(siteOrigin(req), { status: 302 });
  }

  const response = NextResponse.redirect(product.url, { status: 302 });
  if (isBotAgent(req.headers.get("user-agent"))) return response;

  /**
   * 방문자 구분은 우리 쿠키로 한다. IP는 프록시 설정(TRUSTED_PROXY_HOPS)에 기대는데,
   * 기본값에서는 모든 요청이 같은 값이라 전 세계가 한 버킷으로 묶였다.
   */
  const existing = (await cookies()).get(VISITOR_COOKIE)?.value;
  const visitor = visitorId(existing);
  if (visitor !== existing) {
    response.cookies.set(VISITOR_COOKIE, visitor, visitorCookieOptions);
  }

  await recordClick(slug, visitor);
  return response;
});
