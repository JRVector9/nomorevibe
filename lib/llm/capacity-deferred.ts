/** Admission refusal only; this error never proves a reservation or provider end. */
export class ModelCapacityDeferredError extends Error {
  constructor(readonly reason: "draining" | "unmapped" | "provider_contract_unavailable") {
    super("model_capacity_deferred");
    this.name = "ModelCapacityDeferredError";
  }
}
