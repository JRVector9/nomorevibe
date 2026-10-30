import { gatewayNotStartedEvidenceSchema, type GatewayNotStartedEvidence } from "./capacity";
import { takeGatewayNotSent } from "./gateway-local-end";
import { logger } from "@/lib/observability/logger";

/**
 * 보내지 않은 게이트웨이 호출의 증인(CLI D5 not_started 의 게이트웨이판). 두 경우만 낸다.
 * (1) fetch 를 한 번도 부르지 않고 닫은 호출 — one-use 준비 호출을 그 자리에서 쓴 것으로 닫으므로 같은 dispatch 는 다시 보낼 수 없다.
 * (2) fetch 를 불렀지만 요청 바이트가 하나도 나가지 않은 것이 증명된 호출(연결 거부·DNS 실패·connect 시간 초과 — gateway-local-end 의
 *     전송 증인: 모든 native dispatch 가 onRequestStart 없이 오류로 끝났다).
 * 요청이 소켓에 쓰인 뒤의 실패(시간 초과·응답 중 끊김)는 전송 여부를 모르므로 증인이 없고, 그 호출은 지금처럼 indeterminate 로 남는다.
 * 증인은 이 프로세스 메모리의 원본 객체뿐이고 한 번만 정산한다 — 저장된 JSON·사본은 권한이 아니다. 정산은 점유만 끝낸다(사용량 증거 없음).
 */
export type GatewayNotStarted = Readonly<{ kind: "gateway_not_started" }>;
export type GatewayNotStartedDispatch = GatewayNotStartedEvidence["dispatch"];
const terminals = new WeakMap<GatewayNotStarted, GatewayNotStartedEvidence>();

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function readGatewayNotStarted(value: unknown): GatewayNotStartedEvidence | null {
  return value && typeof value === "object" ? terminals.get(value as GatewayNotStarted) ?? null : null;
}

export function issueGatewayNotStarted(dispatch: GatewayNotStartedDispatch): GatewayNotStarted {
  const terminal: GatewayNotStarted = Object.freeze({ kind: "gateway_not_started" });
  terminals.set(terminal, freeze(gatewayNotStartedEvidenceSchema.parse({ version: 1, kind: "gateway_not_started", dispatch })));
  return terminal;
}

/** fetch 가 거부됐을 때: 요청 바이트 0 이 증명되면 증인을, 아니면 빈 객체를 돌려준다(전송 함수의 실패 반환에 펼쳐 넣는다). */
export function gatewayNotSentWitness(dispatch: GatewayNotStartedDispatch, error: unknown): { notStarted: GatewayNotStarted } | Record<never, never> {
  const proof = takeGatewayNotSent(dispatch.requestId, error);
  if (!proof) return {};
  logger.info("gateway.not_sent", { requestId: dispatch.requestId, dispatches: proof.dispatches, code: proof.code });
  return { notStarted: issueGatewayNotStarted(dispatch) };
}

/** fetch 가 요청 바이트 0 으로 거부됐다(연결 거부·DNS…): 던지는 쪽은 증인을 싣고, 받는 쪽은 indeterminate 대신 not_started 로 정산한 뒤 cause 를 원래 오류로 다룬다. */
export class GatewayNotSentError extends Error {
  constructor(readonly notStarted: GatewayNotStarted, cause: unknown) { super("gateway_not_sent", { cause }); this.name = "GatewayNotSentError"; }
}
