/**
 * 저장이 새로 만드는 엔진 직접 계약의 모양(2026-11-21 abcllm 이름표 정리 2단계) — 엔진 연결·「작업 ↔ 모델」 순위 저장·작업 분산·표본 비교·배정 표 저장이
 * 이 한 규칙(engineContractShape)을 쓴다. 순수 규칙이라 아무것도 import 하지 않는다(화면 구성 요소가 읽는 admin-ai-tasks.ts 도 부른다).
 *
 * 3단계(계약 다시 저장)는 경로마다 소유자 승인·D-6 표본 비교 뒤 전환 도구(serving-contract-convert.ts)로만 한다. 그래서 평범한 관리 저장(순위 순서 바꾸기 등)이
 * 경로를 몰래 옮기지 않게, 새 계약이 엔진 직접 총량 상한(openai-chat-total-bound-v1, provider local-direct)이 되는 것은 둘 다일 때뿐이다:
 * 1. 계약 읽기 관문(contract-reader-gate.ts)이 열려 있다(계약을 읽는 모든 프로세스가 새 판).
 * 2. 그 경로에 켜진 abcllm 계약이 하나도 없다 — 전환 도구가 경로를 끝까지 옮겼거나(새 모양 계약만 남음), 처음부터 계약이 없는 새 경로다.
 *    일부 모델만 옮긴 경로(abcllm 계약이 하나라도 남음)는 전환 도구가 끝낼 때까지 abcllm 형이다. 켜진 채 남은 옛 게이트웨이 전송 행도 abcllm 계약으로 센다
 *    (호출되지 않는 행이라도 끄기 전까지는 그 경로가 다 옮겨진 것이 아니다).
 * 그 밖에는 예전 그대로 abcllm 형이다(정책 route 도 (경로, abcllm, 장부 이름)).
 * - 새 경로라도 2차(second-review)와 CLI 엔진(OpenCode) 계약은 abcllm 형이다: local-direct 2차 표의 capacity 대체·도우미 실전 경로 겹침(PR #1012 리뷰
 *   「2차 전환 전 필수」), CLI 엔진은 엔진이 닿는지(계획 0-2)·CLI 엔진 local-direct 시험 공백. 전환 도구로 옮긴 경로면 그 경로의 새 저장도 새 모양이다.
 * 이미 있는 계약은 이 규칙으로 바꾸지 않는다 — 그 계약의 provider 로 부른다. 같은 (경로, 모델)을 다시 저장할 때(엔진 연결)는 그 계약의 지금 모양이 경로 상태보다
 * 앞선다: 이미 엔진 직접 총량 상한이면 새 모양 그대로 저장하고, 관문이 닫혀 있으면 abcllm 으로 낮추지 않고 거절한다(converted_gate_closed). abcllm 으로 돌리는 것은
 * 전환 도구의 「되돌리기」뿐이다(저장 함수가 그 밖의 낮추기를 contract_downgrade_refused 로 막는다).
 */
export const TOTAL_BOUND_PROTOCOL_NAME = "openai-chat-total-bound-v1";
export const DIRECT_SHAPE_SAVE_EXCLUDED_ROUTES: readonly string[] = Object.freeze(["second-review"]);
export type EngineContractProvider = "abcllm" | "local-direct";
/** 계약 칸(provider·protocol)이 엔진 직접 총량 상한 모양인가 */
export const isTotalBoundShape = (entry: { provider?: unknown; protocol?: unknown }): boolean =>
  entry.provider === "local-direct" && entry.protocol === TOTAL_BOUND_PROTOCOL_NAME;

/** 한 경로의 켜진 계약 수 — abcllm 형(provider abcllm, 전송 무관)과 엔진 직접 총량 상한 */
export type RouteContractState = Readonly<{ abcllm: number; direct: number }>;
/** 켜진 계약 행(그 경로의 route_id 그대로 — `cli:…`·`local-direct:…` 행은 다른 경로다)에서 센다 */
export function routeContractState(rows: readonly Readonly<{ routeId: string; provider?: unknown; protocol?: unknown }>[], routeId: string): RouteContractState {
  let abcllm = 0, direct = 0;
  for (const row of rows) {
    if (row.routeId !== routeId) continue;
    if (row.provider === "abcllm") abcllm += 1;
    else if (isTotalBoundShape(row)) direct += 1;
  }
  return Object.freeze({ abcllm, direct });
}

/**
 * 까닭: gate_closed(관문 닫힘 → abcllm) · route_unconverted(경로가 아직 전환 전 → abcllm) · excluded(새 경로지만 2차·CLI 엔진 → abcllm) ·
 * converted_gate_closed(그 (경로, 모델)은 이미 새 모양인데 관문이 닫힘 → 저장하지 말고 거절한다). null = 새 모양으로 저장
 */
export type EngineContractShapeReason = "gate_closed" | "route_unconverted" | "excluded" | "converted_gate_closed" | null;
export type EngineContractShape = Readonly<{ provider: EngineContractProvider; reason: EngineContractShapeReason }>;
/** 같은 (경로, 모델)에 켜진 계약의 지금 모양(없으면 null) */
export type ModelContractShape = "total-bound" | "other" | null;
export function engineContractShape(routeId: string, gateOpen: boolean, state: RouteContractState, cliEngine = false,
  current: ModelContractShape = null): EngineContractShape {
  // 이미 옮긴 (경로, 모델)은 낮추지 않는다
  if (current === "total-bound") return Object.freeze({ provider: "local-direct", reason: gateOpen ? null : "converted_gate_closed" });
  if (!gateOpen) return Object.freeze({ provider: "abcllm", reason: "gate_closed" });
  if (state.abcllm > 0) return Object.freeze({ provider: "abcllm", reason: "route_unconverted" });
  // 전환 도구가 끝까지 옮긴 경로(새 모양 계약만 남음)는 2차·CLI 엔진도 새 모양이다. 계약이 없는 새 경로는 2차·CLI 엔진만 abcllm 형
  if (state.direct === 0 && (cliEngine || DIRECT_SHAPE_SAVE_EXCLUDED_ROUTES.includes(routeId))) return Object.freeze({ provider: "abcllm", reason: "excluded" });
  return Object.freeze({ provider: "local-direct", reason: null });
}
/** 화면·저장 결과 한 줄(관문 닫힘은 관문 문장이 따로 말한다) */
export function engineContractShapeText(routeId: string, shape: EngineContractShape, state: RouteContractState): string | null {
  if (shape.reason === "route_unconverted")
    return `${routeId}: 이 경로는 아직 전환 전 — abcllm 모양으로 저장합니다(켜진 abcllm 계약 ${state.abcllm}개). 직접 연결로 옮기는 것은 서빙 계약 화면의 「abcllm 계약 → 직접 연결 전환」입니다.`;
  return null;
}
