import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { RateLimitResult } from "@/lib/rate-limit";

/**
 * 과다 호출 30분 차단 + 크롤링 금지 안내(2026-11-16 사람 지시, PR 2).
 * DB 는 부르지 않는다: 한도 표·설정을 메모리 저장소(setCrawlBurstStoreForTest)로 바꿔 끼우고 시계를 직접 움직인다.
 * 같은 SQL 의 창·차단·실제 runtime_settings 저장은 tests/integration/crawl-burst-block.test.ts 가 본다.
 */
const mocks = vi.hoisted(() => ({ findBySlug: vi.fn() }));
vi.mock("@/lib/domain/products/repository", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/repository")>(),
  findBySlug: mocks.findBySlug,
}));

const { proxy } = await import("@/proxy");
const { guardPublicApiRead } = await import("@/lib/http/anti-scrape");
const { setCrawlBurstStoreForTest } = await import("@/lib/http/crawl-burst");
const { CRAWL_BURST_DEFAULTS, CRAWL_PROHIBITED_MESSAGE, CRAWL_PROHIBITED_MESSAGE_EN, countsTowardCrawlBurst, crawlBurstKey } = await import("@/lib/http/crawl-burst-policy");
const { setSearchBotResolverForTest } = await import("@/lib/http/search-bot-verify");
const { resolveRuntimeSettings, DEFAULT_RUNTIME_SETTINGS } = await import("@/lib/operations/runtime-settings-schema");
const { RATE_LIMIT_BLOCKED_COUNT } = await import("@/lib/rate-limit");
const productRoute = await import("@/app/api/products/[slug]/route");

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SKILL = "nomorevibe-skill/1";
const CLAUDE_USER = "Claude-User (claude-code/2.1.0; +https://support.anthropic.com/)";
const IP = "198.51.100.23";
const OTHER_IP = "198.51.100.99";
const GOOGLE_IP = "66.249.66.1";
const SITE = "https://nomorevibe.com";

/**
 * 2026-11-16 실측(운영과 같은 next build standalone + 시험 DB, Playwright Desktop Chrome — PR #977 본문 표): 상세 한 장을 처음 열 때
 * 이 차단이 세는 요청 수의 최대(README 가 있는 설치형: 문서 1 + session·details·reactions·feedback·readme). 보통 상세는 5.
 * 기본 기준(10초 80번)이 빠른 사람·공유 IP 를 막지 않는지 이 값으로 본다.
 */
const MEASURED_DETAIL_COUNTED = 6;
const LIMIT = CRAWL_BURST_DEFAULTS.burstLimit;

/** rate_limits 한 행의 의미(lib/http/crawl-burst.ts hitInDb·blockInDb)를 메모리로 — 시계는 now 로 움직인다 */
function memoryStore(settings = { ...CRAWL_BURST_DEFAULTS }) {
  const rows = new Map<string, { count: number; resetAt: number }>();
  const clock = { now: Date.now() };
  const retry = (resetAt: number) => Math.max(1, Math.ceil((resetAt - clock.now) / 1000));
  const store = {
    settings: vi.fn(async () => settings),
    hit: vi.fn(async (key: string, limit: number, windowMs: number): Promise<RateLimitResult> => {
      const row = rows.get(key);
      if (!row || row.resetAt < clock.now) rows.set(key, { count: 1, resetAt: clock.now + windowMs });
      else if (row.count < RATE_LIMIT_BLOCKED_COUNT) row.count += 1;
      const current = rows.get(key)!;
      return { allowed: current.count <= limit, count: current.count, retryAfterSeconds: retry(current.resetAt) };
    }),
    block: vi.fn(async (key: string, durationMs: number) => {
      const row = rows.get(key);
      rows.set(key, { count: RATE_LIMIT_BLOCKED_COUNT, resetAt: Math.max(row?.resetAt ?? 0, clock.now + durationMs) });
    }),
  };
  const counted = (ip = IP) => { const row = rows.get(crawlBurstKey(ip)); return row && row.resetAt >= clock.now ? row.count : 0; };
  return { store, rows, clock, settings, counted, advance: (ms: number) => { clock.now += ms; } };
}

let mem: ReturnType<typeof memoryStore>;

const page = (path: string, init: { ua?: string; ip?: string; method?: string; headers?: Record<string, string> } = {}) =>
  proxy(new NextRequest(`${SITE}${path}`, {
    method: init.method ?? "GET",
    headers: { "user-agent": init.ua ?? BROWSER, "x-forwarded-for": init.ip ?? IP, ...init.headers },
  }));
const api = (path: string, init: { ua?: string; ip?: string } = {}) =>
  guardPublicApiRead(new Request(`${SITE}${path}`, { headers: { "user-agent": init.ua ?? BROWSER, "x-forwarded-for": init.ip ?? IP } }), "test");

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  mem = memoryStore();
  setCrawlBurstStoreForTest(mem.store);
  setSearchBotResolverForTest({ reverse: async () => { throw new Error("no rdns"); }, lookup: async () => [] });
  mocks.findBySlug.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setCrawlBurstStoreForTest(null);
  setSearchBotResolverForTest(null);
});

describe("기본값과 관리자 설정(runtime_settings publicApi.burst*)", () => {
  it("기본: 10초에 80번을 넘으면 30분(1800초) 차단", () => {
    expect(CRAWL_BURST_DEFAULTS).toEqual({ burstLimit: 80, burstWindowSeconds: 10, burstBlockSeconds: 1800 });
    expect(DEFAULT_RUNTIME_SETTINGS.publicApi).toEqual({ mode: "observe", burstLimit: 80, burstWindowSeconds: 10, burstBlockSeconds: 1800 });
  });

  it("저장 문서의 값을 쓰고, 범위 밖·정수 아님·모르는 키는 거절한다(기본값 유지)", () => {
    const saved = resolveRuntimeSettings({ publicApi: { burstLimit: 120, burstWindowSeconds: 30, burstBlockSeconds: 3600 } });
    expect(saved.issues).toEqual([]);
    expect(saved.settings.publicApi).toEqual({ mode: "observe", burstLimit: 120, burstWindowSeconds: 30, burstBlockSeconds: 3600 });
    expect(resolveRuntimeSettings({ publicApi: { burstLimit: 0 } })).toMatchObject({ issues: [], settings: { publicApi: { burstLimit: 0 } } });
    const bad = resolveRuntimeSettings({ publicApi: { burstLimit: 10_001, burstWindowSeconds: 0, burstBlockSeconds: 30.5, burstFoo: 1 } });
    expect(bad.issues).toEqual(expect.arrayContaining([
      "runtime_settings_invalid:publicApi.burstLimit", "runtime_settings_invalid:publicApi.burstWindowSeconds",
      "runtime_settings_invalid:publicApi.burstBlockSeconds", "unknown_setting:publicApi.burstFoo",
    ]));
    expect(bad.settings.publicApi).toMatchObject(CRAWL_BURST_DEFAULTS);
    // 관문 모드는 그대로 따로 읽는다
    expect(resolveRuntimeSettings({ publicApi: { mode: "enforce", burstLimit: 80 } }).settings.publicApi).toMatchObject({ mode: "enforce", burstLimit: 80 });
  });

  it("바꾼 기준 수·창·차단 시간이 그대로 쓰인다", async () => {
    Object.assign(mem.settings, { burstLimit: 5, burstWindowSeconds: 3, burstBlockSeconds: 120 });
    for (let i = 0; i < 5; i += 1) expect((await page("/")).status).not.toBe(429);
    expect(mem.store.hit).toHaveBeenLastCalledWith(crawlBurstKey(IP), 5, 3_000);
    const blocked = await page("/");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("120");
    expect(mem.store.block).toHaveBeenCalledWith(crawlBurstKey(IP), 120_000);
    mem.advance(121_000);
    expect((await page("/")).status).not.toBe(429);
  });

  it("기준 수 0 = 끔 — 세지도 막지도 않는다", async () => {
    mem.settings.burstLimit = 0;
    for (let i = 0; i < 200; i += 1) expect((await page("/popular")).status).not.toBe(429);
    expect(mem.store.hit).not.toHaveBeenCalled();
  });
});

describe("세는 것과 기준", () => {
  it("기준 이하(창 안 80번)는 화면·API 모두 통과하고, 창이 지나면 다시 센다", async () => {
    for (let i = 0; i < LIMIT / 2; i += 1) expect((await page(`/p/app-${i}`)).status).not.toBe(429);
    for (let i = 0; i < LIMIT / 2; i += 1) expect(await api(`/api/products/app-${i}/feedback`)).toBeNull();
    expect(mem.counted()).toBe(LIMIT);
    mem.advance(10_001);
    expect((await page("/")).status).not.toBe(429);
    expect(mem.counted()).toBe(1);
  });

  it("81번째에 429 + Retry-After 1800, 그 IP 의 화면과 API 가 함께 막힌다 — 다른 IP 는 그대로", async () => {
    for (let i = 0; i < LIMIT; i += 1) expect((await page("/")).status).not.toBe(429);
    const blocked = await page("/p/some-app");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBe(1800);
    const apiBlocked = await api("/api/products/some-app/reactions");
    expect(apiBlocked?.status).toBe(429);
    expect(Number(apiBlocked!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1799);
    expect((await page("/", { ip: OTHER_IP })).status).not.toBe(429);
    expect(await api("/api/products/some-app/reactions", { ip: OTHER_IP })).toBeNull();
  });

  it("막힌 동안 Retry-After 는 남은 초로 줄고, 30분 뒤 풀린다", async () => {
    for (let i = 0; i <= LIMIT; i += 1) await page("/");
    mem.advance(10 * 60_000);
    const later = await page("/");
    expect(later.status).toBe(429);
    expect(Number(later.headers.get("retry-after"))).toBe(1200);
    mem.advance(19 * 60_000);
    expect(Number((await page("/")).headers.get("retry-after"))).toBe(60);
    mem.advance(60_001);
    expect((await page("/")).status).not.toBe(429);
    expect(await api("/api/products/x/feedback")).toBeNull();
  });

  it("정적 자원·기계 경로·쓰기는 세지 않는다(사람 화면 한 번에 그림 수십 개)", async () => {
    const statics = ["/_next/static/chunks/main.js", "/_next/image?url=%2Fx.png&w=640&q=75", "/api/og-cache/app.abc.webp", "/api/media/abc",
      "/favicon.ico", "/icon.svg", "/apple-icon.png", "/manifest.webmanifest", "/robots.txt", "/sitemap.xml", "/sitemaps/products-1.xml",
      "/feed.xml", "/llms.txt", "/skill.md", "/install.sh", "/badge/app", "/go/app", "/p/app/share-card.png", "/en/p/app/share-card.png",
      "/fonts/x.woff2", "/admin/status", "/api/products/app"];
    for (const path of statics) expect(countsTowardCrawlBurst({ method: "GET", nextUrl: { pathname: path.split("?")[0] } }), path).toBe(false);
    for (let round = 0; round < 5; round += 1) for (const path of statics.filter((p) => !p.startsWith("/admin"))) await page(path);
    expect(mem.store.hit).not.toHaveBeenCalled();
    // 서버 액션·폼(POST)은 화면 요청이 아니다
    for (let i = 0; i < 60; i += 1) await page("/", { method: "POST" });
    expect(mem.store.hit).not.toHaveBeenCalled();
    // 공개 화면은 센다 — 로케일·점이 든 제품 이름·RSC 이동 포함
    for (const path of ["/", "/en", "/en/popular", "/p/my.app.js", "/c/dev", "/rankings/weekly", "/feedback/1", "/zh-Hans/talk"]) {
      expect(countsTowardCrawlBurst({ method: "GET", nextUrl: { pathname: path } }), path).toBe(true);
    }
    expect(countsTowardCrawlBurst({ method: "HEAD", nextUrl: { pathname: "/" } })).toBe(true);
  });

  it("og-cache·media 는 공개 API 읽기 관문을 거치지 않는다(세는 곳이 없다)", () => {
    const files = ["app/api/og-cache", "app/api/media"].flatMap((dir) => readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((name) => /route\.tsx?$/.test(name)).map((name) => `${dir}/${name}`));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/guardPublicApiRead|guardCrawlBurst/);
  });

  it("IP 를 모르면(사설 주소·신뢰 프록시 없음) 세지 않는다", async () => {
    for (let i = 0; i < LIMIT * 2; i += 1) expect((await page("/", { ip: "172.18.0.1" })).status).not.toBe(429);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    for (let i = 0; i < LIMIT * 2; i += 1) expect((await page("/")).status).not.toBe(429);
    expect(mem.store.hit).not.toHaveBeenCalled();
  });

  it("한도 표가 안 되면 막지 않는다(화면이 먼저)", async () => {
    mem.store.hit.mockRejectedValue(new Error("db down"));
    for (let i = 0; i < LIMIT * 2; i += 1) expect((await page("/")).status).not.toBe(429);
  });
});

describe("면제 — 역방향 DNS 로 확인된 검색 봇만", () => {
  it("확인된 Googlebot 은 기준을 넘어도 막히지 않는다", async () => {
    setSearchBotResolverForTest({ reverse: async () => ["crawl-66-249-66-1.googlebot.com"], lookup: async () => [GOOGLE_IP] });
    for (let i = 0; i < LIMIT * 3; i += 1) expect((await page(`/p/app-${i}`, { ua: GOOGLEBOT, ip: GOOGLE_IP })).status, String(i)).not.toBe(429);
    expect(mem.store.block).not.toHaveBeenCalled();
  });

  it("이름(UA)만 Googlebot 인 요청은 보통 방문자처럼 막힌다", async () => {
    for (let i = 0; i < LIMIT; i += 1) await page("/", { ua: GOOGLEBOT });
    expect((await page("/", { ua: GOOGLEBOT })).status).toBe(429);
  });

  it("역방향 이름이 맞아도 정방향 IP 가 다르면 면제하지 않는다", async () => {
    setSearchBotResolverForTest({ reverse: async () => ["fake.googlebot.com"], lookup: async () => ["66.249.66.2"] });
    for (let i = 0; i < LIMIT; i += 1) await page("/", { ua: GOOGLEBOT, ip: GOOGLE_IP });
    expect((await page("/", { ua: GOOGLEBOT, ip: GOOGLE_IP })).status).toBe(429);
  });
});

describe("막힌 동안의 응답 모양과 문구", () => {
  async function blockNow() { for (let i = 0; i <= LIMIT; i += 1) await page("/"); }

  it("화면 요청은 짧은 HTML — 사람 지시 문구 그대로 + 남은 시간, 캐시 금지", async () => {
    await blockNow();
    const response = await page("/p/some-app");
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await response.text();
    // 문장마다 줄이 끊기지 않게 span 으로 감싸도 글자는 지시 원문 그대로다
    const text = html.replace(/<style[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(text).toContain("이 사이트는 크롤링을 금지합니다. 법적 조치를 취할 수 있습니다.");
    expect(html).toContain('<h1 lang="ko"><span>이 사이트는 크롤링을 금지합니다.</span> <span>법적 조치를 취할 수 있습니다.</span></h1>');
    expect(html).toContain(CRAWL_PROHIBITED_MESSAGE_EN);
    expect(html).toMatch(/남은 시간 <strong>약 30분<\/strong>/);
    expect(html).toMatch(/about 30 minutes/);
    expect(html).toContain('<html lang="ko">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("영어 등 다른 언어 화면은 영어 문장을 먼저 보이되 한국어 문구도 그대로 싣는다", async () => {
    await blockNow();
    const html = await (await page("/en/popular")).text();
    expect(html).toContain('<html lang="en">');
    expect(html.indexOf("Time left")).toBeLessThan(html.indexOf("남은 시간"));
    expect(html).toContain("<span>이 사이트는 크롤링을 금지합니다.</span>");
    expect(html).toContain(CRAWL_PROHIBITED_MESSAGE_EN);
  });

  it("HEAD 는 본문 없이 같은 머리", async () => {
    await blockNow();
    const response = await page("/", { method: "HEAD" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1800");
    expect(await response.text()).toBe("");
  });

  it("API 는 JSON error: crawling_prohibited — 실제 제품 API 경로에서", async () => {
    mocks.findBySlug.mockResolvedValue({ id: 1, slug: "some-app", name: "SomeApp", tagline: "t", category: "Other", status: "verified",
      url: "https://some.test", repoUrl: null, claimedAt: new Date(), verifyToken: "nmv_verify_x" });
    await blockNow();
    const response = await productRoute.GET(new Request(`${SITE}/api/products/some-app`, { headers: { "user-agent": BROWSER, "x-forwarded-for": IP } }),
      { params: Promise.resolve({ slug: "some-app" }) } as never);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1800");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ error: "crawling_prohibited", retryAfterSeconds: 1800 });
    expect(body.message).toBe(`${CRAWL_PROHIBITED_MESSAGE} 30분 뒤에 다시 이용할 수 있습니다.`);
    expect(body.message_en).toBe(`${CRAWL_PROHIBITED_MESSAGE_EN} Try again in 30 minutes.`);
    expect(Date.parse(body.retryAt)).toBeGreaterThan(Date.now() + 1_790_000);
    expect(mocks.findBySlug).not.toHaveBeenCalled();
  });

  it("남은 시간이 1분 아래면 초로 알린다", async () => {
    await blockNow();
    mem.advance(1_800_000 - 42_000);
    const body = await (await api("/api/products/x/feedback"))!.json();
    expect(body.retryAfterSeconds).toBe(42);
    expect(body.message).toContain("42초 뒤에");
  });
});

describe("사람이 에이전트에 입력해 쓰는 접근은 허용(2026-11-15 원칙)", () => {
  it("SKILL.md 클레임 확인·가져오기 흐름 한 번이 세는 수는 기준보다 훨씬 적다", async () => {
    mocks.findBySlug.mockResolvedValue({ id: 1, slug: "my-app", name: "MyApp", tagline: "t", category: "Other", status: "seeded",
      url: "https://my-app.test", repoUrl: "https://github.com/me/my-app", claimedAt: null, verifyToken: "nmv_verify_my-app" });
    // 에이전트가 스킬 문서를 읽는다(세지 않음) → 상세 화면을 한 번 본다(Claude-User WebFetch) → 클레임 확인 GET(스킬 curl -A)을 두 번(주소 고쳐 다시)
    expect((await page("/skill.md", { ua: CLAUDE_USER })).status).not.toBe(429);
    expect((await page("/p/my-app", { ua: CLAUDE_USER })).status).not.toBe(429);
    for (const url of ["https://my-app.test", "https://github.com/me/my-app"]) {
      const check = await productRoute.GET(new Request(`${SITE}/api/products/my-app?url=${encodeURIComponent(url)}`, {
        headers: { "user-agent": SKILL, "x-forwarded-for": IP } }), { params: Promise.resolve({ slug: "my-app" }) } as never);
      expect(check.status).toBe(200);
    }
    // 쓰기(POST verify·updates·DELETE)는 공개 읽기 관문을 거치지 않는다 — 세는 것은 위의 3번뿐
    expect(mem.counted()).toBe(3);
    expect(mem.counted() * 10).toBeLessThanOrEqual(CRAWL_BURST_DEFAULTS.burstLimit);
    expect(mem.store.block).not.toHaveBeenCalled();
  });

  it("빠른 사람(10초에 상세 5장, 모두 설치형) 두 명이 한 공유 IP 에 있어도 기준 아래", async () => {
    const perDetail = MEASURED_DETAIL_COUNTED;
    expect(perDetail * 5 * 2).toBeLessThanOrEqual(CRAWL_BURST_DEFAULTS.burstLimit);
    for (let person = 0; person < 2; person += 1) for (let detail = 0; detail < 5; detail += 1) {
      expect((await page(`/p/app-${detail}`)).status).not.toBe(429);
      for (let call = 1; call < perDetail; call += 1) expect(await api(`/api/products/app-${detail}/feedback`)).toBeNull();
    }
    expect(mem.counted()).toBe(perDetail * 10);
    expect(mem.store.block).not.toHaveBeenCalled();
  });
});
