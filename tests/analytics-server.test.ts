import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_EVENT_CATALOG, ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from "@/lib/analytics/events";
import {
  analyticsUserId, analyticsUserIdEnabled, gaSessionCookieName, parseGaClientId, parseGaSessionId, randomClientId, USER_ID_LENGTH,
} from "@/lib/analytics/identity";
import { agentClass, buildServerEvent, MP_COLLECT_URL, serverAnalyticsConfig, trackServer, type MeasurementPayload } from "@/lib/analytics/server";
import { logger } from "@/lib/observability/logger";
import { analyticsPropertyUrl } from "@/lib/analytics/property-url";

/**
 * 서버 발신 방문 분석(PR C) — Measurement Protocol 꼴·방문자 잇기·동의·개인정보·꺼짐.
 * 실제 GA 로는 아무것도 보내지 않는다(fetch 는 가짜).
 */

const MEASUREMENT_ID = "G-TEST123";
const API_SECRET = "test-api-secret_ABC";
const USER_SECRET = "a".repeat(32);
const ENV = { GA_MEASUREMENT_ID: MEASUREMENT_ID, GA_API_SECRET: API_SECRET, ANALYTICS_USER_ID_SECRET: USER_SECRET };
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const GA = "GA1.1.1234567890.1760000000";
const GA_SESSION = "GS2.1.s1761100000$o3$g1$t1761100100$j0$l0$h0";
const NOW = Date.UTC(2026, 9, 22, 3, 0, 0);

/** 브라우저처럼 — _ga 와 세션 쿠키, 그리고 보내면 안 되는 값들(IP·이메일·세션 토큰)을 함께 싣는다 */
function browserRequest(headers: Record<string, string> = {}, cookies = `_ga=${GA}; ${gaSessionCookieName(MEASUREMENT_ID)}=${GA_SESSION}`) {
  return new Request("https://nomorevibe.test/go/app?via=card&q=me%40example.com", {
    headers: {
      "user-agent": CHROME, "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "203.0.113.7",
      cookie: `${cookies}; nmv_user=opaque-session-token-value-0123456789; email=me@example.com`, ...headers,
    },
  });
}
const cliRequest = (ua = "curl/8.7.1") => new Request("https://nomorevibe.test/install.sh", { headers: { "user-agent": ua } });
const okPayload = (built: ReturnType<typeof buildServerEvent>): MeasurementPayload => {
  if (!built.ok) throw new Error(`skipped: ${built.reason}`);
  return built.payload;
};

describe("_ga 쿠키 읽기", () => {
  it("client_id 는 GA1.<깊이>. 뒤의 두 조각이다", () => {
    expect(parseGaClientId("GA1.1.1234567890.1760000000")).toBe("1234567890.1760000000");
    expect(parseGaClientId(" GA1.2.42.1700000000 ")).toBe("42.1700000000");
  });

  it("모양이 다르면 null — 남의 값을 그대로 보내지 않는다", () => {
    for (const value of [undefined, null, "", "GA2.1.1.2", "GA1.1.123", "GA1.1.abc.123", "GA1.1.1.2.3", "GA1.1.1.2;x", "me@example.com"]) {
      expect(parseGaClientId(value), String(value)).toBeNull();
    }
  });

  it("세션 id 는 GS1·GS2 두 모양 모두에서 꺼낸다", () => {
    expect(gaSessionCookieName("G-ABC123")).toBe("_ga_ABC123");
    expect(parseGaSessionId("GS1.1.1761100000.3.1.1761100100.0.0.0")).toBe("1761100000");
    expect(parseGaSessionId(GA_SESSION)).toBe("1761100000");
    for (const value of [undefined, "", "GS1.1.abc.1", "GS2.1.o3$s1761100000", "GS3.1.s1761100000"]) expect(parseGaSessionId(value)).toBeNull();
  });

  it("일회용 client_id 는 gtag 와 같은 <수>.<초> 모양이고 매번 다르다", () => {
    const first = randomClientId(NOW);
    expect(first).toMatch(new RegExp(`^\\d+\\.${Math.floor(NOW / 1000)}$`));
    expect(new Set(Array.from({ length: 20 }, () => randomClientId(NOW))).size).toBeGreaterThan(1);
  });
});

describe("가명 user_id", () => {
  it("같은 비밀·같은 id 는 늘 같은 값이다 — 바뀌면 모든 로그인 사용자의 여정이 끊긴다", () => {
    // 만드는 법을 여기 고정한다: HMAC-SHA256(비밀, "user:" + id) 앞 32글자. 코드가 이 식을 바꾸면 이 시험이 먼저 깨져야 한다
    const expected = (id: number) => createHmac("sha256", USER_SECRET).update(`user:${id}`).digest("hex").slice(0, 32);
    expect(analyticsUserId(42, USER_SECRET)).toBe(expected(42));
    expect(analyticsUserId(43, USER_SECRET)).toBe(expected(43));
    expect(analyticsUserId(42, USER_SECRET)).toBe(analyticsUserId(42, USER_SECRET));
    expect(analyticsUserId(42, USER_SECRET)).not.toBe(analyticsUserId(43, USER_SECRET));
    expect(analyticsUserId(42, USER_SECRET)).toHaveLength(USER_ID_LENGTH);
    expect(analyticsUserId(42, "b".repeat(32))).not.toBe(analyticsUserId(42, USER_SECRET));
  });

  it("비밀이 없거나 짧거나 id 가 이상하면 만들지 않는다", () => {
    expect(analyticsUserIdEnabled(undefined)).toBe(false);
    expect(analyticsUserIdEnabled("short")).toBe(false);
    expect(analyticsUserId(42, undefined)).toBeNull();
    expect(analyticsUserId(42, "a".repeat(31))).toBeNull();
    for (const id of [0, -1, 1.5, Number.NaN, null, undefined]) expect(analyticsUserId(id as number, USER_SECRET)).toBeNull();
  });
});

describe("설정 — 둘 다 있어야 켠다", () => {
  it("측정 ID 와 API 비밀이 모두 맞아야 한다", () => {
    expect(serverAnalyticsConfig({})).toBeNull();
    expect(serverAnalyticsConfig({ GA_MEASUREMENT_ID: MEASUREMENT_ID })).toBeNull();
    expect(serverAnalyticsConfig({ GA_API_SECRET: API_SECRET })).toBeNull();
    expect(serverAnalyticsConfig({ GA_MEASUREMENT_ID: "UA-1234-1", GA_API_SECRET: API_SECRET })).toBeNull();
    expect(serverAnalyticsConfig({ GA_MEASUREMENT_ID: MEASUREMENT_ID, GA_API_SECRET: "has space secret" })).toBeNull();
    expect(serverAnalyticsConfig({ ...ENV, GA_DEBUG: "1" })).toEqual({ measurementId: MEASUREMENT_ID, apiSecret: API_SECRET, debug: true });
  });

  it("꺼져 있으면 꼴도 만들지 않는다", () => {
    expect(buildServerEvent("outbound_visit", { product_slug: "app", link_kind: "site" }, { request: browserRequest(), identity: "browser" }, { env: {} }))
      .toEqual({ ok: false, reason: "disabled" });
  });
});

describe("Measurement Protocol 꼴", () => {
  it("브라우저의 _ga·세션을 이어 붙이고, 광고 신호는 거부로 둔다", () => {
    const built = buildServerEvent("outbound_visit", { product_slug: "app", link_kind: "repo", via: "card" },
      { request: browserRequest(), identity: "browser" }, { env: ENV, now: NOW });
    expect(built.ok && built.url).toBe(`${MP_COLLECT_URL}?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`);
    expect(okPayload(built)).toEqual({
      client_id: "1234567890.1760000000",
      timestamp_micros: NOW * 1_000,
      non_personalized_ads: true,
      consent: { ad_user_data: "DENIED", ad_personalization: "DENIED" },
      events: [{ name: "outbound_visit", params: {
        product_slug: "app", link_kind: "repo", via: "card", id_source: "ga_cookie", session_id: "1761100000", engagement_time_msec: 1,
      } }],
    });
  });

  it("로그인한 사람은 가명 user_id 만 — 내부 id 는 어디에도 없다", () => {
    const payload = okPayload(buildServerEvent("login", { method: "github" }, { request: browserRequest(), identity: "browser", userId: 4242 }, { env: ENV, now: NOW }));
    expect(payload.user_id).toBe(analyticsUserId(4242, USER_SECRET));
    expect(JSON.stringify(payload)).not.toContain("4242");
    // 비밀이 없으면 user_id 없이 보낸다
    const anonymous = okPayload(buildServerEvent("login", { method: "github" }, { request: browserRequest(), identity: "browser", userId: 4242 },
      { env: { GA_MEASUREMENT_ID: MEASUREMENT_ID, GA_API_SECRET: API_SECRET }, now: NOW }));
    expect(anonymous).not.toHaveProperty("user_id");
  });

  it("세션 쿠키가 없으면 session_id·engagement_time_msec 를 붙이지 않는다", () => {
    const payload = okPayload(buildServerEvent("outbound_visit", { product_slug: "app", link_kind: "site" },
      { request: browserRequest({}, `_ga=${GA}`), identity: "browser" }, { env: ENV, now: NOW }));
    expect(payload.events[0].params).toEqual({ product_slug: "app", link_kind: "site", id_source: "ga_cookie" });
  });

  it("운영자 표시 쿠키와 GA_DEBUG 는 traffic_type·debug_mode 로 간다", () => {
    const payload = okPayload(buildServerEvent("outbound_visit", { product_slug: "app", link_kind: "site" },
      { request: browserRequest({}, `_ga=${GA}; nmv_internal=1`), identity: "browser" }, { env: { ...ENV, GA_DEBUG: "1" }, now: NOW }));
    expect(payload.events[0].params).toMatchObject({ traffic_type: "internal", debug_mode: 1 });
  });

  it("CLI(쿠키 없음)는 요청마다 새 client_id — 세션도 user_id 도 없다", () => {
    const first = okPayload(buildServerEvent("skill_script_download", { script: "install_sh", agent_class: "curl" },
      { request: cliRequest(), identity: "auto", userId: 7 }, { env: ENV, now: NOW }));
    const second = okPayload(buildServerEvent("skill_script_download", { script: "install_sh", agent_class: "curl" },
      { request: cliRequest(), identity: "auto" }, { env: ENV, now: NOW }));
    expect(first.client_id).toMatch(/^\d+\.\d+$/);
    expect(first.client_id).not.toBe(second.client_id);
    expect(first.events[0].params).toEqual({ script: "install_sh", agent_class: "curl", id_source: "random" });
    // 스킬 API 를 브라우저 쿠키와 함께 부르면 그 브라우저에 잇는다
    const stitched = okPayload(buildServerEvent("launch_submitted", { product_slug: "app", source: "other" },
      { request: browserRequest(), identity: "auto" }, { env: ENV, now: NOW }));
    expect(stitched.client_id).toBe("1234567890.1760000000");
  });

  it("합계(배지)는 고정 client_id 하나 — 쿠키·로그인이 있어도 사람을 잇지 않는다", () => {
    const payload = okPayload(buildServerEvent("badge_impression", { product_slug: "app", badge_style: "verified", badge_lang: "en" },
      { request: browserRequest({}, `_ga=${GA}; nmv_internal=1`), identity: "aggregate", userId: 42 }, { env: ENV, now: NOW }));
    expect(payload.client_id).toBe("aggregate.badge_impression");
    expect(payload).not.toHaveProperty("user_id");
    expect(payload.events[0].params).toEqual({ product_slug: "app", badge_style: "verified", badge_lang: "en", id_source: "aggregate" });
  });
});

describe("동의 — 브라우저 쪽(consent.ts)과 같은 모델", () => {
  const visit = (request: Request, identity: "browser" | "auto" | "aggregate" = "browser") =>
    buildServerEvent("outbound_visit", { product_slug: "app", link_kind: "site" }, { request, identity }, { env: ENV, now: NOW });

  it("GPC·DNT·유럽 경제 지역은 보내지 않는다(합계도)", () => {
    expect(visit(browserRequest({ "sec-gpc": "1" }))).toEqual({ ok: false, reason: "gpc" });
    expect(visit(browserRequest({ dnt: "1" }))).toEqual({ ok: false, reason: "dnt" });
    expect(visit(browserRequest({ "cf-ipcountry": "de" }))).toEqual({ ok: false, reason: "region" });
    expect(visit(browserRequest({ "cf-ipcountry": "GB" }), "aggregate")).toEqual({ ok: false, reason: "region" });
    expect(visit(cliRequest(), "auto")).toMatchObject({ ok: true });
    expect(visit(browserRequest({ "cf-ipcountry": "KR", dnt: "0" }))).toMatchObject({ ok: true });
  });

  it("브라우저인데 _ga 가 없으면(분석을 껐거나 동의 전) 쿠키 없는 신호도 보내지 않는다", () => {
    expect(visit(browserRequest({}, "nmv_visitor=abc"))).toEqual({ ok: false, reason: "no_consent" });
    expect(visit(browserRequest({}, "nmv_visitor=abc"), "auto")).toEqual({ ok: false, reason: "no_consent" });
    expect(visit(browserRequest({}, "_ga=GA1.1.broken"))).toEqual({ ok: false, reason: "no_consent" });
  });

  it("크롤러는 보내지 않는다", () => {
    expect(visit(cliRequest("Googlebot/2.1 (+http://www.google.com/bot.html)"), "auto")).toEqual({ ok: false, reason: "bot" });
    expect(visit(cliRequest("Slackbot-LinkExpanding 1.0"), "aggregate")).toEqual({ ok: false, reason: "bot" });
  });
});

describe("목록 검사 — 서버는 목록에 있는 이름·매개변수만", () => {
  const request = browserRequest();
  const build = (name: string, params: Record<string, unknown>) =>
    buildServerEvent(name as AnalyticsEventName, params as never, { request, identity: "browser" }, { env: ENV, now: NOW });

  it("모르는 이름·브라우저 전용 이름은 보내지 않는다", () => {
    expect(build("checkin", {})).toEqual({ ok: false, reason: "unknown_event" });
    expect(build("outbound_click", { link_kind: "site", product_slug: "app", surface: "product" })).toEqual({ ok: false, reason: "client_event" });
  });

  it("빠진 값·남는 값·틀린 꼴·허용 밖 값은 통째로 거절한다", () => {
    expect(build("outbound_visit", { product_slug: "app" })).toEqual({ ok: false, reason: "invalid_params" });
    expect(build("outbound_visit", { product_slug: "app", link_kind: "site", email: "me@example.com" })).toEqual({ ok: false, reason: "invalid_params" });
    expect(build("outbound_visit", { product_slug: "app", link_kind: "web" })).toEqual({ ok: false, reason: "invalid_params" });
    expect(build("reaction_add", { product_slug: "app", verdict: "good", reaction_source: "panel", signed_in: true })).toEqual({ ok: false, reason: "invalid_params" });
  });

  it("서버가 보내는 이벤트의 매개변수는 문자열·숫자뿐이다(MP 는 참거짓을 받지 않는다)", () => {
    const serverEvents = ANALYTICS_EVENT_NAMES.filter((name) => ANALYTICS_EVENT_CATALOG[name].source !== "client");
    expect(serverEvents).toEqual(expect.arrayContaining(["outbound_visit", "skill_script_download", "launch_submitted", "product_claimed",
      "github_connected", "login", "sign_up", "verify_requested", "verify_succeeded", "badge_impression", "reaction_add", "feedback_received"]));
    for (const name of serverEvents) {
      for (const [key, spec] of Object.entries(ANALYTICS_EVENT_CATALOG[name].params)) expect(["string", "number"], `${name}.${key}`).toContain((spec as { kind: string }).kind);
    }
  });
});

describe("개인정보 — 보내는 꼴에 없어야 하는 것", () => {
  it("IP·User-Agent·쿠키 원문·이메일·세션 토큰·질의가 실리지 않고, 매개변수 키는 목록과 운반 값뿐이다", () => {
    const transport = ["id_source", "session_id", "engagement_time_msec", "traffic_type", "debug_mode"];
    for (const [name, params] of [
      ["outbound_visit", { product_slug: "app", link_kind: "site", via: "card" }],
      ["reaction_add", { product_slug: "app", verdict: "good", reaction_source: "panel", signed_in: "yes" }],
      ["feedback_received", { product_slug: "app", feedback_kind: "bug" }],
      ["sign_up", { method: "github" }],
    ] as const) {
      const payload = okPayload(buildServerEvent(name, params as never, { request: browserRequest(), identity: "browser", userId: 42 }, { env: { ...ENV, GA_DEBUG: "1" }, now: NOW }));
      const text = JSON.stringify(payload);
      for (const secret of ["203.0.113.7", "Mozilla", "Chrome", "me@example.com", "opaque-session-token", "GA1.1.", "GS2.1.", "nmv_user", "q=", "\"42\""]) {
        expect(text, `${name} ${secret}`).not.toContain(secret);
      }
      expect(Object.keys(payload).sort()).toEqual(["client_id", "consent", "events", "non_personalized_ads", "timestamp_micros", "user_id"]);
      const allowed = [...Object.keys(ANALYTICS_EVENT_CATALOG[name].params), ...transport];
      for (const key of Object.keys(payload.events[0].params)) expect(allowed, `${name}.${key}`).toContain(key);
    }
  });

  it("값 안의 이메일·토큰 같은 조각은 PR A 의 sanitize 가 지운다", () => {
    const payload = okPayload(buildServerEvent("outbound_visit", { product_slug: "me@example.com", link_kind: "site", via: "x" },
      { request: browserRequest(), identity: "browser" }, { env: ENV, now: NOW }));
    expect(JSON.stringify(payload)).not.toContain("example.com");
  });
});

describe("trackServer — 기다리지 않고 던지지 않는다", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("설정이 없으면 아무것도 보내지 않는다", () => {
    vi.stubEnv("GA_MEASUREMENT_ID", "");
    vi.stubEnv("GA_API_SECRET", "");
    trackServer("outbound_visit", { product_slug: "app", link_kind: "site" }, { request: browserRequest(), identity: "browser" });
    vi.stubEnv("GA_MEASUREMENT_ID", MEASUREMENT_ID);
    trackServer("outbound_visit", { product_slug: "app", link_kind: "site" }, { request: browserRequest(), identity: "browser" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("켜져 있으면 POST 한 번, 시간 상한(signal)과 함께 — 돌려받는 것은 없다", async () => {
    vi.stubEnv("GA_MEASUREMENT_ID", MEASUREMENT_ID);
    vi.stubEnv("GA_API_SECRET", API_SECRET);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const returned = trackServer("verify_requested", { product_slug: "app" }, { request: cliRequest(), identity: "auto" });
    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${MP_COLLECT_URL}?measurement_id=${MEASUREMENT_ID}&api_secret=`)).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body)).events[0].name).toBe("verify_requested");
  });

  it("GA 가 실패하거나 멈춰도 던지지 않고, API 비밀을 로그에 남기지 않는다", async () => {
    vi.stubEnv("GA_MEASUREMENT_ID", MEASUREMENT_ID);
    vi.stubEnv("GA_API_SECRET", API_SECRET);
    const logged: unknown[] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) vi.spyOn(logger, level).mockImplementation((...args) => { logged.push(args); });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(new Response("bad", { status: 400 }));
    expect(() => trackServer("verify_requested", { product_slug: "app" }, { request: cliRequest(), identity: "auto" })).not.toThrow();
    expect(() => trackServer("verify_requested", { product_slug: "app" }, { request: cliRequest(), identity: "auto" })).not.toThrow();
    await vi.waitFor(() => expect(logged.length).toBe(2));
    expect(JSON.stringify(logged)).not.toContain(API_SECRET);
    expect(JSON.stringify(logged)).toContain("analytics.mp_rejected");
  });

  it("목록에 없는 꼴은 보내지 않고 경고 한 줄", () => {
    vi.stubEnv("GA_MEASUREMENT_ID", MEASUREMENT_ID);
    vi.stubEnv("GA_API_SECRET", API_SECRET);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    trackServer("outbound_visit", { product_slug: "app" } as never, { request: browserRequest(), identity: "browser" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("analytics.server_event_refused", { event: "outbound_visit", reason: "invalid_params" });
  });
});

describe("받아 간 쪽의 갈래", () => {
  it("curl·wget·브라우저·그 밖, 크롤러는 bot", () => {
    expect(agentClass("curl/8.7.1")).toBe("curl");
    expect(agentClass("Wget/1.21.4")).toBe("wget");
    expect(agentClass(CHROME)).toBe("browser");
    expect(agentClass("node")).toBe("other");
    expect(agentClass(null)).toBe("other");
    expect(agentClass("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe("bot");
    expect(agentClass("python-requests/2.32")).toBe("bot");
  });
});

describe("운영센터의 GA 바로가기", () => {
  it("analytics.google.com 주소만 받는다", () => {
    expect(analyticsPropertyUrl(undefined)).toBeNull();
    expect(analyticsPropertyUrl(" ")).toBeNull();
    expect(analyticsPropertyUrl("https://evil.example/analytics")).toBeNull();
    expect(analyticsPropertyUrl("http://analytics.google.com/analytics/web/")).toBeNull();
    expect(analyticsPropertyUrl("https://user:pw@analytics.google.com/")).toBeNull();
    expect(analyticsPropertyUrl("https://analytics.google.com/analytics/web/#/p123456789/reports/intelligenthome"))
      .toBe("https://analytics.google.com/analytics/web/#/p123456789/reports/intelligenthome");
  });
});
