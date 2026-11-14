import { onPrimary } from "@/lib/db";
import { blockRateLimitKey, publicClientIp, rateLimitWindow } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";
import { agentKind, refusedApiAgent } from "./agents";
import { verifiedSearchBot } from "./search-bot-verify";

/**
 * 외부 수집 방지 — 엣지(Cloudflare)에 담기지 않는 공개 API 읽기와 검색 경로를 지킨다.
 *
 * 공개 화면은 Cloudflare 가 담아 두므로 화면의 속도 제한은 Cloudflare 몫이다. 여기서 막는 것:
 *  1. 수집 도구·학습 봇·이름 없는 요청의 공개 API 읽기(403)
 *  2. 다른 사이트의 브라우저 요청(Sec-Fetch-Site: cross-site, 403) — 이 머리가 없는 오래된 브라우저는 그대로 받는다
 *  3. IP 별 읽기 한도(429 + Retry-After) — 함정 경로를 부른 IP 는 같은 키로 한동안 막힌다
 * IP 를 모르면(신뢰 프록시 설정 전·사설 주소) 한도를 걸지 않는다 — 모두가 한 통을 나눠 서로를 막는다.
 * 확인된 검색 봇(역방향 DNS)은 한도를 넘어도 받는다. 이름만 댄 봇은 보통 방문자와 같다.
 */

/** 공개 API 읽기 — IP 하나가 10분에 300번(평균 분당 30). 상세 한 번에 피드백·반응 두 번을 부른다 */
export const API_READ_LIMIT = 300;
export const API_READ_WINDOW_MS = 10 * 60_000;
/** 검색(?q=, 엣지에 담기지 않는다) — IP 하나가 10분에 60번 */
export const SEARCH_LIMIT = 60;
export const SEARCH_WINDOW_MS = 10 * 60_000;
/** 함정 경로를 부른 IP 의 API 읽기 차단 시간 */
export const TRAP_BLOCK_MS = 60 * 60_000;

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

export const apiReadKey = (ip: string) => `api-read:${ip}`;
export const searchKey = (ip: string) => `search:${ip}`;

type GuardRequest = Pick<Request, "headers">;

function refused(): Response {
  return Response.json({
    error: "automated_client_refused",
    message: "자동 수집 도구로 보이는 요청은 받지 않습니다. nomorevibe 스킬을 쓴다면 최신판(/skill.md)으로 바꿔 주세요.",
  }, { status: 403, headers: NO_STORE });
}

export function tooManyReads(retryAfterSeconds: number): Response {
  return Response.json({ error: "rate_limited" }, {
    status: 429,
    headers: { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

/**
 * 공개 API 읽기 관문. 받으면 null, 아니면 그대로 돌려줄 응답.
 * DB 가 잠시 안 되면 막지 않는다 — 읽기 한도는 부가물이고 화면이 먼저다.
 */
export async function guardPublicApiRead(request: GuardRequest, route: string): Promise<Response | null> {
  const userAgent = request.headers.get("user-agent");
  if (refusedApiAgent(userAgent)) {
    logger.info("anti_scrape.agent_refused", { route, agent: agentKind(userAgent) });
    return refused();
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    logger.info("anti_scrape.cross_site_refused", { route });
    return refused();
  }
  return limitByIp(request, route, apiReadKey, API_READ_LIMIT, API_READ_WINDOW_MS);
}

/** 검색 경로 한도 — 화면이라 UA 로 거절하지 않는다(검색·답변 봇은 화면을 본다) */
export async function guardSearch(request: GuardRequest): Promise<Response | null> {
  const response = await limitByIp(request, "search", searchKey, SEARCH_LIMIT, SEARCH_WINDOW_MS);
  if (!response) return null;
  const retryAfter = response.headers.get("Retry-After") ?? "60";
  return new Response("Too many searches. Please try again later.\n", {
    status: 429,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8", "Retry-After": retryAfter },
  });
}

async function limitByIp(
  request: GuardRequest, route: string, keyOf: (ip: string) => string, limit: number, windowMs: number,
): Promise<Response | null> {
  const ip = publicClientIp(request);
  if (!ip) return null;
  let result;
  try {
    result = await onPrimary(() => rateLimitWindow(keyOf(ip), limit, windowMs));
  } catch (error) {
    logger.warn("anti_scrape.limit_unavailable", { route, error });
    return null;
  }
  if (result.allowed) return null;
  if (await verifiedSearchBot(request.headers.get("user-agent"), ip)) return null;
  // 한 창에 한 번만 남긴다 — 넘친 요청마다 쓰면 로그가 수집 속도로 는다
  if (result.count === limit + 1) logger.info("anti_scrape.rate_limited", { route, limit });
  return tooManyReads(result.retryAfterSeconds);
}

/**
 * 함정 경로를 부른 요청 — 그 IP 의 공개 API 읽기를 TRAP_BLOCK_MS 동안 막는다.
 * 확인된 검색 봇은 robots.txt 의 /api/ Disallow 를 지키므로 여기 오지 않는다. 그래도 왔다면 막지 않는다.
 */
export async function recordTrapHit(request: GuardRequest): Promise<"blocked" | "unidentified" | "verified-bot" | "unavailable"> {
  const ip = publicClientIp(request);
  if (!ip) return "unidentified";
  if (await verifiedSearchBot(request.headers.get("user-agent"), ip)) return "verified-bot";
  try {
    await onPrimary(() => blockRateLimitKey(apiReadKey(ip), TRAP_BLOCK_MS));
  } catch (error) {
    logger.warn("anti_scrape.trap_unavailable", { error });
    return "unavailable";
  }
  logger.info("anti_scrape.trap_hit", { agent: agentKind(request.headers.get("user-agent")) });
  return "blocked";
}
