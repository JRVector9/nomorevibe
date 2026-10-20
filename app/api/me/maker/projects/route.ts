import { getPublicSession, PUBLIC_PRIVATE_HEADERS, PublicAuthError, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { makerErrorResponse, makerProjects, makerPendingReplies } from "@/lib/me/maker";

/** 확인한 프로젝트와 숫자, 답장 기다림 수 — 화면은 서버에서 그리고, 이 경로는 같은 값을 JSON 으로 준다 */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    const [projects, waiting] = await Promise.all([makerProjects(session.user.id), makerPendingReplies(session.user.id)]);
    return Response.json({ projects, waiting }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return makerErrorResponse(error);
  }
}
