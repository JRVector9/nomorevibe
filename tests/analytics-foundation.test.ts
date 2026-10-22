import { describe, expect, expectTypeOf, it } from "vitest";
import { analyticsConfig, analyticsEnabled, parseMeasurementId } from "@/lib/analytics/config";
import { ANALYTICS_OPT_OUT_KEY, CONSENT_DENIED_REGIONS, consentDefaultCommands, decideConsent, isRestrictedTimeZone, readConsentSignals } from "@/lib/analytics/consent";
import { ANALYTICS_EVENT_CATALOG, ANALYTICS_EVENT_NAMES, isAnalyticsEventName, type AnalyticsEvent, type AnalyticsEventParams } from "@/lib/analytics/events";
import { isAnalyticsExcludedPath, pageLocale, pageType } from "@/lib/analytics/routes";
import { FORBIDDEN_PARAM_KEYS, sanitizeParams, sanitizePath, sanitizeSearch, sanitizeSearchTerm, sanitizeUrl } from "@/lib/analytics/sanitize";

const ORIGIN = "https://nomorevibe.com";

describe("설정 — 실행 중 환경에서 읽는다", () => {
  it("GA_MEASUREMENT_ID 가 없거나 꼴이 틀리면 꺼진다", () => {
    expect(analyticsConfig({})).toEqual({ measurementId: null, debug: false });
    expect(analyticsConfig({ GA_MEASUREMENT_ID: "" }).measurementId).toBeNull();
    expect(analyticsConfig({ GA_MEASUREMENT_ID: "UA-12345-1" }).measurementId).toBeNull();
    expect(analyticsConfig({ GA_MEASUREMENT_ID: "G-" }).measurementId).toBeNull();
    expect(analyticsConfig({ GA_MEASUREMENT_ID: "G-ABC<script>" }).measurementId).toBeNull();
    expect(analyticsEnabled({})).toBe(false);
  });

  it("G-XXXXXXXXXX 는 공백을 걷고 대문자로 받는다", () => {
    expect(parseMeasurementId(" g-ab12cd34ef ")).toBe("G-AB12CD34EF");
    expect(analyticsConfig({ GA_MEASUREMENT_ID: "G-AB12CD34EF" }).measurementId).toBe("G-AB12CD34EF");
    expect(analyticsEnabled({ GA_MEASUREMENT_ID: "G-AB12CD34EF" })).toBe(true);
  });

  it("GA_DEBUG=1 일 때만 디버그", () => {
    expect(analyticsConfig({ GA_DEBUG: "1" }).debug).toBe(true);
    expect(analyticsConfig({ GA_DEBUG: "true" }).debug).toBe(false);
    expect(analyticsConfig({ GA_DEBUG: "0" }).debug).toBe(false);
  });

  it("NEXT_PUBLIC_ 변수는 읽지 않는다 — 빌드 때 박히면 운영에서 켤 수 없다", () => {
    expect(analyticsConfig({ NEXT_PUBLIC_GA_MEASUREMENT_ID: "G-AB12CD34EF" }).measurementId).toBeNull();
  });
});

describe("공개 화면에서만 — 관리자·기계용·콜백 주소는 뺀다", () => {
  it.each([
    "/admin", "/admin/status", "/admin/login", "/api/me", "/api/auth/github/callback", "/go/some-product", "/go/x?via=card",
    "/badge/foo", "/oauth/callback", "/webhooks/x", "/feed.xml", "/sitemap.xml", "/install.sh", "/skill.md", "/en/admin",
    "/en/api/me", "/_next/static/chunk.js", "/robots.txt",
  ])("%s 는 보내지 않는다", (path) => {
    expect(isAnalyticsExcludedPath(path)).toBe(true);
  });

  it.each(["/", "/en", "/zh-Hans/p/foo", "/p/foo", "/c/dev", "/talk", "/popular", "/rising", "/rankings/weekly", "/launch",
    "/policy", "/me", "/me/account", "/login", "/feedback/2b1c4f5e-1111-4222-8333-944455556666", "/p/foo/github"])("%s 는 보낸다", (path) => {
    expect(isAnalyticsExcludedPath(path)).toBe(false);
  });
});

describe("page_type — 주소에서 화면 갈래", () => {
  it.each([
    ["/", "", "home"], ["/en", "", "home"], ["/", "?q=pdf", "search"], ["/", "?q=%20", "home"], ["/", "?category=Dev", "browse"],
    ["/", "?new=1", "browse"], ["/c/dev", "", "browse"], ["/zh-Hant/c/dev", "", "browse"], ["/p/foo", "", "product"],
    ["/en/p/foo/", "", "product"], ["/p/foo/github", "", "product_settings"], ["/talk", "", "talk"], ["/popular", "", "popular"],
    ["/rising", "", "rising"], ["/rankings/weekly", "", "rankings"], ["/launch", "", "launch"], ["/policy", "", "policy"],
    ["/me", "", "me"], ["/me/tried", "", "me"], ["/login", "", "login"], ["/feedback/abc", "", "feedback"], ["/nope", "", "other"],
  ] as const)("%s%s → %s", (path, search, expected) => {
    expect(pageType(path, search)).toBe(expected);
  });

  it("언어는 주소 접두에서, 없으면 한국어", () => {
    expect(pageLocale("/")).toBe("ko");
    expect(pageLocale("/p/foo")).toBe("ko");
    expect(pageLocale("/en/p/foo")).toBe("en");
    expect(pageLocale("/zh-Hans")).toBe("zh-Hans");
  });
});

describe("주소 정리 — 질의는 허용 목록만, # 뒤는 버린다", () => {
  it("via·utm_*·tab·sort·new 만 남는다", () => {
    expect(sanitizeSearch("?via=card&utm_source=x&utm_campaign=launch&tab=week&sort=stars&new=1")).toBe(
      "?via=card&utm_source=x&utm_campaign=launch&tab=week&sort=stars&new=1");
    expect(sanitizeSearch("?q=my+secret&returnTo=%2Fme&token=abc&email=a%40b.com&category=Dev&code=12345678")).toBe("");
  });

  it("비밀이 든 주소는 질의와 #을 잃는다", () => {
    expect(sanitizeUrl(`${ORIGIN}/login?returnTo=%2Fme%3Ftoken%3Dabc&via=header#access_token=xyz`, ORIGIN)).toBe(`${ORIGIN}/login?via=header`);
    expect(sanitizeUrl(`${ORIGIN}/?q=alice%40example.com&utm_source=newsletter`, ORIGIN)).toBe(`${ORIGIN}/?utm_source=newsletter`);
  });

  it("허용된 값 안의 이메일도 지운다", () => {
    expect(sanitizeSearch("?utm_source=alice@example.com")).toBe("");
  });

  it("바깥 주소는 origin+경로만", () => {
    expect(sanitizeUrl("https://news.ycombinator.com/item?id=123&auth=secret#x", ORIGIN)).toBe("https://news.ycombinator.com/item");
    expect(sanitizeUrl("javascript:alert(1)", ORIGIN)).toBe("");
    // 앞 화면이 없으면(document.referrer 가 빈 값) 보내지 않는다 — 사이트 첫 화면으로 바뀌면 안 된다
    expect(sanitizeUrl("", ORIGIN)).toBe("");
  });

  it("경로만 꺼낸다", () => {
    expect(sanitizePath("/p/foo?x=1#y")).toBe("/p/foo");
    expect(sanitizePath("")).toBe("/");
  });
});

describe("검색어 — 소문자, 길이 제한, 개인정보 지움", () => {
  it("소문자·공백 하나·64자", () => {
    expect(sanitizeSearchTerm("  PDF   Editor ")).toBe("pdf editor");
    expect(sanitizeSearchTerm("a".repeat(200))).toHaveLength(64);
  });

  it("이메일·전화·코드·토큰은 지우고 남는 것이 없으면 보내지 않는다", () => {
    expect(sanitizeSearchTerm("contact alice@example.com")).toBe("contact");
    expect(sanitizeSearchTerm("010-1234-5678")).toBeNull();
    expect(sanitizeSearchTerm("12345678")).toBeNull();
    expect(sanitizeSearchTerm("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBeNull();
    expect(sanitizeSearchTerm("   ")).toBeNull();
    expect(sanitizeSearchTerm(42)).toBeNull();
  });

  it("짧은 숫자와 하이픈 slug 는 그대로", () => {
    expect(sanitizeSearchTerm("gpt 4o")).toBe("gpt 4o");
    expect(sanitizeSearchTerm("awesome-claude-code-subagents-collection")).toBe("awesome-claude-code-subagents-collection");
  });
});

describe("매개변수 정리 — 금지 키·객체 값·긴 값", () => {
  it("금지 키는 값과 상관없이 버린다", () => {
    const clean = sanitizeParams({ email: "a@b.com", user_id: "1", token: "x", ip: "1.2.3.4", name: "Alice", q: "secret", product_slug: "foo" });
    expect(clean).toEqual({ product_slug: "foo" });
  });

  it("객체·배열·NaN·빈 문자열은 버리고, 100자로 자른다", () => {
    const clean = sanitizeParams({ a: { x: 1 }, b: [1], c: Number.NaN, d: "", e: "x".repeat(150), f: 3, g: true });
    expect(clean).toEqual({ e: "x".repeat(100), f: 3, g: true });
  });

  it("주소 값은 sanitizeUrl 을 거친다(page_location 은 1000자까지)", () => {
    const clean = sanitizeParams({ page_location: `${ORIGIN}/p/foo?returnTo=x&via=card#t`, link: "https://evil.example/x?secret=1" }, ORIGIN);
    expect(clean).toEqual({ page_location: `${ORIGIN}/p/foo?via=card`, link: "https://evil.example/x" });
  });

  it("값 속 이메일은 지운다", () => {
    expect(sanitizeParams({ copy_target: "mail alice@example.com" })).toEqual({ copy_target: "mail" });
  });
});

describe("동의 — 광고는 늘 거부, 분석은 끄기·GPC·DNT·지역이면 불러오지 않는다", () => {
  const base = { optOut: false, gpc: false, dnt: false, timeZone: "Asia/Seoul" };

  it("아무 신호가 없으면 불러온다", () => {
    expect(decideConsent(base)).toEqual({ load: true, reason: null });
    expect(decideConsent({ ...base, timeZone: null })).toEqual({ load: true, reason: null });
    expect(decideConsent({ ...base, timeZone: "America/New_York" })).toEqual({ load: true, reason: null });
  });

  it("끄기 → GPC → DNT → 지역 순으로 이유를 댄다", () => {
    expect(decideConsent({ ...base, optOut: true, gpc: true })).toEqual({ load: false, reason: "opt_out" });
    expect(decideConsent({ ...base, gpc: true, dnt: true })).toEqual({ load: false, reason: "gpc" });
    expect(decideConsent({ ...base, dnt: true })).toEqual({ load: false, reason: "dnt" });
    expect(decideConsent({ ...base, timeZone: "Europe/Berlin" })).toEqual({ load: false, reason: "region" });
  });

  it("유럽 경제 지역·영국·스위스 시간대를 넓게 잡는다", () => {
    for (const zone of ["Europe/London", "Europe/Zurich", "Europe/Paris", "Atlantic/Reykjavik", "Atlantic/Canary", "Indian/Reunion", "GB", "CET"]) {
      expect(isRestrictedTimeZone(zone)).toBe(true);
    }
    for (const zone of ["Asia/Seoul", "Asia/Shanghai", "Asia/Taipei", "America/Los_Angeles", "UTC", "", null]) {
      expect(isRestrictedTimeZone(zone)).toBe(false);
    }
  });

  it("gtag 기본값: 지역 목록은 analytics_storage 거부, 나머지는 허용 — 광고 셋은 어디서나 거부", () => {
    const [regional, global] = consentDefaultCommands();
    expect(regional).toMatchObject({ analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
    expect(regional.region).toEqual(CONSENT_DENIED_REGIONS);
    expect(global).toEqual({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" });
    expect(CONSENT_DENIED_REGIONS).toHaveLength(32);
    for (const code of ["DE", "FR", "IE", "GB", "CH", "NO", "IS", "LI"]) expect(CONSENT_DENIED_REGIONS).toContain(code);
  });

  it("브라우저 신호를 읽는다 — 저장소가 던져도 멈추지 않는다", () => {
    const store = new Map([[ANALYTICS_OPT_OUT_KEY, "1"]]);
    expect(readConsentSignals({ navigator: { globalPrivacyControl: true, doNotTrack: "1" }, localStorage: { getItem: (key) => store.get(key) ?? null } }))
      .toMatchObject({ optOut: true, gpc: true, dnt: true });
    expect(readConsentSignals({ navigator: {}, doNotTrack: "1", localStorage: { getItem: () => { throw new Error("blocked"); } } }))
      .toMatchObject({ optOut: false, gpc: false, dnt: true });
    expect(readConsentSignals({ navigator: { doNotTrack: "0", globalPrivacyControl: "true" } })).toMatchObject({ gpc: false, dnt: false });
  });
});

describe("이벤트 목록", () => {
  it("이름은 snake_case 40자 이하, 매개변수는 25개 이하·40자 이하", () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      const params = Object.keys(ANALYTICS_EVENT_CATALOG[name].params);
      expect(params.length).toBeLessThanOrEqual(25);
      for (const param of params) expect(param).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    }
  });

  it("GA4 추천 이름을 쓴다", () => {
    for (const name of ["page_view", "select_item", "search", "share", "login", "sign_up", "select_content"]) {
      expect(isAnalyticsEventName(name)).toBe(true);
    }
    expect(isAnalyticsEventName("toString")).toBe(false);
    expect(isAnalyticsEventName("pageview")).toBe(false);
  });

  it("서버가 보내는 이벤트도 같은 목록에 있다", () => {
    for (const name of ["outbound_visit", "skill_script_download", "launch_submitted", "product_claimed", "github_connected"] as const) {
      expect(ANALYTICS_EVENT_CATALOG[name].source).toBe("server");
    }
  });

  it("어느 이벤트에도 금지 키가 없다 — 개인정보·자격·자유 입력", () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      for (const param of Object.keys(ANALYTICS_EVENT_CATALOG[name].params)) {
        expect(FORBIDDEN_PARAM_KEYS, `${name}.${param}`).not.toContain(param);
        expect(param, `${name}.${param}`).not.toMatch(/email|token|password|secret|(^|_)ip($|_)|user_id|^(user_|first_|last_|full_|display_|nick)?name$/);
      }
    }
  });

  it("타입이 이름과 매개변수를 묶는다", () => {
    expectTypeOf<AnalyticsEventParams["outbound_click"]["link_kind"]>().toEqualTypeOf<"site" | "repo">();
    expectTypeOf<Extract<AnalyticsEvent, { name: "select_item" }>["params"]>().toEqualTypeOf<AnalyticsEventParams["select_item"]>();
    // @ts-expect-error — 목록에 없는 매개변수는 막힌다
    const wrong: AnalyticsEventParams["github_click"] = { product_slug: "foo", surface: "product", email: "a@b.com" };
    expect(wrong).toBeTruthy();
  });
});
