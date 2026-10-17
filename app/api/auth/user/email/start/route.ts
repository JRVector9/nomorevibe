import { NextResponse } from "next/server";
import { startEmailLogin } from "@/lib/domain/accounts/email-login";
import { publicAuthErrorResponse, PublicAuthError, PUBLIC_PRIVATE_HEADERS, readLoginJson, requestCookie, requireLoginMutation, requirePublicAuthEnabled, requirePublicOrigin } from "@/lib/domain/accounts/request-auth";
import { csrfForToken, isOpaqueToken, LOGIN_NONCE_COOKIE, loginNonceCookieOptions, newPublicSession } from "@/lib/domain/accounts/session";
import { trustedClientIp } from "@/lib/rate-limit";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/** The pre-authentication nonce is independent from both user and admin sessions. */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    if (request.headers.get("sec-fetch-site") === "cross-site") throw new PublicAuthError(403, "invalid_origin");
    if (request.headers.has("origin")) requirePublicOrigin(request);
    const existing = requestCookie(request, LOGIN_NONCE_COOKIE);
    const nonce = isOpaqueToken(existing) ? existing : newPublicSession().token;
    const response = NextResponse.json({ csrfToken: csrfForToken(nonce, "login") }, { headers: PUBLIC_PRIVATE_HEADERS });
    response.cookies.set(LOGIN_NONCE_COOKIE, nonce, loginNonceCookieOptions());
    return response;
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}

export const POST = webWriteRoute(async (request: Request) => {
  try {
    const browserNonce = requireLoginMutation(request);
    const input = await readLoginJson(request);
    const result = await startEmailLogin({ email: input.email, returnTo: input.returnTo, browserNonce, ip: trustedClientIp(request) });
    const response = NextResponse.json(result, { status: 202, headers: PUBLIC_PRIVATE_HEADERS });
    response.cookies.set(LOGIN_NONCE_COOKIE, browserNonce, loginNonceCookieOptions());
    return response;
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
