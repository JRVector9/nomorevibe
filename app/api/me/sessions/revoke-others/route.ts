import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requestCookie, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { hashSessionToken, PUBLIC_SESSION_COOKIE } from "@/lib/domain/accounts/session";
import { revokeOtherSessions } from "@/lib/me/account";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/** 지금 기기만 남기고 모두 로그아웃 */
export const POST = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    const result = await revokeOtherSessions(user.id, hashSessionToken(requestCookie(request, PUBLIC_SESSION_COOKIE)!));
    return Response.json({ ok: true, revoked: result.revoked }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
