import { onPrimary } from "@/lib/db";
import {
  getPublicSession, publicAuthErrorResponse, PublicAuthError, PUBLIC_PRIVATE_HEADERS, readLoginJson, requirePublicAuthEnabled, requirePublicMutation,
} from "@/lib/domain/accounts/request-auth";
import { parseNotificationSettingsInput, readNotificationSettings, saveNotificationSettings } from "@/lib/me/notification-settings";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { rateLimit } from "@/lib/rate-limit";

/** 알림 설정(MY7) — 내 행만 읽고 쓴다. 행이 없으면 기본값을 돌려준다 */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    return Response.json(await readNotificationSettings(session.user.id), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}

/** 바꿀 칸만 보낸다 — { makerReply: "weekly" } 처럼. 칸마다 고를 수 있는 값은 EMAIL_SETTING_CHOICES */
export const PUT = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    if (!await onPrimary(() => rateLimit(`me-notification-settings:${user.id}`, 30, 60_000))) throw new PublicAuthError(429, "rate_limited");
    const input = parseNotificationSettingsInput(await readLoginJson(request));
    if (!input) throw new PublicAuthError(400, "invalid_request");
    return Response.json(await saveNotificationSettings(user.id, input), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}, publicAuthErrorResponse);
