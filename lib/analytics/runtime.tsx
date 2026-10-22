import Script from "next/script";
import { ANALYTICS_EVENT_CATALOG, type AnalyticsEventName, type AnalyticsPageType, type PageViewParams } from "@/lib/analytics/events";
import {
  analyticsSnapshot, connectAnalyticsRuntime, setAnalyticsSnapshot, type AnalyticsRuntime, type PageViewInput,
} from "@/lib/analytics/client";
import { consentDefaultCommands, decideConsent, readConsentSignals, type ConsentBrowser } from "@/lib/analytics/consent";
import { classifyClick, viewEvent, type ClickContext, type TrackElement } from "@/lib/analytics/dom";
import { isAnalyticsExcludedPath, pageLocale, pageType } from "@/lib/analytics/routes";
import { sanitizeParams, sanitizePath, sanitizeSearchTerm, sanitizeUrl, type CleanParams } from "@/lib/analytics/sanitize";

/**
 * 방문 분석의 실제 일 — gtag 준비, 동의, 값 정리, 보내기, 끄기(2026-10-22).
 *
 * 로더(components/analytics/AnalyticsLoader.tsx)가 GA 가 켜진 공개 화면에서만 import() 로 따로 받는다.
 * 첫 로드 JS 에 들어가는 쪽은 lib/analytics/client.ts(track·trackPageView 와 대기열)뿐이다.
 *
 * 화면의 분석 표시(lib/analytics/attrs.ts)는 여기서 읽는다 — 문서에 클릭 듣개 하나(잡기 단계라 화면의 onClick 보다 먼저,
 * 막지 않는다)와 화면마다 data-track-view 를 보는 IntersectionObserver 하나.
 */

type Gtag = (...args: unknown[]) => void;
type AnalyticsWindow = Window & { dataLayer?: unknown[]; gtag?: Gtag } & Record<string, unknown>;

const state: {
  measurementId: string | null;
  debug: boolean;
  initialized: boolean;
  listening: boolean;
  page: { location: string; referrer: string; title: string; key: string; type: AnalyticsPageType } | null;
  views: IntersectionObserver | null;
} = { measurementId: null, debug: false, initialized: false, listening: false, page: null, views: null };

function browser(): AnalyticsWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as AnalyticsWindow);
}

function siteOrigin(win: AnalyticsWindow | null): string | undefined {
  try { return win?.location.origin; } catch { return undefined; }
}

/** 지금 화면의 정리한 주소·제목 — 이벤트마다 page_location 으로 붙는다 */
function currentPageFields(win: AnalyticsWindow): CleanParams {
  if (state.page) return { page_location: state.page.location, page_referrer: state.page.referrer, page_title: state.page.title };
  const origin = siteOrigin(win);
  const location = sanitizeUrl(win.location.href, origin);
  const referrer = sanitizeUrl(win.document?.referrer ?? "", origin);
  return { ...(location ? { page_location: location } : {}), ...(referrer ? { page_referrer: referrer } : {}) };
}

/** gtag 스텁과 동의 기본값·설정을 넣는다 — 스크립트가 오기 전에도 dataLayer 에 쌓인다 */
function initializeGtag(win: AnalyticsWindow, measurementId: string, debug: boolean): void {
  win.dataLayer = win.dataLayer ?? [];
  if (typeof win.gtag !== "function") {
    // gtag 는 arguments 객체를 그대로 넣어야 한다(배열이면 읽지 않는다)
    // eslint-disable-next-line prefer-rest-params
    win.gtag = function gtag() { (win.dataLayer as unknown[]).push(arguments); };
  }
  const gtag = win.gtag;
  win[`ga-disable-${measurementId}`] = false;
  if (state.initialized) {
    gtag("consent", "update", { analytics_storage: "granted" });
    return;
  }
  for (const command of consentDefaultCommands()) gtag("consent", "default", command);
  gtag("set", "ads_data_redaction", true);
  gtag("set", "url_passthrough", false);
  gtag("js", new Date());
  gtag("config", measurementId, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    ...(debug ? { debug_mode: true } : {}),
    ...currentPageFields(win),
  });
  state.initialized = true;
}

/** select_item 은 GA 상품 보고서가 읽는 items 배열도 함께 */
function withItems(name: AnalyticsEventName, params: CleanParams): Record<string, unknown> {
  if (name !== "select_item") return params;
  const { item_id, item_list_id, item_list_name, index } = params;
  return { ...params, items: [{ item_id, item_list_id, item_list_name, index }] };
}

function send(name: AnalyticsEventName, params: Record<string, unknown>): void {
  try {
    const win = browser();
    if (!win || isAnalyticsExcludedPath(win.location.pathname)) return;
    // 검색어는 정리해서 보내고, 남는 것이 없으면(이메일·숫자뿐) 보내지 않는다
    // 화면 오류 경계는 갈래를 모른다(other) — 지금 화면의 갈래로 채운다
    if (name === "app_error" && params.page_type === "other" && state.page) params = { ...params, page_type: state.page.type };
    if (name === "search") {
      const term = sanitizeSearchTerm(params.search_term);
      if (!term) return;
      params = { ...params, search_term: term };
    }
    const clean = sanitizeParams(params, siteOrigin(win));
    const status = analyticsSnapshot().status;
    if (status === "log") {
      console.debug("[analytics]", name, withItems(name, clean));
      return;
    }
    if (status !== "on" || typeof win.gtag !== "function") return;
    const page = name === "page_view" ? {} : currentPageFields(win);
    win.gtag("event", name, { ...page, ...withItems(name, clean), transport_type: "beacon" });
  } catch {
    // 분석은 화면을 막지 않는다
  }
}

/** 화면이 스스로 밝힌 갈래(data-track-page-type) — 404 화면은 주소가 /p/… 여도 not_found 다 */
function declaredPageType(win: AnalyticsWindow): AnalyticsPageType | null {
  const value = win.document?.querySelector?.("[data-track-page-type]")?.getAttribute("data-track-page-type");
  return value && (ANALYTICS_EVENT_CATALOG.page_view.params.page_type.values ?? []).includes(value) ? value as AnalyticsPageType : null;
}

/** 같은 주소·같은 갈래를 잇달아 보내지 않는다(같은 링크를 다시 누른 경우, 개발 모드의 두 번 실행) */
function pageView({ pathname, search, title }: PageViewInput): void {
  try {
    const win = browser();
    if (!win || isAnalyticsExcludedPath(pathname)) return;
    const origin = siteOrigin(win) ?? "";
    const location = sanitizeUrl(`${origin}${pathname}${search}`, origin || undefined);
    if (!location) return;
    const type = declaredPageType(win) ?? pageType(pathname, search);
    const key = `${location}|${type}`;
    if (state.page?.key === key) return;
    const referrer = state.page?.location ?? sanitizeUrl(win.document?.referrer ?? "", origin || undefined);
    state.page = { location, referrer, title, key, type };
    const params: PageViewParams = {
      page_location: location,
      page_path: sanitizePath(pathname),
      page_title: title,
      ...(referrer ? { page_referrer: referrer } : {}),
      locale: pageLocale(pathname),
      page_type: type,
    };
    if (analyticsSnapshot().status === "on" && typeof win.gtag === "function") {
      // 이후 이벤트(스크롤 등 GA 자체 수집 포함)도 정리한 주소를 쓰게
      win.gtag("set", { page_location: location, page_referrer: referrer, page_title: title });
    }
    send("page_view", params);
    watchViews(win);
  } catch {
    // 분석은 화면을 막지 않는다
  }
}

function clickContext(win: AnalyticsWindow): ClickContext {
  return { origin: siteOrigin(win) ?? "", pathname: win.location.pathname, search: win.location.search };
}

/** 문서의 클릭 하나로 화면의 분석 표시를 읽는다 — 가운데 단추(새 탭)도 센다. 막지 않는다 */
function onClick(event: MouseEvent): void {
  try {
    if (event.type === "auxclick" && event.button !== 1) return;
    const win = browser();
    const target = event.target as unknown as TrackElement | null;
    if (!win || !target || typeof target.getAttribute !== "function") return;
    for (const item of classifyClick(target, clickContext(win))) send(item.name, item.params);
  } catch {
    // 분석은 클릭을 막지 않는다
  }
}

function listen(win: AnalyticsWindow): void {
  if (state.listening || !win.document?.addEventListener) return;
  win.document.addEventListener("click", onClick, { capture: true, passive: true });
  win.document.addEventListener("auxclick", onClick, { capture: true, passive: true });
  state.listening = true;
}

/** 화면에 절반 넘게 들어온 data-track-view 를 화면마다 한 번 보낸다(/launch 단계) */
function watchViews(win: AnalyticsWindow): void {
  state.views?.disconnect();
  state.views = null;
  const Observer = (win as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  if (typeof Observer !== "function" || !win.document?.querySelectorAll) return;
  const seen = new Set<string>();
  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const item = viewEvent(entry.target as unknown as TrackElement, clickContext(win));
      const key = item ? `${item.name}:${JSON.stringify(item.params)}` : "";
      if (item && !seen.has(key)) {
        seen.add(key);
        send(item.name, item.params);
      }
    }
  }, { threshold: 0.5 });
  state.views = observer;
  // 화면이 아직 그려지는 중일 수 있어 조금 뒤에 한 번 더 찾는다
  const scan = () => { if (state.views === observer) win.document.querySelectorAll("[data-track-view]").forEach((element) => observer.observe(element)); };
  scan();
  win.setTimeout(scan, 1_000);
}

/** GA 쿠키(_ga, _ga_<ID>, _gid)를 지운다 — 이 주소와 상위 도메인 모두 */
function clearAnalyticsCookies(win: AnalyticsWindow): void {
  const doc = win.document;
  if (!doc) return;
  const names = doc.cookie.split(";").map((part) => part.split("=", 1)[0].trim()).filter((name) => /^_ga(?:_|$)|^_gid$/.test(name));
  if (!names.length) return;
  const labels = win.location.hostname.split(".");
  const domains = ["", ...labels.map((_, index) => `.${labels.slice(index).join(".")}`).filter((domain) => domain.split(".").length > 2)];
  for (const name of names) {
    for (const domain of domains) {
      doc.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ""}; SameSite=Lax`;
    }
  }
}

/** 끄면 그 자리에서 analytics_storage 거부·GA 멈춤(ga-disable-<ID>)·쿠키 삭제. 다시 켜면 다른 이유가 없을 때만 */
function setOptOut(optOut: boolean): void {
  const win = browser();
  if (!win) return;
  const id = state.measurementId;
  if (optOut) {
    if (id && state.initialized && typeof win.gtag === "function") {
      win.gtag("consent", "update", { analytics_storage: "denied" });
      win[`ga-disable-${id}`] = true;
    }
    clearAnalyticsCookies(win);
    setAnalyticsSnapshot({ status: "off", reason: "opt_out" });
    return;
  }
  if (!id) {
    setAnalyticsSnapshot(analyticsSnapshot().status === "log" ? { status: "log", reason: null } : { status: "off", reason: "disabled" });
    return;
  }
  const decision = decideConsent({ ...readConsentSignals(win as unknown as ConsentBrowser), optOut: false });
  if (!decision.load) {
    setAnalyticsSnapshot({ status: "off", reason: decision.reason });
    return;
  }
  initializeGtag(win, id, state.debug);
  setAnalyticsSnapshot({ status: "on", reason: null });
  listen(win);
  state.page = null;
  pageView({ pathname: win.location.pathname, search: win.location.search, title: (win.document?.title ?? "").trim() });
}

const runtime: AnalyticsRuntime = { send, pageView, setOptOut };

/** 로더가 한 번 부른다. 돌려준 loadScript 가 참일 때만 gtag.js 를 불러온다 */
export function startAnalytics({ measurementId, debug, devLog }: {
  measurementId: string | null; debug: boolean; devLog: boolean;
}): { loadScript: boolean } {
  try {
    state.measurementId = measurementId;
    state.debug = debug;
    const win = browser();
    if (!win) return { loadScript: false };
    // 관리자·기계용 주소의 404 화면도 공개 틀을 쓴다 — 거기서는 불러오지 않는다
    if (isAnalyticsExcludedPath(win.location.pathname)) {
      setAnalyticsSnapshot({ status: "off", reason: "disabled" });
    } else if (!measurementId) {
      setAnalyticsSnapshot(devLog ? { status: "log", reason: null } : { status: "off", reason: "disabled" });
    } else {
      const decision = decideConsent(readConsentSignals(win as unknown as ConsentBrowser));
      if (decision.load) {
        initializeGtag(win, measurementId, debug);
        setAnalyticsSnapshot({ status: "on", reason: null });
      } else {
        setAnalyticsSnapshot({ status: "off", reason: decision.reason });
      }
    }
    const status = analyticsSnapshot().status;
    if (status === "on" || status === "log") listen(win);
    connectAnalyticsRuntime(runtime);
    return { loadScript: status === "on" };
  } catch {
    setAnalyticsSnapshot({ status: "off", reason: "disabled" });
    return { loadScript: false };
  }
}

/** gtag.js — 동의를 본 뒤 켜진 방문자에게만 그린다(afterInteractive) */
export function GtagScript({ measurementId }: { measurementId: string }) {
  return <Script id="nmv-gtag" strategy="afterInteractive" src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`} />;
}

/** 시험 전용 — 모듈 상태를 처음으로 */
export function resetAnalyticsRuntimeForTests(): void {
  state.measurementId = null;
  state.debug = false;
  state.initialized = false;
  state.page = null;
  state.views?.disconnect();
  state.views = null;
  if (state.listening && typeof document !== "undefined") {
    document.removeEventListener("click", onClick, { capture: true });
    document.removeEventListener("auxclick", onClick, { capture: true });
  }
  state.listening = false;
}
