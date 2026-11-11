import { gatewayHttpRejectedEvidenceSchema, type GatewayHttpRejectedDispatch, type GatewayHttpRejectedEvidence,
  type GatewayHttpRejectedStatus } from "./capacity";
import { GATEWAY_HTTP_REJECTED_STATUSES } from "./gateway-http-rejected-sql";

/**
 * 공급자가 처리하지 않고 거절한 text 경로 게이트웨이 호출의 증인(0174, 2026-11-11). gateway-not-started 와 같은 방식이다: 게이트웨이 모듈이 fetch 가
 * 돌려준 응답의 상태 줄을 본 그 자리에서만 내고(완결된 HTTP 응답 — 상태가 GATEWAY_HTTP_REJECTED_STATUSES 중 하나), 원본 객체만 정산 근거다
 * (저장된 JSON·사본은 권한이 아니다). 받는 쪽은 indeterminate 대신 reconcileGatewayHttpRejected 로 정산한다 — 점유만 끝나고 C 는 그대로다.
 * 시간 초과·연결 끊김·본문 도중 실패·5xx 는 여기 오지 않는다(위쪽이 아직 생성 중일 수 있다 — 지금처럼 결과 미확정).
 */
export type GatewayHttpRejected = Readonly<{ kind: "gateway_http_rejected" }>;
const terminals = new WeakMap<GatewayHttpRejected, GatewayHttpRejectedEvidence>();

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function readGatewayHttpRejected(value: unknown): GatewayHttpRejectedEvidence | null {
  return value && typeof value === "object" ? terminals.get(value as GatewayHttpRejected) ?? null : null;
}

export function isGatewayHttpRejectedStatus(status: number): status is GatewayHttpRejectedStatus {
  return (GATEWAY_HTTP_REJECTED_STATUSES as readonly number[]).includes(status);
}

export function issueGatewayHttpRejected(dispatch: GatewayHttpRejectedDispatch, status: GatewayHttpRejectedStatus,
  retryAfterMs: number | null): GatewayHttpRejected {
  const terminal: GatewayHttpRejected = Object.freeze({ kind: "gateway_http_rejected" });
  terminals.set(terminal, freeze(gatewayHttpRejectedEvidenceSchema.parse({ version: 1, kind: "gateway_http_rejected",
    dispatch: structuredClone(dispatch), status, retryAfterMs })));
  return terminal;
}

/** 받은 응답이 처리 전 거절이면 증인을, 아니면 빈 객체를 돌려준다(전송 함수의 실패 반환에 펼쳐 넣는다). */
export function gatewayHttpRejectedWitness(dispatch: GatewayHttpRejectedDispatch, status: number,
  retryAfterMs: number | null): { rejected: GatewayHttpRejected } | Record<never, never> {
  return isGatewayHttpRejectedStatus(status) ? { rejected: issueGatewayHttpRejected(dispatch, status, retryAfterMs) } : {};
}
