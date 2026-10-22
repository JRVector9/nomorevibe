import { classifyAuditReason, type AuditReasonCategory } from "./audit-reason-category";
import { SCREENSHOT_SOURCES } from "./audit-import-sources";
import { countedOpinion, holdGates, type HoldGateOpinion, type HoldGateOptions } from "./product-audit-hold";
import { secondRejectHolds } from "./second-opinion-rules";
import type { AuditHoldSettings } from "./settings";

/**
 * 올린 두 번째 의견이 보류에 무엇을 하나(0116) — 미리보기(audit-second-opinion-upload.ts)와 적용(audit-policy.ts import 처리)이 같은 셈을 쓴다.
 *
 * 보류의 둘째 문(product-audit-hold.ts holdGates)은 그대로다: 두 번째 모델의 승인이 하나라도 있으면 사유 갈래로는 걸지 않고, 보류에 세는
 * 두 번째 거절이 하나라도 있으면 건다. 그래서 '남은 거절이 있으면 풀지 않는다' — 스크린샷까지 본 새 승인도, 예전에 글만 본 모델(grok 일괄·
 * Qwen-v2 자동 의견)이 같은 항목을 거절했으면 보류를 풀 수 없다. 그 항목들은 크롤러가 글을 읽지 못한 JS 페이지라 예전 거절의 사유가 대개
 * '제목만·빈 화면'이었다.
 *
 * 대체(supersede): 사람이 미리보기에서 켰을 때만(기본 꺼짐) — 이 줄이 스크린샷까지 본 출처(SCREENSHOT_SOURCES)의 승인이고 보류에서 세는
 * 확신이면(countedOpinion — m1 은 0.90 이상), 같은 항목의 글만 본 출처의 거절을 빼고 둘째 문을 다시 본다. 그래도 맞지 않으면 푼다.
 * 거절 의견을 지우지는 않는다 — 기록으로 남고, 제품 기록의 풀림 줄에 무엇을 대신했는지 적는다.
 */

export type ImportBlocker = { kind: "reject"; model: string; source: string | null; confidence: number | null }
  | { kind: "category"; category: AuditReasonCategory };
export type ImportHoldEffect = {
  /** gate: 덮어쓴 뒤의 의견으로 둘째 문이 맞지 않아 푼다 · supersede: 대체를 켜서 푼다 · null: 그대로 보류 */
  release: "gate" | "supersede" | null;
  /** 대체가 대신한 글만 본 거절 */
  superseded: { model: string; source: string | null; confidence: number | null }[];
  /** 그대로 보류일 때 무엇이 막나 — 보류에 세는 두 번째 거절, 또는 사유 갈래(세는 승인이 없음 — 확신이 하한 아래 등) */
  blockers: ImportBlocker[];
};

const view = (opinion: HoldGateOpinion) => ({ model: opinion.model, source: opinion.source ?? null,
  confidence: typeof opinion.confidence === "number" ? opinion.confidence : null });

export function importHoldEffect(input: {
  /** thinText: 그 제품의 수집 본문이 적다(audit-text-gate.ts) — 글만 본 m1 의견은 보류에서 세지 않는다 */
  item: { reason: string | null; model: string | null; confidence: number | null; thinText?: boolean };
  /** 이 줄을 덮어쓴 뒤 그 항목의 의견 전부 */
  opinions: HoldGateOpinion[];
  line: { decision: string; confidence: number | null; shot: boolean; source: string; model: string };
  hold: Pick<AuditHoldSettings, "categories" | "secondOpinionReject">;
  options: HoldGateOptions;
  supersede: boolean;
}): ImportHoldEffect {
  const gateItem = { reason: input.item.reason, model: input.item.model, confidence: input.item.confidence, thinText: input.item.thinText };
  const gates = holdGates({ ...gateItem, opinions: input.opinions }, input.hold, input.options);
  if (!gates.byCategory && !gates.bySecondOpinion) return { release: "gate", superseded: [], blockers: [] };
  const countedReject = (opinion: HoldGateOpinion) => opinion.decision === "reject"
    && countedOpinion(opinion, input.options, { opinions: input.opinions, thinText: input.item.thinText })
    && secondRejectHolds(opinion.model, input.item.reason);
  const textRejects = input.opinions.filter((opinion) => countedReject(opinion) && !SCREENSHOT_SOURCES.has(opinion.source ?? ""));
  const qualifies = input.line.decision === "approve" && input.line.shot && SCREENSHOT_SOURCES.has(input.line.source)
    && countedOpinion({ model: input.line.model, decision: "approve", source: input.line.source, confidence: input.line.confidence }, input.options);
  if (input.supersede && qualifies && textRejects.length) {
    const after = holdGates({ ...gateItem, opinions: input.opinions.filter((opinion) => !textRejects.includes(opinion)) }, input.hold, input.options);
    if (!after.byCategory && !after.bySecondOpinion) return { release: "supersede", superseded: textRejects.map(view), blockers: [] };
  }
  const blockers: ImportBlocker[] = input.opinions.filter(countedReject).map((opinion) => ({ kind: "reject" as const, ...view(opinion) }));
  if (gates.byCategory) blockers.push({ kind: "category", category: classifyAuditReason(input.item.reason) });
  return { release: null, superseded: [], blockers };
}

/** 대체를 켜면 풀릴 수 있는 줄인가 — 미리보기가 '대체 대상'을 셀 때 */
export function supersedeCandidate(line: { decision: string; shot: boolean; source: string }): boolean {
  return line.decision === "approve" && line.shot && SCREENSHOT_SOURCES.has(line.source);
}
