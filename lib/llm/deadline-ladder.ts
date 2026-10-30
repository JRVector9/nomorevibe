// Pure validation lives separately so the registry can validate ladders without an import cycle.
export * from "./deadline-policy";
import { modelDeadlineLadder, modelTimeoutMs } from "./model-registry";

/** PR711 defaults remain 50s < 55s < 60s; declarations do not prove external enforcement. */
export const REVIEW_GATEWAY_LADDER = modelDeadlineLadder("review-gateway");
/** Only the outer client bound is declared for M1; no measured engine bound is invented. */
export const PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS = modelTimeoutMs("product-translate");
/**
 * text 워커의 product-translate 틱 예산(scripts/worker.ts jobRunOptions). 입장·DB 대기 뒤에도 호출에 클라이언트 상한 + 기록 여유 2초가 남아야
 * dispatch 가 거절되지 않는다(lib/domain/products/translations.ts callBudget). 2026-10-30: M1 mlx-lm(~35 tok/s)의 긴 번역이 40초를 넘겨 300초로
 * (설명 1건 8,000자 ≈ 100초; 묶음은 PRODUCT_TRANSLATION_BATCH_CHARS 8K 자까지만 묶여 긴 설명은 단독으로 나간다).
 */
export const PRODUCT_TRANSLATION_JOB_BUDGET_MS = PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS + 15_000;
