// Keyless M3 service on its pinned Tailscale IP. The host's short MagicDNS name
// is not resolvable inside the production Docker containers on M3 or mini.
// No external provider fallback.
export const DEEPSEEK_REVIEW_BASE = 'http://100.92.77.66:8010/v1';
export const DEEPSEEK_REVIEW_MODEL = 'deepseek-v4.1-flash-1017';
export const DEEPSEEK_REVIEW_PROVIDER = 'm3-deepseek';
export const DEEPSEEK_REVIEW_TIMEOUT_MS = 60_000;
export const DEEPSEEK_MIN_CONFIDENCE = 0.9;
export const deepseekActor = (generation: number) => `${DEEPSEEK_REVIEW_PROVIDER}:${generation}`;
