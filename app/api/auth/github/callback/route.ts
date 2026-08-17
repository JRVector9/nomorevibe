import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { siteOrigin } from "@/lib/site";
import { logger } from "@/lib/observability/logger";
import { isAdminLogin, authSecret } from "@/lib/auth/admin";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import {
  OAUTH_STATE_COOKIE,
  exchangeCodeForToken,
  fetchGithubUser,
} from "@/lib/auth/oauth";

/** 로그인 실패를 화면에 알린다. 실패 이유를 URL로 노출하지 않는다 */
function deny(origin: string, reason: string, detail: Record<string, unknown> = {}) {
  logger.warn("auth.denied", { reason, ...detail });
  const response = NextResponse.redirect(`${origin}/admin/login?error=1`);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

export const GET = withRoute("auth.github.callback", async (req: Request) => {
  const origin = siteOrigin(req);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const secret = authSecret();
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!secret || !clientId || !clientSecret) {
    return deny(origin, "not_configured");
  }

  // state 검증 — 우리가 시작한 요청인지 확인한다. 이게 없으면 공격자가 피해자를
  // 자기 계정으로 로그인시킬 수 있다.
  const expected = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === OAUTH_STATE_COOKIE)?.[1];

  if (!state || !expected || state !== expected) {
    return deny(origin, "state_mismatch");
  }
  if (!code) return deny(origin, "no_code");

  const accessToken = await exchangeCodeForToken(code, clientId, clientSecret);
  if (!accessToken) return deny(origin, "token_exchange_failed");

  const user = await fetchGithubUser(accessToken);
  if (!user) return deny(origin, "user_fetch_failed");

  // 신원은 확인됐지만 어드민은 아닐 수 있다
  if (!isAdminLogin(user.login)) {
    return deny(origin, "not_admin", { login: user.login });
  }

  logger.info("auth.granted", { login: user.login });
  const response = NextResponse.redirect(`${origin}/admin`);
  response.cookies.set(SESSION_COOKIE, await signSession(user.login, secret), sessionCookieOptions);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
});
