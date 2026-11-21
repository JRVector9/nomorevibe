import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
const mocks = vi.hoisted(() => ({ mode: vi.fn(), rate: vi.fn(), write: vi.fn() }));
// The session POST is a write route (rate_limits upsert); pass through the DR write gate without a DB.
vi.mock("@/lib/operations/dr/web-gate", async original => ({ ...await original<typeof import("@/lib/operations/dr/web-gate")>(), runWebWrite: mocks.write }));
vi.mock("@/lib/anti-scrape/control", () => ({ publicApiMode: mocks.mode }));
vi.mock("@/lib/rate-limit", async original => ({ ...await original<typeof import("@/lib/rate-limit")>(), rateLimitWindow: mocks.rate }));
import { SESSION_COOKIE } from "@/lib/anti-scrape/session";
import { canonicalSiteHostname, verifyTurnstile } from "@/lib/anti-scrape/turnstile";
import { logger } from "@/lib/observability/logger";
import { POST } from "@/app/api/session/route";

/**
 * Production requests reach Next through Cloudflare→Traefik, so request.url carries the internal bind host
 * (http://web:3000). Turnstile's hostname must be compared with the canonical NEXT_PUBLIC_SITE_URL instead.
 */
const INTERNAL = "http://web:3000";
const SITE_URL = "https://nomorevibe.com";
const SITE_KEY = "1x00000000000000000000AA"; // Cloudflare official always-pass test sitekey
// Mock-only placeholder (not a Cloudflare key, never sent anywhere: fetch is stubbed). Official test secrets skip hostname checks.
const PLACEHOLDER_SECRET = "mock-only-placeholder-secret";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX"; // Cloudflare documented dummy token
const SIGNING = "unit-test-session-signing-key-not-an-operational-key";
const ctx = { params: Promise.resolve({}) };
function internalRequest(path = "/api/session", init: RequestInit = {}) {
  return new Request(`${INTERNAL}${path}`, { ...init, headers: {
    "user-agent": "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36", "x-forwarded-for": "198.51.100.10", origin: SITE_URL,
    "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)),
  } });
}
const siteverify = (hostname: unknown) => vi.fn().mockResolvedValue(Response.json({ success: true, hostname, action: "api-session" }));
let info: MockInstance<typeof logger.info>, warn: MockInstance<typeof logger.warn>;
const logged = () => JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
const mismatches = () => info.mock.calls.filter(([event]) => event === "anti_scrape.turnstile_hostname_mismatch").map(([, fields]) => fields);
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE_URL);
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1"); vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  mocks.mode.mockReset().mockResolvedValue("enforce");
  mocks.rate.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 60 });
  mocks.write.mockReset().mockImplementation((load: () => Promise<unknown>) => load());
  info = vi.spyOn(logger, "info"); warn = vi.spyOn(logger, "warn");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Turnstile hostname은 정식 사이트 주소와 비교", () => {
  it("정식 hostname은 NEXT_PUBLIC_SITE_URL에서만 얻고 요청 주소로 대신하지 않는다", () => {
    expect(canonicalSiteHostname()).toBe("nomorevibe.com");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://NomoreVibe.com/");
    expect(canonicalSiteHostname()).toBe("nomorevibe.com");
    for (const value of ["", "not a url", "ftp://nomorevibe.com"]) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
      expect(canonicalSiteHostname()).toBeNull();
    }
  });
  it("request.url이 내부 주소(web:3000)여도 siteverify hostname이 정식 주소면 통과하고 불일치 기록 없음", async () => {
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify("nomorevibe.com"), mocks.mode)).toBe(true);
    expect(mocks.mode).not.toHaveBeenCalled();
    expect(mismatches()).toEqual([]);
  });
  it("막기 모드: 정식 주소와 다르면(내부 hostname 포함) 거절하고 기대·실제 hostname을 기록", async () => {
    for (const hostname of ["evil.example", "web"]) {
      expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify(hostname), mocks.mode)).toBe(false);
    }
    expect(mismatches()).toEqual([
      { mode: "enforce", outcome: "refused", expected: "nomorevibe.com", actual: "evil.example" },
      { mode: "enforce", outcome: "refused", expected: "nomorevibe.com", actual: "web" },
    ]);
  });
  it("기록만 모드: 불일치는 통과시키되 별도 이벤트로 센다", async () => {
    mocks.mode.mockResolvedValue("observe");
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify("evil.example"), mocks.mode)).toBe(true);
    expect(mismatches()).toEqual([{ mode: "observe", outcome: "allowed", expected: "nomorevibe.com", actual: "evil.example" }]);
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify(undefined), mocks.mode)).toBe(true);
    expect(mismatches()[1]).toEqual({ mode: "observe", outcome: "allowed", expected: "nomorevibe.com", actual: null });
  });
  it("hostname이 맞아도 action·success가 틀리면 모드와 무관하게 거절", async () => {
    mocks.mode.mockResolvedValue("observe");
    const wrongAction = vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "nomorevibe.com", action: "other" }));
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), wrongAction, mocks.mode)).toBe(false);
    const failed = vi.fn().mockResolvedValue(Response.json({ success: false, hostname: "nomorevibe.com", action: "api-session" }));
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), failed, mocks.mode)).toBe(false);
    expect(mismatches()).toEqual([]);
  });
  it("정식 주소 설정이 없으면: 기록만은 통과+미설정 기록, 막기·모드 미상·모드 읽기 실패는 거절", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    mocks.mode.mockResolvedValue("observe");
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify("nomorevibe.com"), mocks.mode)).toBe(true);
    mocks.mode.mockResolvedValue("enforce");
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify("nomorevibe.com"), mocks.mode)).toBe(false);
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify("nomorevibe.com"))).toBe(false);
    mocks.mode.mockRejectedValue(new Error("db"));
    expect(await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify("nomorevibe.com"), mocks.mode)).toBe(false);
    expect(warn.mock.calls.filter(([event]) => event === "anti_scrape.turnstile_hostname_unconfigured").map(([, fields]) => fields)).toEqual([
      { mode: "observe", outcome: "allowed", actual: "nomorevibe.com" },
      { mode: "enforce", outcome: "refused", actual: "nomorevibe.com" },
      { mode: "enforce", outcome: "refused", actual: "nomorevibe.com" },
      { mode: "enforce", outcome: "refused", actual: "nomorevibe.com" },
    ]);
  });
  it("기록에는 키·토큰·IP를 남기지 않고 이상한 hostname은 invalid로 줄인다", async () => {
    mocks.mode.mockResolvedValue("observe");
    await verifyTurnstile(TOKEN, PLACEHOLDER_SECRET, internalRequest(), siteverify("evil.example\n{\"x\":1}"), mocks.mode);
    expect(mismatches()[0]).toMatchObject({ actual: "invalid" });
    for (const secret of [PLACEHOLDER_SECRET, TOKEN, "198.51.100.10", SIGNING]) expect(logged()).not.toContain(secret);
  });
});

describe("세션 발급 HTTP — 프록시 뒤 내부 request.url", () => {
  beforeEach(() => {
    vi.stubEnv("TURNSTILE_SITE_KEY", SITE_KEY); vi.stubEnv("TURNSTILE_SECRET_KEY", PLACEHOLDER_SECRET);
    vi.stubEnv("PUBLIC_API_SESSION_SECRET", SIGNING);
  });
  const post = (headers: HeadersInit = {}) => POST(internalRequest("/api/session", { method: "POST", body: JSON.stringify({ token: TOKEN }), headers }), ctx);
  it("막기 모드: 정식 출처·정식 hostname이면 쿠키 발급, hostname이 다르면 401", async () => {
    vi.stubGlobal("fetch", siteverify("nomorevibe.com"));
    const ok = await post();
    expect(ok.status).toBe(200); expect(ok.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    vi.stubGlobal("fetch", siteverify("evil.example"));
    const refused = await post();
    expect(refused.status).toBe(401); expect(refused.headers.has("set-cookie")).toBe(false);
    expect(mismatches()).toEqual([{ mode: "enforce", outcome: "refused", expected: "nomorevibe.com", actual: "evil.example" }]);
  });
  it("기록만 모드: hostname 불일치도 발급하고 불일치를 기록", async () => {
    mocks.mode.mockResolvedValue("observe");
    vi.stubGlobal("fetch", siteverify("evil.example"));
    expect((await post()).status).toBe(200);
    expect(mismatches()).toEqual([{ mode: "observe", outcome: "allowed", expected: "nomorevibe.com", actual: "evil.example" }]);
  });
  it("Origin은 정식 출처와 비교한다 — 내부 주소·다른 출처·Origin 없음은 403", async () => {
    vi.stubGlobal("fetch", siteverify("nomorevibe.com"));
    expect((await post({ origin: INTERNAL })).status).toBe(403);
    expect((await post({ origin: "https://other.test" })).status).toBe(403);
    const request = internalRequest("/api/session", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    request.headers.delete("origin");
    expect((await POST(request, ctx)).status).toBe(403);
  });
});
