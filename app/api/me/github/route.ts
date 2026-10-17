import { getPublicSession, publicAuthErrorResponse, PublicAuthError, PUBLIC_PRIVATE_HEADERS, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { requireGithubStarEnabled } from "@/lib/domain/github-user/config";
import { disconnectGithubUser, getGithubConnection } from "@/lib/domain/github-user/repository";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

export async function GET(request: Request) {
  try {
    requireGithubStarEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    return Response.json({ connection: await getGithubConnection(session.user.id) }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}
export const DELETE = webWriteRoute(async (request: Request) => {
  try {
    requireGithubStarEnabled();
    const user = await requirePublicMutation(request);
    await disconnectGithubUser(user.id);
    return Response.json({ ok: true }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}, publicAuthErrorResponse);
