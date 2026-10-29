// Pure validation lives separately so the registry can validate ladders without an import cycle.
export * from "./deadline-policy";
import { modelDeadlineLadder, modelTimeoutMs } from "./model-registry";

/** PR711 defaults remain 50s < 55s < 60s; declarations do not prove external enforcement. */
export const REVIEW_GATEWAY_LADDER = modelDeadlineLadder("review-gateway");
/** Only the outer client bound is declared for M1; no measured engine bound is invented. */
export const PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS = modelTimeoutMs("product-translate");
