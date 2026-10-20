import { getPublicSession, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { getMeSummary } from "@/lib/me/summary";

/** 마이페이지 머리·아바타 메뉴가 한 번에 받는 값. 로그아웃이면 /api/me 처럼 user: null */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) return Response.json({ user: null, csrfToken: null, counts: null, isMaker: false, providers: [] }, { headers: PUBLIC_PRIVATE_HEADERS });
    // 숫자를 못 읽어도 머리는 로그인 상태로 둔다(세션은 이미 확인했다)
    const summary = await getMeSummary(session.user.id).catch(() => undefined);
    if (summary === null) return Response.json({ user: null, csrfToken: null, counts: null, isMaker: false, providers: [] }, { headers: PUBLIC_PRIVATE_HEADERS });
    return Response.json(summary ? { ...summary, csrfToken: session.csrfToken }
      : { user: { ...session.user, createdAt: null }, counts: null, isMaker: false, providers: [], csrfToken: session.csrfToken }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}
