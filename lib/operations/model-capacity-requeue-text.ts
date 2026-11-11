/**
 * 「다시 대기열」(결과 미확정 행) 결과의 말 — 서버(장부 닫기 메모·작업 로그)와 화면(결과 한 줄·행마다 까닭)이 같은 글자를 쓴다.
 * 의존 없는 작은 모듈이라 클라이언트 구성 요소도 가져다 쓴다(2026-11-09).
 *
 * 행마다 결과는 셋 중 하나다.
 * - requeued: 그 단계의 실제 작업 큐로 되돌렸다 → 장부 행을 운영자 검토(withdrawn)로 닫는다.
 * - done: 할 일이 이미 끝났거나 할 일이 없어졌다(판정·번역이 끝남, 대상이 사라짐) → 다시 넣지 않고 닫는다.
 * - skipped: 넣지도 닫지도 않았다 → 행은 결과 미확정으로 남고, 화면이 이 까닭을 행마다 보인다.
 */
export const REQUEUE_REASON_TEXT = Object.freeze({
  // requeued
  requeued: "다시 넣음",
  // done — 할 일이 끝났거나 없어짐
  candidate_gone: "후보가 없어짐",
  candidate_decided: "후보 판정이 이미 남(사람·거절·발행)",
  first_review_done: "1차 판정이 이미 남",
  first_review_reopened: "원본이 바뀌어 처음부터 다시 판정함",
  vote_done: "2차 표가 이미 끝남",
  vote_gone: "2차 표가 없어짐",
  translation_done: "번역이 이미 끝남",
  translation_gone: "번역 대상이 없어짐",
  product_not_listed: "공개 상태가 아닌 제품",
  profile_done: "키워드를 이미 지음",
  verify_done: "검수가 끝났거나 키워드를 다시 짓는 중",
  tagline_done: "소개가 이미 있음",
  tagline_not_needed: "소개 짓기 대상이 아님",
  category_done: "분류가 이미 끝남",
  // 로컬 직접 경로(2026-11-11)
  delegate_done: "위임 검수를 그 뒤 다시 해 끝남",
  attempts_exhausted: "시도 상한에 닿아 더 묻지 않음 — 사람 몫으로 남음",
  tiebreak_gone: "갈림 판가름 행이 없어졌거나 바뀜",
  tiebreak_done: "갈림 판가름이 이미 끝남(답·물을 수 없음)",
  confirm_done: "갈림 확인이 이미 끝났거나 기다리지 않음",
  audit_item_gone: "감사 항목이 없어짐",
  audit_done: "감사 답이 이미 있음",
  audit_closed: "감사가 끝났거나 취소됨",
  // skipped — 남는다
  unsupported_route: "다시 대기열을 지원하지 않는 단계 — 근거를 보고 한 건씩 닫기",
  key_unreadable: "작업 키를 읽지 못함 — 한 건씩 닫기",
  route_error: "단계 처리 중 오류 — 다시 누르거나 한 건씩 닫기",
  close_failed: "작업은 처리했으나 장부 행을 닫지 못함 — 다시 누르기",
} as const);
export type RequeueReason = keyof typeof REQUEUE_REASON_TEXT;
export type RequeueOutcome = "requeued" | "done" | "skipped";
export const requeueReasonText = (reason: string): string => (REQUEUE_REASON_TEXT as Readonly<Record<string, string>>)[reason] ?? reason;

/** 한 번 누른 결과 — requests = 본 행, requeued = 다시 넣은 행, closed = 닫힌 장부 행(다시 넣은 행 + 할 일이 끝난 행), left = 남은 행. */
export type RequeueSummary = Readonly<{
  requests: number; requeued: number; done: number; closed: number; left: number;
  /** 남은 행의 까닭(많은 것부터) */
  reasons: readonly Readonly<{ reason: string; count: number }>[];
}>;

const fmt = (value: number) => value.toLocaleString("ko-KR");

/** 「N건 다시 넣음 · M건 닫음 · K건 남음(까닭)」 */
export function requeueSummaryText(summary: RequeueSummary): string {
  if (!summary.requests) return "다시 넣을 결과 미확정 행이 없습니다";
  const head = `${fmt(summary.requeued)}건 다시 넣음 · ${fmt(summary.closed)}건 닫음`;
  if (!summary.left) return head;
  const why = summary.reasons.map(entry => `${requeueReasonText(entry.reason)} ${fmt(entry.count)}`).join(" · ");
  return `${head} · ${fmt(summary.left)}건 남음(${why})`;
}
