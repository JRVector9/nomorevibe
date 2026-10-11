import { NextResponse } from "next/server";
import { verifyEmailLogin } from "@/lib/domain/accounts/email-login";
import { publicAuthErrorResponse, PublicAuthError, PUBLIC_PRIVATE_HEADERS, readLoginJson, requestCookie, requireLoginMutation } from "@/lib/domain/accounts/request-auth";
import { LOGIN_NONCE_COOKIE, loginNonceCookieOptions, PUBLIC_SESSION_COOKIE, publicSessionCookieOptions } from "@/lib/domain/accounts/session";

export async function POST(request: Request) {
  try {
    const browserNonce = requireLoginMutation(request);
    const input = await readLoginJson(request);
    if (typeof input.challengeId !== "string" || typeof input.code !== "string") throw new PublicAuthError(400, "invalid_code");
    const result = await verifyEmailLogin({ challengeId: input.challengeId, code: input.code, browserNonce, previousToken: requestCookie(request, PUBLIC_SESSION_COOKIE) });
    const response = NextResponse.json({ user: result.user, csrfToken: result.csrfToken, returnTo: result.returnTo }, { headers: PUBLIC_PRIVATE_HEADERS });
    response.cookies.set(PUBLIC_SESSION_COOKIE, result.token, publicSessionCookieOptions());
    response.cookies.set(LOGIN_NONCE_COOKIE, "", { ...loginNonceCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}
