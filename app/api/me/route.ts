import { getPublicSession, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { getMeHeader } from "@/lib/me/summary";

/** 로그인 상태와 CSRF. view=header 는 머리(account-store)가 화면마다 함께 받는 값(getMeHeader)을 더한다 */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) return Response.json({ user: null, csrfToken: null }, { headers: PUBLIC_PRIVATE_HEADERS });
    // 더한 값을 못 읽어도 로그인 상태는 알린다(세션은 이미 확인했다)
    const header = new URL(request.url).searchParams.get("view") === "header" ? await getMeHeader(session.user.id).catch(() => null) : null;
    return Response.json({ ...session, ...header }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}
