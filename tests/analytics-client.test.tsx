import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsSnapshot, resetAnalyticsForTests, setAnalyticsOptOut, track, trackPageView } from "@/lib/analytics/client";
import { resetAnalyticsRuntimeForTests, startAnalytics } from "@/lib/analytics/runtime";
import { ANALYTICS_OPT_OUT_KEY } from "@/lib/analytics/consent";
import { FORBIDDEN_PARAM_KEYS } from "@/lib/analytics/sanitize";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

const ID = "G-TEST123456";

type FakeOptions = { path?: string; search?: string; title?: string; referrer?: string; gpc?: boolean; dnt?: string; optOut?: boolean };

/** 브라우저 흉내 — gtag 가 dataLayer 에 넣은 명령과 쿠키 쓰기를 모은다 */
function fakeWindow(options: FakeOptions = {}) {
  const store = new Map<string, string>(options.optOut ? [[ANALYTICS_OPT_OUT_KEY, "1"]] : []);
  const cookieWrites: string[] = [];
  let cookieJar = "_ga=GA1.1.123; _ga_TEST123456=GS1.1; other=1";
  const win: Record<string, unknown> = {
    location: {
      origin: "https://nomorevibe.com", hostname: "nomorevibe.com", pathname: options.path ?? "/p/foo", search: options.search ?? "",
      get href() { return `https://nomorevibe.com${(win.location as { pathname: string }).pathname}${(win.location as { search: string }).search}`; },
    },
    document: {
      title: options.title ?? "Foo — nomorevibe", referrer: options.referrer ?? "",
      get cookie() { return cookieJar; },
      set cookie(value: string) { cookieWrites.push(value); if (/Max-Age=0/.test(value)) cookieJar = cookieJar.split("; ").filter((part) => !part.startsWith(`${value.split("=", 1)[0]}=`)).join("; "); },
    },
    navigator: { globalPrivacyControl: options.gpc ?? false, doNotTrack: options.dnt ?? null },
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } },
  };
  vi.stubGlobal("window", win);
  /** gtag 명령을 [명령, 인자…] 배열로 */
  const commands = () => ((win.dataLayer as IArguments[] | undefined) ?? []).map((entry) => Array.from(entry));
  const events = () => commands().filter(([command]) => command === "event");
  return { win, store, cookieWrites, commands, events };
}

beforeEach(() => {
  resetAnalyticsForTests();
  resetAnalyticsRuntimeForTests();
  vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({ resolvedOptions: () => ({ timeZone: "Asia/Seoul" }) } as unknown as Intl.DateTimeFormat);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GA 가 꺼져 있으면 아무것도 하지 않는다", () => {
  it("측정 ID 가 없으면 gtag·dataLayer 를 만들지 않고 track 은 조용히 끝난다", () => {
    const { win } = fakeWindow();
    expect(startAnalytics({ measurementId: null, debug: false, devLog: false })).toEqual({ loadScript: false });
    track("github_click", { product_slug: "foo", surface: "product" });
    trackPageView();
    expect(win.dataLayer).toBeUndefined();
    expect(win.gtag).toBeUndefined();
    expect(analyticsSnapshot()).toEqual({ status: "off", reason: "disabled" });
  });

  it("로더가 아직 없으면(GA 꺼짐) 모아만 두고 보내지 않는다", () => {
    const { win } = fakeWindow();
    track("github_click", { product_slug: "foo", surface: "product" });
    expect(win.dataLayer).toBeUndefined();
  });

  it("브라우저가 아니어도(서버) 던지지 않는다", () => {
    expect(() => track("nav_click", { target: "home", surface: "header" })).not.toThrow();
    expect(() => trackPageView()).not.toThrow();
    expect(() => setAnalyticsOptOut(true)).not.toThrow();
  });

  it("개발 중 GA_DEBUG=1 이면 보냈을 이벤트를 콘솔에만 찍는다", () => {
    const { win } = fakeWindow();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    startAnalytics({ measurementId: null, debug: true, devLog: true });
    track("outbound_click", { link_kind: "site", product_slug: "foo", surface: "product" });
    expect(debug).toHaveBeenCalledWith("[analytics]", "outbound_click", { link_kind: "site", product_slug: "foo", surface: "product" });
    expect(win.dataLayer).toBeUndefined();
  });
});

describe("켜져 있으면", () => {
  it("동의 기본값 → js → config(광고 신호 끔, 자동 page_view 끔) 차례로 넣고 스크립트를 부른다", () => {
    const { commands } = fakeWindow({ path: "/p/foo", search: "?returnTo=%2Fme&via=card" });
    expect(startAnalytics({ measurementId: ID, debug: false, devLog: false })).toEqual({ loadScript: true });
    const list = commands();
    expect(list[0]).toEqual(["consent", "default", expect.objectContaining({ analytics_storage: "denied", region: expect.arrayContaining(["DE", "GB", "CH"]) })]);
    expect(list[1]).toEqual(["consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" }]);
    const config = list.find(([command]) => command === "config")!;
    expect(config[1]).toBe(ID);
    expect(config[2]).toMatchObject({ send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
      page_location: "https://nomorevibe.com/p/foo?via=card" });
    expect(config[2]).not.toHaveProperty("debug_mode");
    expect(list).toContainEqual(["set", "ads_data_redaction", true]);
    // 로그인한 사람에게도 user_id 를 붙이지 않는다
    expect(JSON.stringify(list)).not.toContain("user_id");
  });

  it("GA_DEBUG 면 debug_mode 를 켠다", () => {
    const { commands } = fakeWindow();
    startAnalytics({ measurementId: ID, debug: true, devLog: false });
    expect(commands().find(([command]) => command === "config")![2]).toMatchObject({ debug_mode: true });
  });

  it("track 은 정리한 화면 주소와 beacon 을 붙여 보낸다 — 금지 키는 빠진다", () => {
    const { events } = fakeWindow({ path: "/p/foo", search: "?token=abc" });
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    track("outbound_click", { link_kind: "repo", product_slug: "foo", surface: "product", email: "a@b.com" } as never);
    const [, name, params] = events().at(-1)!;
    expect(name).toBe("outbound_click");
    expect(params).toEqual({ page_location: "https://nomorevibe.com/p/foo", link_kind: "repo", product_slug: "foo", surface: "product", transport_type: "beacon" });
  });

  it("select_item 은 GA 상품 보고서용 items 도 함께", () => {
    const { events } = fakeWindow({ path: "/" });
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    track("select_item", { item_list_id: "home_rising", item_list_name: "Rising", index: 2, item_id: "foo" });
    expect(events().at(-1)![2]).toMatchObject({ item_id: "foo", items: [{ item_id: "foo", item_list_id: "home_rising", item_list_name: "Rising", index: 2 }] });
  });

  it("로더보다 먼저 온 이벤트는 켜질 때 보낸다", () => {
    const { events } = fakeWindow();
    track("nav_click", { target: "home", surface: "header" });
    expect(events()).toHaveLength(0);
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    expect(events().map(([, name]) => name)).toEqual(["nav_click"]);
  });

  it("관리자·기계용 주소에서는 불러오지도 보내지도 않는다", () => {
    const { win } = fakeWindow({ path: "/admin/status" });
    expect(startAnalytics({ measurementId: ID, debug: false, devLog: false })).toEqual({ loadScript: false });
    track("nav_click", { target: "home", surface: "header" });
    expect(win.dataLayer).toBeUndefined();
  });

  it("gtag 가 던져도 track 은 던지지 않는다", () => {
    const { win } = fakeWindow();
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    win.gtag = () => { throw new Error("boom"); };
    expect(() => track("nav_click", { target: "home", surface: "header" })).not.toThrow();
    expect(() => trackPageView({ pathname: "/talk", search: "" })).not.toThrow();
  });
});

describe("page_view", () => {
  it("주소·경로·제목·언어·갈래를 싣고, 같은 주소를 잇달아 부르면 한 번만", () => {
    const { win, events } = fakeWindow({ path: "/en/p/foo", search: "?via=x&q=secret", referrer: "https://news.ycombinator.com/item?id=1" });
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    trackPageView();
    trackPageView();
    const views = events().filter(([, name]) => name === "page_view");
    expect(views).toHaveLength(1);
    expect(views[0][2]).toEqual({ page_location: "https://nomorevibe.com/en/p/foo?via=x", page_path: "/en/p/foo", page_title: "Foo — nomorevibe",
      page_referrer: "https://news.ycombinator.com/item", locale: "en", page_type: "product", transport_type: "beacon" });
    // 앱 안 이동 — 앞 화면이 page_referrer 가 된다
    (win.location as { pathname: string }).pathname = "/en/talk";
    (win.document as { title: string }).title = "Talk — nomorevibe";
    trackPageView({ pathname: "/en/talk", search: "" });
    expect(events().at(-1)![2]).toMatchObject({ page_location: "https://nomorevibe.com/en/talk", page_referrer: "https://nomorevibe.com/en/p/foo?via=x",
      page_type: "talk", page_title: "Talk — nomorevibe" });
  });

  it("홈에서 검색으로 바뀌면 주소가 같아도 다시 센다(검색어는 주소에 싣지 않는다)", () => {
    const { events } = fakeWindow({ path: "/" });
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    trackPageView({ pathname: "/", search: "" });
    trackPageView({ pathname: "/", search: "?q=pdf" });
    const views = events().filter(([, name]) => name === "page_view");
    expect(views.map(([, , params]) => [params.page_location, params.page_type])).toEqual([
      ["https://nomorevibe.com/", "home"], ["https://nomorevibe.com/", "search"]]);
  });

  it("보내는 매개변수에 금지 키가 없다", () => {
    const { events } = fakeWindow({ path: "/login", search: "?returnTo=%2Fme" });
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    trackPageView();
    for (const [, , params] of events()) {
      for (const key of Object.keys(params)) expect(FORBIDDEN_PARAM_KEYS).not.toContain(key);
      expect(JSON.stringify(params)).not.toContain("returnTo");
    }
  });
});

describe("동의 — 꺼진 방문자에게는 gtag 를 불러오지 않는다", () => {
  it.each([
    [{ gpc: true }, "gpc"], [{ dnt: "1" }, "dnt"], [{ optOut: true }, "opt_out"],
  ] as const)("%o → %s", (options, reason) => {
    const { win } = fakeWindow(options);
    expect(startAnalytics({ measurementId: ID, debug: false, devLog: false })).toEqual({ loadScript: false });
    expect(analyticsSnapshot()).toEqual({ status: "off", reason });
    track("nav_click", { target: "home", surface: "header" });
    expect(win.dataLayer).toBeUndefined();
  });

  it("유럽 시간대면 불러오지 않는다", () => {
    vi.mocked(Intl.DateTimeFormat).mockReturnValue({ resolvedOptions: () => ({ timeZone: "Europe/Berlin" }) } as unknown as Intl.DateTimeFormat);
    const { win } = fakeWindow();
    expect(startAnalytics({ measurementId: ID, debug: false, devLog: false })).toEqual({ loadScript: false });
    expect(analyticsSnapshot()).toEqual({ status: "off", reason: "region" });
    expect(win.dataLayer).toBeUndefined();
  });

  it("끄기를 누르면 그 자리에서 거부로 바꾸고 GA 를 멈추고 쿠키를 지운다 — 다시 켜면 돌아온다", () => {
    const { win, store, commands, cookieWrites } = fakeWindow();
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    setAnalyticsOptOut(true);
    expect(store.get(ANALYTICS_OPT_OUT_KEY)).toBe("1");
    expect(commands().at(-1)).toEqual(["consent", "update", { analytics_storage: "denied" }]);
    expect(win[`ga-disable-${ID}`]).toBe(true);
    expect(cookieWrites.some((value) => value.startsWith("_ga=; Max-Age=0") && value.includes("Domain=.nomorevibe.com"))).toBe(true);
    expect(cookieWrites.some((value) => value.startsWith("_ga_TEST123456=; Max-Age=0"))).toBe(true);
    expect(cookieWrites.some((value) => value.startsWith("other="))).toBe(false);
    expect(analyticsSnapshot()).toEqual({ status: "off", reason: "opt_out" });
    const before = commands().length;
    track("nav_click", { target: "home", surface: "header" });
    expect(commands()).toHaveLength(before);

    setAnalyticsOptOut(false);
    expect(store.has(ANALYTICS_OPT_OUT_KEY)).toBe(false);
    expect(win[`ga-disable-${ID}`]).toBe(false);
    expect(commands()).toContainEqual(["consent", "update", { analytics_storage: "granted" }]);
    expect(analyticsSnapshot()).toEqual({ status: "on", reason: null });
  });

  it("GPC 가 있으면 다시 켜기를 눌러도 켜지지 않는다", () => {
    const { win } = fakeWindow({ gpc: true, optOut: true });
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    setAnalyticsOptOut(false);
    expect(analyticsSnapshot()).toEqual({ status: "off", reason: "gpc" });
    expect(win.dataLayer).toBeUndefined();
  });
});

describe("화면", () => {
  it("측정 ID 가 없으면 로더를 그리지 않는다", async () => {
    vi.stubEnv("GA_MEASUREMENT_ID", "");
    vi.stubEnv("GA_DEBUG", "");
    const { GoogleAnalytics } = await import("@/components/analytics/GoogleAnalytics");
    expect(GoogleAnalytics()).toBeNull();
    vi.unstubAllEnvs();
  });

  it("측정 ID 가 있으면 로더에 ID 를 넘긴다 — 서버 HTML 에는 gtag 가 없다(동의를 본 뒤 브라우저가 부른다)", async () => {
    vi.stubEnv("GA_MEASUREMENT_ID", ID);
    const { GoogleAnalytics } = await import("@/components/analytics/GoogleAnalytics");
    const element = GoogleAnalytics();
    expect(element?.props).toMatchObject({ measurementId: ID, debug: false, devLog: false });
    expect(renderToStaticMarkup(element!)).not.toContain("googletagmanager");
    vi.unstubAllEnvs();
  });

  it("끄기 단추는 서버 HTML 에 그리지 않는다(상태는 브라우저만 안다)", async () => {
    const { AnalyticsOptOut } = await import("@/components/analytics/AnalyticsOptOut");
    expect(renderToStaticMarkup(<AnalyticsOptOut variant="footer" enabled />)).toBe("");
    expect(renderToStaticMarkup(<AnalyticsOptOut variant="policy" enabled />)).toBe("");
  });

  it("상태 문구 — 켜짐·끔·신호·지역·쓰지 않음", async () => {
    const { optOutStatusKey } = await import("@/components/analytics/AnalyticsOptOut");
    expect(optOutStatusKey({ status: "on", reason: null }, true)).toBe("analytics.statusOn");
    expect(optOutStatusKey({ status: "off", reason: "opt_out" }, true)).toBe("analytics.statusOptOut");
    expect(optOutStatusKey({ status: "off", reason: "gpc" }, true)).toBe("analytics.statusGpc");
    expect(optOutStatusKey({ status: "off", reason: "dnt" }, true)).toBe("analytics.statusDnt");
    expect(optOutStatusKey({ status: "off", reason: "region" }, true)).toBe("analytics.statusRegion");
    expect(optOutStatusKey({ status: "pending", reason: null }, false)).toBe("analytics.statusDisabled");
    expect(optOutStatusKey({ status: "pending", reason: null }, true)).toBeNull();
  });
});

describe("이동 뒤 제목 기다리기", () => {
  function fakeDom(title: string) {
    const observers: Array<() => void> = [];
    const doc = { title, head: {} };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("MutationObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
    return { doc, mutate: (next: string) => { doc.title = next; for (const callback of observers) callback(); } };
  }

  it("제목이 이미 바뀌었으면 바로, 아니면 바뀔 때, 끝내 안 바뀌면 1초 뒤 한 번", async () => {
    vi.useFakeTimers();
    const { afterTitleSettles } = await import("@/components/analytics/AnalyticsLoader");
    const run = vi.fn();

    fakeDom("New — nomorevibe");
    afterTitleSettles("Old — nomorevibe", run);
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);

    const dom = fakeDom("Old — nomorevibe");
    afterTitleSettles("Old — nomorevibe", run);
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
    dom.mutate("Next — nomorevibe");
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    expect(run).toHaveBeenCalledTimes(2);

    fakeDom("Same — nomorevibe");
    afterTitleSettles("Same — nomorevibe", run);
    vi.advanceTimersByTime(999);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(3);

    // 다음 이동이 먼저 오면 앞의 것은 보내지 않는다
    fakeDom("Same — nomorevibe");
    const cancel = afterTitleSettles("Same — nomorevibe", run);
    cancel();
    vi.advanceTimersByTime(2_000);
    expect(run).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("첫 로드 묶음", () => {
  it("track 이 든 client.ts 는 정리·동의·gtag 코드(runtime)를 값으로 끌어오지 않는다 — GA 가 꺼진 방문자는 받지 않는다", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/analytics/client.ts", "utf8");
    const valueImports = [...source.matchAll(/^import (?!type )[^;]+ from "([^"]+)";/gm)].map((match) => match[1]);
    expect(valueImports).toEqual(["@/lib/analytics/opt-out-key"]);
    const loader = readFileSync("components/analytics/AnalyticsLoader.tsx", "utf8");
    expect(loader).not.toMatch(/^import [^;]+ from "@\/lib\/analytics\/runtime";/m);
    expect(loader).not.toMatch(/from "next\/script"/);
  });
});
