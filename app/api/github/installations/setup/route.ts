import { NextResponse } from "next/server";
import { getPublicSession, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requestCookie } from "@/lib/domain/accounts/request-auth";
import { hashSessionToken, PUBLIC_SESSION_COOKIE } from "@/lib/domain/accounts/session";
import { GITHUB_NONCE_COOKIE, githubNonceCookieOptions } from "@/lib/domain/github-user/authorization";
import { completeMakerGithubInstallation, feedbackOAuthConfig, requireMakerGithubEnabled } from "@/lib/domain/github-installations/authorization";
import { GithubInstallationError } from "@/lib/domain/github-installations/credentials";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

export const GET = webWriteRoute(async (request: Request) => {
  try {
    requireMakerGithubEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new GithubInstallationError(401, "login_required");
    const url = new URL(request.url);
    if (url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("installation_id").length > 1 || url.searchParams.getAll("setup_action").length > 1) throw new GithubInstallationError(400, "invalid_github_flow");
    const id = url.searchParams.get("installation_id"), action = url.searchParams.get("setup_action") ?? undefined;
    if (action !== "request" && (!id || !/^[1-9]\d*$/.test(id))) throw new GithubInstallationError(400, "github_invalid_request");
    const result = await completeMakerGithubInstallation({ state: url.searchParams.get("state") ?? "", actorUserId: session.user.id, browserNonce: requestCookie(request, GITHUB_NONCE_COOKIE) ?? "", sessionTokenHash: hashSessionToken(requestCookie(request, PUBLIC_SESSION_COOKIE)!), installationId: id ? Number(id) : undefined, setupAction: action });
    const target = new URL(result.returnTo, feedbackOAuthConfig().origin);
    target.searchParams.delete("pending");
    target.searchParams.delete("connected");
    target.searchParams.set(result.status === "pending" ? "pending" : "connected", "1");
    const response = NextResponse.redirect(target);
    for (const [name, value] of Object.entries(PUBLIC_PRIVATE_HEADERS)) response.headers.set(name, value);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(GITHUB_NONCE_COOKIE, "", { ...githubNonceCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    const response = publicAuthErrorResponse(error);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
}, error => {
  const response = publicAuthErrorResponse(error);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
});
