import type { AuditReasonCategory } from "./audit-reason-category";

/** Qwen-v2 자동 단계 하나 — 켬/끔과 틱당 상한 */
export type QwenAutoStepValues = { enabled: boolean; perTick: number };

/** 감사 보류 설정의 값 — settings-schema.ts auditHoldSchema 와 같은 모양(브라우저도 쓰므로 스키마를 끌어오지 않는다) */
export type AuditHoldValues = { enabled: boolean; minConfidence: number; categories: readonly AuditReasonCategory[]; secondOpinionReject: boolean;
  autoSecondOpinion: QwenAutoStepValues; publishedFilter: QwenAutoStepValues };

/**
 * 바꾼 설정이 보류를 넓히거나 사람 없이 정하는 일을 켜는가 — 켬, 문턱 내림, 갈래 더함, 두 번째 모델 거절 켬, Qwen-v2 자동 의견 켬
 * (그 거절이 보류의 까닭이 된다), 공개분 자동 유지 켬(사람 확인 행을 Qwen-v2 승인으로 닫는다). 그러면 사유를 받는다
 * (감사 화면·setAuditHold 가 함께 본다). 틱당 상한은 빠르기일 뿐이라 넓힘으로 보지 않는다.
 */
export function auditHoldWidens(before: AuditHoldValues, next: AuditHoldValues): boolean {
  return (!before.enabled && next.enabled) || next.minConfidence < before.minConfidence
    || next.categories.some((category) => !before.categories.includes(category)) || (!before.secondOpinionReject && next.secondOpinionReject)
    || (!before.autoSecondOpinion.enabled && next.autoSecondOpinion.enabled) || (!before.publishedFilter.enabled && next.publishedFilter.enabled);
}

const sameStep = (left: QwenAutoStepValues, right: QwenAutoStepValues) => left.enabled === right.enabled && left.perTick === right.perTick;

export function sameAuditHold(left: AuditHoldValues, right: AuditHoldValues): boolean {
  return left.enabled === right.enabled && left.minConfidence === right.minConfidence && left.secondOpinionReject === right.secondOpinionReject
    && [...left.categories].sort().join() === [...right.categories].sort().join()
    && sameStep(left.autoSecondOpinion, right.autoSecondOpinion) && sameStep(left.publishedFilter, right.publishedFilter);
}
