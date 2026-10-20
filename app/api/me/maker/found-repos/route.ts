import { getPublicSession, PUBLIC_PRIVATE_HEADERS, PublicAuthError, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { findMyRepos, makerErrorResponse } from "@/lib/me/maker";

/** 내 저장소 찾기 — GitHub 이름이 같은 공개 제품 중 아직 확인하지 않은 것(내 프로젝트 탭의 «프로젝트 추가로 확인하기») */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    return Response.json(await findMyRepos(session.user.id), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return makerErrorResponse(error);
  }
}
