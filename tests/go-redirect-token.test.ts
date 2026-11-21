import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /go/<slug> 서명 토큰(2026-11-15 사람 결정: 이름·요약 밖의 프로젝트 연결 정보는 보호 API 를 거쳐서만).
 * slug 만으로 바깥 주소를 얻을 수 없어야 한다 — 토큰이 없거나 틀리거나 다른 제품 것이거나 지났으면 상세(/p/<slug>)로, 세지 않는다.
 * DB 는 부르지 않는다: 제품 찾기·클릭 기록·한도 표만 바꿔 끼운다.
 */
const mocks = vi.hoisted(() => ({ findBySlug: vi.fn(), recordClick: vi.fn(), rateLimitWindow: vi.fn() }));
vi.mock("@/lib/domain/products/repository", () => ({ findBySlug: mocks.findBySlug }));
vi.mock("@/lib/domain/products/clicks", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/clicks")>(), recordClick: mocks.recordClick,
}));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...await original<typeof import("@/lib/rate-limit")>(), rateLimitWindow: mocks.rateLimitWindow,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

const { GET: go } = await import("@/app/go/[slug]/route");
const { GO_TOKEN_TTL_MS, issueGoToken, signedGoLink, verifyGoToken } = await import("@/lib/domain/products/go-token");
const { GO_LIMIT, GO_WINDOW_MS, goKey } = await import("@/lib/http/anti-scrape");

const SECRET = "go-token-test-secret-0123456789abcdef";
const ORIGIN = "https://nomorevibe.com";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const PUBLIC_IP = "198.51.100.23";
const product = { id: 1, slug: "ggml", url: "https://github.com/ggml-org/ggml", status: "verified", accessMode: "installable" };

/** 운영처럼 request.url 은 bind 주소(공개 주소 아님) */
function visit(slug: string, query = "", headers: Record<string, string> = {}) {
  return go(new Request(`http://web:3000/go/${encodeURIComponent(slug)}${query}`, { headers: { "user-agent": CHROME, ...headers } }),
    { params: Promise.resolve({ slug }) });
}
const tokenFor = (slug: string, now = Date.now()) => issueGoToken(slug, now)!.token;

beforeEach(() => {
  vi.stubEnv("VISITOR_HASH_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  vi.stubEnv("GA_MEASUREMENT_ID", "");
  vi.stubEnv("LOG_LEVEL", "error");
  mocks.findBySlug.mockReset().mockResolvedValue(product);
  mocks.recordClick.mockReset().mockResolvedValue(undefined);
  mocks.rateLimitWindow.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 600 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function expectDetail(response: Response, path = "/p/ggml") {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${ORIGIN}${path}`);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

describe("/go 토큰이 맞지 않으면 상세로 — 바깥 주소를 주지 않고 세지 않는다", () => {
  it("토큰 없음", async () => {
    expectDetail(await visit("ggml"));
    expect(mocks.findBySlug).not.toHaveBeenCalled();
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });

  it("틀린 토큰·모양이 다른 토큰", async () => {
    const good = tokenFor("ggml");
    const [expires, sig] = good.split(".");
    const flipped = `${expires}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    for (const bad of [flipped, "abc", `${expires}.`, `${expires}.${sig}x`, `zzzzzzzzzzz.${sig}`]) {
      expectDetail(await visit("ggml", `?t=${encodeURIComponent(bad)}`));
    }
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });

  it("다른 제품의 토큰", async () => {
    expectDetail(await visit("ggml", `?t=${tokenFor("llama-cpp")}`));
    expect(verifyGoToken("ggml", tokenFor("llama-cpp"))).toBe("invalid");
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });

  it("만료된 토큰 — 유효 시간은 상수 하나(10~15분)", async () => {
    expect(GO_TOKEN_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(GO_TOKEN_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
    const old = tokenFor("ggml", Date.now() - GO_TOKEN_TTL_MS - 1_000);
    expect(verifyGoToken("ggml", old)).toBe("expired");
    expectDetail(await visit("ggml", `?t=${old}`));
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });

  it("만료를 늘린 토큰(서명은 그대로)은 위조", () => {
    const [, sig] = tokenFor("ggml").split(".");
    const later = (Math.ceil((Date.now() + GO_TOKEN_TTL_MS * 4) / 1000)).toString(36);
    expect(verifyGoToken("ggml", `${later}.${sig}`)).toBe("invalid");
  });

  it("언어 접두를 지킨다 — ?lang=, 없으면 같은 사이트 Referer, 다른 사이트 Referer 는 무시", async () => {
    expectDetail(await visit("ggml", "?lang=en"), "/en/p/ggml");
    expectDetail(await visit("ggml", "", { referer: `${ORIGIN}/ja/p/ggml` }), "/ja/p/ggml");
    expectDetail(await visit("ggml", "", { referer: "https://evil.example/en/p/ggml" }), "/p/ggml");
    expectDetail(await visit("ggml", "?lang=xx"), "/p/ggml");
  });
});

describe("/go 토큰이 맞으면 지금처럼", () => {
  it("바깥 주소로 302 + 클릭 기록 + no-store", async () => {
    const response = await visit("ggml", `?t=${tokenFor("ggml")}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(product.url);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.recordClick).toHaveBeenCalledWith("ggml", expect.any(String));
  });

  it("보호 API 가 내주는 주소(signedGoLink)를 그대로 따라가면 바깥으로 — 언어·via 는 질의에 남는다", async () => {
    const link = signedGoLink("ggml", { locale: "en", via: "card" })!;
    expect(link.href).toMatch(/^\/go\/ggml\?t=[0-9a-z]+\.[A-Za-z0-9_-]{22}&lang=en&via=card$/);
    expect(link.expiresAt).toBeGreaterThan(Date.now());
    const response = await visit("ggml", link.href.slice("/go/ggml".length));
    expect(response.headers.get("location")).toBe(product.url);
    expect(mocks.recordClick).toHaveBeenCalledTimes(1);
  });

  it("via 를 받아 분석에 싣는다(기존 동작 유지)", async () => {
    vi.stubEnv("GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("GA_API_SECRET", "test-api-secret_ABC");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await visit("ggml", `?t=${tokenFor("ggml")}&via=card`, { cookie: "_ga=GA1.1.1234567890.1760000000" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(body.events[0]).toMatchObject({ name: "outbound_visit", params: { product_slug: "ggml", via: "card" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("봇은 토큰이 맞아도 세지 않는다 — 이동은 그대로, 토큰 없는 봇은 상세로", async () => {
    for (const ua of ["Slackbot-LinkExpanding 1.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.7.1"]) {
      const response = await visit("ggml", `?t=${tokenFor("ggml")}`, { "user-agent": ua });
      expect(response.headers.get("location"), ua).toBe(product.url);
      expectDetail(await visit("ggml", "", { "user-agent": ua }));
    }
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });

  it("차단된 제품은 토큰이 맞아도 첫 화면으로", async () => {
    mocks.findBySlug.mockResolvedValue({ ...product, status: "banned" });
    const response = await visit("ggml", `?t=${tokenFor("ggml")}`);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });
});

describe("서버 비밀이 없으면 발급도 검증도 실패 — 안전한 쪽(상세)", () => {
  it.each([["없음", ""], ["짧음", "short-secret"]])("비밀 %s", async (_label, secret) => {
    const token = tokenFor("ggml");
    vi.stubEnv("VISITOR_HASH_SECRET", secret);
    expect(issueGoToken("ggml")).toBeNull();
    expect(signedGoLink("ggml")).toBeNull();
    expect(verifyGoToken("ggml", token)).toBe("unconfigured");
    expectDetail(await visit("ggml", `?t=${token}`));
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });

  it("다른 비밀로 만든 토큰은 받지 않는다(용도 라벨로 파생한 열쇠)", () => {
    const token = issueGoToken("ggml", Date.now(), "another-secret-0123456789abcdef-xyz")!.token;
    expect(verifyGoToken("ggml", token)).toBe("invalid");
  });
});

describe("IP 한도 — 10분 60번, 넘치면 429 + Retry-After + no-store", () => {
  beforeEach(() => vi.stubEnv("TRUSTED_PROXY_HOPS", "1"));

  it("공개 IP 마다 go: 열쇠로 센다", async () => {
    expect(GO_LIMIT).toBe(60);
    expect(GO_WINDOW_MS).toBe(10 * 60_000);
    await visit("ggml", `?t=${tokenFor("ggml")}`, { "x-forwarded-for": PUBLIC_IP });
    expect(mocks.rateLimitWindow).toHaveBeenCalledWith(goKey(PUBLIC_IP), GO_LIMIT, GO_WINDOW_MS);
  });

  it("넘치면 토큰이 맞아도 429 — 기록하지 않는다", async () => {
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: GO_LIMIT + 1, retryAfterSeconds: 321 });
    const response = await visit("ggml", `?t=${tokenFor("ggml")}`, { "x-forwarded-for": PUBLIC_IP });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("321");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.findBySlug).not.toHaveBeenCalled();
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });

  it("한도 표가 잠시 안 되면 막지 않는다(공개 API 와 같은 관례)", async () => {
    mocks.rateLimitWindow.mockRejectedValue(new Error("db down"));
    const response = await visit("ggml", `?t=${tokenFor("ggml")}`, { "x-forwarded-for": PUBLIC_IP });
    expect(response.headers.get("location")).toBe(product.url);
  });
});
