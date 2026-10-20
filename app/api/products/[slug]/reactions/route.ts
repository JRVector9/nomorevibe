import { NextResponse } from "next/server";
import { PUBLIC_PRIVATE_HEADERS } from "@/lib/domain/accounts/request-auth";
import { isBotAgent, VISITOR_COOKIE, visitorCookieOptions } from "@/lib/domain/products/clicks";
import { isReactionSlug, ReactionError, readReactionJson, validateReactionWrite } from "@/lib/domain/reactions/contract";
import {
  enforceReactionLimits, reactionErrorResponse, reactionFencedResponse, reactionFlood, reactionRequester, requireReactionsEnabled,
} from "@/lib/domain/reactions/http";
import { deleteReaction, putReaction, readReaction } from "@/lib/domain/reactions/repository";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/**
 * 써봤어요 — 내 평가와 공개 요약(GET), 저장·바꾸기(PUT), 지우기(DELETE). 피드백 설계 5.2절.
 * 상세 HTML 은 엣지에 4분 남으므로 화면은 이 경로를 브라우저에서 따로 부른다. 응답은 모두 private, no-store.
 */

type Context = { params: Promise<{ slug: string }> };
const headers = PUBLIC_PRIVATE_HEADERS;

async function slugOf(context: Context): Promise<string> {
  const { slug } = await context.params;
  if (!isReactionSlug(slug)) throw new ReactionError("reaction_not_found", 404);
  return slug;
}

export async function GET(request: Request, context: Context) {
  try {
    requireReactionsEnabled();
    const slug = await slugOf(context);
    const requester = await reactionRequester(request, false);
    const result = await readReaction(slug, requester);
    // 로그인했으면 쓰기에 쓸 CSRF 값을 함께 준다 — /api/me 를 한 번 더 부르지 않게
    return Response.json({ ...result, signedIn: requester.userId !== null, csrfToken: requester.csrfToken }, { headers });
  } catch (error) {
    return reactionErrorResponse(error);
  }
}

export const PUT = webWriteRoute(async (request: Request, context: Context) => {
  try {
    requireReactionsEnabled();
    // 봇(링크 미리보기·크롤러)은 /go 처럼 세지 않는다
    if (isBotAgent(request.headers.get("user-agent"))) throw new ReactionError("reaction_refused", 403);
    const requester = await reactionRequester(request, true);
    const slug = await slugOf(context);
    const input = validateReactionWrite(await readReactionJson(request));
    if (input.trapped) {
      // 숨은 칸(봇 미끼)에 값이 있으면 성공처럼 답하고 버린다
      const mine = { verdict: input.verdict, tags: input.tags, comment: input.comment, commentState: input.comment ? "held" : null, triedVerified: false, updatedAt: new Date().toISOString() };
      return Response.json({ mine, summary: null }, { headers });
    }
    // 로그인하지 않았고 쿠키가 없으면 /go 와 같은 nmv_visitor 를 새로 준다
    const visitor = requester.visitor ?? (requester.userId ? null : crypto.randomUUID());
    await enforceReactionLimits(request, requester.userId, visitor);
    const result = await putReaction(slug, { userId: requester.userId, visitor }, input, { flood: await reactionFlood(slug) });
    const response = NextResponse.json(result, { headers });
    if (visitor && visitor !== requester.visitor) response.cookies.set(VISITOR_COOKIE, visitor, visitorCookieOptions);
    return response;
  } catch (error) {
    return reactionErrorResponse(error);
  }
}, reactionFencedResponse);

export const DELETE = webWriteRoute(async (request: Request, context: Context) => {
  try {
    requireReactionsEnabled();
    const requester = await reactionRequester(request, true);
    const slug = await slugOf(context);
    await enforceReactionLimits(request, requester.userId, requester.visitor);
    return Response.json(await deleteReaction(slug, requester), { headers });
  } catch (error) {
    return reactionErrorResponse(error);
  }
}, reactionFencedResponse);
