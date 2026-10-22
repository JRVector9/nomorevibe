import Script from "next/script";
import type { AnalyticsEventName, PageViewParams } from "@/lib/analytics/events";
import {
  analyticsSnapshot, connectAnalyticsRuntime, setAnalyticsSnapshot, type AnalyticsRuntime, type PageViewInput,
} from "@/lib/analytics/client";
import { consentDefaultCommands, decideConsent, readConsentSignals, type ConsentBrowser } from "@/lib/analytics/consent";
import { isAnalyticsExcludedPath, pageLocale, pageType } from "@/lib/analytics/routes";
import { sanitizeParams, sanitizePath, sanitizeUrl, type CleanParams } from "@/lib/analytics/sanitize";

/**
 * 방문 분석의 실제 일 — gtag 준비, 동의, 값 정리, 보내기, 끄기(2026-10-22).
 *
 * 로더(components/analytics/AnalyticsLoader.tsx)가 GA 가 켜진 공개 화면에서만 import() 로 따로 받는다.
 * 첫 로드 JS 에 들어가는 쪽은 lib/analytics/client.ts(track·trackPageView 와 대기열)뿐이다.
 */

type Gtag = (...args: unknown[]) => void;
type AnalyticsWindow = Window & { dataLayer?: unknown[]; gtag?: Gtag } & Record<string, unknown>;

const state: {
  measurementId: string | null;
  debug: boolean;
  initialized: boolean;
  page: { location: string; referrer: string; title: string; key: string } | null;
} = { measurementId: null, debug: false, initialized: false, page: null };

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

/** 같은 주소·같은 갈래를 잇달아 보내지 않는다(같은 링크를 다시 누른 경우, 개발 모드의 두 번 실행) */
function pageView({ pathname, search, title }: PageViewInput): void {
  try {
    const win = browser();
    if (!win || isAnalyticsExcludedPath(pathname)) return;
    const origin = siteOrigin(win) ?? "";
    const location = sanitizeUrl(`${origin}${pathname}${search}`, origin || undefined);
    if (!location) return;
    const type = pageType(pathname, search);
    const key = `${location}|${type}`;
    if (state.page?.key === key) return;
    const referrer = state.page?.location ?? sanitizeUrl(win.document?.referrer ?? "", origin || undefined);
    state.page = { location, referrer, title, key };
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
  } catch {
    // 분석은 화면을 막지 않는다
  }
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
    connectAnalyticsRuntime(runtime);
    return { loadScript: analyticsSnapshot().status === "on" };
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
}
