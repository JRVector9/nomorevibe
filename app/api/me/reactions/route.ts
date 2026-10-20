import { getPublicSession, PUBLIC_PRIVATE_HEADERS, PublicAuthError } from "@/lib/domain/accounts/request-auth";
import { reactionErrorResponse, requireReactionsEnabled } from "@/lib/domain/reactions/http";
import { listUserReactions } from "@/lib/domain/reactions/repository";

/** 마이페이지 써봤어요 탭 — 내 계정의 평가(최근에 바꾼 순). 쓰기는 /api/products/{slug}/reactions 그대로 */
export async function GET(request: Request) {
  try {
    requireReactionsEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    return Response.json({ reactions: await listUserReactions(session.user.id) }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return reactionErrorResponse(error);
  }
}
