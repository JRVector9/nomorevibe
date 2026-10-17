import { ModelCapacityDeferredError } from "./capacity-deferred";
import { readModelCapacityCallerControl } from "./capacity-repository";

const TEXT_MODEL_ROUTES = ["reason-translate", "product-tagline-ko", "product-translate", "crawl-tagline",
  "product-search-profile", "product-search-verify", "search-query-translate"] as const;
type TextModelRoute = typeof TEXT_MODEL_ROUTES[number];

/** Admission refusal only. No text route can issue a positive permit or prove a
 * provider terminal yet; disabled retains the original transport and wire. */
export async function assertTextModelAdmission(input: { routeId: TextModelRoute; model: string }): Promise<void> {
  const { routeId, model } = input;
  if (!TEXT_MODEL_ROUTES.includes(routeId)) throw new Error("invalid_text_model_route");
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") return;
  if (control.mode === "draining") throw new ModelCapacityDeferredError("draining");
  if (control.mode !== "open") throw new Error("model_capacity_control_invalid");
  const mapped = control.policy?.routes.some(route => route.routeId === routeId
    && route.provider === "abcllm" && route.model === model);
  throw new ModelCapacityDeferredError(mapped ? "provider_contract_unavailable" : "unmapped");
}
