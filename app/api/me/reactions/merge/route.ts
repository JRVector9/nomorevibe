import { PUBLIC_PRIVATE_HEADERS, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { parseReactionSlugs, REACTION_MERGE_BODY_BYTES, ReactionError, readReactionJson } from "@/lib/domain/reactions/contract";
import { reactionErrorResponse, reactionFencedResponse, requestVisitor, requireReactionsEnabled } from "@/lib/domain/reactions/http";
import { mergeBrowserReactions } from "@/lib/domain/reactions/repository";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { rateLimit } from "@/lib/rate-limit";

/**
 * 첫 로그인 합치기(L4 의 써봤어요 몫) — 이 브라우저가 평가한 slug 마다 이 쿠키의 익명 행을 계정에 붙인다.
 * 둘 다 있으면 나중에 바꾼 것을 남긴다. 로그인 세션 + Origin + CSRF. 한 번에 100개까지(몸통은 긴 slug 100개가 드는 10KB).
 */
export const POST = webWriteRoute(async (request: Request) => {
  try {
    requireReactionsEnabled();
    const user = await requirePublicMutation(request);
    const body = await readReactionJson(request, REACTION_MERGE_BODY_BYTES);
    const slugs = parseReactionSlugs((body as { slugs?: unknown } | null)?.slugs);
    if (!await rateLimit(`reaction-merge:user:${user.id}`, 30, 3_600_000)) throw new ReactionError("reaction_rate_limited", 429);
    const visitor = requestVisitor(request);
    return Response.json(visitor ? await mergeBrowserReactions(user.id, slugs, visitor) : { merged: 0 }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return reactionErrorResponse(error);
  }
}, reactionFencedResponse);
