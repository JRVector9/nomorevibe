import { NextResponse } from "next/server";
import { getPublicSession, publicAuthErrorResponse, PublicAuthError, PUBLIC_PRIVATE_HEADERS, requestCookie } from "@/lib/domain/accounts/request-auth";
import { PUBLIC_SESSION_COOKIE, publicSessionCookieOptions } from "@/lib/domain/accounts/session";
import { finishGithubAuthorization, GITHUB_NONCE_COOKIE, githubNonceCookieOptions, requireGithubStarEnabled } from "@/lib/domain/github-user/authorization";
import { githubStarAppConfig } from "@/lib/domain/github-user/config";
import { consumeGithubAuthFlow } from "@/lib/domain/github-user/repository";

export async function GET(request: Request) {
  try {
    requireGithubStarEnabled();
    const url = new URL(request.url);
    if (url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1) throw new PublicAuthError(400, "invalid_github_flow");
    const session = await getPublicSession(request);
    const input = { state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "", browserNonce: requestCookie(request, GITHUB_NONCE_COOKIE) ?? "", actorUserId: session?.user.id ?? null, previousToken: requestCookie(request, PUBLIC_SESSION_COOKIE) };
    if (url.searchParams.has("error")) {
      await consumeGithubAuthFlow({ ...input, purpose: "star" });
      throw new PublicAuthError(400, "github_authorization_declined");
    }
    const result = await finishGithubAuthorization(input);
    const response = NextResponse.redirect(new URL(result.returnTo, githubStarAppConfig().callbackUrl));
    for (const [name, value] of Object.entries(PUBLIC_PRIVATE_HEADERS)) response.headers.set(name, value);
    response.cookies.set(PUBLIC_SESSION_COOKIE, result.token, publicSessionCookieOptions());
    response.cookies.set(GITHUB_NONCE_COOKIE, "", { ...githubNonceCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    if (error instanceof PublicAuthError && (error.status === 404 || error.status === 503)) return publicAuthErrorResponse(error);
    const code = error instanceof PublicAuthError ? error.code : "github_authorization_failed";
    let origin: string;
    try { origin = new URL(githubStarAppConfig().callbackUrl).origin; } catch { return publicAuthErrorResponse(error); }
    const target = new URL("/login", origin);
    target.searchParams.set("connectGithub", "1");
    target.searchParams.set("githubError", code);
    const response = NextResponse.redirect(target);
    for (const [name, value] of Object.entries(PUBLIC_PRIVATE_HEADERS)) response.headers.set(name, value);
    response.cookies.set(GITHUB_NONCE_COOKIE, "", { ...githubNonceCookieOptions(), maxAge: 0 });
    return response;
  }
}
