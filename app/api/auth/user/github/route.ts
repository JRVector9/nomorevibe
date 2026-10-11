import { NextResponse } from "next/server";
import { getPublicSession, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, readLoginJson, requireLoginMutation, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { GITHUB_NONCE_COOKIE, githubNonceCookieOptions, requireGithubStarEnabled, startGithubAuthorization } from "@/lib/domain/github-user/authorization";

export async function POST(request: Request) {
  try {
    requireGithubStarEnabled();
    const session = await getPublicSession(request);
    if (session) await requirePublicMutation(request);
    else requireLoginMutation(request);
    const input = await readLoginJson(request);
    const result = await startGithubAuthorization({ actorUserId: session?.user.id ?? null, consent: input.consent === true, returnTo: typeof input.returnTo === "string" ? input.returnTo : "/" });
    const response = NextResponse.json({ authorizeUrl: result.authorizeUrl }, { headers: PUBLIC_PRIVATE_HEADERS });
    response.cookies.set(GITHUB_NONCE_COOKIE, result.browserNonce, githubNonceCookieOptions());
    return response;
  } catch (error) { return publicAuthErrorResponse(error); }
}
