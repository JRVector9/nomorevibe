/**
 * - `device_unconfigured`(PR 1b): 경로의 장비에 활성 `model_capacity_devices` 행도 정책 `groupLimits` 대체도 없다.
 * - `work_busy`: 장부가 행 없이 거절했다(같은 작업 fence·중복 작업) — 이 작업 하나가 다른 요청에 묶였을 뿐, 슬롯은 남아 있을 수 있다.
 *   장부(requestSlot)는 포화와 같은 `capacity` 로 답하므로 호출자가 capacityRefusalReason(capacity-busy-targets.ts)으로 가른다.
 * - `ledger_mismatch`: 이 대상 한 세대의 장부 행이 정확한 사슬로 읽히지 않는다(2026-10-31) — 그 대상만 격리하고 잡은 다음 대상으로 간다.
 *   예전에는 이 오류가 틱 전체를 던져 같은 머리 대상이 매 틱 잡 전체를 멈췄다. 호출·시도·실패 기록은 없다.
 * - `helper_ineligible`(PR 2a Layer B): 이 요청은 도우미 경로(model_helper_assignments 의 live·shadow 경로)인데 지금 닫혀 있다 — 감시자 신호가 없거나·
 *   만료됐거나·다른 epoch·판·계정이거나, 감시자가 꺼졌거나, 자동 정지·mode·판정이 막거나, 배정 점유가 max_slots 에 찼다(fail-closed).
 *   대기 행·event 를 남기지 않는다. 도우미 단계는 이번 틱을 멈출 뿐 모델 호출을 다시 시도하지 않는다. 우선 역할 경로에는 오지 않는다.
 * - `assignments_unavailable`(PR 3b-B): MODEL_ASSIGNMENT_TABLE 이 켜졌는데 이 프로세스가 배정 표를 아직 한 번도 읽지 못했다 — 어느 모델이 맞는지
 *   모르므로 예전 설정으로 고르거나 정리하지 않고 이번 틱을 멈춘다(호출·시도·실패 기록 없음). 다음 틱에 다시 읽는다.
 */
export type ModelCapacityDeferredReason = "draining" | "unmapped" | "provider_contract_unavailable"
  | "reservation_required" | "owner_unavailable" | "capacity" | "queue_full" | "policy_changed"
  | "withdrawn" | "dispatched" | "disabled" | "reservation_lost" | "device_unconfigured" | "work_busy"
  | "ledger_mismatch" | "helper_ineligible" | "assignments_unavailable";

export function isModelCapacityDeferredReason(value: unknown): value is ModelCapacityDeferredReason {
  return typeof value === "string" && ["draining", "unmapped", "provider_contract_unavailable", "reservation_required",
    "owner_unavailable", "capacity", "queue_full", "policy_changed", "withdrawn", "dispatched", "disabled", "reservation_lost",
    "device_unconfigured", "work_busy", "ledger_mismatch", "helper_ineligible", "assignments_unavailable"].includes(value);
}

/**
 * 이 작업 하나만의 미룸인가 — 앞선 호출이 아직 보내진 중(`dispatched`)이거나 같은 작업이 다른 요청에 묶였다(`work_busy`),
 * 또는 이 작업의 장부 세대가 사슬로 읽히지 않는다(`ledger_mismatch`).
 * 2026-10-30 소유자 결정("미확인이 되어도 절대 멈추지 않는다"): 호출자는 이 대상만 건너뛰고 같은 틱·쪽의 다른 일을 계속한다.
 * 모델·경로·틱 전체를 멈추는 사유(포화 `capacity`·`queue_full`·정책·owner·draining 등)는 여기에 넣지 않는다.
 */
export function modelCapacityDeferralIsPerWork(reason: ModelCapacityDeferredReason): boolean {
  return reason === "dispatched" || reason === "work_busy" || reason === "ledger_mismatch";
}

/** Admission refusal only; this error never proves a reservation or provider end. */
export class ModelCapacityDeferredError extends Error {
  constructor(readonly reason: ModelCapacityDeferredReason) {
    super("model_capacity_deferred");
    this.name = "ModelCapacityDeferredError";
  }
}
