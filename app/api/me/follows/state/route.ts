import { getPublicSession, PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { followState } from "@/lib/me/follows";

/** 상세·분야 화면의 팔로 단추가 묻는다 — ?product=<id>&maker=<login>&category=<slug>. 화면은 엣지에 저장되므로 여기서 따로 읽는다 */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    const params = new URL(request.url).searchParams;
    const state = await followState(session.user.id, {
      product: params.get("product") ?? undefined, maker: params.get("maker") ?? undefined, category: params.get("category") ?? undefined,
    });
    return Response.json(state, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}
