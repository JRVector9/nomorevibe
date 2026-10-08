/** 구간 나누기는 운영센터도 쓰므로 lib 에 있다(human-queue.ts) */
export { heldStages, type HeldStage } from "@/lib/crawl/human-queue";

/**
 * 심사 구간 — 후보가 지금 파이프라인의 어디에 서 있는가.
 *
 * 규칙 판정 → 1차 AI → 2차 심사 → 사람 확인 → 결과. 칩을 갈래(보류 이유·AI 결론·2차 표)로만
 * 나눠 두었을 때는 "지금 사람이 해야 할 일이 어디에 몇 건인가"를 칩을 더해 가며 짐작해야 했다.
 * 구간은 겹치지 않는다 — 보류 후보 하나는 AI 대기·2차 대기·확정만·직접 판단 중 정확히 한 곳에 있다.
 */
export type StageKey = "judge" | "ai" | "second" | "agreed" | "human" | "publish" | "published" | "rejected";

export const STAGE_STATE: Record<StageKey, "new" | "needs_review" | "approved" | "published" | "rejected"> = {
  judge: "new", ai: "needs_review", second: "needs_review", agreed: "needs_review", human: "needs_review",
  publish: "approved", published: "published", rejected: "rejected",
};

export const STAGE_GROUPS: { step: string; title: string; stages: { key: StageKey; label: string; hint: string }[] }[] = [
  { step: "1", title: "규칙 판정", stages: [
    { key: "judge", label: "판정 대기", hint: "수집한 원본을 규칙이 가르는 중" },
  ] },
  { step: "2", title: "1차 AI 심사", stages: [
    { key: "ai", label: "AI 대기", hint: "규칙이 보류했고 AI 결론이 아직 없다" },
  ] },
  { step: "3", title: "2차 심사", stages: [
    { key: "second", label: "2차 대기", hint: "AI가 결론을 냈고 다른 모델의 표를 모으는 중" },
  ] },
  { step: "4", title: "사람 확인", stages: [
    { key: "agreed", label: "확정만 하면 됨", hint: "두 모델이 같은 결론 — 훑어보고 한 번에 확정" },
    { key: "human", label: "직접 판단", hint: "모델끼리 갈렸거나 표가 모자라다" },
  ] },
  { step: "5", title: "결과", stages: [
    { key: "publish", label: "발행 대기", hint: "승인됨, 발행 잡이 올린다" },
    { key: "published", label: "발행 완료", hint: "공개 목록에 있다" },
    { key: "rejected", label: "거부", hint: "규칙·AI·사람이 거부했다" },
  ] },
];

export const STAGE_KEYS = STAGE_GROUPS.flatMap((group) => group.stages.map((stage) => stage.key));

/** A stage card selects the whole stage, independent of previous detail/search filters. */
export function stageHref(current: StageKey | "", selected: StageKey): string {
  return current === selected ? "/admin/review#review-list" : `/admin/review?stage=${selected}#review-list`;
}

/** 2차 심사 거르기(?second=) — 같은 결론끼리 모아 한 번에 확정한다. 'published' 는 2차가 다시 본 공개분 */
export const SECOND_FILTERS = [['unanimous_reject', '만장일치·거부'], ['unanimous_approve', '만장일치·승인'],
  ['agreed_reject', '2표 일치·거부'], ['agreed_approve', '2표 일치·승인'], ['needs_human', '사람 확인']] as const;
export type SecondFilter = typeof SECOND_FILTERS[number][0] | 'published';
export const SECOND_FILTER_KEYS: readonly SecondFilter[] = [...SECOND_FILTERS.map(([key]) => key), 'published'];
