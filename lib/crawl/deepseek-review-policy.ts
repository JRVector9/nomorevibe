import { modelTimeoutMs } from "@/lib/llm/model-registry";
import { modelBaseUrl, modelForPurpose } from "@/lib/llm/model-registry";
// Keyless M3 service on its pinned Tailscale IP. The host's short MagicDNS name
// is not resolvable inside the production Docker containers on M3 or mini.
// No external provider fallback.
export const DEEPSEEK_REVIEW_BASE = modelBaseUrl("human-review", process.env, "local-direct");
export const DEEPSEEK_REVIEW_MODEL = modelForPurpose("human-review").model;
export const DEEPSEEK_REVIEW_PROVIDER = 'm3-deepseek';
/** 로드 시점 값(테스트·문서용). 호출·틱은 deepseekReviewTimeoutMs() 로 등록부 경로 human-review 를 그때 읽는다 — 관리자 실시간 한도가 다음 틱에 반영된다 */
export const DEEPSEEK_REVIEW_TIMEOUT_MS = modelTimeoutMs("human-review");
export function deepseekReviewTimeoutMs(): number { return modelTimeoutMs("human-review"); }
export const DEEPSEEK_MIN_CONFIDENCE = 0.9;
export const deepseekActor = (generation: number) => `${DEEPSEEK_REVIEW_PROVIDER}:${generation}`;
