export type ModelCapacityDeferredReason = "draining" | "unmapped" | "provider_contract_unavailable"
  | "reservation_required" | "owner_unavailable" | "capacity" | "queue_full" | "policy_changed"
  | "withdrawn" | "dispatched" | "disabled" | "reservation_lost";

/** Admission refusal only; this error never proves a reservation or provider end. */
export class ModelCapacityDeferredError extends Error {
  constructor(readonly reason: ModelCapacityDeferredReason) {
    super("model_capacity_deferred");
    this.name = "ModelCapacityDeferredError";
  }
}
