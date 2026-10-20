import { PUBLIC_PRIVATE_HEADERS, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { rateLimit } from "@/lib/rate-limit";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { MakerError } from "@/lib/me/maker-claims";
import { makerErrorResponse, makerFencedResponse, parseReplyInput, readMakerJson, upsertMakerReply } from "@/lib/me/maker";

/** 메이커 답장 쓰기·고치기 — {targetType, targetId, body}. 그 제품의 운영자만(아니면 403), 로그인·Origin·CSRF·시간당 60번 */
export const PUT = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    const input = parseReplyInput(await readMakerJson(request, 16_384));
    if (!(await rateLimit(`maker:reply:user:${user.id}`, 60, 60 * 60_000))) throw new MakerError("rate_limited", 429);
    const reply = await upsertMakerReply(user.id, input);
    return Response.json({ reply }, { status: reply.created ? 201 : 200, headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return makerErrorResponse(error);
  }
}, makerFencedResponse);
