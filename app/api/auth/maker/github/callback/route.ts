import { NextResponse } from "next/server";
import { getPublicSession, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requestCookie } from "@/lib/domain/accounts/request-auth";
import { hashSessionToken, PUBLIC_SESSION_COOKIE } from "@/lib/domain/accounts/session";
import { GITHUB_NONCE_COOKIE } from "@/lib/domain/github-user/authorization";
import { finishMakerGithubAuthorization, requireMakerGithubEnabled } from "@/lib/domain/github-installations/authorization";
import { GithubInstallationError } from "@/lib/domain/github-installations/credentials";

export async function GET(request: Request) {
  try {
    requireMakerGithubEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new GithubInstallationError(401, "login_required");
    const url = new URL(request.url);
    if (url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1 || url.searchParams.getAll("error").length > 1) throw new GithubInstallationError(400, "invalid_github_flow");
    const result = await finishMakerGithubAuthorization({ state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "", declined: url.searchParams.has("error"), actorUserId: session.user.id, browserNonce: requestCookie(request, GITHUB_NONCE_COOKIE) ?? "", sessionTokenHash: hashSessionToken(requestCookie(request, PUBLIC_SESSION_COOKIE)!) });
    const response = NextResponse.redirect(result.installUrl);
    for (const [name, value] of Object.entries(PUBLIC_PRIVATE_HEADERS)) response.headers.set(name, value);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    const response = publicAuthErrorResponse(error);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
}
