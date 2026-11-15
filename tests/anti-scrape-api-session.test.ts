import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), rate: vi.fn(), cards: vi.fn(), details: vi.fn(), readme: vi.fn(), write: vi.fn() }));
// The session POST upserts rate_limits, so it runs inside the DR write gate; unit tests pass through it without a DB.
vi.mock("@/lib/operations/dr/web-gate", async original => ({ ...await original<typeof import("@/lib/operations/dr/web-gate")>(), runWebWrite: mocks.write }));
vi.mock("@/lib/anti-scrape/control", () => ({ publicApiMode: mocks.mode }));
vi.mock("@/lib/rate-limit", async original => ({ ...await original<typeof import("@/lib/rate-limit")>(), rateLimitWindow: mocks.rate }));
vi.mock("@/lib/domain/products/star-growth", () => ({ getStarGrowthPage: mocks.cards }));
vi.mock("@/lib/domain/products/detail-view", () => ({ getProductDetail: mocks.details, getProductIdentity: mocks.readme }));
import { issueSession, readSession, SESSION_COOKIE, sessionConfig, sessionIpHash } from "@/lib/anti-scrape/session";
import { verifyTurnstile } from "@/lib/anti-scrape/turnstile";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { GET, POST } from "@/app/api/session/route";
import { GET as cardsGet } from "@/app/api/product-cards/route";
import { GET as detailsGet } from "@/app/api/products/[slug]/details/route";
import { GET as readmeGet } from "@/app/api/products/[slug]/readme/route";
import { resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
const SITE = "1x00000000000000000000AA";
const SECRET = "1x0000000000000000000000000000000AA";
const SIGNING = "unit-test-session-signing-key-not-an-operational-key";
function request(path = "/api/product-cards?slugs=a,b", cookie?: string, extra: RequestInit = {}) {
  return new Request(`https://nomorevibe.test${path}`, { ...extra, headers: {
    "user-agent": "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36", "x-forwarded-for": "198.51.100.10", origin: "https://nomorevibe.test",
    ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}), ...Object.fromEntries(new Headers(extra.headers)),
  } });
}
function sessionPost(body: string) { return request("/api/session", undefined, { method: "POST", body, headers: { "content-type": "application/json" } }); }
const ctx = { params: Promise.resolve({ slug: "test" }) };
beforeEach(() => {
  vi.stubEnv("TURNSTILE_SITE_KEY", SITE); vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET); vi.stubEnv("PUBLIC_API_SESSION_SECRET", SIGNING);
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1"); vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  mocks.mode.mockReset().mockResolvedValue("enforce");
  mocks.rate.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 120 });
  mocks.cards.mockReset().mockResolvedValue({ items: [] }); mocks.details.mockReset(); mocks.readme.mockReset();
  mocks.write.mockReset().mockImplementation((load: () => Promise<unknown>) => load());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("서명 세션", () => {
  it("30분 유효, /24 안은 허용하고 위조·만료·다른 IP·키 교체는 거절", () => {
    const now = Date.now(), issued = issueSession(request(), SIGNING, now);
    expect(readSession(request(undefined, issued.value), SIGNING, now)).toMatchObject({ id: issued.session.id, exp: Math.floor(now / 1000) + 1800 });
    expect(readSession(request(undefined, issued.value, { headers: { "x-forwarded-for": "198.51.100.99" } }), SIGNING, now)).not.toBeNull();
    expect(readSession(request(undefined, issued.value, { headers: { "x-forwarded-for": "198.51.101.1" } }), SIGNING, now)).toBeNull();
    expect(readSession(request(undefined, issued.value + "x"), SIGNING, now)).toBeNull();
    expect(readSession(request(undefined, issued.value), SIGNING, now + 1800_000)).toBeNull();
    expect(readSession(request(undefined, issued.value), "other-key", now)).toBeNull();
    expect(readSession(request(undefined, "malformed"), SIGNING)).toBeNull();
  });
  it("IPv6 표현을 정규화하고 신뢰하지 않는 CF 헤더는 쓰지 않는다", () => {
    const hash = (ip: string) => sessionIpHash(request(undefined, undefined, { headers: { "x-forwarded-for": ip } }), SIGNING);
    expect(hash("2001:4860:0:1::1")).toBe(hash("2001:4860:0000:0001:0:0:0:abcd"));
    expect(hash("2001:4860:0:2::1")).not.toBe(hash("2001:4860:0:1::1"));
    expect(hash("::ffff:8.8.8.8")).toBe(hash("8.8.8.8"));
    expect(hash("::ffff:808:808")).toBe(hash("8.8.8.8"));
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(hash("8.8.8.8")).toBe(hash("1.1.1.1"));
  });
});
describe("Turnstile 서버 검증", () => {
  it("공식 공개 시험 키 성공/실패, 중복, 네트워크 실패를 처리", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "localhost" }));
    expect(await verifyTurnstile("XXXX.DUMMY.TOKEN.XXXX", SECRET, request(), fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://challenges.cloudflare.com/turnstile/v0/siteverify", expect.objectContaining({ method: "POST", cache: "no-store", redirect: "error" }));
    fetcher.mockResolvedValue(Response.json({ success: false, "error-codes": ["invalid-input-response"] }));
    expect(await verifyTurnstile("XXXX.DUMMY.TOKEN.XXXX", "2x0000000000000000000000000000000AA", request(), fetcher)).toBe(false);
    fetcher.mockResolvedValue(Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    expect(await verifyTurnstile("XXXX.DUMMY.TOKEN.XXXX", SECRET, request(), fetcher)).toBe(false);
    fetcher.mockRejectedValue(new Error("network"));
    expect(await verifyTurnstile("token", SECRET, request(), fetcher)).toBe(false);
    expect(await verifyTurnstile("x".repeat(2049), SECRET, request(), fetcher)).toBe(false);
  });
  it("실제 배포 경계는 정식 주소 hostname·action 일치를 요구하며 production 시험 키는 거절", async () => {
    // Canonical hostname comes from NEXT_PUBLIC_SITE_URL (tests/anti-scrape-api-turnstile-hostname.test.ts covers proxy hosts).
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.test");
    // Mock-only placeholder, never sent to Cloudflare.
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "wrong.test", action: "api-session" }));
    expect(await verifyTurnstile("token", "mock-only-secret", request(), fetcher)).toBe(false);
    fetcher.mockResolvedValue(Response.json({ success: true, hostname: "nomorevibe.test", action: "wrong" }));
    expect(await verifyTurnstile("token", "mock-only-secret", request(), fetcher)).toBe(false);
    fetcher.mockResolvedValue(Response.json({ success: true, hostname: "nomorevibe.test", action: "api-session" }));
    expect(await verifyTurnstile("token", "mock-only-secret", request(), fetcher)).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(await verifyTurnstile("token", SECRET, request(), fetcher)).toBe(false);
  });
});
describe("세션 발급 HTTP", () => {
  it("runtime sitekey만 공개, 성공은 httpOnly Strict 쿠키, 실패는 쿠키 없음", async () => {
    const config = await GET(request("/api/session"), ctx);
    expect(await config.json()).toEqual({ enabled: true, siteKey: SITE, mode: "enforce", expiresAt: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "localhost" })));
    const ok = await POST(sessionPost('{"token":"XXXX.DUMMY.TOKEN.XXXX"}'), ctx);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly"); expect(ok.headers.get("set-cookie")).toContain("SameSite=strict");
    expect(ok.headers.get("set-cookie")).toContain("Path=/api"); expect(ok.headers.get("cache-control")).toContain("no-store");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: false })));
    const failed = await POST(sessionPost('{"token":"XXXX.DUMMY.TOKEN.XXXX"}'), ctx);
    expect(failed.status).toBe(401); expect(failed.headers.has("set-cookie")).toBe(false);
    // POST is a DB write (per-IP issue limit), so it goes through the write gate; GET does not.
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });
  it("fenced DB면 발급 전에 503 — 속도 제한 행도 쓰지 않고 쿠키도 없다", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "localhost" }));
    vi.stubGlobal("fetch", fetcher);
    mocks.write.mockRejectedValue(new DrWriterFencedError("site_fenced"));
    const response = await POST(sessionPost('{"token":"XXXX.DUMMY.TOKEN.XXXX"}'), ctx);
    expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(mocks.rate).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("같은 세션 갱신은 id와 한도 유지", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "localhost" })));
    const old = issueSession(request(), SIGNING);
    const response = await POST(request("/api/session", old.value, { method: "POST", body: '{"token":"XXXX.DUMMY.TOKEN.XXXX"}' }), ctx);
    const value = response.headers.get("set-cookie")!.split(";")[0].slice(SESSION_COOKIE.length + 1);
    expect(readSession(request(undefined, value), SIGNING)?.id).toBe(old.session.id);
  });
  it("다른 출처·큰 본문·잘못된 JSON·발급 과다 거절", async () => {
    expect((await POST(request("/api/session", undefined, { method: "POST", headers: { origin: "https://other.test" } }), ctx)).status).toBe(403);
    expect((await POST(sessionPost("x".repeat(4097)), ctx)).status).toBe(413);
    expect((await POST(sessionPost("{"), ctx)).status).toBe(400);
    mocks.rate.mockImplementation(async (key: string) => ({ allowed: !key.startsWith("api-session-issue:"), count: 11, retryAfterSeconds: 88 }));
    const response = await POST(sessionPost('{"token":"t"}'), ctx);
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("88");
  });
});
describe("API 앞단 및 기존 차단 순서", () => {
  it.each(["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "PUBLIC_API_SESSION_SECRET"])("%s 없으면 기존 API 그대로·설정 DB 안 읽음", async name => {
    vi.stubEnv(name, ""); expect(sessionConfig()).toBeNull();
    expect(await guardPublicApiRead(request(), "products.cards")).toBeNull();
    expect(mocks.mode).not.toHaveBeenCalled();
    expect(await (await GET(request("/api/session"), ctx)).json()).toEqual({ enabled: false });
  });
  it("기록 모드는 세션 누락과 한도 초과를 기록만 한다", async () => {
    mocks.mode.mockResolvedValue("observe");
    expect(await guardPublicApiRead(request(), "products.cards")).toBeNull();
    mocks.rate.mockImplementation(async (key: string) => ({ allowed: !key.startsWith("api-session:"), count: 601, retryAfterSeconds: 123 }));
    expect(await guardPublicApiRead(request(undefined, issueSession(request(), SIGNING).value), "products.cards")).toBeNull();
    expect(resolveRuntimeSettings({}).settings.publicApi.mode).toBe("observe");
    expect(resolveRuntimeSettings({ publicApi: { mode: "enforce" } })).toMatchObject({ issues: [], settings: { publicApi: { mode: "enforce" } } });
    expect(resolveRuntimeSettings({ publicApi: { mode: "invalid" } }).issues).toContain("runtime_settings_invalid:publicApi.mode");
  });
  it("카드·상세·README는 세션 없으면 DB 본문 읽기 전에 401", async () => {
    for (const [get, path] of [[cardsGet, "/api/product-cards?list=rising"], [detailsGet, "/api/products/test/details"], [readmeGet, "/api/products/test/readme"]] as const) {
      const response = await get(request(path), ctx);
      expect(response.status).toBe(401); expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    }
    expect(mocks.cards).not.toHaveBeenCalled(); expect(mocks.details).not.toHaveBeenCalled(); expect(mocks.readme).not.toHaveBeenCalled();
    expect((await cardsGet(request("/api/product-cards?list=rising", issueSession(request(), SIGNING).value), ctx)).status).toBe(200);
  });
  it("위조·만료는 401, 정상 세션은 통과하며 카드 비용과 상세 한도를 공유 DB에서 센다", async () => {
    const valid = issueSession(request(), SIGNING), expired = issueSession(request(), SIGNING, Date.now() - 1800_000);
    for (const value of [valid.value + "x", expired.value]) expect((await guardPublicApiRead(request(undefined, value), "products.cards"))?.status).toBe(401);
    expect(await guardPublicApiRead(request(undefined, valid.value), "products.cards")).toBeNull();
    expect(mocks.rate).toHaveBeenCalledWith(`api-session:cards:${valid.session.id}`, 600, 600_000, 2);
    expect(await guardPublicApiRead(request(undefined, valid.value), "products.details")).toBeNull();
    expect(mocks.rate).toHaveBeenCalledWith(`api-session:detail:${valid.session.id}`, 60, 600_000, 1);
    expect(await guardPublicApiRead(request(undefined, valid.value), "products.summaries")).toBeNull();
    expect(mocks.rate).toHaveBeenCalledWith(`api-session:cards:${valid.session.id}`, 600, 600_000, 100);
    mocks.rate.mockImplementation(async (key: string) => ({ allowed: !key.startsWith("api-session:"), count: 601, retryAfterSeconds: 123 }));
    const limited = await guardPublicApiRead(request(undefined, valid.value), "products.cards");
    expect(limited?.status).toBe(429); expect(limited?.headers.get("retry-after")).toBe("123");
  });
  it("봇·cross-site·IP 차단은 세션보다 먼저, 검색은 세션 대상 아님", async () => {
    expect((await guardPublicApiRead(request(undefined, undefined, { headers: { "user-agent": "curl/8" } }), "products.cards"))?.status).toBe(403);
    expect((await guardPublicApiRead(request(undefined, undefined, { headers: { "sec-fetch-site": "cross-site" } }), "products.cards"))?.status).toBe(403);
    mocks.rate.mockResolvedValue({ allowed: false, count: 301, retryAfterSeconds: 42 });
    expect((await guardPublicApiRead(request(), "products.cards"))?.status).toBe(429);
    expect(mocks.mode).not.toHaveBeenCalled();
  });
  it("차단 모드 설정/한도 저장소 실패는 503", async () => {
    mocks.mode.mockRejectedValue(new Error("db"));
    expect((await guardPublicApiRead(request(), "products.cards"))?.status).toBe(503);
    mocks.mode.mockResolvedValue("enforce");
    mocks.rate.mockImplementation(async (key: string) => { if (key.startsWith("api-session:")) throw new Error("db"); return { allowed: true }; });
    expect((await guardPublicApiRead(request(undefined, issueSession(request(), SIGNING).value), "products.cards"))?.status).toBe(503);
  });
});
