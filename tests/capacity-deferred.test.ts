import { describe, expect, it } from "vitest";
import { isModelCapacityDeferredReason, MODEL_CAPACITY_DEFERRED_REASONS, modelCapacityDeferralIsGlobal, modelCapacityDeferralIsPerModel,
  modelCapacityDeferralIsPerWork, modelCapacityDeferralScope, type ModelCapacityDeferredReason } from "@/lib/llm/capacity-deferred";

/**
 * 미룸 사유의 범위 표(PR 3a-B, 2026-10-31 소유자 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다").
 * consumer·legacy 틱은 이 범위만큼만 멈춘다: work → 그 항목만, model → 그 모델만(이 패스), global → 쪽·틱(cursor 유지, 5초 쉼).
 */
const TABLE: Record<ModelCapacityDeferredReason, "global" | "model" | "work"> = {
  draining: "global", disabled: "global", policy_changed: "global", owner_unavailable: "global", reservation_required: "global",
  capacity: "model", queue_full: "model", unmapped: "model", provider_contract_unavailable: "model", device_unconfigured: "model",
  helper_ineligible: "model",
  dispatched: "work", work_busy: "work", ledger_mismatch: "work", withdrawn: "work", reservation_lost: "work",
};

describe("미룸 사유 범위 표", () => {
  it("모든 사유가 표에 있고 범위는 하나다", () => {
    expect([...MODEL_CAPACITY_DEFERRED_REASONS].sort()).toEqual(Object.keys(TABLE).sort());
    for (const [reason, scope] of Object.entries(TABLE) as [ModelCapacityDeferredReason, "global" | "model" | "work"][]) {
      expect(modelCapacityDeferralScope(reason), reason).toBe(scope);
      expect([modelCapacityDeferralIsGlobal(reason), modelCapacityDeferralIsPerModel(reason), modelCapacityDeferralIsPerWork(reason)].filter(Boolean), reason)
        .toHaveLength(1);
      expect(modelCapacityDeferralIsGlobal(reason), reason).toBe(scope === "global");
      expect(modelCapacityDeferralIsPerModel(reason), reason).toBe(scope === "model");
      expect(modelCapacityDeferralIsPerWork(reason), reason).toBe(scope === "work");
    }
  });
  it("항목 하나의 일은 그 항목만 넘긴다 — #754 의 work_busy·dispatched 에 ledger_mismatch·withdrawn·reservation_lost 가 더해졌다", () => {
    expect(MODEL_CAPACITY_DEFERRED_REASONS.filter(modelCapacityDeferralIsPerWork).sort())
      .toEqual(["dispatched", "ledger_mismatch", "reservation_lost", "withdrawn", "work_busy"]);
  });
  it("장비는 모델에 붙으므로 device_unconfigured 는 모델 범위다 — 다른 장비의 모델은 계속 돈다", () => {
    expect(modelCapacityDeferralScope("device_unconfigured")).toBe("model");
    expect(MODEL_CAPACITY_DEFERRED_REASONS.filter(modelCapacityDeferralIsGlobal).sort())
      .toEqual(["disabled", "draining", "owner_unavailable", "policy_changed", "reservation_required"]);
  });
  it("도우미 경로 닫힘(helper_ineligible, PR 2a)은 그 장비의 도우미 경로만의 일이라 모델 범위다 — 우선 역할 경로와 다른 장비는 계속 돈다", () => {
    expect(modelCapacityDeferralScope("helper_ineligible")).toBe("model");
    expect(modelCapacityDeferralIsPerWork("helper_ineligible")).toBe(false);
  });
  it("모르는 문자열은 사유가 아니다", () => {
    expect(isModelCapacityDeferredReason("capacity")).toBe(true);
    for (const value of ["", "indeterminate", "CAPACITY", 1, null, undefined, "toString"]) expect(isModelCapacityDeferredReason(value), String(value)).toBe(false);
  });
});
