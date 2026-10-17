import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { siteOrigin } from "@/lib/site";
import { adminIngressAllowed, adminMutationOriginAllowed, adminOrigin } from "@/lib/auth/admin-access";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * POST만 받는다 — GET이면 남의 페이지에 이미지 태그 하나로 로그아웃시킬 수 있다.
 * 서명 쿠키만 지우고 DB 에 쓰지 않는다 — fence·DB 가 안 될 때도 로그아웃은 된다(dbWrite: false).
 */
export const POST = withRoute("auth.logout", async (req: Request) => {
  if (!adminIngressAllowed(req.headers)) return new NextResponse(null, { status: 404 });
  if (!adminMutationOriginAllowed(req.headers)) return new NextResponse(null, { status: 403 });
  const response = NextResponse.redirect(`${adminOrigin() ?? siteOrigin(req)}/admin/login`, 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}, { dbWrite: false });
