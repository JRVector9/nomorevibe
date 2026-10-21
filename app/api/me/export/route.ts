import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { exportAccount } from "@/lib/me/account";
import { exportFileName } from "@/lib/me/profile";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/**
 * 내 데이터 받기 — JSON 파일 하나로 내려받는다. 하루 2번(429 export_rate_limited).
 * 한도를 rate_limits 에 쓰므로 POST + Origin + CSRF 다 — GET 이면 다른 사이트의 이동 한 번이 그날 한도를 써 버린다.
 */
export const POST = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    const data = await exportAccount(user.id);
    return new Response(JSON.stringify(data, null, 2), { headers: { ...PUBLIC_PRIVATE_HEADERS, "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(data.exportedAt)}"`, "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
