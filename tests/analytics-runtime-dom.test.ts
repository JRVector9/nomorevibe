import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAnalyticsForTests, setAnalyticsOptOut, track, trackPageView } from "@/lib/analytics/client";
import { resetAnalyticsRuntimeForTests, startAnalytics } from "@/lib/analytics/runtime";
import { parseMarkup, type MarkupNode } from "./analytics-markup";

/**
 * 방문 분석 런타임이 화면 표시를 읽는 일(2026-10-22) — 문서 클릭 듣개, data-track-view 관찰, 검색어 정리, 화면이 밝힌 갈래.
 * DOM 없이: 문서·관찰자를 흉내 내고, 클릭 대상은 그린 HTML 의 나무(tests/analytics-markup.ts)를 쓴다.
 */

const ID = "G-TEST123456";

function fakeBrowser(pathname: string, page: MarkupNode = parseMarkup("")) {
  const listeners = new Map<string, (event: unknown) => void>();
  let observerCallback: ((entries: Array<{ isIntersecting: boolean; target: MarkupNode }>) => void) | null = null;
  const observed: MarkupNode[] = [];
  const win: Record<string, unknown> = {
    location: { origin: "https://nomorevibe.com", hostname: "nomorevibe.com", pathname, search: "", href: `https://nomorevibe.com${pathname}` },
    document: {
      title: "t", referrer: "", cookie: "",
      addEventListener: (type: string, handler: (event: unknown) => void) => { listeners.set(type, handler); },
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => page.querySelectorAll(selector),
      querySelector: (selector: string) => page.querySelectorAll(selector)[0] ?? null,
    },
    navigator: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout: () => 0,
    IntersectionObserver: class {
      constructor(callback: typeof observerCallback) { observerCallback = callback; }
      observe(target: MarkupNode) { observed.push(target); }
      unobserve() {}
      disconnect() {}
    },
  };
  vi.stubGlobal("window", win);
  const events = () => ((win.dataLayer as IArguments[] | undefined) ?? []).map((entry) => Array.from(entry)).filter(([command]) => command === "event");
  return {
    win, events, observed,
    click: (target: MarkupNode, extra: Record<string, unknown> = {}) => listeners.get("click")?.({ type: "click", target, ...extra }),
    auxclick: (target: MarkupNode, button: number) => listeners.get("auxclick")?.({ type: "auxclick", target, button }),
    intersect: (targets: MarkupNode[]) => observerCallback?.(targets.map((target) => ({ isIntersecting: true, target }))),
  };
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

describe("문서 클릭 하나로 화면 표시를 읽는다", () => {
  it("제품 카드를 누르면 select_item(+items), 가운데 단추도 센다, 오른쪽 단추는 안 센다", () => {
    const page = parseMarkup(`<section id="rising"><a href="/p/a">a</a><a href="/p/b">b</a></section>`);
    const browser = fakeBrowser("/", page);
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    const [, second] = page.querySelectorAll("a[href]");
    browser.click(second);
    browser.auxclick(second, 1);
    browser.auxclick(second, 2);
    const sent = browser.events().filter(([, name]) => name === "select_item");
    expect(sent).toHaveLength(2);
    expect(sent[0][2]).toMatchObject({ item_list_id: "home_rising", index: 1, item_id: "b", transport_type: "beacon",
      items: [{ item_id: "b", item_list_id: "home_rising", item_list_name: "rising", index: 1 }] });
  });

  it("분석을 끄면 듣개가 있어도 보내지 않는다", () => {
    const page = parseMarkup(`<section id="rising"><a href="/p/a">a</a></section>`);
    const browser = fakeBrowser("/", page);
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    setAnalyticsOptOut(true);
    const before = browser.events().length;
    browser.click(page.querySelectorAll("a[href]")[0]);
    expect(browser.events()).toHaveLength(before);
  });

  it("꺼진 방문자(GPC)에게는 듣개를 달지 않는다", () => {
    const page = parseMarkup(`<a href="/p/a">a</a>`);
    const browser = fakeBrowser("/", page);
    (browser.win.navigator as Record<string, unknown>).globalPrivacyControl = true;
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    browser.click(page.querySelectorAll("a[href]")[0]);
    expect(browser.win.dataLayer).toBeUndefined();
  });

  it("이상한 대상(텍스트 노드 등)이 와도 던지지 않는다", () => {
    const browser = fakeBrowser("/");
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    expect(() => browser.click(null as never)).not.toThrow();
    expect(() => browser.click({ nodeType: 3 } as never)).not.toThrow();
  });
});

describe("data-track-view — 화면에 들어오면 화면마다 한 번", () => {
  it("/launch 단계를 관찰하고, 들어온 것만 한 번씩 보낸다", () => {
    const page = parseMarkup(`<main><div data-track-view="launch_step_view" data-track-params='{"step":"install","step_index":1}'></div><section data-track-view="launch_step_view" data-track-params='{"step":"verify","step_index":3}'></section></main>`);
    const browser = fakeBrowser("/launch", page);
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    trackPageView({ pathname: "/launch", search: "", title: "Launch" });
    expect(browser.observed).toHaveLength(2);
    const [install, verify] = page.querySelectorAll("[data-track-view]");
    browser.intersect([install]);
    browser.intersect([install]);
    browser.intersect([verify]);
    const steps = browser.events().filter(([, name]) => name === "launch_step_view").map(([, , params]) => [params.step, params.step_index]);
    expect(steps).toEqual([["install", 1], ["verify", 3]]);
  });
});

describe("검색어·오류·화면 갈래", () => {
  it("search 의 검색어는 정리해서 보내고, 남는 것이 없으면 보내지 않는다", () => {
    const browser = fakeBrowser("/");
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    track("search", { search_term: "  PDF Editor alice@example.com ", result_count: 12, surface: "search" });
    track("search", { search_term: "alice@example.com 010-1234-5678", result_count: 0, surface: "search" });
    const searches = browser.events().filter(([, name]) => name === "search");
    expect(searches).toHaveLength(1);
    expect(searches[0][2]).toMatchObject({ search_term: "pdf editor", result_count: 12, surface: "search" });
  });

  it("404 화면은 주소와 상관없이 page_type not_found, 오류 경계의 other 는 지금 화면 갈래로", () => {
    const page = parseMarkup(`<main data-track-page-type="not_found"><h1>없음</h1></main>`);
    const browser = fakeBrowser("/p/missing", page);
    startAnalytics({ measurementId: ID, debug: false, devLog: false });
    trackPageView({ pathname: "/p/missing", search: "", title: "없음" });
    expect(browser.events().find(([, name]) => name === "page_view")![2]).toMatchObject({ page_type: "not_found", page_path: "/p/missing" });
    track("app_error", { error_code: "client_render", page_type: "other" });
    track("app_error", { error_code: "not_found", page_type: "not_found" });
    const errors = browser.events().filter(([, name]) => name === "app_error").map(([, , params]) => [params.error_code, params.page_type]);
    expect(errors).toEqual([["client_render", "not_found"], ["not_found", "not_found"]]);
  });
});
