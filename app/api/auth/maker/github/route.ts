import { NextResponse } from "next/server";
import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, readLoginJson, requestCookie, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { hashSessionToken, PUBLIC_SESSION_COOKIE } from "@/lib/domain/accounts/session";
import { GITHUB_NONCE_COOKIE, githubNonceCookieOptions } from "@/lib/domain/github-user/authorization";
import { GithubInstallationError } from "@/lib/domain/github-installations/credentials";
import { requireMakerGithubEnabled, startMakerGithubAuthorization } from "@/lib/domain/github-installations/authorization";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

export const POST = webWriteRoute(async (request: Request) => {
  try {
    requireMakerGithubEnabled();
    const user = await requirePublicMutation(request);
    if (new URL(request.url).search) throw new GithubInstallationError(400, "github_invalid_request");
    const editToken = request.headers.get("x-edit-token");
    if (!editToken) throw new GithubInstallationError(401, "maker_edit_token_required");
    const input = await readLoginJson(request);
    if (Object.keys(input).some(key => !["slug", "deliveryConsent", "returnTo"].includes(key)) || typeof input.slug !== "string" || input.slug.length > 80 || !/^[a-z0-9-]+$/.test(input.slug)
      || (input.returnTo !== undefined && (typeof input.returnTo !== "string" || input.returnTo.length > 2_000))) throw new GithubInstallationError(400, "github_invalid_request");
    const result = await startMakerGithubAuthorization({ actorUserId: user.id, slug: input.slug, editToken, deliveryConsent: input.deliveryConsent === true, sessionTokenHash: hashSessionToken(requestCookie(request, PUBLIC_SESSION_COOKIE)!), returnTo: input.returnTo as string | undefined });
    const response = NextResponse.json({ authorizeUrl: result.authorizeUrl }, { headers: PUBLIC_PRIVATE_HEADERS });
    response.cookies.set(GITHUB_NONCE_COOKIE, result.browserNonce, githubNonceCookieOptions());
    return response;
  } catch (error) { return publicAuthErrorResponse(error); }
}, publicAuthErrorResponse);
