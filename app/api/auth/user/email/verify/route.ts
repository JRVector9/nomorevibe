import { NextResponse } from "next/server";
import { deviceLabel } from "@/lib/domain/accounts/device";
import { verifyEmailLogin } from "@/lib/domain/accounts/email-login";
import { publicAuthErrorResponse, PublicAuthError, PUBLIC_PRIVATE_HEADERS, readLoginJson, requestCookie, requireLoginMutation } from "@/lib/domain/accounts/request-auth";
import { LOGIN_NONCE_COOKIE, loginNonceCookieOptions, PUBLIC_SESSION_COOKIE, publicSessionCookieOptions } from "@/lib/domain/accounts/session";
import { rememberEmailLocale } from "@/lib/me/notification-settings";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

export const POST = webWriteRoute(async (request: Request) => {
  try {
    const browserNonce = requireLoginMutation(request);
    const input = await readLoginJson(request);
    if (typeof input.challengeId !== "string" || typeof input.code !== "string") throw new PublicAuthError(400, "invalid_code");
    const result = await verifyEmailLogin({ challengeId: input.challengeId, code: input.code, browserNonce, previousToken: requestCookie(request, PUBLIC_SESSION_COOKIE), deviceLabel: deviceLabel(request.headers.get("user-agent")) });
    // 알림 메일의 언어 = 로그인한 화면의 언어(돌아갈 주소의 언어). 던지지 않는다(MY7)
    await rememberEmailLocale(result.user.id, result.returnTo);
    const response = NextResponse.json({ user: result.user, csrfToken: result.csrfToken, returnTo: result.returnTo }, { headers: PUBLIC_PRIVATE_HEADERS });
    response.cookies.set(PUBLIC_SESSION_COOKIE, result.token, publicSessionCookieOptions());
    response.cookies.set(LOGIN_NONCE_COOKIE, "", { ...loginNonceCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
