import { getPublicSession, PUBLIC_PRIVATE_HEADERS, PublicAuthError, publicAuthErrorResponse, readLoginJson, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { requireGithubStarEnabled } from "@/lib/domain/github-user/config";
import { getGithubStarStatus, writeGithubStar } from "@/lib/domain/github-stars/service";
import { StarProviderRateLimit, StarWriteFailure } from "@/lib/domain/github-stars/contract";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

type Context = { params: Promise<{ slug: string }> };
function errorResponse(error: unknown): Response {
  if (error instanceof StarWriteFailure || error instanceof StarProviderRateLimit) {
    const retryAt = error instanceof StarWriteFailure ? error.view.retryAt : error.retryAt;
    return Response.json({ error: error.code, ...(error instanceof StarWriteFailure ? { star: error.view } : {}), ...(retryAt ? { retryAt } : {}) }, { status: error.status, headers: { ...PUBLIC_PRIVATE_HEADERS, ...(retryAt ? { "Retry-After": String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))) } : {}) } });
  }
  return publicAuthErrorResponse(error);
}
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    requireGithubStarEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    return Response.json(await getGithubStarStatus((await context.params).slug, session.user.id), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}
export const PUT = webWriteRoute(async (request: Request, context: Context): Promise<Response> => {
  try {
    requireGithubStarEnabled();
    const user = await requirePublicMutation(request);
    return Response.json(await writeGithubStar((await context.params).slug, user.id, await readLoginJson(request)), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}, errorResponse);
