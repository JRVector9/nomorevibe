import type { ConsentBlockReason } from "@/lib/analytics/consent";
import type { AnalyticsEventName, AnalyticsEventParams } from "@/lib/analytics/events";
import { ANALYTICS_OPT_OUT_KEY } from "@/lib/analytics/opt-out-key";

/**
 * 브라우저에서 방문 분석 이벤트를 보낸다 — track()·trackPageView() 하나로(2026-10-22).
 *
 * - GA 가 꺼져 있거나(측정 ID 없음) 동의가 없으면 아무것도 하지 않는다. 어떤 경우에도 던지지 않는다 — 분석 때문에
 *   단추·이동이 멈추면 안 된다.
 * - 이 파일은 모든 공개 화면의 첫 로드 JS 에 들어가므로 작게 둔다. 정리·동의·gtag 는 lib/analytics/runtime.tsx 에 있고,
 *   로더(components/analytics/AnalyticsLoader.tsx)가 GA 가 켜진 화면에서만 따로 불러와 여기에 잇는다(connectAnalyticsRuntime).
 *   GA 가 꺼진 방문자는 그 코드를 받지 않는다.
 * - 런타임이 이어지기 전의 이벤트는 20개까지 모아 뒀다가 켜지면 보내고, 꺼지면 버린다(자식 컴포넌트의 효과가 로더보다 먼저 돈다).
 * - 런타임이 이벤트마다 정리한 화면 주소(page_location)와 transport_type: "beacon" 을 붙인다(화면을 떠나는 클릭도 잃지 않는다).
 * - GA 가 꺼진 개발 환경에서 GA_DEBUG=1 이면 보냈을 이벤트를 콘솔에 찍는다(status "log").
 * - 로그인한 사람에게도 user_id 를 붙이지 않는다.
 */

export type AnalyticsStatus = "pending" | "on" | "log" | "off";
export type AnalyticsSnapshot = {
  status: AnalyticsStatus;
  /** 꺼진 까닭 — disabled: 측정 ID 가 없거나 보내지 않는 주소다 */
  reason: ConsentBlockReason | "disabled" | null;
};

/** 화면 보기를 부른 그 순간의 주소·제목 — 런타임이 늦게 와도 그때 값으로 보낸다 */
export type PageViewInput = { pathname: string; search: string; title: string };

/** 런타임(lib/analytics/runtime.tsx)이 여기에 잇는 손잡이 */
export type AnalyticsRuntime = {
  send(name: AnalyticsEventName, params: Record<string, unknown>): void;
  pageView(input: PageViewInput): void;
  setOptOut(optOut: boolean): void;
};

type Queued = { kind: "event"; name: AnalyticsEventName; params: Record<string, unknown> } | { kind: "page"; input: PageViewInput };

const QUEUE_LIMIT = 20;
const PENDING: AnalyticsSnapshot = { status: "pending", reason: null };

const state: { snapshot: AnalyticsSnapshot; runtime: AnalyticsRuntime | null; queue: Queued[] } = { snapshot: PENDING, runtime: null, queue: [] };
const listeners = new Set<() => void>();

export function analyticsSnapshot(): AnalyticsSnapshot {
  return state.snapshot;
}

export function subscribeAnalytics(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 런타임 전용 — 상태를 바꾸고 듣는 쪽(로더·끄기 단추)에 알린다 */
export function setAnalyticsSnapshot(next: AnalyticsSnapshot): void {
  if (state.snapshot.status === next.status && state.snapshot.reason === next.reason) return;
  state.snapshot = next;
  if (next.status === "off") state.queue = [];
  for (const listener of listeners) {
    try { listener(); } catch { /* 듣는 쪽의 실수가 분석을 멈추지 않게 */ }
  }
}

/** 런타임 전용 — 손잡이를 잇고 모아 둔 것을 보낸다(꺼져 있으면 버린다) */
export function connectAnalyticsRuntime(runtime: AnalyticsRuntime | null): void {
  state.runtime = runtime;
  const queued = state.queue;
  state.queue = [];
  if (!runtime || (state.snapshot.status !== "on" && state.snapshot.status !== "log")) return;
  for (const item of queued) {
    try {
      if (item.kind === "event") runtime.send(item.name, item.params);
      else runtime.pageView(item.input);
    } catch { /* 하나가 실패해도 나머지는 보낸다 */ }
  }
}

function enqueue(item: Queued): void {
  if (state.queue.length < QUEUE_LIMIT) state.queue.push(item);
}

/**
 * 이벤트 하나를 보낸다. 꺼져 있으면 하지 않는다. 던지지 않는다.
 * 이름과 매개변수는 lib/analytics/events.ts 의 목록이 타입으로 막는다. 값 정리(금지 키·주소·길이)는 런타임이 한다.
 */
export function track<Name extends AnalyticsEventName>(name: Name, params: AnalyticsEventParams[Name]): void {
  try {
    if (state.snapshot.status === "off" || typeof window === "undefined") return;
    const copy = { ...params } as Record<string, unknown>;
    if (state.runtime && state.snapshot.status !== "pending") state.runtime.send(name, copy);
    else enqueue({ kind: "event", name, params: copy });
  } catch {
    // 분석은 화면을 막지 않는다
  }
}

/**
 * 화면 보기 — 첫 화면과 App Router 이동마다 로더가 부른다. 주소·제목은 부른 순간의 값을 쓴다.
 * 같은 주소·같은 갈래를 잇달아 부르면 런타임이 한 번만 보낸다.
 */
export function trackPageView(input: Partial<PageViewInput> = {}): void {
  try {
    if (state.snapshot.status === "off" || typeof window === "undefined") return;
    const captured: PageViewInput = {
      pathname: input.pathname ?? window.location.pathname,
      search: input.search ?? window.location.search,
      title: (input.title ?? window.document?.title ?? "").trim(),
    };
    if (state.runtime && state.snapshot.status !== "pending") state.runtime.pageView(captured);
    else enqueue({ kind: "page", input: captured });
  } catch {
    // 분석은 화면을 막지 않는다
  }
}

/**
 * 이 브라우저에서 분석을 끄거나 다시 켠다(정책 화면·푸터의 단추).
 * 끄면 그 자리에서 기록하고 멈춘다(런타임이 있으면 analytics_storage 거부·GA 멈춤·쿠키 삭제까지).
 * 다시 켜면 런타임이 다른 이유(GPC·DNT·지역)를 보고 정한다.
 */
export function setAnalyticsOptOut(optOut: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (optOut) window.localStorage.setItem(ANALYTICS_OPT_OUT_KEY, "1");
    else window.localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
  } catch { /* 저장소가 막혀 있으면 이 화면에서만 지킨다 */ }
  try {
    if (state.runtime) state.runtime.setOptOut(optOut);
    else if (optOut) setAnalyticsSnapshot({ status: "off", reason: "opt_out" });
  } catch {
    // 단추가 멈추지 않게
    if (optOut) setAnalyticsSnapshot({ status: "off", reason: "opt_out" });
  }
}

/** 시험 전용 — 모듈 상태를 처음으로 */
export function resetAnalyticsForTests(): void {
  state.snapshot = PENDING;
  state.runtime = null;
  state.queue = [];
  listeners.clear();
}
