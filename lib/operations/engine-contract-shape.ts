/**
 * 저장이 새로 만드는 엔진 직접 계약의 모양(2026-11-21 abcllm 이름표 정리 2단계) — 엔진 연결·「작업 ↔ 모델」 순위 저장·작업 분산·배정 표 저장이 같은 규칙을 쓴다.
 * 순수 규칙이라 아무것도 import 하지 않는다(화면 구성 요소가 읽는 admin-ai-tasks.ts 도 부른다).
 *
 * - 계약 읽기 관문(contract-reader-gate.ts)이 열려 있으면 새 계약은 엔진 직접 총량 상한(openai-chat-total-bound-v1, provider local-direct)이고,
 *   정책 route 도 (경로, local-direct, 장부 이름)이다. 닫혀 있으면 예전처럼 abcllm 형이다(옛 판 프로세스도 읽는 모양) — 저장은 막지 않고 알린다.
 * - 2차(second-review)는 관문과 무관하게 abcllm 형 그대로다: local-direct 2차 표는 capacity 대체·도우미 실전 경로와 겹치는 동작이 있어(PR #1012 리뷰
 *   「2차 전환 전 필수」) 그 확인이 끝나 이 목록에서 뺄 때까지 새로 만들지 않는다. 이미 있는 2차 계약은 3단계 전환 도구가 옮긴다.
 * - CLI 엔진(OpenCode) 계약도 abcllm 형 그대로다(엔진이 닿는지 0-2 미확인 · CLI 엔진 local-direct 시험 공백). 전환 도구는 옮길 수 있다.
 * 이미 있는 계약은 이 규칙으로 바꾸지 않는다 — 그 계약의 provider 로 부른다.
 */
export const TOTAL_BOUND_PROTOCOL_NAME = "openai-chat-total-bound-v1";
export const DIRECT_SHAPE_SAVE_EXCLUDED_ROUTES: readonly string[] = Object.freeze(["second-review"]);
export type EngineContractProvider = "abcllm" | "local-direct";
export function newEngineContractProvider(routeId: string, gateOpen: boolean, cliEngine = false): EngineContractProvider {
  return gateOpen && !cliEngine && !DIRECT_SHAPE_SAVE_EXCLUDED_ROUTES.includes(routeId) ? "local-direct" : "abcllm";
}
/** 계약 칸(provider·protocol)이 엔진 직접 총량 상한 모양인가 */
export const isTotalBoundShape = (entry: { provider?: unknown; protocol?: unknown }): boolean =>
  entry.provider === "local-direct" && entry.protocol === TOTAL_BOUND_PROTOCOL_NAME;
