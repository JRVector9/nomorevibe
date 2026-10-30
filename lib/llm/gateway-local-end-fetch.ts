import { Dispatcher, fetch as undiciFetch, getGlobalDispatcher } from "undici";
import { trackGatewayTransport } from "./gateway-local-end";

/**
 * reserved 게이트웨이 호출의 fetch(PR15d, not-started 증인). 항상 추적한다(MODEL_CAPACITY_LOCAL_END 와 무관 — flag 는 로컬 종료 증인의 노출만 거른다).
 * 전송은 그대로(현재 전역 dispatcher 에 위임 — replay meter 같은 전역 설정도 그대로 탄다) 두고, native dispatch 마다
 * (1) 요청 시작 hook(onRequestStart — 요청이 소켓에 쓰이기 직전. undici 8 의 fetch handler 이름이며, legacy handler 면 onConnect)과
 * (2) 종료 callback(onResponseEnd/onResponseError — 그 요청 소켓의 마지막 사건)을 센다. origin-permits 의 HopDispatcher 와 같은 관측이다.
 * 연결 거절·DNS 실패·연결 시간 초과·요청 전 TLS 실패는 onRequestStart 없이 onResponseError 로 끝난다 → takeGatewayNotSent 가 미전송을 증명한다.
 */
export async function gatewayFetch(requestId: string, ...[url, init]: Parameters<typeof undiciFetch>): ReturnType<typeof undiciFetch> {
  const track = trackGatewayTransport(requestId);
  class Observed extends Dispatcher {
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const end = track.dispatched();
      const observed = new Proxy(handler, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          // 시작 hook 은 하위 handler 보다 먼저 센다(하위가 throw 해도 '시작'은 취소되지 않는다). 없는 hook 은 만들지 않는다 — undici 가 handler 세대를 이 이름으로 가른다.
          if ((key === "onRequestStart" || key === "onConnect") && typeof value === "function") return (...args: unknown[]) => {
            track.started(); return Reflect.apply(value, target, args); };
          if (key === "onResponseEnd" || key === "onResponseError") return (...args: unknown[]) => {
            try { return typeof value === "function" ? Reflect.apply(value, target, args) : undefined; } finally { end(); } };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try { return getGlobalDispatcher().dispatch(options, observed); }
      catch (error) { track.unknown(); throw error; }
    }
  }
  try { return await undiciFetch(url, { ...init, dispatcher: new Observed() }); }
  finally { track.settled(); }
}
