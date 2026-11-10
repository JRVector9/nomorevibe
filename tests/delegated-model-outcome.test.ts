import { describe, expect, it } from "vitest";
import { delegatedModelOutcome, delegatedThresholdHold, type DelegatedAnswer } from "@/lib/crawl/delegated-model-outcome";
import { readDelegatedModelOutcome } from "@/lib/crawl/delegated-hold";

// 0173: 위임 시도의 원래 답과 사람에게 남긴 까닭 — recordHumanReview 가 끝난 길마다 이 값으로 적는다
const at = 0.9;
const options = (cannotApprove = false) => ({ cannotApprove, minConfidence: at });
const answer = (decision: DelegatedAnswer["decision"], confidence?: number): DelegatedAnswer => ({ decision, confidence });

describe("문턱 단계의 남긴 까닭(delegatedThresholdHold)", () => {
  it("모델 보류는 확신과 상관없이 model_abstained", () => {
    expect(delegatedThresholdHold(answer("needs_review", 0.95), false, at)).toBe("model_abstained");
    expect(delegatedThresholdHold(answer("needs_review"), true, at)).toBe("model_abstained");
  });
  it("승인 불가 사유의 승인은 확신이 문턱 미만이어도 cannot_approve — 문턱을 내려도 적용되지 않는다", () => {
    expect(delegatedThresholdHold(answer("approve", 0.97), true, at)).toBe("cannot_approve");
    expect(delegatedThresholdHold(answer("approve", 0.5), true, at)).toBe("cannot_approve");
  });
  it("승인 불가 사유는 반려를 막지 않는다 — 확신 미만의 반려는 low_confidence, 문턱 이상이면 지난다", () => {
    expect(delegatedThresholdHold(answer("reject", 0.8), true, at)).toBe("low_confidence");
    expect(delegatedThresholdHold(answer("reject", 0.95), true, at)).toBeNull();
  });
  it("확신이 문턱 미만이거나 없으면 low_confidence, 문턱과 같으면 지난다", () => {
    expect(delegatedThresholdHold(answer("approve", 0.89), false, at)).toBe("low_confidence");
    expect(delegatedThresholdHold(answer("approve"), false, at)).toBe("low_confidence");
    expect(delegatedThresholdHold(answer("approve", 0.9), false, at)).toBeNull();
    expect(delegatedThresholdHold(answer("reject", 0.9), false, at)).toBeNull();
  });
});

describe("기록 값(delegatedModelOutcome)", () => {
  it("적용한 승인·반려는 까닭 없이 원래 결정·확신을 적는다", () => {
    expect(delegatedModelOutcome(answer("approve", 0.97), "applied", options())).toEqual({ decision: "approve", confidence: 0.97, holdCause: null });
    expect(delegatedModelOutcome(answer("reject", 0.93), "applied", options())).toEqual({ decision: "reject", confidence: 0.93, holdCause: null });
  });
  it("문턱 단계에서 남긴 것은 원래 결정(바뀌기 전)과 그 까닭을 적는다", () => {
    expect(delegatedModelOutcome(answer("needs_review", 0.6), "held", options())).toEqual({ decision: "needs_review", confidence: 0.6, holdCause: "model_abstained" });
    expect(delegatedModelOutcome(answer("approve", 0.8), "held", options())).toEqual({ decision: "approve", confidence: 0.8, holdCause: "low_confidence" });
    expect(delegatedModelOutcome(answer("reject"), "held", options())).toEqual({ decision: "reject", confidence: null, holdCause: "low_confidence" });
    expect(delegatedModelOutcome(answer("approve", 0.97), "held", options(true))).toEqual({ decision: "approve", confidence: 0.97, holdCause: "cannot_approve" });
  });
  it("근거 나이 길의 승인은 그 길의 까닭을 적는다", () => {
    expect(delegatedModelOutcome(answer("approve", 0.95), "stale", options()).holdCause).toBe("stale_evidence");
    expect(delegatedModelOutcome(answer("approve", 0.95), "repo_changed", options()).holdCause).toBe("repo_changed");
    expect(delegatedModelOutcome(answer("approve", 0.95), "repo_gone", options()).holdCause).toBe("repo_gone");
  });
  it("적은 값은 계약의 읽기(readDelegatedModelOutcome)를 그대로 지난다", () => {
    for (const value of [delegatedModelOutcome(answer("approve", 0.8), "held", options()), delegatedModelOutcome(answer("reject"), "applied", options()),
      delegatedModelOutcome(answer("approve", 0.95), "repo_gone", options())])
      expect(readDelegatedModelOutcome(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
});
