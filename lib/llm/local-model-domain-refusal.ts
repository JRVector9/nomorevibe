import { ModelCapacityDeferredError } from "./capacity-deferred";

/**
 * 호출 직전 도메인 증명(local-model-domain.ts localModelDomainRefusal)이 거절한 검사(2026-11-03).
 * 예전에는 증명이 boolean 이라 dispatch 가 null → 호출자 reservation_lost → 예약 물림(withdrawn, evidence·reason 없음)만 남았다.
 * 운영에서 입력 기한(validUntil)이 지난 공개분 2차 행 하나가 이 길로 14시간 동안 866번 물렸는데 어느 검사인지 장부에 없었다.
 * 이제 dispatch 가 예약을 물리는 같은 TX 에서 withdrawn 이벤트 evidence 에 이 검사를 적고, 호출자에게 아래 오류로 알린다.
 */
export const LOCAL_MODEL_DOMAIN_CHECKS = ["job_mismatch", "assist_input_mismatch", "assist_domain", "pipeline_draining", "source_missing",
  "crawl_disabled", "screen_proof_stale", "screen_source_future", "input_expired", "source_changed", "split_gate_closed", "input_changed",
  "product_unavailable", "item_mismatch", "campaign_missing", "step_disabled", "target_not_open"] as const;
export type LocalModelDomainCheck = typeof LOCAL_MODEL_DOMAIN_CHECKS[number];
/** validUntil 은 input_expired 때만 — 증명이 잠근 원본의 입력 유효 기한(min(fetched, scan) + 24h) */
export type LocalModelDomainRefusal = { check: LocalModelDomainCheck; validUntil?: string };

/** withdrawn(reservation_cancelled) 이벤트 evidence 의 모양 — model_capacity_events 의 evidence 는 object 이면 된다 */
export function localModelDomainRefusalEvidence(refusal: LocalModelDomainRefusal) {
  return { version: 1, kind: "local_model_domain_refused", ...refusal } as const;
}

/**
 * 증명이 거절해 예약을 물렸다. 예전 호출자와 같게 reason 은 reservation_lost(범위 work — 이 항목 하나)이고, check 로 까닭을 가른다.
 * 입력 기한 지남(input_expired)은 원본이 다시 수집되기 전까지 몇 번을 다시 물어도 같은 답이다 — 호출자는 그 항목을 건너뛰고 다음 항목으로 간다.
 */
export class LocalModelDomainRefusedError extends ModelCapacityDeferredError {
  constructor(readonly refusal: LocalModelDomainRefusal) {
    super("reservation_lost");
    this.name = "LocalModelDomainRefusedError";
  }
  get check(): LocalModelDomainCheck { return this.refusal.check; }
}
