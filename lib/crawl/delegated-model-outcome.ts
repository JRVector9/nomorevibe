import type { ReviewOutcome } from './agent-review-contract';
import type { DelegatedHoldCause, DelegatedModelOutcome } from './delegated-hold';

/** 모델의 원래 답 중 기록에 남기는 것 — 문턱을 걸기 전 결정과 확신 */
export type DelegatedAnswer = Pick<ReviewOutcome, 'decision' | 'confidence'>;

/**
 * 위임 시도가 succeeded 로 끝난 길(human-review-repository.ts recordHumanReview 의 갈래).
 * 실패·밀려남(superseded)·저장소 확인 미룸(repo_check_deferred)은 succeeded 가 아니라 model_outcome 을 적지 않는다(NULL).
 *  - applied: 승인·반려를 후보에 적용했다
 *  - held: 확신 문턱·승인 불가 사유 단계에서 판단 보류로 닫았다
 *  - stale: 승인 의견이지만 근거가 72시간을 넘어 원본을 다시 받는다(STALE_EVIDENCE_REFRESH)
 *  - repo_changed / repo_gone: 승인 의견이지만 24~72시간 근거의 저장소 확인에서 저장소가 바뀌었다 / 사라졌다
 */
export type DelegatedEnding = 'applied' | 'held' | 'stale' | 'repo_changed' | 'repo_gone';

/**
 * 확신 문턱·승인 불가 사유 단계에서 사람에게 남기는 까닭. null 이면 이 단계를 지난다(반려는 적용, 승인은 근거 나이 길로 간다).
 *
 * 지금 코드는 이 단계를 한 줄의 「또는」으로 가른다 — reviewWithDeepSeek 가 확신 미만의 승인·반려를 needs_review 로 바꾸고,
 * recordHumanReview 가 (확신 미만 또는 승인 불가 사유의 승인)을 다시 needs_review 로 둔다. 그래서 까닭이 겹칠 수 있고, 겹치면 이 순서로 하나만 고른다:
 *  1. model_abstained — 모델이 스스로 needs_review 를 냈다(확신과 상관없이)
 *  2. cannot_approve — 승인 의견인데 후보 사유가 사람만 승인할 수 있는 것(스팸 의심·저장소 삭제·재수집 실패).
 *     확신이 문턱 미만이어도 이것이 먼저다 — 문턱을 내려도 적용되지 않으므로 「확신 부족」으로 세지 않는다
 *  3. low_confidence — 승인·반려 의견의 확신이 문턱 미만. 확신이 없으면 0 으로 본다(reviewWithDeepSeek·recordHumanReview 와 같다)
 * 근거 나이 길(stale_evidence·repo_changed·repo_gone)은 이 단계를 지난 승인에만 닿는다 — 확신 미만의 승인은 저장소 확인도 원본 재수집도 하지 않는다.
 */
export function delegatedThresholdHold(answer: DelegatedAnswer, cannotApprove: boolean, minConfidence: number):
  'model_abstained' | 'cannot_approve' | 'low_confidence' | null {
  if (answer.decision === 'needs_review') return 'model_abstained';
  if (answer.decision === 'approve' && cannotApprove) return 'cannot_approve';
  if ((answer.confidence ?? 0) < minConfidence) return 'low_confidence';
  return null;
}

/** 시도 행의 model_outcome — 원래 결정·확신과 끝난 길에서 고른 까닭(적용했으면 null) */
export function delegatedModelOutcome(answer: DelegatedAnswer, ending: DelegatedEnding,
  options: { cannotApprove: boolean; minConfidence: number }): DelegatedModelOutcome {
  const holdCause: DelegatedHoldCause | null = ending === 'applied' ? null
    : ending === 'stale' ? 'stale_evidence'
    : ending === 'repo_changed' ? 'repo_changed'
    : ending === 'repo_gone' ? 'repo_gone'
    // held 는 이 단계의 까닭이 늘 있다(recordHumanReview 가 같은 조건으로 needs_review 를 둔다) — 없으면 확신 부족으로 본다(닿지 않는다)
    : delegatedThresholdHold(answer, options.cannotApprove, options.minConfidence) ?? 'low_confidence';
  return { decision: answer.decision, confidence: answer.confidence ?? null, holdCause };
}
