import { NextResponse } from "next/server";
import { getPublicSession, publicAuthErrorResponse, PublicAuthError, PUBLIC_PRIVATE_HEADERS, requestCookie } from "@/lib/domain/accounts/request-auth";
import { deviceLabel } from "@/lib/domain/accounts/device";
import { PUBLIC_SESSION_COOKIE, publicSessionCookieOptions } from "@/lib/domain/accounts/session";
import { finishGithubAuthorization, GITHUB_NONCE_COOKIE, githubNonceCookieOptions, requireGithubStarEnabled } from "@/lib/domain/github-user/authorization";
import { githubStarAppConfig } from "@/lib/domain/github-user/config";
import { consumeGithubAuthFlow } from "@/lib/domain/github-user/repository";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { localePath, pathLocale, safePublicReturnUrl } from "@/lib/i18n/routing";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { trackServer } from "@/lib/analytics/server";

export const GET = webWriteRoute(async (request: Request) => {
  let consumedReturnTo: string | undefined;
  try {
    requireGithubStarEnabled();
    const url = new URL(request.url);
    if (url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1) throw new PublicAuthError(400, "invalid_github_flow");
    const session = await getPublicSession(request);
    const input = { state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "", browserNonce: requestCookie(request, GITHUB_NONCE_COOKIE) ?? "", actorUserId: session?.user.id ?? null, previousToken: requestCookie(request, PUBLIC_SESSION_COOKIE), deviceLabel: deviceLabel(request.headers.get("user-agent")) };
    if (url.searchParams.has("error")) {
      const flow = await consumeGithubAuthFlow({ ...input, purpose: "star" });
      consumedReturnTo = flow.returnTo;
      throw new PublicAuthError(400, "github_authorization_declined");
    }
    const result = await finishGithubAuthorization(input, (returnTo) => { consumedReturnTo = returnTo; });
    const response = NextResponse.redirect(new URL(result.returnTo, githubStarAppConfig().callbackUrl));
    for (const [name, value] of Object.entries(PUBLIC_PRIVATE_HEADERS)) response.headers.set(name, value);
    // 돌아간 화면이 github.com 을 앞 화면(referrer)으로 받으면 GA 가 새 세션을 연다 — 로그인 앞뒤의 여정이 끊기지 않게 지운다
    response.headers.set("Referrer-Policy", "no-referrer");
    /**
     * 방문 분석(서버 사실): 로그인 중이던 사람이면 스타 권한 연결, 아니면 GitHub 로그인 — 새 계정이면 sign_up 도.
     * login 은 이메일과 같이 성공한 로그인마다(가입 포함), sign_up 은 새 계정일 때만(lib/analytics/events.ts).
     */
    const analytics = { request, identity: "browser", userId: result.user.id } as const;
    if (input.actorUserId !== null) {
      trackServer("github_connected", { kind: "star" }, analytics);
    } else {
      if (result.created) trackServer("sign_up", { method: "github" }, analytics);
      trackServer("login", { method: "github" }, analytics);
      trackServer("github_connected", { kind: "login" }, analytics);
    }
    response.cookies.set(PUBLIC_SESSION_COOKIE, result.token, publicSessionCookieOptions());
    response.cookies.set(GITHUB_NONCE_COOKIE, "", { ...githubNonceCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    if (error instanceof PublicAuthError && (error.status === 404 || error.status === 503)) return publicAuthErrorResponse(error);
    const code = error instanceof PublicAuthError ? error.code : "github_authorization_failed";
    let origin: string;
    try { origin = new URL(githubStarAppConfig().callbackUrl).origin; } catch { return publicAuthErrorResponse(error); }
    const returnTo = consumedReturnTo === undefined ? undefined : safePublicReturnUrl(consumedReturnTo);
    const locale = returnTo ? pathLocale(returnTo) ?? DEFAULT_LOCALE : DEFAULT_LOCALE;
    const target = new URL(localePath(locale, "/login"), origin);
    target.searchParams.set("connectGithub", "1");
    target.searchParams.set("githubError", code);
    if (returnTo) target.searchParams.set("returnTo", returnTo);
    const response = NextResponse.redirect(target);
    for (const [name, value] of Object.entries(PUBLIC_PRIVATE_HEADERS)) response.headers.set(name, value);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(GITHUB_NONCE_COOKIE, "", { ...githubNonceCookieOptions(), maxAge: 0 });
    return response;
  }
}, publicAuthErrorResponse);
