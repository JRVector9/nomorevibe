import { getPublicSession, PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requestCookie, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { hashSessionToken, PUBLIC_SESSION_COOKIE } from "@/lib/domain/accounts/session";
import { listSessions } from "@/lib/me/account";

/** 로그인된 기기 목록 — 토큰 해시 대신 앞 16자 id 만 */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    const sessions = await listSessions(session.user.id, hashSessionToken(requestCookie(request, PUBLIC_SESSION_COOKIE)!));
    return Response.json({ sessions }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}
