/**
 * 게이트웨이(in-process HTTP) 모델 호출의 로컬 증인(PR15d, not-started 증인). 프로세스 그룹이 없는 호출(웹 프로세스·살아 있는 워커의
 * 시간 초과/abort)은 그룹 ESRCH 로 끝을 증명할 수 없다. 대신 이 프로세스가 직접 본 사실 — fetch promise 가 끝났고, undici 의 native
 * dispatch 마다 요청 시작 hook(onRequestStart — 요청이 소켓에 쓰이기 직전)과 종료 callback(onResponseEnd/onResponseError)이 왔는가 — 을
 * requestId 별로 센다. 증인은 이 프로세스 메모리에만 있고 한 번만 꺼낸다(직렬화된 값은 권한이 아니다).
 *
 * 증인은 둘이다. (1) 로컬 종료(takeGatewayLocalEnd): '로컬 호출이 끝났다'는 뜻뿐이다 — provider 쪽 생성 종료나 사용량 증거가 아니며,
 * 장부 해제는 운영 회수가 provider 정책(client_bound, 또는 증명된 hard deadline 경과)으로 따로 판정한다.
 * (2) 미전송(takeGatewayNotSent): 모든 native dispatch 가 오류로 끝났고 어느 것도 onRequestStart 에 닿지 않았다 — 연결 거절·DNS 실패·
 * 연결 시간 초과·요청 전 TLS 실패처럼 요청 바이트가 이 프로세스 밖으로 나간 적이 없다는 증명이다. provider 는 요청을 본 적이 없다.
 *
 * 추적(dispatch/시작/종료 계수)은 항상 켜져 있다 — 메모리 안 계수뿐이라 값이 싸고 전송은 현재 전역 dispatcher 에 그대로 위임한다.
 * MODEL_CAPACITY_LOCAL_END 는 이제 (1) 로컬 종료 증인의 노출만 거른다(미설정/0 이면 takeGatewayLocalEnd 는 항상 null, '1' 이면 증인을 준다).
 * 다른 값은 설정 오류라 증인을 주지 않는다(fail-closed). migration 0099 를 먼저 적용한 뒤에만 켠다. (2) 는 이 flag 와 무관하다.
 * undici 를 import 하지 않는다(장부 모듈이 가볍게 읽는다). 추적 fetch 는 gateway-local-end-fetch.ts 에 있다.
 */
export type GatewayLocalEnd = Readonly<{ requestId: string; dispatches: number; terminals: number }>;
/** 요청 바이트가 이 프로세스 밖으로 나간 적 없다는 증명. code 는 오류 코드(ECONNREFUSED 등)뿐 — 메시지·URL 은 담지 않는다. */
export type GatewayNotSent = Readonly<{ requestId: string; dispatches: number; code: string | null }>;
type Track = { dispatches: number; started: number; terminals: number; unknown: boolean; fetchSettled: boolean };
/** 정산된(terminal) 호출의 기록은 꺼내지 않고 남는다. 오래된 것부터 버린다 — 버려진 호출은 증인이 없을 뿐(점유 유지)이다. */
const MAX_TRACKED = 1024;
const tracks = new Map<string, Track>();

export function gatewayLocalEndTrackingEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const flag = env.MODEL_CAPACITY_LOCAL_END;
  if (flag === undefined || flag === "0") return false;
  if (flag === "1") return true;
  throw new Error("invalid_model_capacity_local_end");
}

/** reserved 게이트웨이 호출 하나의 관측 시작(항상). 같은 requestId 를 두 번 추적하면(정상 경로에는 없음) 그 호출은 증인을 잃는다. */
export function trackGatewayTransport(requestId: string) {
  const existing = tracks.get(requestId);
  const track: Track = existing ? { ...existing, unknown: true } : { dispatches: 0, started: 0, terminals: 0, unknown: false, fetchSettled: false };
  tracks.delete(requestId); tracks.set(requestId, track);
  while (tracks.size > MAX_TRACKED) tracks.delete(tracks.keys().next().value!);
  return Object.freeze({
    /** native dispatch 하나. 돌려준 함수는 그 dispatch 의 종료 callback 에서 한 번만 센다. */
    dispatched: () => { track.dispatches++; let ended = false; return () => { if (!ended) { ended = true; track.terminals++; } }; },
    /** native dispatch 가 요청 시작 hook(onRequestStart/legacy onConnect)에 닿았다 — 요청 바이트가 소켓에 쓰였을 수 있다. 미전송 증인은 영영 없다. */
    started: () => { track.started++; },
    /** dispatcher 가 동기 throw 했다 — native 종료를 볼 수 없으니 증인을 만들지 않는다. */
    unknown: () => { track.unknown = true; },
    settled: () => { track.fetchSettled = true; },
  });
}

/** MODEL_CAPACITY_LOCAL_END 가 '1' 일 때만 true. 잘못된 값은 증인을 만들지 않는다(예외를 새 곳으로 퍼뜨리지 않는다). */
function localEndExposed(): boolean {
  try { return gatewayLocalEndTrackingEnabled(); } catch { return false; }
}

/** MODEL_CAPACITY_LOCAL_END=1 이고 fetch 가 끝났고 시작된 모든 native dispatch(1개 이상)가 종료를 보고했을 때만 증인을 준다. 준 뒤에는 지운다(한 번만). */
export function takeGatewayLocalEnd(requestId: string): GatewayLocalEnd | null {
  if (!localEndExposed()) return null;
  const track = tracks.get(requestId);
  if (!track || track.unknown || !track.fetchSettled || track.dispatches < 1 || track.terminals !== track.dispatches) return null;
  tracks.delete(requestId);
  return Object.freeze({ requestId, dispatches: track.dispatches, terminals: track.terminals });
}

const codeOf = (value: unknown): string | null => {
  const code = typeof value === "object" && value !== null ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length > 0 ? code.slice(0, 64) : null;
};

/**
 * 요청 바이트가 이 프로세스 밖으로 나간 적 없다는 증명: fetch 가 오류로 끝났고(error), 모든 native dispatch(1개 이상)가 오류로 끝났고,
 * 어느 것도 onRequestStart 에 닿지 않았다. 하나라도 시작됐으면(= 소켓에 쓰였을 수 있으면) 절대 주지 않는다. 증명 못 하면 null 이고 기록은
 * 남는다(뒤늦게 dispatch 가 끝나면 다시 물을 수 있다). 증명하면 지운다(한 번만). code 는 error.code 또는 error.cause.code(문자열일 때)다.
 */
export function takeGatewayNotSent(requestId: string, error: unknown): GatewayNotSent | null {
  const track = tracks.get(requestId);
  if (!track || track.unknown || !track.fetchSettled || track.dispatches < 1 || track.started !== 0 || track.terminals !== track.dispatches) return null;
  tracks.delete(requestId);
  const cause = typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  return Object.freeze({ requestId, dispatches: track.dispatches, code: codeOf(error) ?? codeOf(cause) });
}
