// Keyless M3 service, observed through /v1/models. No external provider fallback.
export const DEEPSEEK_REVIEW_BASE = 'http://m3ultra:8010/v1';
export const DEEPSEEK_REVIEW_MODEL = 'deepseek-v4.1-flash-1017';
export const DEEPSEEK_REVIEW_PROVIDER = 'm3-deepseek';
export const DEEPSEEK_REVIEW_TIMEOUT_MS = 60_000;
export const DEEPSEEK_MIN_CONFIDENCE = 0.9;
export const deepseekActor = (generation: number) => `${DEEPSEEK_REVIEW_PROVIDER}:${generation}`;
