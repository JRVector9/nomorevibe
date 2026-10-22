import type { AnalyticsEventName, AnalyticsEventParams, PageViewParams } from "@/lib/analytics/events";
import { ANALYTICS_OPT_OUT_KEY, consentDefaultCommands, decideConsent, readConsentSignals, type ConsentBlockReason, type ConsentBrowser } from "@/lib/analytics/consent";
import { isAnalyticsExcludedPath, pageLocale, pageType } from "@/lib/analytics/routes";
import { sanitizeParams, sanitizePath, sanitizeUrl, type CleanParams } from "@/lib/analytics/sanitize";

/**
 * 브라우저에서 방문 분석 이벤트를 보낸다 — track()·trackPageView() 하나로(2026-10-22).
 *
 * - GA 가 꺼져 있거나(측정 ID 없음) 동의가 없으면 아무것도 하지 않는다. 어떤 경우에도 던지지 않는다 — 분석 때문에
 *   단추·이동이 멈추면 안 된다.
 * - 로더(components/analytics/AnalyticsLoader.tsx)가 startAnalytics() 를 부르기 전의 이벤트는 20개까지 모아 뒀다가
 *   켜지면 보내고, 꺼지면 버린다(자식 컴포넌트의 효과가 로더보다 먼저 돈다).
 * - 이벤트마다 transport_type: "beacon" 을 붙여 화면을 떠나는 클릭도 잃지 않는다. 화면 주소(page_location)는 정리한 값을 함께 보낸다.
 * - GA 가 꺼진 개발 환경에서 GA_DEBUG=1 이면 보냈을 이벤트를 콘솔에 찍는다(status "log").
 * - 로그인한 사람에게도 user_id 를 붙이지 않는다.
 */

export type AnalyticsStatus = "pending" | "on" | "log" | "off";
export type AnalyticsSnapshot = {
  status: AnalyticsStatus;
  /** 꺼진 까닭 — disabled: 측정 ID 가 없다 */
  reason: ConsentBlockReason | "disabled" | null;
};

type Gtag = (...args: unknown[]) => void;
type AnalyticsWindow = Window & { dataLayer?: unknown[]; gtag?: Gtag } & Record<string, unknown>;

const QUEUE_LIMIT = 20;
const PENDING: AnalyticsSnapshot = { status: "pending", reason: null };

const state: {
  snapshot: AnalyticsSnapshot;
  measurementId: string | null;
  debug: boolean;
  initialized: boolean;
  queue: Array<{ name: AnalyticsEventName; params: Record<string, unknown> }>;
  page: { location: string; referrer: string; title: string; key: string } | null;
} = { snapshot: PENDING, measurementId: null, debug: false, initialized: false, queue: [], page: null };

const listeners = new Set<() => void>();

function browser(): AnalyticsWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as AnalyticsWindow);
}

function setSnapshot(next: AnalyticsSnapshot): void {
  if (state.snapshot.status === next.status && state.snapshot.reason === next.reason) return;
  state.snapshot = next;
  for (const listener of listeners) {
    try { listener(); } catch { /* 듣는 쪽의 실수가 분석을 멈추지 않게 */ }
  }
}

export function analyticsSnapshot(): AnalyticsSnapshot {
  return state.snapshot;
}

export function subscribeAnalytics(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
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
  if (!state.initialized) {
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
  } else {
    gtag("consent", "update", { analytics_storage: "granted" });
  }
}

/** 로더가 한 번 부른다. 돌려준 loadScript 가 참일 때만 gtag.js 를 불러온다 */
export function startAnalytics({ measurementId, debug, devLog }: {
  measurementId: string | null; debug: boolean; devLog: boolean;
}): { loadScript: boolean } {
  try {
    state.measurementId = measurementId;
    state.debug = debug;
    const win = browser();
    if (!measurementId || !win) {
      setSnapshot(devLog && win ? { status: "log", reason: "disabled" } : { status: "off", reason: "disabled" });
      flushQueue();
      return { loadScript: false };
    }
    // 관리자·기계용 주소의 404 화면도 공개 틀을 쓴다 — 거기서는 불러오지 않는다
    if (isAnalyticsExcludedPath(win.location.pathname)) {
      setSnapshot({ status: "off", reason: "disabled" });
      flushQueue();
      return { loadScript: false };
    }
    const decision = decideConsent(readConsentSignals(win as unknown as ConsentBrowser));
    if (!decision.load) {
      setSnapshot({ status: "off", reason: decision.reason });
      flushQueue();
      return { loadScript: false };
    }
    initializeGtag(win, measurementId, debug);
    setSnapshot({ status: "on", reason: null });
    flushQueue();
    return { loadScript: true };
  } catch {
    setSnapshot({ status: "off", reason: "disabled" });
    state.queue = [];
    return { loadScript: false };
  }
}

function flushQueue(): void {
  const queued = state.queue;
  state.queue = [];
  if (state.snapshot.status !== "on" && state.snapshot.status !== "log") return;
  for (const event of queued) send(event.name, event.params);
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

/** select_item 은 GA 상품 보고서가 읽는 items 배열도 함께 */
function withItems(name: AnalyticsEventName, params: CleanParams): Record<string, unknown> {
  if (name !== "select_item") return params;
  const { item_id, item_list_id, item_list_name, index } = params;
  return { ...params, items: [{ item_id, item_list_id, item_list_name, index }] };
}

function send(name: AnalyticsEventName, params: Record<string, unknown>): void {
  const win = browser();
  if (!win) return;
  const origin = siteOrigin(win);
  const clean = sanitizeParams(params, origin);
  if (state.snapshot.status === "log") {
    console.debug("[analytics]", name, withItems(name, clean));
    return;
  }
  if (state.snapshot.status !== "on" || typeof win.gtag !== "function") return;
  const page = name === "page_view" ? {} : currentPageFields(win);
  win.gtag("event", name, { ...page, ...withItems(name, clean), transport_type: "beacon" });
}

/**
 * 이벤트 하나를 보낸다. 꺼져 있으면 하지 않는다. 던지지 않는다.
 * 이름과 매개변수는 lib/analytics/events.ts 의 목록이 타입으로 막는다.
 */
export function track<Name extends AnalyticsEventName>(name: Name, params: AnalyticsEventParams[Name]): void {
  try {
    const status = state.snapshot.status;
    if (status === "off") return;
    const win = browser();
    if (!win) return;
    try {
      if (isAnalyticsExcludedPath(win.location.pathname)) return;
    } catch { return; }
    if (status === "pending") {
      if (state.queue.length < QUEUE_LIMIT) state.queue.push({ name, params: { ...params } });
      return;
    }
    send(name, params as Record<string, unknown>);
  } catch {
    // 분석은 화면을 막지 않는다
  }
}

/**
 * 화면 보기 — 첫 화면과 App Router 이동마다 로더가 부른다.
 * 같은 주소·같은 갈래를 잇달아 부르면 한 번만 보낸다(같은 링크를 다시 누른 경우, 개발 모드의 두 번 실행).
 */
export function trackPageView(input: { pathname?: string; search?: string; title?: string } = {}): void {
  try {
    if (state.snapshot.status === "off") return;
    const win = browser();
    if (!win) return;
    const pathname = input.pathname ?? win.location.pathname;
    const search = input.search ?? win.location.search;
    if (isAnalyticsExcludedPath(pathname)) return;
    const origin = siteOrigin(win) ?? "";
    const location = sanitizeUrl(`${origin}${pathname}${search}`, origin || undefined);
    if (!location) return;
    const type = pageType(pathname, search);
    const key = `${location}|${type}`;
    if (state.page?.key === key) return;
    const referrer = state.page?.location ?? sanitizeUrl(win.document?.referrer ?? "", origin || undefined);
    const title = (input.title ?? win.document?.title ?? "").trim();
    state.page = { location, referrer, title, key };
    const params: PageViewParams = {
      page_location: location,
      page_path: sanitizePath(pathname),
      page_title: title,
      ...(referrer ? { page_referrer: referrer } : {}),
      locale: pageLocale(pathname),
      page_type: type,
    };
    if (state.snapshot.status === "on" && typeof win.gtag === "function") {
      // 이후 이벤트(스크롤 등 GA 자체 수집 포함)도 정리한 주소를 쓰게
      win.gtag("set", { page_location: location, page_referrer: referrer, page_title: title });
    }
    track("page_view", params);
  } catch {
    // 분석은 화면을 막지 않는다
  }
}

/** 마지막으로 보낸 화면 제목 — 로더가 새 제목이 들어왔는지 볼 때 쓴다 */
export function lastPageTitle(): string | null {
  return state.page?.title ?? null;
}

/** GA 쿠키(_ga, _ga_<ID>, _gid)를 지운다 — 이 주소와 상위 도메인 모두 */
function clearAnalyticsCookies(win: AnalyticsWindow): void {
  const doc = win.document;
  if (!doc) return;
  const names = doc.cookie.split(";").map((part) => part.split("=", 1)[0].trim()).filter((name) => /^_ga(?:_|$)|^_gid$/.test(name));
  if (!names.length) return;
  const host = win.location.hostname;
  const labels = host.split(".");
  const domains = ["", ...labels.map((_, index) => `.${labels.slice(index).join(".")}`).filter((domain) => domain.split(".").length > 2)];
  for (const name of names) {
    for (const domain of domains) {
      doc.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ""}; SameSite=Lax`;
    }
  }
}

/**
 * 이 브라우저에서 분석을 끄거나 다시 켠다(정책 화면·푸터의 단추).
 * 끄면 그 자리에서 analytics_storage 를 거부로 바꾸고 GA 를 멈추고(ga-disable-<ID>) GA 쿠키를 지운다.
 * 다시 켜면 다른 이유(GPC·DNT·지역)가 없을 때만 켠다.
 */
export function setAnalyticsOptOut(optOut: boolean): void {
  const win = browser();
  if (!win) return;
  try {
    if (optOut) win.localStorage.setItem(ANALYTICS_OPT_OUT_KEY, "1");
    else win.localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
  } catch { /* 저장소가 막혀 있으면 이 화면에서만 지킨다 */ }
  try {
    const id = state.measurementId;
    if (optOut) {
      state.queue = [];
      if (id && state.initialized && typeof win.gtag === "function") {
        win.gtag("consent", "update", { analytics_storage: "denied" });
        win[`ga-disable-${id}`] = true;
      }
      clearAnalyticsCookies(win);
      setSnapshot({ status: "off", reason: "opt_out" });
      return;
    }
    if (!id) {
      setSnapshot({ status: state.snapshot.status === "log" ? "log" : "off", reason: "disabled" });
      return;
    }
    const decision = decideConsent({ ...readConsentSignals(win as unknown as ConsentBrowser), optOut: false });
    if (!decision.load) {
      setSnapshot({ status: "off", reason: decision.reason });
      return;
    }
    initializeGtag(win, id, state.debug);
    setSnapshot({ status: "on", reason: null });
    state.page = null;
    trackPageView();
  } catch {
    // 단추가 멈추지 않게
  }
}

/** 시험 전용 — 모듈 상태를 처음으로 */
export function resetAnalyticsForTests(): void {
  state.snapshot = PENDING;
  state.measurementId = null;
  state.debug = false;
  state.initialized = false;
  state.queue = [];
  state.page = null;
  listeners.clear();
}
