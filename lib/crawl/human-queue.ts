import type { ReviewAiDecision } from "./admin-review";
import type { SecondChipKey, SecondReviewCounts } from "./second-review";

/**
 * "사람이 볼 것"의 정의 — 운영센터와 심사 큐가 같은 객체의 같은 필드를 그린다.
 *
 * 전에는 운영센터가 보류 전체(사람 확인 1,355 · 최장 39일)를, 심사 큐가 직접 판단 구간(1,075 · 최장 7일)을
 * 따로 세서 어느 화면을 믿어야 할지 몰랐다(2026-10-08 감사 ADM-04). 여기서는 DB 를 읽지 않는다 —
 * 읽기는 review-overview.ts 의 humanQueueOverview 가 하고, 나누고 이름 붙이는 일은 이 순수 함수들이 한다.
 */

/** 보류 안에서 가르는 구간. 나머지는 후보 상태(state) 그대로다 */
export type HeldStage = "ai" | "second" | "agreed" | "human";

/**
 * 보류 후보를 구간으로 나눈다.
 *
 * aiIds 는 보류 전부를 1차 AI 결론으로 나눈 것이다(reviewQueueAiDecisions). 2차 칩의 id 에는 이미 보류가 아닌
 * 후보가 섞일 수 있어(2차 행은 후보가 다시 판정돼도 남는다) 보류 집합과 겹치는 것만 센다.
 * 2차가 끝난 것이 먼저다 — AI 결론이 없는데 2차 결론이 있을 수는 없지만, 있다면 사람 쪽으로 보낸다.
 * 사람만 가르는 사유인데 2차가 이미 같은 결론을 낸 것은 "확정만 하면 됨"에 둔다 — 구간이 겹치지 않게.
 */
export function heldStages(aiIds: Map<ReviewAiDecision, number[]>, secondIds: Record<SecondChipKey, number[]>,
  /** 사람만 가르는 사유(HUMAN_ONLY_REASONS) — 2차 표가 없어도 "직접 판단"에 선다 */
  humanOnly: number[] = []): {
  ids: Record<HeldStage, number[]>; agreedReject: number; agreedApprove: number;
} {
  const held = new Set([...aiIds.values()].flat());
  const within = (list: number[]) => list.filter((id) => held.has(id));
  const agreedReject = within([...secondIds.unanimous_reject, ...secondIds.agreed_reject]);
  const agreedApprove = within([...secondIds.unanimous_approve, ...secondIds.agreed_approve]);
  const agreed = new Set([...agreedReject, ...agreedApprove]);
  const human = within([...secondIds.needs_human, ...humanOnly]).filter((id) => !agreed.has(id));
  const concluded = new Set([...agreed, ...human]);
  const none = new Set(aiIds.get("none") ?? []);
  const ai = [...none].filter((id) => !concluded.has(id));
  const second = [...held].filter((id) => !none.has(id) && !concluded.has(id));
  return {
    ids: { ai, second, agreed: [...agreed], human: [...new Set(human)] },
    agreedReject: new Set(agreedReject).size, agreedApprove: new Set(agreedApprove).size,
  };
}

/**
 * 대기의 기준 시각 — 규칙 판정 시각(없으면 마지막 변경). 심사 목록의 "대기" 칸과 "오래 기다린 것부터" 정렬이
 * 같은 시각을 쓰므로, 그 정렬의 맨 위 줄이 화면 머리의 "최장"과 같다.
 */
export const WAIT_REFERENCE = "규칙 판정 시각(없으면 마지막 변경) 기준 — 심사 목록의 '대기' 칸, '오래 기다린 것부터' 정렬과 같은 시각";
/** humanFlowLabel 의 뜻 — 화면 칸의 title 로 붙인다 */
export const FLOW_NOTE = "24h +N 은 최근 24시간에 들어와 아직 남은 수, 처리는 사람이 24시간에 내린 결정 수";

export type HumanQueueOverview = {
  /** 보류(needs_review) 전체 — 네 구간의 합 */
  held: number;
  /** 구간별 후보 id — 겹치지 않는다 */
  ids: Record<HeldStage, number[]>;
  stages: Record<HeldStage, number>;
  /** 확정만 하면 됨 — 두 모델이 같은 결론 */
  agreed: { reject: number; approve: number };
  /** 사람 몫 = 확정만 하면 됨 + 직접 판단 */
  person: number;
  /** 2차 칩 — 보류 안의 후보로 좁힌 id 와 수. 목록이 칩을 누른 결과와 칩의 수가 같다 */
  secondIds: Record<SecondChipKey, number[]>;
  second: Record<SecondChipKey, number>;
  /** 2차가 다시 본 공개분 — 보류가 아니라 공개 제품이라 구간 밖이다 */
  secondPublished: number;
  /** 직접 판단 구간의 나이(WAIT_REFERENCE) — 가장 오래된 날수, 2주 넘은 수, 최근 24시간에 들어와 남은 수. 못 읽으면 null */
  wait: { oldestDays: number | null; stalled: number; in24h: number } | null;
  /** 최근 24시간에 사람이 내린 결정(admin_override). 못 읽으면 null */
  decided24h: { approve: number; reject: number } | null;
  /** 보류 전체의 1차 AI 결론 — 세부 거르기가 쓴다 */
  aiDecisions: { counts: Record<ReviewAiDecision, number>; ids: Map<ReviewAiDecision, number[]> };
};

export function buildHumanQueueOverview(parts: {
  aiDecisions: HumanQueueOverview["aiDecisions"];
  seconds: { counts: SecondReviewCounts; ids: Record<SecondChipKey, number[]> };
  humanOnly: number[];
  wait: HumanQueueOverview["wait"];
  decided24h: HumanQueueOverview["decided24h"];
}): HumanQueueOverview {
  const split = heldStages(parts.aiDecisions.ids, parts.seconds.ids, parts.humanOnly);
  const held = new Set([...parts.aiDecisions.ids.values()].flat());
  const secondIds = Object.fromEntries(Object.entries(parts.seconds.ids)
    .map(([key, list]) => [key, list.filter((id) => held.has(id))])) as Record<SecondChipKey, number[]>;
  const stages = { ai: split.ids.ai.length, second: split.ids.second.length, agreed: split.ids.agreed.length, human: split.ids.human.length };
  return {
    held: held.size, ids: split.ids, stages, agreed: { reject: split.agreedReject, approve: split.agreedApprove },
    person: stages.agreed + stages.human,
    secondIds, second: Object.fromEntries(Object.entries(secondIds).map(([key, list]) => [key, list.length])) as Record<SecondChipKey, number>,
    secondPublished: parts.seconds.counts.published,
    wait: parts.wait, decided24h: parts.decided24h, aiDecisions: parts.aiDecisions,
  };
}

const n = (value: number) => value.toLocaleString("ko-KR");

/** 직접 판단의 나이 한 줄 — 두 화면이 같은 말을 쓴다 */
export function humanWaitLabel(overview: HumanQueueOverview): string {
  if (overview.stages.human === 0) return "대기 없음";
  return overview.wait?.oldestDays != null ? `판정 뒤 최장 ${overview.wait.oldestDays}일` : "대기 시각 미확인";
}

/** 직접 판단의 24시간 흐름 — 들어와 남은 수(+)와 사람이 내린 결정 수(처리). 칸이 좁아 짧게 쓴다 */
export function humanFlowLabel(overview: HumanQueueOverview): string {
  const decided = overview.decided24h ? overview.decided24h.approve + overview.decided24h.reject : null;
  return `24h +${n(overview.wait?.in24h ?? 0)} · 처리 ${decided === null ? "?" : n(decided)}`;
}
