import { getFeedback, listProductFeedbackWithTotal } from "@/lib/domain/feedback/repository";
import { submitFeedback } from "@/lib/domain/feedback/submit";
import { FeedbackError, readFeedbackJson } from "@/lib/domain/feedback/contract";
import { PublicAuthError, publicAuthErrorResponse, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { productFeedbackEnabled } from "@/lib/domain/github-integration/flags";
import { WEB_FENCED_RETRY_AFTER, webWriteRoute } from "@/lib/operations/dr/web-gate";
import { trackServer } from "@/lib/analytics/server";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { publicFeedbackItem } from "@/lib/domain/feedback/public-view";

const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ slug: string }> };

/**
 * 공개 의견 목록 — 상세 화면(FeedbackList)이 브라우저에서 부른다. 화면이 그리는 것만 내보낸다:
 * 내부 제품 id·작성자 계정 id·제품 이름·전달 오류 코드는 공개 목록에 쓰이지 않는다(내 의견은 /api/me/feedback 이 따로 준다).
 */
export async function GET(request: Request, context: Context) {
  if (!productFeedbackEnabled()) return Response.json({ error: "feedback_disabled" }, { status: 404, headers });
  const refused = await guardPublicApiRead(request, "products.feedback.list");
  if (refused) return refused;
  const { slug } = await context.params;
  const { feedback, total } = await listProductFeedbackWithTotal(slug);
  return Response.json({ feedback: feedback.map(publicFeedbackItem), total }, { headers });
}

export const POST = webWriteRoute(async (request: Request, context: Context) => {
  if (!productFeedbackEnabled()) return Response.json({ error: "feedback_disabled" }, { status: 404, headers });
  try {
    const user = await requirePublicMutation(request);
    const input = await readFeedbackJson(request);
    const { slug } = await context.params;
    const result = await submitFeedback(slug, user.id, input);
    const feedback = await getFeedback(result.feedback.id, { userId: user.id });
    // 방문 분석(서버 사실): 새로 저장된 요청만 — 같은 요청의 재전송(replayed)은 세지 않는다. 제목·내용은 싣지 않는다
    if (!result.replayed) trackServer("feedback_received", { product_slug: slug, feedback_kind: result.feedback.kind }, { request, identity: "browser", userId: user.id });
    return Response.json({ feedback, replayed: result.replayed }, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    if (error instanceof PublicAuthError) return publicAuthErrorResponse(error);
    if (error instanceof FeedbackError) return Response.json({ error: error.code }, { status: error.status, headers });
    return Response.json({ error: "feedback_unavailable" }, { status: 503, headers });
  }
}, () => Response.json({ error: "feedback_unavailable" }, { status: 503, headers: { ...headers, "Retry-After": WEB_FENCED_RETRY_AFTER } }));
