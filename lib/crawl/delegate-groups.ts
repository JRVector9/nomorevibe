import type { DelegatedHoldCause, DelegatedModelDecision, DelegatedModelOutcome } from "./delegated-hold";

/**
 * 사람 몫의 「AI 위임 결과」 나누기 — 사람 몫 위임 검수(human-deepseek-review)가 지금 원본에서 무엇을 남겼는가.
 * 2026-11-10 운영자: 「근거 부족으로 나오는 건 별도로 정리해서 사람이 승인하는 리스트로 보여야 한다. 지금은 분리가 안 되어 있다」.
 *
 * 보류 후보 하나는 정확히 한 갈래에 선다. 갈래는 지금 원본(currentReviewSource)·지금 스위치 세대(deepseekActor)의 마지막 성공 위임 시도로 정한다 —
 * 위임 잡의 고르기(humanReviewRepos)가 「이 원본에서 끝냈다」고 보는 것과 같은 기준이다. 원본이 바뀌면 다시 「AI 미검토」로 돌아간다.
 * 읽기는 delegate-groups-read.ts 가 하고, 나누고 이름 붙이는 일은 이 파일의 순수 함수가 한다(화면 구성 요소도 이 파일만 부른다).
 */
export const DELEGATE_GROUPS = ["abstained", "low_confidence", "human_only", "legacy", "unreviewed", "admin"] as const;
export type DelegateGroup = (typeof DELEGATE_GROUPS)[number];

/** 확신 문턱 — deepseek-review-policy.ts DEEPSEEK_MIN_CONFIDENCE 와 같은 값(화면 글자용. 시험이 둘이 같은지 본다) */
export const DELEGATE_CONFIDENCE_THRESHOLD_TEXT = "0.9";

export const DELEGATE_GROUP_GUIDE: Record<DelegateGroup, { label: string; hint: string }> = {
  abstained: { label: "근거 부족 · AI 판단 보류",
    hint: "AI가 근거가 모자라거나 엇갈린다며 스스로 판단을 보류했다 — 사람이 근거를 보고 승인·반려한다" },
  low_confidence: { label: "확신 부족 · AI 의견 있음",
    hint: `AI가 승인·반려 의견을 냈지만 확신이 ${DELEGATE_CONFIDENCE_THRESHOLD_TEXT} 미만이라 적용하지 않았다 — 의견과 확신을 보고 확정한다` },
  human_only: { label: "사람만 승인 · 원본 문제",
    hint: "AI는 승인 의견이지만 사람만 승인하는 사유(스팸 의심·저장소 삭제·재수집 실패)이거나, 근거가 72시간을 넘어 원본을 다시 받거나, 저장소가 바뀌었거나 사라졌다. AI 결정이 적용된 뒤 되돌려진 것도 여기에 선다" },
  legacy: { label: "이전 기록 · 까닭 미기록",
    hint: "AI가 이 원본에서 보류했지만 남긴 까닭을 적기 전(0173 전)의 기록이라 근거 부족인지 확신 부족인지 모른다" },
  unreviewed: { label: "AI 미검토",
    hint: "위임 검수가 지금 원본에 아직 판단을 남기지 않았다 — 차례 대기·2차 대기·보류 재심사 몫·시도 소진·원본이 바뀐 것 포함" },
  admin: { label: "관리자 보류 · AI 대상 아님", hint: "관리자가 보류한 후보(자동 판정이 아닌 보류) — 위임 검수가 집지 않는다" },
};

/** 남긴 까닭(delegated-hold.ts) → 화면 말 */
export const DELEGATE_HOLD_CAUSE_LABELS: Record<DelegatedHoldCause, string> = {
  model_abstained: "근거 부족 — AI가 스스로 판단을 보류",
  low_confidence: `확신 부족 — 확신이 ${DELEGATE_CONFIDENCE_THRESHOLD_TEXT} 미만이라 적용하지 않음`,
  cannot_approve: "사람만 승인하는 사유(스팸 의심·저장소 삭제·재수집 실패)라 승인을 적용하지 않음",
  stale_evidence: "근거가 72시간을 넘어 승인하지 않고 원본을 다시 받음",
  repo_changed: "저장소 확인에서 저장소가 바뀌어 승인하지 않음",
  repo_gone: "저장소 확인에서 저장소가 사라져 승인하지 않음",
};

/** 사람 몫 목록에서 한 갈래만 연 주소 — 운영 홈 「사람이 처리할 일」의 수가 이 목록으로 간다 */
export const delegateGroupHref = (group: DelegateGroup) => `/admin/review?tab=human&delegate=${group}`;

/** 후보 한 건의 사실 — id, 판정 주체, 지금 원본의 마지막 성공 위임 시도(없으면 null)와 그 원래 답(읽지 못한 모양·옛 행은 null) */
export type DelegateFacts = { id: number; decidedBy: string | null; attemptId: number | null; outcome: DelegatedModelOutcome | null };

/**
 * 갈래 정하기 — 차례가 곧 규칙이다.
 *  1. 자동 판정 보류가 아니면(decided_by ≠ 'auto') 관리자 보류 — 위임 잡이 집지 않는다
 *  2. 지금 원본의 성공 위임 시도가 없으면 AI 미검토
 *  3. 그 시도에 원래 답이 없으면(0173 전 행·모양이 어긋난 값) 이전 기록
 *  4. 남긴 까닭이 model_abstained 면 근거 부족, low_confidence 면 확신 부족, 나머지(승인 불가·근거 나이·저장소 확인, 적용 뒤 되돌림)는 사람만 승인
 */
export function delegateGroupOf(facts: Omit<DelegateFacts, "id">): DelegateGroup {
  if (facts.decidedBy !== "auto") return "admin";
  if (facts.attemptId === null) return "unreviewed";
  if (!facts.outcome) return "legacy";
  if (facts.outcome.holdCause === "model_abstained") return "abstained";
  if (facts.outcome.holdCause === "low_confidence") return "low_confidence";
  return "human_only";
}

export type DelegateGroups = { ids: Record<DelegateGroup, number[]> };

export function groupDelegateFacts(rows: readonly DelegateFacts[]): DelegateGroups {
  const ids = Object.fromEntries(DELEGATE_GROUPS.map(group => [group, [] as number[]])) as Record<DelegateGroup, number[]>;
  for (const row of rows) ids[delegateGroupOf(row)].push(row.id);
  return { ids };
}

/**
 * 갈래별 수 — scope(지금 단계·갈래 조건의 id)가 있으면 그 안에서만 센다. 목록은 같은 id 를 교집합으로 거르므로
 * 검색·기간 조건이 없을 때 칩의 수와 그 칩을 누른 목록의 전체 수가 같다.
 */
export function delegateGroupCounts(groups: DelegateGroups, scope?: readonly number[]): Record<DelegateGroup, number> {
  const keep = scope ? new Set(scope) : null;
  return Object.fromEntries(DELEGATE_GROUPS.map(group => [group,
    keep ? groups.ids[group].filter(id => keep.has(id)).length : groups.ids[group].length])) as Record<DelegateGroup, number>;
}

/** 상세가 그리는 위임 검수의 마지막 판단 — 목록(listAdminReviewEntries)이 후보마다 하나 붙인다 */
export type DelegateOpinion = {
  /** 모델의 원래 답과 남긴 까닭(0173). 옛 행은 null — 시도 행에 남은 결정(applied)만 안다 */
  model: DelegatedModelOutcome | null;
  /** 시도 행의 결정 — 확신 문턱·승인 불가·근거 나이 규칙을 적용한 뒤(사람에게 남기면 needs_review) */
  applied: DelegatedModelDecision | null;
  /** 모델이 준 확신(0~1) */
  confidence: number | null;
  reason: string | null; reasonKo: string | null;
  modelName: string | null;
  at: string;
  /** 지금 원본·지금 스위치 세대의 시도인가 — 아니면 원본이 바뀌기 전의 판단이고, 갈래는 「AI 미검토」다 */
  current: boolean;
};

const LEANING: Record<DelegatedModelDecision, string> = { approve: "승인 의견", reject: "반려 의견", needs_review: "판단 보류" };

/** 위임 판단 한 줄 — 의견(모델의 원래 답)과 남긴 까닭. 옛 행은 적용한 결정만 말한다 */
export function delegateOpinionText(opinion: Pick<DelegateOpinion, "model" | "applied">): { leaning: string; cause: string } {
  if (!opinion.model) return {
    leaning: opinion.applied === "needs_review" ? "보류(원래 답 미기록)" : opinion.applied ? LEANING[opinion.applied] : "판단 미기록",
    cause: "까닭 미기록(0173 전 기록)",
  };
  return { leaning: LEANING[opinion.model.decision],
    cause: opinion.model.holdCause ? DELEGATE_HOLD_CAUSE_LABELS[opinion.model.holdCause] : "결정을 그대로 적용함" };
}

export const delegateConfidenceText = (value: number | null) => value === null ? "확신 —" : `확신 ${value.toFixed(2)}`;
