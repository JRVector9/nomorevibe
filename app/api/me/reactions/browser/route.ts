import { PUBLIC_PRIVATE_HEADERS } from "@/lib/domain/accounts/request-auth";
import { parseReactionSlugs } from "@/lib/domain/reactions/contract";
import { reactionErrorResponse, requestVisitor, requireReactionsEnabled } from "@/lib/domain/reactions/http";
import { listBrowserReactions } from "@/lib/domain/reactions/repository";

/**
 * 로그아웃 상태의 써봤어요 목록 — 이 브라우저가 기억한 slug(localStorage nmb-reacted-v1)마다 이 쿠키의 해시를 다시 만들어
 * 맞는 익명 행만 돌려준다. 해시가 제품마다 달라 slug 없이는 아무것도 찾을 수 없다(Q4). 한 번에 100개까지.
 */
export async function GET(request: Request) {
  try {
    requireReactionsEnabled();
    const visitor = requestVisitor(request);
    const slugs = parseReactionSlugs(new URL(request.url).searchParams.get("slugs"));
    return Response.json({ reactions: visitor ? await listBrowserReactions(slugs, visitor) : [] }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return reactionErrorResponse(error);
  }
}
