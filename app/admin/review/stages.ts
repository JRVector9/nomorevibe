import type { ReviewAiDecision } from "@/lib/crawl/admin-review";
import type { SecondChipKey } from "@/lib/crawl/second-review";

/**
 * 심사 구간 — 후보가 지금 파이프라인의 어디에 서 있는가.
 *
 * 규칙 판정 → 1차 AI → 2차 심사 → 사람 확인 → 결과. 칩을 갈래(보류 이유·AI 결론·2차 표)로만
 * 나눠 두었을 때는 "지금 사람이 해야 할 일이 어디에 몇 건인가"를 칩을 더해 가며 짐작해야 했다.
 * 구간은 겹치지 않는다 — 보류 후보 하나는 AI 대기·2차 대기·확정만·직접 판단 중 정확히 한 곳에 있다.
 */
export type StageKey = "judge" | "ai" | "second" | "agreed" | "human" | "publish" | "published" | "rejected";

/** 보류 안에서 가르는 구간. 나머지는 후보 상태(state) 그대로다 */
export type HeldStage = "ai" | "second" | "agreed" | "human";

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

/**
 * 보류 후보를 구간으로 나눈다.
 *
 * aiIds 는 보류 전부를 1차 AI 결론으로 나눈 것이다(reviewQueueAiDecisions). 2차 칩의 id 에는 이미 보류가 아닌
 * 후보가 섞일 수 있어(2차 행은 후보가 다시 판정돼도 남는다) 보류 집합과 겹치는 것만 센다.
 * 2차가 끝난 것이 먼저다 — AI 결론이 없는데 2차 결론이 있을 수는 없지만, 있다면 사람 쪽으로 보낸다.
 */
export function heldStages(aiIds: Map<ReviewAiDecision, number[]>, secondIds: Record<SecondChipKey, number[]>,
  /** 사람만 가르는 사유(2차 갈림·소개 없음) — 2차 표가 없어도 "직접 판단"에 선다 */
  humanOnly: number[] = []): {
  ids: Record<HeldStage, number[]>; agreedReject: number; agreedApprove: number;
} {
  const held = new Set([...aiIds.values()].flat());
  const within = (list: number[]) => list.filter((id) => held.has(id));
  const agreedReject = within([...secondIds.unanimous_reject, ...secondIds.agreed_reject]);
  const agreedApprove = within([...secondIds.unanimous_approve, ...secondIds.agreed_approve]);
  const human = within([...secondIds.needs_human, ...humanOnly]);
  const concluded = new Set([...agreedReject, ...agreedApprove, ...human]);
  const none = new Set(aiIds.get("none") ?? []);
  const ai = [...none].filter((id) => !concluded.has(id));
  const second = [...held].filter((id) => !none.has(id) && !concluded.has(id));
  return {
    ids: { ai, second, agreed: [...new Set([...agreedReject, ...agreedApprove])], human: [...new Set(human)] },
    agreedReject: new Set(agreedReject).size, agreedApprove: new Set(agreedApprove).size,
  };
}
