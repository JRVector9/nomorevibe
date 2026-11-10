import { sql, type SQL } from "drizzle-orm";

/**
 * 사람 몫 위임 검수(human-deepseek-review)의 모델 원래 답과 「사람에게 남김」의 까닭 — crawl_review_attempts.model_outcome(0173).
 *
 * outcome 칸은 확신 문턱·승인 불가 사유·근거 나이 규칙을 적용한 뒤의 결정만 남긴다(사람에게 남기면 needs_review).
 * 그래서 모델이 근거가 부족해 판단을 보류한 것과, 승인·반려 의견이 있었는데 확신이 문턱에 못 미친 것이 같은 needs_review 로 보였다
 * (2026-11-10 운영자: 「근거 부족은 사람이 승인하는 목록으로 따로」). 이 칸이 그 둘을 가른다.
 *
 * 쓰는 곳은 위임 시도 기록(human-review-repository.ts recordHumanReview) 하나다. 옛 행(0173 전)은 NULL — 원래 답을 알 수 없다.
 */
export const DELEGATED_MODEL_DECISIONS = ["approve", "reject", "needs_review"] as const;
export type DelegatedModelDecision = (typeof DELEGATED_MODEL_DECISIONS)[number];

/**
 * 사람에게 남긴 까닭. null = 남기지 않았다(모델 결정을 그대로 적용).
 *  - model_abstained: 모델이 스스로 needs_review(근거 부족·상충) — 「근거 부족」 목록
 *  - low_confidence: 승인·반려 의견이지만 확신이 DEEPSEEK_MIN_CONFIDENCE 미만 — 「확신 부족」
 *  - cannot_approve: 승인 의견이지만 후보 사유가 사람만 승인할 수 있는 것(스팸 의심·저장소 삭제·재수집 실패)
 *  - stale_evidence: 승인 의견이지만 근거가 72시간을 넘어 원본을 다시 받는다(STALE_EVIDENCE_REFRESH)
 *  - repo_changed: 승인 의견이지만 24~72시간 근거의 저장소 확인에서 저장소가 바뀌었다
 *  - repo_gone: 승인 의견이지만 저장소 확인에서 저장소가 사라졌다(repo_deleted 로 넘김)
 */
export const DELEGATED_HOLD_CAUSES = ["model_abstained", "low_confidence", "cannot_approve", "stale_evidence", "repo_changed", "repo_gone"] as const;
export type DelegatedHoldCause = (typeof DELEGATED_HOLD_CAUSES)[number];

export type DelegatedModelOutcome = {
  decision: DelegatedModelDecision;
  /** 모델이 준 확신(0~1). 없으면 null */
  confidence: number | null;
  holdCause: DelegatedHoldCause | null;
};

/** SQL 에서 위임 시도의 남긴 까닭 — alias 는 crawl_review_attempts 의 별칭(예: sql.raw("a")). 옛 행·적용된 행은 NULL */
export function delegatedHoldCauseSql(alias: SQL): SQL<DelegatedHoldCause | null> {
  return sql<DelegatedHoldCause | null>`(${alias}.model_outcome->>'holdCause')`;
}

/** 저장된 값 읽기 — 모양이 어긋나면 null(옛 행과 같이 「원래 답 모름」으로 본다) */
export function readDelegatedModelOutcome(value: unknown): DelegatedModelOutcome | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const decision = row.decision, confidence = row.confidence, holdCause = row.holdCause;
  if (!(DELEGATED_MODEL_DECISIONS as readonly unknown[]).includes(decision)) return null;
  if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence))) return null;
  if (holdCause !== null && !(DELEGATED_HOLD_CAUSES as readonly unknown[]).includes(holdCause)) return null;
  return { decision: decision as DelegatedModelDecision, confidence: confidence as number | null, holdCause: holdCause as DelegatedHoldCause | null };
}
