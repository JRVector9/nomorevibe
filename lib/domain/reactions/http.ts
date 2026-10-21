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
 * IP 한도의 묶음 — IPv6 는 /64(한 회선이 보통 /64 하나를 통째로 받아 주소를 마음대로 바꾼다), IPv4·IPv4 사상 주소는 그대로.
 * 모양을 알 수 없으면 받은 글자 그대로
 */
export function ipBucket(ip: string): string {
  const value = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!value.includes(":")) return value;
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1];
  const halves = value.split("::");
  if (halves.length > 2 || !/^[0-9a-f:]+$/.test(value)) return value;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * 쓰기 한도(피드백 설계 4.2) — 계정 또는 이 브라우저 시간당 30, 신뢰할 수 있는 IP 가 있으면 IP 묶음(IPv6 는 /64) 시간당 60.
 * 쿠키를 지우고 다시 오는 연타는 IP 묶음이 막는다. IP 는 해시로만 rate_limits 열쇠에 남는다.
 * 신뢰할 IP 가 없을 때의 익명 연타는 제품마다 새 익명 줄 한도(putReaction untrustedIp)가 랭킹에서 뺀다.
 * 제품 하나의 변경 급증(시간당 120)은 putReaction 이 실제로 바뀐 쓰기만 세어 랭킹에서 뺀다.
 * 이 브라우저 목록 읽기(browser)는 같은 모양에 따로 센다 — 한 번에 slug 100개의 해시를 만들고 주 DB 를 읽는다.
 */
const LIMITS = { write: { prefix: "reaction", owner: 30, ip: 60 }, browser: { prefix: "reaction-browser", owner: 300, ip: 1_200 } } as const;

export async function enforceReactionLimits(request: Request, userId: number | null, visitor: string | null, kind: keyof typeof LIMITS = "write"): Promise<void> {
  const limits = LIMITS[kind];
  const visitorKey = visitor ? reactionRateKey(visitor) : null;
  const owner = userId ? `user:${userId}` : visitorKey ? `visitor:${visitorKey}` : null;
  if (owner && !await rateLimit(`${limits.prefix}:${owner}`, limits.owner, HOUR_MS)) throw new ReactionError("reaction_rate_limited", 429);
  const ip = trustedClientIp(request);
  const ipKey = ip ? productVisitorHash("ip:", ipBucket(ip)) : null;
  if (ipKey && !await rateLimit(`${limits.prefix}:ip:${ipKey}`, limits.ip, HOUR_MS)) throw new ReactionError("reaction_rate_limited", 429);
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
