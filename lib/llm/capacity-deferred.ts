/**
 * - `device_unconfigured`(PR 1b): 경로의 장비에 활성 `model_capacity_devices` 행도 정책 `groupLimits` 대체도 없다.
 * - `work_busy`: 장부가 행 없이 거절했다(같은 작업 fence·중복 작업) — 이 작업 하나가 다른 요청에 묶였을 뿐, 슬롯은 남아 있을 수 있다.
 *   장부(requestSlot)는 포화와 같은 `capacity` 로 답하므로 호출자가 capacityRefusalReason(capacity-busy-targets.ts)으로 가른다.
 */
export type ModelCapacityDeferredReason = "draining" | "unmapped" | "provider_contract_unavailable"
  | "reservation_required" | "owner_unavailable" | "capacity" | "queue_full" | "policy_changed"
  | "withdrawn" | "dispatched" | "disabled" | "reservation_lost" | "device_unconfigured" | "work_busy";

export function isModelCapacityDeferredReason(value: unknown): value is ModelCapacityDeferredReason {
  return typeof value === "string" && ["draining", "unmapped", "provider_contract_unavailable", "reservation_required",
    "owner_unavailable", "capacity", "queue_full", "policy_changed", "withdrawn", "dispatched", "disabled", "reservation_lost",
    "device_unconfigured", "work_busy"].includes(value);
}

/**
 * 이 작업 하나만의 미룸인가 — 앞선 호출이 아직 보내진 중(`dispatched`)이거나 같은 작업이 다른 요청에 묶였다(`work_busy`).
 * 2026-10-30 소유자 결정("미확인이 되어도 절대 멈추지 않는다"): 호출자는 이 대상만 건너뛰고 같은 틱·쪽의 다른 일을 계속한다.
 * 모델·경로·틱 전체를 멈추는 사유(포화 `capacity`·`queue_full`·정책·owner·draining 등)는 여기에 넣지 않는다.
 */
export function modelCapacityDeferralIsPerWork(reason: ModelCapacityDeferredReason): boolean {
  return reason === "dispatched" || reason === "work_busy";
}

/** Admission refusal only; this error never proves a reservation or provider end. */
export class ModelCapacityDeferredError extends Error {
  constructor(readonly reason: ModelCapacityDeferredReason) {
    super("model_capacity_deferred");
    this.name = "ModelCapacityDeferredError";
  }
}
