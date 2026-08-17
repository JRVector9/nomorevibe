import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { siteOrigin } from "@/lib/site";
import { SESSION_COOKIE } from "@/lib/auth/session";

/** POST만 받는다 — GET이면 남의 페이지에 이미지 태그 하나로 로그아웃시킬 수 있다 */
export const POST = withRoute("auth.logout", async (req: Request) => {
  const response = NextResponse.redirect(`${siteOrigin(req)}/admin/login`);
  response.cookies.delete(SESSION_COOKIE);
  return response;
});
