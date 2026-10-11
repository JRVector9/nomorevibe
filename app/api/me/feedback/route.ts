import { getPublicSession, PublicAuthError, publicAuthErrorResponse } from "@/lib/domain/accounts/request-auth";
import { listMyFeedback } from "@/lib/domain/feedback/repository";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const session = await getPublicSession(request);
    if (!session) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const slug = new URL(request.url).searchParams.get("slug");
    const feedback = slug === null ? await listMyFeedback(session.user.id) : await listMyFeedback(session.user.id, slug);
    return Response.json({ feedback }, { headers });
  } catch (error) {
    if (error instanceof PublicAuthError) return publicAuthErrorResponse(error);
    return Response.json({ error: "feedback_unavailable" }, { status: 503, headers });
  }
}
