import { getFeedback, listProductFeedbackWithTotal } from "@/lib/domain/feedback/repository";
import { submitFeedback } from "@/lib/domain/feedback/submit";
import { FeedbackError, readFeedbackJson } from "@/lib/domain/feedback/contract";
import { PublicAuthError, publicAuthErrorResponse, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { productFeedbackEnabled } from "@/lib/domain/github-integration/flags";
import { WEB_FENCED_RETRY_AFTER, webWriteRoute } from "@/lib/operations/dr/web-gate";

const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ slug: string }> };

export async function GET(_request: Request, context: Context) {
  if (!productFeedbackEnabled()) return Response.json({ error: "feedback_disabled" }, { status: 404, headers });
  const { slug } = await context.params;
  return Response.json(await listProductFeedbackWithTotal(slug), { headers });
}

export const POST = webWriteRoute(async (request: Request, context: Context) => {
  if (!productFeedbackEnabled()) return Response.json({ error: "feedback_disabled" }, { status: 404, headers });
  try {
    const user = await requirePublicMutation(request);
    const input = await readFeedbackJson(request);
    const { slug } = await context.params;
    const result = await submitFeedback(slug, user.id, input);
    const feedback = await getFeedback(result.feedback.id, { userId: user.id });
    return Response.json({ feedback, replayed: result.replayed }, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    if (error instanceof PublicAuthError) return publicAuthErrorResponse(error);
    if (error instanceof FeedbackError) return Response.json({ error: error.code }, { status: error.status, headers });
    return Response.json({ error: "feedback_unavailable" }, { status: 503, headers });
  }
}, () => Response.json({ error: "feedback_unavailable" }, { status: 503, headers: { ...headers, "Retry-After": WEB_FENCED_RETRY_AFTER } }));
