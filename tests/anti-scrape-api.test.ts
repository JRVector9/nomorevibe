import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NextRequest } from "next/server";
import { common } from "@/messages/ko/common";

/**
 * 외부 수집 방지 2단계 B — API·IP·속도 제한과 함정 경로(2026-11-14).
 * DB 는 부르지 않는다: 한도 표(rateLimitWindow·blockRateLimitKey)만 바꿔 끼우고 IP 판정은 진짜 함수를 쓴다.
 * 실제 DB 의 창·차단 계산은 tests/integration/anti-scrape-api-limits.test.ts 가 본다.
 */
const mocks = vi.hoisted(() => ({
  rateLimitWindow: vi.fn(),
  blockRateLimitKey: vi.fn(),
  findBySlug: vi.fn(),
  listFeedback: vi.fn(),
  readReaction: vi.fn(),
}));

vi.mock("@/lib/rate-limit", async (original) => ({
  ...await original<typeof import("@/lib/rate-limit")>(),
  rateLimitWindow: mocks.rateLimitWindow,
  blockRateLimitKey: mocks.blockRateLimitKey,
}));
vi.mock("@/lib/domain/products/repository", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/repository")>(),
  findBySlug: mocks.findBySlug,
}));
vi.mock("@/lib/domain/feedback/repository", () => ({
  listProductFeedbackWithTotal: mocks.listFeedback, getFeedback: vi.fn(),
}));
vi.mock("@/lib/domain/github-integration/flags", async (original) => ({
  ...await original<typeof import("@/lib/domain/github-integration/flags")>(),
  productFeedbackEnabled: () => true,
}));
vi.mock("@/lib/domain/reactions/repository", () => ({
  readReaction: mocks.readReaction, putReaction: vi.fn(), deleteReaction: vi.fn(),
}));
vi.mock("@/lib/domain/reactions/http", async (original) => ({
  ...await original<typeof import("@/lib/domain/reactions/http")>(),
  requireReactionsEnabled: () => undefined,
  reactionRequester: async () => ({ userId: null, csrfToken: null, visitor: "11111111-2222-3333-4444-555555555555" }),
}));

const { agentKind, refusedApiAgent } = await import("@/lib/http/agents");
const { clientIp, publicClientIp, trustedClientIp, isPrivateAddress } = await import("@/lib/rate-limit");
const antiScrape = await import("@/lib/http/anti-scrape");
const { setSearchBotResolverForTest, verifiedSearchBot } = await import("@/lib/http/search-bot-verify");
const productRoute = await import("@/app/api/products/[slug]/route");
const feedbackRoute = await import("@/app/api/products/[slug]/feedback/route");
const reactionsRoute = await import("@/app/api/products/[slug]/reactions/route");
const trapRoute = await import("@/app/api/catalog/[[...path]]/route");
const { SiteFooter, TRAP_PATH } = await import("@/components/home/SiteFooter");

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA = {
  curl: "curl/8.7.1",
  requests: "python-requests/2.32.3",
  scrapy: "Scrapy/2.11.2 (+https://scrapy.org)",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  claudebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  ccbot: "CCBot/2.0 (https://commoncrawl.org/faq/)",
  bytespider: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  headless: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
} as const;
const SEARCH_AGENTS = [
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
  UA.googlebot,
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)",
  "Mozilla/5.0 (compatible; Daum/4.1; +http://cs.daum.net/faq/15/4118.html?faqId=28966)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
  "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
];

const PUBLIC_IP = "198.51.100.23";

function request(path: string, init: { ua?: string | null; ip?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  const ua = init.ua === undefined ? BROWSER : init.ua;
  if (ua !== null) headers.set("user-agent", ua);
  if (init.ip !== null) headers.set("x-forwarded-for", init.ip ?? PUBLIC_IP);
  return new Request(`https://nomorevibe.test${path}`, { headers });
}

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  mocks.rateLimitWindow.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 600 });
  mocks.blockRateLimitKey.mockReset().mockResolvedValue(undefined);
  mocks.findBySlug.mockReset();
  mocks.listFeedback.mockReset();
  mocks.readReaction.mockReset();
  setSearchBotResolverForTest({ reverse: async () => { throw new Error("no rdns"); }, lookup: async () => [] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  setSearchBotResolverForTest(null);
});

describe("클라이언트 IP — 신뢰 프록시 홉과 CF-Connecting-IP", () => {
  const headers = (values: Record<string, string>) => ({ headers: new Headers(values) });

  it("TRUSTED_PROXY_HOPS=0(기본)이면 머리를 믿지 않는다 — CF-Connecting-IP 도", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    vi.stubEnv("TRUST_CF_CONNECTING_IP", "1");
    const req = headers({ "x-forwarded-for": "10.0.0.2", "cf-connecting-ip": PUBLIC_IP });
    expect(clientIp(req)).toBe("direct");
    expect(trustedClientIp(req)).toBeNull();
    expect(publicClientIp(req)).toBeNull();
  });

  it("Tunnel 경유(우리 프록시가 본 피어가 사설 주소)면 CF-Connecting-IP 를 쓴다", () => {
    vi.stubEnv("TRUST_CF_CONNECTING_IP", "1");
    expect(clientIp(headers({ "x-forwarded-for": "172.18.0.1", "cf-connecting-ip": PUBLIC_IP }))).toBe(PUBLIC_IP);
    expect(clientIp(headers({ "x-forwarded-for": "127.0.0.1", "cf-connecting-ip": "2001:db8::7" }))).toBe("2001:db8::7");
    // Traefik 이 앞 체인을 남겨 둔 경우에도 hop 으로 고른 피어만 본다
    expect(publicClientIp(headers({ "x-forwarded-for": "6.6.6.6, 192.168.65.1", "cf-connecting-ip": PUBLIC_IP }))).toBe(PUBLIC_IP);
  });

  it("공인 주소에서 바로 들어와 CF-Connecting-IP 를 꾸미면 무시한다(위조 방지)", () => {
    vi.stubEnv("TRUST_CF_CONNECTING_IP", "1");
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.50", "cf-connecting-ip": "1.2.3.4" }))).toBe("203.0.113.50");
  });

  it("TRUST_CF_CONNECTING_IP 가 꺼져 있거나 값이 IP 가 아니면 쓰지 않는다", () => {
    expect(clientIp(headers({ "x-forwarded-for": "172.18.0.1", "cf-connecting-ip": PUBLIC_IP }))).toBe("172.18.0.1");
    vi.stubEnv("TRUST_CF_CONNECTING_IP", "1");
    expect(clientIp(headers({ "x-forwarded-for": "172.18.0.1", "cf-connecting-ip": "evil, 1.2.3.4" }))).toBe("172.18.0.1");
  });

  it("사설 주소로만 판정되면 공개 IP 가 없다 — 모두가 한 통을 나눠 막히지 않게", () => {
    expect(publicClientIp(headers({ "x-forwarded-for": "172.18.0.1" }))).toBeNull();
    expect(publicClientIp(headers({ "x-forwarded-for": PUBLIC_IP }))).toBe(PUBLIC_IP);
    for (const ip of ["10.1.2.3", "127.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "::1", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "203.0.113.9", "2001:db8::1", "not-an-ip"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("User-Agent 분류", () => {
  it("대표 실측 10종 중 가짜 Googlebot 을 뺀 9종은 공개 API 에서 거절한다", () => {
    expect(agentKind(UA.curl)).toBe("tool");
    expect(agentKind(UA.requests)).toBe("tool");
    expect(agentKind(UA.scrapy)).toBe("tool");
    expect(agentKind(UA.headless)).toBe("tool");
    for (const ua of [UA.gptbot, UA.claudebot, UA.ccbot, UA.bytespider]) expect(agentKind(ua), ua).toBe("training");
    expect(agentKind(null)).toBe("missing");
    expect(agentKind("   ")).toBe("missing");
    for (const ua of [UA.curl, UA.requests, UA.scrapy, UA.headless, UA.gptbot, UA.claudebot, UA.ccbot, UA.bytespider, "", null]) {
      expect(refusedApiAgent(ua), String(ua)).toBe(true);
    }
    // Googlebot 이름은 거절하지 않지만 그 이름만으로 한도를 면하지도 않는다(아래 한도 시험)
    expect(refusedApiAgent(UA.googlebot)).toBe(false);
  });

  it("검색·답변용 봇과 브라우저는 거절하지 않는다", () => {
    for (const ua of SEARCH_AGENTS) {
      expect(agentKind(ua), ua).toBe("search");
      expect(refusedApiAgent(ua), ua).toBe(false);
    }
    expect(agentKind(BROWSER)).toBe("other");
    expect(agentKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toBe("other");
    expect(agentKind("nomorevibe-skill/1")).toBe("skill");
    expect(refusedApiAgent("nomorevibe-skill/1")).toBe(false);
  });
});

describe("공개 API 읽기 관문", () => {
  it("거절할 UA 는 DB 를 부르기 전에 403", async () => {
    const response = await antiScrape.guardPublicApiRead(request("/api/products/x", { ua: UA.curl }), "test");
    expect(response?.status).toBe(403);
    expect(await response!.json()).toMatchObject({ error: "automated_client_refused" });
    expect(response!.headers.get("cache-control")).toContain("no-store");
    expect(mocks.rateLimitWindow).not.toHaveBeenCalled();
  });

  it("다른 사이트의 브라우저 요청(Sec-Fetch-Site: cross-site)은 403, 같은 사이트·머리 없음은 받는다", async () => {
    expect((await antiScrape.guardPublicApiRead(request("/api/x", { headers: { "sec-fetch-site": "cross-site" } }), "test"))?.status).toBe(403);
    expect(await antiScrape.guardPublicApiRead(request("/api/x", { headers: { "sec-fetch-site": "same-origin" } }), "test")).toBeNull();
    expect(await antiScrape.guardPublicApiRead(request("/api/x"), "test")).toBeNull();
  });

  it("IP 별 한 통(api-read:<ip>)을 300/10분으로 센다", async () => {
    expect(await antiScrape.guardPublicApiRead(request("/api/x"), "test")).toBeNull();
    expect(mocks.rateLimitWindow).toHaveBeenCalledWith(`api-read:${PUBLIC_IP}`, 300, 10 * 60_000);
  });

  it("한도를 넘으면 429 와 Retry-After", async () => {
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 301, retryAfterSeconds: 412 });
    const response = await antiScrape.guardPublicApiRead(request("/api/x"), "test");
    expect(response?.status).toBe(429);
    expect(response!.headers.get("retry-after")).toBe("412");
    expect(await response!.json()).toEqual({ error: "rate_limited" });
  });

  it("IP 를 모르면(신뢰 프록시 없음·사설 주소) 한도를 걸지 않는다", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(await antiScrape.guardPublicApiRead(request("/api/x"), "test")).toBeNull();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(await antiScrape.guardPublicApiRead(request("/api/x", { ip: "172.18.0.1" }), "test")).toBeNull();
    expect(mocks.rateLimitWindow).not.toHaveBeenCalled();
  });

  it("한도 표가 잠시 안 되면 막지 않는다", async () => {
    mocks.rateLimitWindow.mockRejectedValue(new Error("db down"));
    expect(await antiScrape.guardPublicApiRead(request("/api/x"), "test")).toBeNull();
  });

  it("가짜 Googlebot 은 이름만으로 한도를 면하지 않고, 역방향·정방향 DNS 로 확인된 Googlebot 만 면한다", async () => {
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 400, retryAfterSeconds: 30 });
    expect((await antiScrape.guardPublicApiRead(request("/api/x", { ua: UA.googlebot }), "test"))?.status).toBe(429);

    setSearchBotResolverForTest({
      reverse: async (ip) => ip === "66.249.66.1" ? ["crawl-66-249-66-1.googlebot.com"] : ["evil.example.com"],
      lookup: async (host) => host === "crawl-66-249-66-1.googlebot.com" ? ["66.249.66.1"] : [],
    });
    expect(await antiScrape.guardPublicApiRead(request("/api/x", { ua: UA.googlebot, ip: "66.249.66.1" }), "test")).toBeNull();
    expect((await antiScrape.guardPublicApiRead(request("/api/x", { ua: UA.googlebot, ip: "203.0.113.77" }), "test"))?.status).toBe(429);
    // 브라우저 이름으로 온 같은 IP 는 확인 대상이 아니다
    expect((await antiScrape.guardPublicApiRead(request("/api/x", { ip: "66.249.66.1" }), "test"))?.status).toBe(429);
  });

  it("역방향 이름이 도메인으로 끝나도 정방향이 다른 IP 면 확인되지 않는다(googlebot.com.evil 같은 이름 포함)", async () => {
    setSearchBotResolverForTest({
      reverse: async () => ["crawl.googlebot.com", "googlebot.com.evil.example"],
      lookup: async () => ["66.249.66.99"],
    });
    expect(await verifiedSearchBot(UA.googlebot, "203.0.113.5")).toBe(false);
    setSearchBotResolverForTest({ reverse: async () => ["googlebot.com.evil.example"], lookup: async () => ["203.0.113.5"] });
    expect(await verifiedSearchBot(UA.googlebot, "203.0.113.5")).toBe(false);
  });

  it("GCP VM 역방향 이름(*.bc.googleusercontent.com)은 정방향이 맞아도 확인된 Googlebot 이 아니다", async () => {
    const ip = "34.64.10.20";
    const name = "20.10.64.34.bc.googleusercontent.com";
    setSearchBotResolverForTest({
      reverse: async (value) => value === ip ? [name] : [],
      lookup: async (host) => host === name ? [ip] : [],
    });
    expect(await verifiedSearchBot(UA.googlebot, ip)).toBe(false);
    expect(await verifiedSearchBot("Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)", ip)).toBe(false);
    // 사용자가 시킨 가져오기용 이름(gae.googleusercontent.com)도 Googlebot 이름으로는 받지 않는다
    setSearchBotResolverForTest({ reverse: async () => ["1-2-3-4.gae.googleusercontent.com"], lookup: async () => [ip] });
    expect(await verifiedSearchBot(UA.googlebot, ip)).toBe(false);

    // 읽기 한도와 함정 차단도 그대로 받는다
    setSearchBotResolverForTest({
      reverse: async (value) => value === ip ? [name] : [],
      lookup: async (host) => host === name ? [ip] : [],
    });
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 400, retryAfterSeconds: 30 });
    expect((await antiScrape.guardPublicApiRead(request("/api/x", { ua: UA.googlebot, ip }), "test"))?.status).toBe(429);
  });

  it("진짜 googlebot.com·google.com 역방향 이름은 정방향이 같은 IP 면 여전히 확인된다", async () => {
    const hosts: Record<string, string> = {
      "66.249.66.1": "crawl-66-249-66-1.googlebot.com",
      "66.249.90.77": "geo-crawl-66-249-90-77.geo.googlebot.com",
      "66.249.80.5": "rate-limited-proxy-66-249-80-5.google.com",
    };
    setSearchBotResolverForTest({
      reverse: async (value) => hosts[value] ? [hosts[value]] : [],
      lookup: async (host) => Object.entries(hosts).filter(([, name]) => name === host).map(([value]) => value),
    });
    for (const ip of Object.keys(hosts)) expect(await verifiedSearchBot(UA.googlebot, ip), ip).toBe(true);
  });
});

describe("공개 제품 JSON API 응답 항목", () => {
  const product = {
    id: 4242, slug: "found-app", url: "https://found-app.test", name: "FoundApp", tagline: "수집된 소개",
    description: "긴 설명", category: "Other", builder: "claude-code", stack: ["next"], ogImage: null, makerName: "maker",
    repoUrl: "https://github.com/someone/found-app", status: "seeded", source: "crawler", claimedAt: null,
    verifyMethod: null, verifiedAt: null, createdAt: new Date(), updatedAt: new Date(), verifyToken: "nmv_verify_found-app",
    editTokenHash: "x".repeat(64), claimInvitedAt: new Date(),
  };

  it("익명 응답은 스킬 클레임 확인에 필요한 항목만 — 내부 id 등은 없다", async () => {
    mocks.findBySlug.mockResolvedValue({ ...product, status: "verified", source: "skill", verifiedAt: new Date() });
    const response = await productRoute.GET(request("/api/products/found-app"), params("found-app") as never);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["category", "name", "slug", "status", "tagline", "url"]);
    for (const hidden of ["id", "description", "builder", "stack", "makerName", "repoUrl", "source", "verifyToken", "editTokenHash", "claimInvitedAt", "createdAt", "updatedAt"]) {
      expect(body, hidden).not.toHaveProperty(hidden);
    }
  });

  it("주인 없는 제품은 claimable·verify 를 함께 준다(스킬 클레임 흐름)", async () => {
    mocks.findBySlug.mockResolvedValue(product);
    const response = await productRoute.GET(request("/api/products/found-app", { ua: "nomorevibe-skill/1" }), params("found-app") as never);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.claimable).toBe(true);
    expect(body.verify).toBeTruthy();
    expect(body).not.toHaveProperty("id");
  });

  it("이름 없는 curl 은 403 이고 제품을 읽지 않는다", async () => {
    const response = await productRoute.GET(request("/api/products/found-app", { ua: UA.curl }), params("found-app") as never);
    expect(response.status).toBe(403);
    expect(mocks.findBySlug).not.toHaveBeenCalled();
  });

  it("공개 의견 목록은 화면이 그리는 항목만 — 내부 제품 id·작성자 계정 id·오류 코드는 없다", async () => {
    mocks.listFeedback.mockResolvedValue({ total: 1, feedback: [{
      id: "0f0e0d0c-0b0a-4908-8706-050403020100", productId: 4242, slug: "found-app", productName: "FoundApp", authorUserId: 77,
      authorDisplayName: "jr", kind: "bug", title: "제목", body: "본문", reviewState: "accepted", reviewReason: null,
      deliveryState: "delivered", createdAt: "2026-11-14T00:00:00.000Z", githubIssueUrl: "https://github.com/a/b/issues/1",
      externalIssueState: "open", lastErrorCode: "github_rate_limited",
    }] });
    const response = await feedbackRoute.GET(request("/api/products/found-app/feedback"), params("found-app"));
    expect(response.status).toBe(200);
    const body = await response.json() as { total: number; feedback: Record<string, unknown>[] };
    expect(body.total).toBe(1);
    expect(Object.keys(body.feedback[0]).sort()).toEqual(["authorDisplayName", "body", "createdAt", "deliveryState", "externalIssueState",
      "githubIssueUrl", "id", "kind", "reviewReason", "reviewState", "title"]);
    expect((await feedbackRoute.GET(request("/api/products/found-app/feedback", { ua: UA.requests }), params("found-app"))).status).toBe(403);
  });

  it("반응 읽기도 같은 관문 — 학습 봇 403, 브라우저 200", async () => {
    mocks.readReaction.mockResolvedValue({ mine: null, summary: { tried: 1, good: 1, meh: 0, bad: 0 } });
    expect((await reactionsRoute.GET(request("/api/products/found-app/reactions", { ua: UA.gptbot }), params("found-app"))).status).toBe(403);
    expect(mocks.readReaction).not.toHaveBeenCalled();
    const ok = await reactionsRoute.GET(request("/api/products/found-app/reactions"), params("found-app"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ summary: { tried: 1 }, signedIn: false });
  });

  it("연속 요청이 한도를 넘으면 제품 API 가 429 와 Retry-After 를 준다", async () => {
    mocks.findBySlug.mockResolvedValue({ ...product, status: "verified" });
    let count = 0;
    mocks.rateLimitWindow.mockImplementation(async () => { count += 1; return { allowed: count <= 300, count, retryAfterSeconds: 540 }; });
    const statuses: number[] = [];
    for (let index = 0; index < 302; index += 1) statuses.push((await productRoute.GET(request("/api/products/found-app"), params("found-app") as never)).status);
    expect(statuses.slice(0, 300).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(300)).toEqual([429, 429]);
    const limited = await productRoute.GET(request("/api/products/found-app"), params("found-app") as never);
    expect(limited.headers.get("retry-after")).toBe("540");
  });
});

describe("함정 경로", () => {
  it("부른 IP 의 공개 API 읽기를 한 시간 막고, 평범한 404 를 담지 않게 준다", async () => {
    const response = await trapRoute.GET(request(TRAP_PATH, { ua: BROWSER }));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(mocks.blockRateLimitKey).toHaveBeenCalledWith(`api-read:${PUBLIC_IP}`, 60 * 60_000);
  });

  it("막힌 IP 의 다음 API 읽기는 429(같은 키가 한도 밖)", async () => {
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 1_000_000_001, retryAfterSeconds: 3599 });
    const response = await antiScrape.guardPublicApiRead(request("/api/products/x"), "test");
    expect(response?.status).toBe(429);
    expect(response!.headers.get("retry-after")).toBe("3599");
  });

  it("IP 를 모르면 아무도 막지 않는다 — 사설 주소 하나로 모두가 막히지 않게", async () => {
    await trapRoute.GET(request(TRAP_PATH, { ip: "172.18.0.1" }));
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    await trapRoute.GET(request(TRAP_PATH));
    expect(mocks.blockRateLimitKey).not.toHaveBeenCalled();
  });

  it("확인된 검색 봇은 막지 않는다", async () => {
    setSearchBotResolverForTest({ reverse: async () => ["crawl-66-249-66-1.googlebot.com"], lookup: async () => ["66.249.66.1"] });
    expect(await antiScrape.recordTrapHit(request(TRAP_PATH, { ua: UA.googlebot, ip: "66.249.66.1" }))).toBe("verified-bot");
    expect(mocks.blockRateLimitKey).not.toHaveBeenCalled();
  });

  it("공통 바닥글에 사람 눈·보조 기술에 안 보이는 함정 링크가 /api/ 아래로 걸린다", () => {
    const props: Parameters<typeof SiteFooter>[0] = { locale: "ko", messages: common, children: null };
    const html = renderToStaticMarkup(createElement(SiteFooter, props));
    expect(TRAP_PATH.startsWith("/api/")).toBe(true);
    const link = html.match(/<a [^>]*data-nmv-trap[^>]*>/)?.[0] ?? "";
    expect(link).toContain(`href="${TRAP_PATH}"`);
    expect(link).toContain('aria-hidden="true"');
    expect(link).toContain('tabindex="-1"');
    expect(link).toContain('rel="nofollow"');
    expect(link).toContain("left:-10000px");
  });
});

describe("검색 경로 한도(proxy)", () => {
  it("?q= 공개 화면 요청은 IP 별 검색 한도를 넘으면 429 와 Retry-After, 엣지에 담지 않는다", async () => {
    const { proxy } = await import("@/proxy");
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 61, retryAfterSeconds: 120 });
    const response = await proxy(new NextRequest("https://nomorevibe.test/?q=agent", { headers: { "user-agent": BROWSER, "x-forwarded-for": PUBLIC_IP } }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(mocks.rateLimitWindow).toHaveBeenCalledWith(`search:${PUBLIC_IP}`, 60, 10 * 60_000);
  });

  it("검색이 아닌 화면·API·빈 q 는 검색 한도를 부르지 않는다", async () => {
    const { proxy } = await import("@/proxy");
    for (const url of ["https://nomorevibe.test/", "https://nomorevibe.test/?q=%20", "https://nomorevibe.test/api/products/x?q=a", "https://nomorevibe.test/p/x"]) {
      await proxy(new NextRequest(url, { headers: { "user-agent": BROWSER, "x-forwarded-for": PUBLIC_IP } }));
    }
    expect(mocks.rateLimitWindow).not.toHaveBeenCalled();
  });

  it("검색 봇은 검색 화면에서도 UA 로 거절하지 않는다(한도 안이면 통과)", async () => {
    const { proxy } = await import("@/proxy");
    const response = await proxy(new NextRequest("https://nomorevibe.test/?q=agent", { headers: { "user-agent": SEARCH_AGENTS[0], "x-forwarded-for": PUBLIC_IP } }));
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(429);
  });
});
