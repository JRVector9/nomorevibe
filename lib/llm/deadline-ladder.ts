// Pure validation lives separately so the registry can validate ladders without an import cycle.
export * from "./deadline-policy";
import { modelDeadlineLadder, modelTimeoutMs } from "./model-registry";

/** PR711 defaults remain 50s < 55s < 60s; declarations do not prove external enforcement. */
export const REVIEW_GATEWAY_LADDER = modelDeadlineLadder("review-gateway");
/** Only the outer client bound is declared for M1; no measured engine bound is invented. */
export const PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS = modelTimeoutMs("product-translate");
/** 틱 예산 = 클라이언트 상한 + 입장·DB 대기·기록 여유. callBudget(상한 + 2초)이 dispatch 를 거절하지 않게 한다(lib/domain/products/translations.ts). */
export const PRODUCT_TRANSLATION_JOB_MARGIN_MS = 15_000;
/**
 * 틱마다 다시 읽는 product-translate 상한: 등록부 덮어쓰기(관리자 저장)는 잡 시작의 ensureServingContracts 로 갱신되므로 재배포 없이 다음 틱에 반영된다.
 * 2026-10-30: M1 mlx-lm(~35 tok/s)의 긴 번역이 40초를 넘겨 300초로(설명 1건 8,000자 ≈ 100초; 묶음은 PRODUCT_TRANSLATION_BATCH_CHARS 8K 자까지).
 * 아래 상수는 로드 시점 값(테스트·문서용)이고 워커(scripts/worker.ts)·잡(lib/jobs/products/translations.ts)은 함수를 쓴다.
 */
export function productTranslationClientTimeoutMs(): number { return modelTimeoutMs("product-translate"); }
export function productTranslationJobBudgetMs(): number { return productTranslationClientTimeoutMs() + PRODUCT_TRANSLATION_JOB_MARGIN_MS; }
export const PRODUCT_TRANSLATION_JOB_BUDGET_MS = PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS + PRODUCT_TRANSLATION_JOB_MARGIN_MS;
