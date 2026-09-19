import { describe, expect, it } from "vitest";
import type { ReviewAiDecision } from "@/lib/crawl/admin-review";
import { heldStages, STAGE_GROUPS, STAGE_KEYS } from "@/app/admin/review/stages";

const noSecond = { unanimous_reject: [], unanimous_approve: [], agreed_reject: [], agreed_approve: [], needs_human: [] };

describe("heldStages — 보류 후보를 심사 구간으로 나눈다", () => {
  it("구간은 겹치지 않고, 더하면 보류 전체다", () => {
    const aiIds = new Map<ReviewAiDecision, number[]>([["none", [1, 2]], ["reject", [3, 4]], ["approve", [5, 6]], ["needs_review", [7]]]);
    const result = heldStages(aiIds, { ...noSecond, agreed_reject: [3], unanimous_approve: [5], needs_human: [7] });
    expect(result.ids).toEqual({ ai: [1, 2], second: [4, 6], agreed: [3, 5], human: [7] });
    expect(result).toMatchObject({ agreedReject: 1, agreedApprove: 1 });
    const all = Object.values(result.ids).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("이미 보류가 아닌 후보의 2차 표는 세지 않는다 — 2차 행은 후보가 다시 판정돼도 남는다", () => {
    const result = heldStages(new Map<ReviewAiDecision, number[]>([["reject", [3]]]), { ...noSecond, agreed_reject: [3, 99], needs_human: [98] });
    expect(result.ids).toEqual({ ai: [], second: [], agreed: [3], human: [] });
    expect(result.agreedReject).toBe(1);
  });

  it("구간은 규칙 → 1차 AI → 2차 → 사람 → 결과 순서다", () => {
    expect(STAGE_GROUPS.map((group) => group.title)).toEqual(["규칙 판정", "1차 AI 심사", "2차 심사", "사람 확인", "결과"]);
    expect(STAGE_KEYS).toEqual(["judge", "ai", "second", "agreed", "human", "publish", "published", "rejected"]);
  });
});
