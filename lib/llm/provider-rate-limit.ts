import { logger } from "@/lib/observability/logger";
import { ModelCapacityDeferredError } from "./capacity-deferred";

/**
 * 공급자 요청 빈도 한도(HTTP 429)의 쉼 — text 경로(route)·공급자·장부 모델 하나씩(2026-11-11).
 *
 * 왜: LG EXAONE API 가 한국어 소개(product-tagline-ko)의 모든 호출에 429 를 돌려준 동안(운영 2026-11-10 23:37Z~) 잡은 틱마다 같은 순위로 다시 줄을 섰다.
 * 그 호출마다 장부 행이 결과 미확정(transport_unknown)으로 남아 장비 칸(한도 1)을 유지 시간(capacity.unknownHoldSeconds)만큼 쥐었고,
 * 그 뒤에 선 대기 행은 wait_expired 로 물러났다(약 2시간에 미확정 11·대기 만료 40, 성공 0).
 *
 * 규칙:
 * - 429 응답을 받으면 그 (경로, 공급자, 장부 모델)을 쉬게 한다. 쉬는 시간 = max(Retry-After, 지수 backoff(연속 429 수)) — Retry-After 는 최소값으로 지키고,
 *   없거나 짧아도 연속 429 마다 30초부터 두 배씩(최대 30분) 늘린다. Retry-After 는 1시간에서 자른다(잘못된 큰 값이 순위를 하루 멈추지 않게).
 * - 쉬는 동안 순위 대체·작업 분산(TextTaskRanks)은 그 순위·구성원을 고르지 않고(rate_limited 로 쉼, 포화로 셈), 그 경로의 용량 호출자도 장부에
 *   요청하지 않는다(대기·전송 행 없음 — 모델 단위 미룸 `rate_limited`, capacity-deferred.ts). 모든 순위가 쉬면 잡은 model_capacity 로 미룬다.
 * - 공급자가 429 가 아닌 응답을 주면(성공·다른 오류) 연속 수를 지운다.
 * - 이 프로세스 메모리에만 있다(text 역할은 역할 lease 로 한 후보만 일한다). 다른 경로·모델·장비는 건드리지 않는다.
 * - 장부 정산은 이 모듈의 일이 아니다: 보낸 뒤 받은 429(와 401·403)는 0174 부터 게이트웨이가 낸 처리 전 거절 증인(gateway_http_rejected,
 *   lib/llm/gateway-http-rejected.ts)으로 용량 호출자가 확정 실패로 정산해 칸을 바로 비운다(예전에는 결과 미확정으로 유지 시간만큼 칸을 쥐었다).
 *   이 쉼은 그와 별개로 다음 호출을 막는다.
 */
export const PROVIDER_RATE_LIMIT_BASE_MS = 30_000;
export const PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS = 30 * 60_000;
export const PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS = 60 * 60_000;
const CONSECUTIVE_MAX = 32;

export type ProviderRateLimitKey = Readonly<{ routeId: string; provider: string; model: string }>;
type State = { consecutive: number; until: number };
const holder = globalThis as unknown as { __nmvProviderRateLimits?: Map<string, State> };
const states = () => (holder.__nmvProviderRateLimits ??= new Map());
const keyOf = (key: ProviderRateLimitKey) => JSON.stringify([key.routeId, key.provider, key.model]);

/** Retry-After 값(초 수 또는 HTTP-date) → ms. 읽을 수 없으면 null, 지난 시각이면 0, 상한(1시간)에서 자른다. */
export function parseRetryAfterMs(value: string | null | undefined, now: number): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d{1,10}$/.test(text)) return Math.min(Number(text) * 1_000, PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS);
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS) : null;
}

/** 연속 429 n 번째의 최소 쉼 — 30초 × 2^(n−1), 최대 30분. */
export function providerRateLimitBackoffMs(consecutive: number): number {
  const n = Math.min(Math.max(1, Math.floor(consecutive)), CONSECUTIVE_MAX);
  return Math.min(PROVIDER_RATE_LIMIT_BASE_MS * 2 ** (n - 1), PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS);
}

/** 429 하나를 적는다. 이미 더 늦게까지 쉬고 있으면 그 시각을 줄이지 않는다. */
export function recordProviderRateLimit(key: ProviderRateLimitKey, retryAfterMs: number | null, now = Date.now()):
  Readonly<{ consecutive: number; waitMs: number; until: number }> {
  const id = keyOf(key), previous = states().get(id);
  const consecutive = Math.min((previous?.consecutive ?? 0) + 1, CONSECUTIVE_MAX);
  const waitMs = Math.max(retryAfterMs ?? 0, providerRateLimitBackoffMs(consecutive));
  const until = Math.max(previous?.until ?? 0, now + waitMs);
  states().set(id, { consecutive, until });
  logger.warn("provider_rate_limit.cooling", { routeId: key.routeId, provider: key.provider, model: key.model, consecutive, waitMs,
    retryAfterMs, until: new Date(until).toISOString() });
  return Object.freeze({ consecutive, waitMs, until });
}

/** 공급자가 429 가 아닌 응답을 줬다 — 연속 수와 쉼을 지운다. */
export function clearProviderRateLimit(key: ProviderRateLimitKey): void {
  if (states().delete(keyOf(key))) logger.info("provider_rate_limit.cleared", { routeId: key.routeId, provider: key.provider, model: key.model });
}

/** 지금 쉬는 중이면 그 끝 시각(ms), 아니면 null. */
export function providerRateLimitedUntil(key: ProviderRateLimitKey, now = Date.now()): number | null {
  const state = states().get(keyOf(key));
  return state && state.until > now ? state.until : null;
}

/** 시험 전용 — 모든 쉼을 지운다. */
export function resetProviderRateLimitsForTest(): void { states().clear(); }

/**
 * 용량 호출자가 장부에 묻기 전에 부른다 — 이 경로·공급자·모델이 429 로 쉬는 중이면 모델 단위 미룸(`rate_limited`)을 던진다.
 * 대기·전송 행을 만들지 않으므로 순위(TextTaskRanks)는 그 순위만 쉬게 하고 같은 일을 다음 순위로 넘긴다.
 */
export function assertProviderNotRateLimited(key: ProviderRateLimitKey, now = Date.now()): void {
  if (providerRateLimitedUntil(key, now) !== null) throw new ModelCapacityDeferredError("rate_limited");
}
