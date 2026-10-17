import { Dispatcher, fetch as undiciFetch, getGlobalDispatcher } from "undici";
import { gatewayLocalEndTrackingEnabled, trackGatewayTransport } from "./gateway-local-end";

/**
 * reserved 게이트웨이 호출의 fetch(PR15d). 비활성이면 원래 undici fetch 그대로다.
 * 활성이면 전송은 그대로(현재 전역 dispatcher 에 위임 — replay meter 같은 전역 설정도 그대로 탄다) 두고, native dispatch 마다 종료
 * callback(onResponseEnd/onResponseError — 그 요청 소켓의 마지막 사건)을 센다. origin-permits 의 HopDispatcher 와 같은 관측이다.
 */
export async function gatewayFetch(requestId: string, ...[url, init]: Parameters<typeof undiciFetch>): ReturnType<typeof undiciFetch> {
  if (!gatewayLocalEndTrackingEnabled()) return undiciFetch(url, init);
  const track = trackGatewayTransport(requestId);
  class Observed extends Dispatcher {
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const end = track.dispatched();
      const observed = new Proxy(handler, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
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
