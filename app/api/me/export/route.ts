import { getPublicSession, PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { exportAccount } from "@/lib/me/account";

/** 내 데이터 받기 — JSON 파일 하나로 내려받는다. 하루 2번(429 export_rate_limited) */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    const data = await exportAccount(session.user.id);
    const day = data.exportedAt.slice(0, 10).replaceAll("-", "");
    return new Response(JSON.stringify(data, null, 2), { headers: { ...PUBLIC_PRIVATE_HEADERS, "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="nomorevibe-my-data-${day}.json"`, "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}
