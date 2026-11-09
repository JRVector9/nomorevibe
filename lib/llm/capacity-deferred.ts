/**
 * - `device_unconfigured`(PR 1b): 경로의 장비에 활성 `model_capacity_devices` 행도 정책 `groupLimits` 대체도 없다.
 * - `work_busy`: 장부가 행 없이 거절했다(같은 작업 fence·중복 작업) — 이 작업 하나가 다른 요청에 묶였을 뿐, 슬롯은 남아 있을 수 있다.
 *   장부(requestSlot)는 포화와 같은 `capacity` 로 답하므로 호출자가 capacityRefusalReason(capacity-busy-targets.ts)으로 가른다.
 * - `ledger_mismatch`: 이 대상 한 세대의 장부 행이 정확한 사슬로 읽히지 않는다(2026-10-31) — 그 대상만 격리하고 잡은 다음 대상으로 간다.
 *   예전에는 이 오류가 틱 전체를 던져 같은 머리 대상이 매 틱 잡 전체를 멈췄다. 호출·시도·실패 기록은 없다.
 * - `helper_ineligible`(PR 2a Layer B): 이 요청은 도우미 경로(model_helper_assignments 의 live·shadow 경로)인데 지금 닫혀 있다 — 감시자 신호가 없거나·
 *   만료됐거나·다른 epoch·판·계정이거나, 감시자가 꺼졌거나, 자동 정지·mode·판정이 막거나, 배정 점유가 max_slots 에 찼다(fail-closed).
 *   대기 행·event 를 남기지 않는다. 도우미 단계는 이번 틱을 멈출 뿐 모델 호출을 다시 시도하지 않는다. 우선 역할 경로에는 오지 않는다.
 * - `route_quota`(step 2, 2026-11-08): 이 장비에서 이 route 가 경로 몫의 상한(max_slots, 빌려주기 꺼짐이면 보장)에 닿았다 — 대기 행·event 를 남기지 않는다
 *   (이미 줄에 서 있던 자기 대기 행은 wait_cancelled 로 거둔다). 그 장비의 그 경로만의 일이라 다음 순위가 받고, 순위가 없으면 포화(`capacity`)처럼 나중에 다시 한다.
 * - `model_quota`(0170, 2026-11-09): 이 장비에서 이 모델(장부 model 문자열, 공급자 무관)이 모델 상한(model_limits.max_slots)에 닿았다 — `route_quota` 와
 *   똑같이 대기 행·event 를 남기지 않고(자기 대기 행은 거두고) 다음 순위가 받으며, 순위가 없으면 포화처럼 나중에 다시 한다.
 * - `assignments_unavailable`(PR 3b-B): 배정 표 읽기가 켜졌는데 이 프로세스가 배정 표를 아직 한 번도 읽지 못했다 — 어느 모델이 맞는지
 *   모르므로 예전 설정으로 고르거나 정리하지 않고 이번 틱을 멈춘다(호출·시도·실패 기록 없음). 다음 틱에 다시 읽는다.
 *   PR 3b-E 부터는 스위치 자체(runtime_settings 토글 `assignments.tableReads`)를 아직 읽지 못한 때도 같다 — DB 에서 설정을 읽는 프로세스만.
 */
export type ModelCapacityDeferredReason = "draining" | "unmapped" | "provider_contract_unavailable"
  | "reservation_required" | "owner_unavailable" | "capacity" | "queue_full" | "policy_changed"
  | "withdrawn" | "dispatched" | "disabled" | "reservation_lost" | "device_unconfigured" | "work_busy"
  | "ledger_mismatch" | "helper_ineligible" | "assignments_unavailable" | "route_quota" | "model_quota";

/**
 * 미룸 사유의 범위(PR 3a-B, 2026-10-31 소유자 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다").
 * 호출자(consumer 쪽·legacy 틱의 자리)는 이 범위만큼만 멈춘다 — 그 밖의 항목·모델·단계는 계속 돈다.
 *
 * - `global`: 이 프로세스가 지금 어느 모델에도 새 요청을 낼 수 없다 — 장부 모드(`draining`·`disabled`)·정책 세대(`policy_changed`)·
 *   요청 owner 없음(`owner_unavailable`)·예약 없는 보냄 시도(`reservation_required`, 호출 흐름 계약 위반)·배정 표를 켰는데 아직 한 번도 못 읽음
 *   (`assignments_unavailable`, PR 3b-B — 표가 고르는 어느 단계도 모델을 고를 수 없다; 30초 스냅숏이 읽히면 풀린다). 쪽을 접고 cursor 를 지킨 채 잠깐 쉰다.
 * - `model`: 그 route 의 그 모델(=그 장비)만의 일 — 포화(`capacity`)·대기열 가득(`queue_full`)·정책에 없음(`unmapped`)·전송 계약 없음
 *   (`provider_contract_unavailable`)·장비 행 없음(`device_unconfigured`, 장비는 모델에 붙으므로 모델 단위다)·도우미 경로 닫힘
 *   (`helper_ineligible`, PR 2a — 그 장비의 도우미 경로만 닫힌 것)·경로 몫 상한(`route_quota`, step 2)·모델 상한(`model_quota`, 0170). 그 모델은 이 패스 동안 건너뛰고
 *   다른 모델의 항목은 계속 본다. 모델이 하나뿐인 단계에서는 결과적으로 쪽이 끝난다(다른 모델이 없으니).
 * - `work`: 이 항목(요청) 하나만의 일 — 앞선 호출이 보내진 중(`dispatched`)·같은 항목이 다른 요청에 묶임(`work_busy`)·장부 세대 어긋남
 *   (`ledger_mismatch`)·이 요청이 줄에서 물러남(`withdrawn`)·받은 예약을 보내기 전에 잃음(`reservation_lost`). 항목 하나를 넘기고 다음 항목을 본다.
 *   항목에는 호출·시도·실패 기록이 남지 않는다 — 다음 패스가 다시 집는다.
 */
export type ModelCapacityDeferralScope = "global" | "model" | "work";

const SCOPE: Readonly<Record<ModelCapacityDeferredReason, ModelCapacityDeferralScope>> = Object.freeze({
  draining: "global", disabled: "global", policy_changed: "global", owner_unavailable: "global", reservation_required: "global",
  assignments_unavailable: "global",
  capacity: "model", queue_full: "model", unmapped: "model", provider_contract_unavailable: "model", device_unconfigured: "model",
  helper_ineligible: "model", route_quota: "model", model_quota: "model",
  dispatched: "work", work_busy: "work", ledger_mismatch: "work", withdrawn: "work", reservation_lost: "work",
});

export const MODEL_CAPACITY_DEFERRED_REASONS: readonly ModelCapacityDeferredReason[] =
  Object.freeze(Object.keys(SCOPE) as ModelCapacityDeferredReason[]);

export function isModelCapacityDeferredReason(value: unknown): value is ModelCapacityDeferredReason {
  return typeof value === "string" && Object.hasOwn(SCOPE, value);
}

export function modelCapacityDeferralScope(reason: ModelCapacityDeferredReason): ModelCapacityDeferralScope {
  return SCOPE[reason];
}

/** 프로세스 전체의 미룸 — 어느 모델에도 새 요청을 낼 수 없다. 쪽·틱을 접고(cursor 유지) 잠깐 쉰다. */
export function modelCapacityDeferralIsGlobal(reason: ModelCapacityDeferredReason): boolean {
  return SCOPE[reason] === "global";
}

/** 그 모델(장비)만의 미룸 — 이 패스 동안 그 모델만 건너뛰고 다른 모델의 항목은 계속 본다. */
export function modelCapacityDeferralIsPerModel(reason: ModelCapacityDeferredReason): boolean {
  return SCOPE[reason] === "model";
}

/**
 * 이 작업 하나만의 미룸인가 — 앞선 호출이 아직 보내진 중(`dispatched`)이거나 같은 작업이 다른 요청에 묶였다(`work_busy`),
 * 이 작업의 장부 세대가 사슬로 읽히지 않는다(`ledger_mismatch`), 이 요청이 줄에서 물러났거나(`withdrawn`) 예약을 잃었다(`reservation_lost`).
 * 2026-10-30 소유자 결정("미확인이 되어도 절대 멈추지 않는다"): 호출자는 이 대상만 건너뛰고 같은 틱·쪽의 다른 일을 계속한다.
 * 모델·경로·틱 전체를 멈추는 사유(포화 `capacity`·`queue_full`·정책·owner·draining 등)는 여기에 넣지 않는다.
 */
export function modelCapacityDeferralIsPerWork(reason: ModelCapacityDeferredReason): boolean {
  return SCOPE[reason] === "work";
}

/** Admission refusal only; this error never proves a reservation or provider end. */
export class ModelCapacityDeferredError extends Error {
  constructor(readonly reason: ModelCapacityDeferredReason) {
    super("model_capacity_deferred");
    this.name = "ModelCapacityDeferredError";
  }
}
