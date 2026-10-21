import type { AuditReasonCategory } from "./audit-reason-category";

/** 감사 보류 설정의 값 — settings-schema.ts auditHoldSchema 와 같은 모양(브라우저도 쓰므로 스키마를 끌어오지 않는다) */
export type AuditHoldValues = { enabled: boolean; minConfidence: number; categories: readonly AuditReasonCategory[]; secondOpinionReject: boolean };

/**
 * 바꾼 설정이 보류를 넓히는가 — 켬, 문턱 내림, 갈래 더함, 두 번째 모델 거절 켬. 넓히면 사유를 받는다(감사 화면·setAuditHold 가 함께 본다):
 * 사람 눈 없이 공개 목록에서 빠지는 제품이 늘어난다.
 */
export function auditHoldWidens(before: AuditHoldValues, next: AuditHoldValues): boolean {
  return (!before.enabled && next.enabled) || next.minConfidence < before.minConfidence
    || next.categories.some((category) => !before.categories.includes(category)) || (!before.secondOpinionReject && next.secondOpinionReject);
}

export function sameAuditHold(left: AuditHoldValues, right: AuditHoldValues): boolean {
  return left.enabled === right.enabled && left.minConfidence === right.minConfidence && left.secondOpinionReject === right.secondOpinionReject
    && [...left.categories].sort().join() === [...right.categories].sort().join();
}
