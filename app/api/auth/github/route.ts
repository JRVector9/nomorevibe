import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { siteOrigin } from "@/lib/site";
import { OAUTH_STATE_COOKIE, oauthStateCookieOptions } from "@/lib/auth/oauth";

/**
 * OAuth 시작 — GitHub 인증 화면으로 보낸다.
 *
 * state를 만들어 쿠키에 심고 같은 값을 GitHub에 넘긴다. 콜백에서 둘을 비교해
 * 우리가 시작한 요청인지 확인한다 — 없으면 공격자가 피해자를 자기 계정으로
 * 로그인시킬 수 있다(CSRF).
 */
export const GET = withRoute("auth.github.start", async (req: Request) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GitHub OAuth가 설정되지 않았습니다" }, { status: 503 });
  }

  const state = crypto.randomUUID();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", `${siteOrigin(req)}/api/auth/github/callback`);
  // 어드민 로그인에 필요한 것은 신원뿐이다. 레포 권한은 요구하지 않는다.
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);

  const response = NextResponse.redirect(authorize.toString());
  response.cookies.set(OAUTH_STATE_COOKIE, state, oauthStateCookieOptions);
  return response;
});
