/**
 * 「LLM 운영」 화면 사이 주소 — 의존 없는 작은 모듈이라 클라이언트 구성 요소(LiveModels 등)도 가져다 쓴다.
 * 결과 미확정 행을 다시 대기열에 넣거나 닫는 곳은 기록 › 재실행 대기 한 곳이다(2026-11-07 승인 시안 PR 3).
 */
export const LLM_RETRY_HREF = "/admin/models/history#retry";
export const llmRetryRowHref = (requestId: string) => `/admin/models/history#rv-${requestId}`;
