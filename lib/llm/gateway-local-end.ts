/**
 * 게이트웨이(in-process HTTP) 모델 호출의 로컬 종료 증인(PR15d). 프로세스 그룹이 없는 호출(웹 프로세스·살아 있는 워커의 시간 초과/abort)은
 * 그룹 ESRCH 로 끝을 증명할 수 없다. 대신 이 프로세스가 직접 본 사실 — fetch promise 가 끝났고, undici 의 native dispatch 마다 종료
 * callback(onResponseEnd/onResponseError)이 왔다 — 을 requestId 별로 센다. 증인은 이 프로세스 메모리에만 있고 한 번만 꺼낸다(직렬화된 값은
 * 권한이 아니다). 증인은 '로컬 호출이 끝났다'는 뜻뿐이다: provider 쪽 생성 종료나 사용량 증거가 아니며, 장부 해제는 운영 회수가 provider
 * 정책(client_bound, 또는 증명된 hard deadline 경과)으로 따로 판정한다.
 *
 * 기본 비활성이다(MODEL_CAPACITY_LOCAL_END 미설정/0): 전송은 원래 undici fetch 그대로이고 아무것도 기록하지 않는다.
 * '1' 이면 추적한다. 다른 값은 설정 오류로 거절한다. migration 0099 를 먼저 적용한 뒤에만 켠다.
 * undici 를 import 하지 않는다(장부 모듈이 가볍게 읽는다). 추적 fetch 는 gateway-local-end-fetch.ts 에 있다.
 */
export type GatewayLocalEnd = Readonly<{ requestId: string; dispatches: number; terminals: number }>;
type Track = { dispatches: number; terminals: number; unknown: boolean; fetchSettled: boolean };
/** 정산된(terminal) 호출의 기록은 꺼내지 않고 남는다. 오래된 것부터 버린다 — 버려진 호출은 증인이 없을 뿐(점유 유지)이다. */
const MAX_TRACKED = 1024;
const tracks = new Map<string, Track>();

export function gatewayLocalEndTrackingEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const flag = env.MODEL_CAPACITY_LOCAL_END;
  if (flag === undefined || flag === "0") return false;
  if (flag === "1") return true;
  throw new Error("invalid_model_capacity_local_end");
}

/** reserved 게이트웨이 호출 하나의 관측 시작. 같은 requestId 를 두 번 추적하면(정상 경로에는 없음) 그 호출은 증인을 잃는다. */
export function trackGatewayTransport(requestId: string) {
  const existing = tracks.get(requestId);
  const track: Track = existing ? { ...existing, unknown: true } : { dispatches: 0, terminals: 0, unknown: false, fetchSettled: false };
  tracks.delete(requestId); tracks.set(requestId, track);
  while (tracks.size > MAX_TRACKED) tracks.delete(tracks.keys().next().value!);
  return Object.freeze({
    /** native dispatch 하나. 돌려준 함수는 그 dispatch 의 종료 callback 에서 한 번만 센다. */
    dispatched: () => { track.dispatches++; let ended = false; return () => { if (!ended) { ended = true; track.terminals++; } }; },
    /** dispatcher 가 동기 throw 했다 — native 종료를 볼 수 없으니 증인을 만들지 않는다. */
    unknown: () => { track.unknown = true; },
    settled: () => { track.fetchSettled = true; },
  });
}

/** fetch 가 끝났고 시작된 모든 native dispatch(1개 이상)가 종료를 보고했을 때만 증인을 준다. 준 뒤에는 지운다(한 번만). */
export function takeGatewayLocalEnd(requestId: string): GatewayLocalEnd | null {
  const track = tracks.get(requestId);
  if (!track || track.unknown || !track.fetchSettled || track.dispatches < 1 || track.terminals !== track.dispatches) return null;
  tracks.delete(requestId);
  return Object.freeze({ requestId, dispatches: track.dispatches, terminals: track.terminals });
}
