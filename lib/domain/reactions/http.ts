import "server-only";
import { getPublicSession, PUBLIC_PRIVATE_HEADERS, PublicAuthError, publicAuthErrorResponse, requestCookie, requirePublicOrigin } from "@/lib/domain/accounts/request-auth";
import { matchesSecretHash } from "@/lib/domain/accounts/session";
import { VISITOR_COOKIE, visitorId } from "@/lib/domain/products/clicks";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { WEB_FENCED_RETRY_AFTER } from "@/lib/operations/dr/web-gate";
import { logger } from "@/lib/observability/logger";
import { productVisitorHash } from "@/lib/domain/products/visitors";
import { rateLimit, trustedClientIp } from "@/lib/rate-limit";
import { ReactionError } from "./contract";
import { productReactionsEnabled } from "./flags";
import { reactionRateKey } from "./repository";

/** 써봤어요 route 공용 — 누가 보냈나(계정·이 브라우저)와 오류 응답. 응답은 모두 private, no-store */

export type ReactionRequester = { userId: number | null; csrfToken: string | null; visitor: string | null };

export function requireReactionsEnabled(): void {
  if (!productReactionsEnabled()) throw new ReactionError("reactions_disabled", 404);
}

/** nmv_visitor 원문 — /go 와 같은 모양만 받는다. 쿠키 원문은 해시를 만들 때만 쓰고 저장하지 않는다 */
export function requestVisitor(request: Request): string | null {
  const value = requestCookie(request, VISITOR_COOKIE);
  return value && visitorId(value) === value ? value : null;
}

/**
 * 쓰기는 Origin 을 본다(익명도 — requirePublicOrigin 과 같은 규칙). 로그인 세션이 있으면 그 계정으로 쓰고 x-csrf-token 도 맞아야 한다.
 * 로그인 기능이 꺼져 있으면 세션을 읽지 않는다(getPublicSession 이 null).
 */
export async function reactionRequester(request: Request, mutation: boolean): Promise<ReactionRequester> {
  if (mutation) requirePublicOrigin(request);
  const session = await getPublicSession(request);
  if (session && mutation && !matchesSecretHash(session.csrfToken, request.headers.get("x-csrf-token") ?? "")) {
    throw new PublicAuthError(403, "invalid_csrf");
  }
  return { userId: session?.user.id ?? null, csrfToken: session?.csrfToken ?? null, visitor: requestVisitor(request) };
}

const HOUR_MS = 3_600_000;

/**
 * 쓰기 한도(피드백 설계 4.2) — 계정 또는 이 브라우저 시간당 30, 신뢰할 수 있는 IP 가 있으면 IP 묶음 시간당 60.
 * 쿠키를 지우고 다시 오는 연타는 IP 묶음이 막는다. IP 는 해시로만 rate_limits 열쇠에 남는다.
 */
export async function enforceReactionLimits(request: Request, userId: number | null, visitor: string | null): Promise<void> {
  const visitorKey = visitor ? reactionRateKey(visitor) : null;
  const owner = userId ? `user:${userId}` : visitorKey ? `visitor:${visitorKey}` : null;
  if (owner && !await rateLimit(`reaction:${owner}`, 30, HOUR_MS)) throw new ReactionError("reaction_rate_limited", 429);
  const ip = trustedClientIp(request);
  const ipKey = ip ? productVisitorHash("ip:", ip) : null;
  if (ipKey && !await rateLimit(`reaction:ip:${ipKey}`, 60, HOUR_MS)) throw new ReactionError("reaction_rate_limited", 429);
}

/** 제품 하나에 들어오는 신호가 시간당 120 을 넘으면 받기는 하되 랭킹·공개 요약에서 뺀다 */
export async function reactionFlood(slug: string): Promise<boolean> {
  return !await rateLimit(`reaction:product:${slug}`, 120, HOUR_MS);
}

export function reactionErrorResponse(error: unknown): Response {
  if (error instanceof ReactionError) return Response.json({ error: error.code }, { status: error.status, headers: PUBLIC_PRIVATE_HEADERS });
  if (error instanceof PublicAuthError || error instanceof DrWriterFencedError) return publicAuthErrorResponse(error);
  logger.warn("reaction.unavailable", { error });
  return Response.json({ error: "reaction_unavailable" }, { status: 503, headers: PUBLIC_PRIVATE_HEADERS });
}

export function reactionFencedResponse(): Response {
  return Response.json({ error: "reaction_unavailable" }, { status: 503, headers: { ...PUBLIC_PRIVATE_HEADERS, "Retry-After": WEB_FENCED_RETRY_AFTER } });
}
