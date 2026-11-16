import { eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { runtimeSettings } from "@/lib/db/operations-schema";
import { resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { logger } from "@/lib/observability/logger";
import { publicClientIp, RATE_LIMIT_BLOCKED_COUNT, type RateLimitResult } from "@/lib/rate-limit";
import { agentKind } from "./agents";
import { CRAWL_BURST_DEFAULTS, crawlBlockedResponse, crawlBurstKey, type CrawlBurstSettings } from "./crawl-burst-policy";
import { verifiedSearchBot } from "./search-bot-verify";

/**
 * 과다 호출 차단(2026-11-16 사람 지시 「크롤링 봇 초당 호출이 너무 많으면 30분 제한하고 크롤링 금지·법적 조치 안내」).
 *
 * 같은 공인 IP 의 공개 화면(proxy.ts) + 공개 API 읽기(guardPublicApiRead)를 한 통(`burst:<ip>`, rate_limits 표)에 센다.
 * 창(기본 10초) 안에 기준 수(기본 50)를 넘으면 그 키를 차단 시간(기본 30분) 동안 한도 밖으로 만든다(blockRateLimitKey 와 같은 방식 —
 * 따로 차단 표를 두지 않고 count 를 크게 올린다. 그래서 막힌 동안에도 한 문장으로 남은 시간을 안다). 기준 수·창·차단 시간은
 * runtime_settings 의 publicApi.burst* 이고 30초마다 다시 읽는다.
 *
 * - 면제는 역방향 DNS 로 확인된 검색 봇뿐이다(기존 규칙). 이름(UA)만 댄 봇은 보통 방문자와 같다.
 * - IP 를 모르면(신뢰 프록시 설정 전·사설 주소) 세지 않는다 — 모두가 한 통을 나눠 서로를 막는다.
 * - 한도 표나 설정 행이 잠시 안 되면 막지 않는다 — 화면이 먼저다.
 * - 차단은 서버 로그 `anti_scrape.burst_blocked` 한 줄(차단마다 한 번, 풀리는 시각 포함)로 남는다. 지금 막힌 IP 수와 수동 해제는
 *   scripts/crawl-burst.ts(해제는 operations_audit `crawl-burst-release`).
 */

export type CrawlBurstStore = {
  settings(): Promise<CrawlBurstSettings>;
  /** 창 갱신과 증가를 한 문장에서 — rateLimitWindow 와 같은 의미 */
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  /** 키를 지금부터 durationMs 동안 한도 밖으로(이미 더 길면 줄이지 않는다) */
  block(key: string, durationMs: number): Promise<void>;
};

const SETTINGS_TTL_MS = 30_000;
let settingsCache: { at: number; value: CrawlBurstSettings } | null = null;
let settingsLoading: Promise<CrawlBurstSettings> | null = null;

async function loadSettings(): Promise<CrawlBurstSettings> {
  try {
    const [row] = await onPrimary(() => db.select({ values: runtimeSettings.values }).from(runtimeSettings).where(eq(runtimeSettings.id, 1)));
    const { burstLimit, burstWindowSeconds, burstBlockSeconds } = resolveRuntimeSettings(row?.values ?? {}).settings.publicApi;
    return { burstLimit, burstWindowSeconds, burstBlockSeconds };
  } catch (error) {
    logger.warn("anti_scrape.burst_settings_unavailable", { error });
    return settingsCache?.value ?? { ...CRAWL_BURST_DEFAULTS };
  }
}

async function cachedSettings(): Promise<CrawlBurstSettings> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  settingsLoading ??= loadSettings().then((value) => {
    settingsCache = { at: Date.now(), value };
    return value;
  }).finally(() => { settingsLoading = null; });
  return settingsLoading;
}

/**
 * rateLimitWindow(lib/rate-limit.ts)와 같은 문장이지만 따로 둔다. 공개 API 단위 시험들이 rateLimitWindow 를 바꿔 끼워
 * api-read 한도(예: count 301)를 흉내 내는데, 같은 함수를 쓰면 그 흉내가 과다 호출 차단으로 읽혀 다른 응답이 나간다.
 */
async function hitInDb(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const window = sql.raw(`interval '${Math.max(1, Math.round(windowMs / 1000))} seconds'`);
  const [row] = await db.insert(rateLimits)
    .values({ key, count: 1, resetAt: sql`now() + ${window}` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        // 막힌 동안(count ≥ RATE_LIMIT_BLOCKED_COUNT)에는 더 올리지 않는다 — integer 열이 넘치지 않게
        count: sql`case when ${rateLimits.resetAt} < now() then 1 when ${rateLimits.count} >= ${RATE_LIMIT_BLOCKED_COUNT} then ${rateLimits.count} else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${rateLimits.resetAt} < now() then now() + ${window} else ${rateLimits.resetAt} end`,
      },
    })
    .returning({
      count: rateLimits.count,
      retryAfter: sql<number>`greatest(1, ceil(extract(epoch from (${rateLimits.resetAt} - now()))))::int`,
    });
  const count = row?.count ?? 1;
  return { allowed: count <= limit, count, retryAfterSeconds: Math.max(1, Number(row?.retryAfter ?? 1)) };
}

async function blockInDb(key: string, durationMs: number): Promise<void> {
  const window = sql.raw(`interval '${Math.max(1, Math.round(durationMs / 1000))} seconds'`);
  await db.insert(rateLimits)
    .values({ key, count: RATE_LIMIT_BLOCKED_COUNT, resetAt: sql`now() + ${window}` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: { count: sql`${RATE_LIMIT_BLOCKED_COUNT}`, resetAt: sql`greatest(${rateLimits.resetAt}, now() + ${window})` },
    });
}

const dbStore: CrawlBurstStore = {
  settings: cachedSettings,
  hit: (key, limit, windowMs) => onPrimary(() => hitInDb(key, limit, windowMs)),
  block: (key, durationMs) => onPrimary(() => blockInDb(key, durationMs)),
};
let store: CrawlBurstStore = dbStore;

/** 시험이 한도 표·설정을 바꿔 끼운다(null 이면 DB 로 되돌리고 설정 캐시를 비운다) */
export function setCrawlBurstStoreForTest(next: CrawlBurstStore | null): void {
  store = next ?? dbStore;
  settingsCache = null;
  settingsLoading = null;
}

type GuardRequest = Pick<Request, "headers"> & { method?: string; url?: string; nextUrl?: { pathname: string } };

/**
 * 세는 요청 하나를 센다. 받으면 null, 막혔으면 그대로 돌려줄 429 응답.
 * kind: "page" = 공개 화면(짧은 HTML), "api" = 공개 API 읽기(JSON).
 */
export async function guardCrawlBurst(request: GuardRequest, kind: "page" | "api", route: string): Promise<Response | null> {
  const ip = publicClientIp(request);
  if (!ip) return null;
  let settings: CrawlBurstSettings;
  let result: RateLimitResult;
  try {
    settings = await store.settings();
    if (settings.burstLimit <= 0) return null;
    result = await store.hit(crawlBurstKey(ip), settings.burstLimit, settings.burstWindowSeconds * 1000);
  } catch (error) {
    logger.warn("anti_scrape.burst_unavailable", { route, error });
    return null;
  }
  if (result.allowed) return null;
  const pathname = request.nextUrl?.pathname ?? (request.url ? new URL(request.url).pathname : "/");
  const respond = (retryAfterSeconds: number) => crawlBlockedResponse({ kind, retryAfterSeconds, method: request.method, pathname });
  // 이미 막힌 IP — 남은 차단 시간이 Retry-After
  if (result.count >= RATE_LIMIT_BLOCKED_COUNT) return respond(result.retryAfterSeconds);
  const userAgent = request.headers.get("user-agent");
  if (await verifiedSearchBot(userAgent, ip)) return null;
  try {
    await store.block(crawlBurstKey(ip), settings.burstBlockSeconds * 1000);
  } catch (error) {
    logger.warn("anti_scrape.burst_block_unavailable", { route, error });
  }
  // 차단마다 한 줄 — 창에서 처음 넘친 요청만 남긴다(동시에 넘친 요청들이 같은 차단을 다시 써도 줄은 하나)
  if (result.count === settings.burstLimit + 1) {
    logger.info("anti_scrape.burst_blocked", {
      route, kind, agent: agentKind(userAgent), limit: settings.burstLimit, windowSeconds: settings.burstWindowSeconds,
      blockSeconds: settings.burstBlockSeconds, releaseAt: new Date(Date.now() + settings.burstBlockSeconds * 1000).toISOString(),
    });
  }
  return respond(settings.burstBlockSeconds);
}
