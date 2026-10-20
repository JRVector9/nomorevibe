import { PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, readLoginJson, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { markNotificationsRead, unreadNotificationCount } from "@/lib/me/notifications";
import { rateLimit } from "@/lib/rate-limit";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/** 읽음 표시 — { ids: number[] }(1~100개) 또는 { all: true }. 내 줄만 바뀐다 */
export const POST = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    if (!await rateLimit(`me-notifications-read:${user.id}`, 120, 60_000)) throw new PublicAuthError(429, "rate_limited");
    const body = await readLoginJson(request);
    const ids = body.ids;
    const target = body.all === true && ids === undefined ? { all: true as const }
      : Array.isArray(ids) && ids.length >= 1 && ids.length <= 100 && ids.every((id) => Number.isSafeInteger(id) && id > 0) && body.all === undefined
        ? { ids: [...new Set(ids as number[])] } : null;
    if (!target) throw new PublicAuthError(400, "invalid_request");
    const updated = await markNotificationsRead(user.id, target);
    return Response.json({ updated, unread: await unreadNotificationCount(user.id) }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}, publicAuthErrorResponse);
