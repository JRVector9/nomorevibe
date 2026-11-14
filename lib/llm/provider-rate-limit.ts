import { logger } from "@/lib/observability/logger";
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF, type ProviderRateLimitBackoffPolicy } from "./provider-rate-limit-policy";

/**
 * 공급자 요청 빈도 한도(HTTP 429)의 쉼 — text 경로(route)·공급자·장부 모델 하나씩(2026-11-11).
 *
 * 왜: LG EXAONE API 가 한국어 소개(product-tagline-ko)의 모든 호출에 429 를 돌려준 동안(운영 2026-11-10 23:37Z~) 잡은 틱마다 같은 순위로 다시 줄을 섰다.
 * 그 호출마다 장부 행이 결과 미확정(transport_unknown)으로 남아 장비 칸(한도 1)을 유지 시간(capacity.unknownHoldSeconds)만큼 쥐었고,
 * 그 뒤에 선 대기 행은 wait_expired 로 물러났다(약 2시간에 미확정 11·대기 만료 40, 성공 0).
 *
 * 규칙:
 * - 429 응답을 받으면 그 (경로, 공급자, 장부 모델)을 쉬게 한다. 쉬는 시간 = max(Retry-After, 지수 backoff(연속 429 수)) — Retry-After 는 최소값으로 지키고,
 *   없거나 짧아도 연속 429 마다 기본 30초부터 두 배씩(기본 최대 30분) 늘린다. 명시적 서빙 계약 정책이 있으면 그 시작·상한을 따른다.
 *   Retry-After 는 1시간에서 자른다(잘못된 큰 값이 순위를 하루 멈추지 않게).
 * - 쉬는 동안 순위 대체·작업 분산(TextTaskRanks)은 그 순위·구성원을 고르지 않고(rate_limited 로 쉼, 포화로 셈), 그 경로의 용량 호출자도 장부에
 *   요청하지 않는다(대기·전송 행 없음 — 모델 단위 미룸 `rate_limited`, capacity-deferred.ts). 모든 순위가 쉬면 잡은 model_capacity 로 미룬다.
 * - 공급자가 429 가 아닌 응답을 주면(성공·다른 오류) 연속 수를 지운다. opt-in quota hold는 따로 보존한다.
 * - 명시적 honorQuotaHeaders 계약만 EXAONE의 검증된 잔여량 0 헤더를 따른다. 응답 시점부터 전체 창(초·분·일)만큼 보수적으로 쉬며,
 *   공급자의 정확한 초기화 시각이나 계정 한도를 추정하지 않는다. 이 대기는 Retry-After 증인의 1시간 상한과 별개다.
 * - opt-in 429의 Retry-After/Retry-After-ms는 별도 입장 대기에 최대 하루까지 반영한다. 거절 증인의 1시간 상한은 유지한다.
 * - 이 프로세스 메모리에만 있다(text 역할은 역할 lease 로 한 후보만 일한다). 다른 경로·모델·장비는 건드리지 않는다.
 * - 장부 정산은 이 모듈의 일이 아니다: 보낸 뒤 받은 429(와 401·403)는 0174 부터 게이트웨이가 낸 처리 전 거절 증인(gateway_http_rejected,
 *   lib/llm/gateway-http-rejected.ts)으로 용량 호출자가 확정 실패로 정산해 칸을 바로 비운다(예전에는 결과 미확정으로 유지 시간만큼 칸을 쥐었다).
 *   이 쉼은 그와 별개로 다음 호출을 막는다.
 */
export const PROVIDER_RATE_LIMIT_BASE_MS = DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF.initialBackoffMs;
export const PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS = DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF.maxBackoffMs;
export const PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS = 60 * 60_000;
const CONSECUTIVE_MAX = 32;
const QUOTA_HOLD_MAX_MS = 86_400_000;

export type ProviderRateLimitKey = Readonly<{ routeId: string; provider: string; model: string }>;
type State = { consecutive: number; until: number };
const holder = globalThis as unknown as { __nmvProviderRateLimits?: Map<string, State>; __nmvProviderQuotaHolds?: Map<string, number> };
const states = () => (holder.__nmvProviderRateLimits ??= new Map());
const quotaHolds = () => (holder.__nmvProviderQuotaHolds ??= new Map());
const keyOf = (key: ProviderRateLimitKey) => JSON.stringify([key.routeId, key.provider, key.model]);
type ResponseHeaders = Readonly<{ get(name: string): string | null }>;
const QUOTA_WINDOWS_MS = Object.freeze({ second: 1_000, minute: 60_000, day: 86_400_000 });
export type ProviderQuotaWindow = Readonly<{ window: keyof typeof QUOTA_WINDOWS_MS; limit: number; remaining: number }>;

/** Canonical unsigned safe integers only; the limits come from the response, never documentation examples. */
function headerInteger(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]{0,15})$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) ? number : null;
}

/** https://docs.exaone.ai/ko/docs/rate-limits — missing, malformed and contradictory pairs have no authority. */
export function parseProviderQuotaHeaders(headers: ResponseHeaders): readonly ProviderQuotaWindow[] {
  return (Object.keys(QUOTA_WINDOWS_MS) as (keyof typeof QUOTA_WINDOWS_MS)[]).flatMap(window => {
    const limit = headerInteger(headers.get(`x-${window}-rate-limit`));
    const remaining = headerInteger(headers.get(`x-${window}-rate-limit-remaining`));
    return limit !== null && limit > 0 && remaining !== null && remaining <= limit ? [{ window, limit, remaining }] : [];
  });
}

/** Opt-in caller only. A full-window hold is conservative waiting, not an inferred reset timestamp. */
export function recordProviderQuotaHeaders(key: ProviderRateLimitKey, headers: ResponseHeaders, now = Date.now(), includeRetryAfter = false): number | null {
  const windows = parseProviderQuotaHeaders(headers), id = keyOf(key);
  // Admission waiting may honor up to one day; rejection evidence keeps its existing one-hour bound.
  const retryWaitMs = includeRetryAfter ? Math.max(
    parseRetryAfterMs(headers.get("retry-after"), now, QUOTA_HOLD_MAX_MS) ?? 0,
    parseRetryAfterMillisecondsMs(headers.get("retry-after-ms"), QUOTA_HOLD_MAX_MS) ?? 0,
  ) : 0;
  const waitMs = windows.reduce((longest, row) => row.remaining === 0 ? Math.max(longest, QUOTA_WINDOWS_MS[row.window]) : longest, retryWaitMs);
  const until = Math.max(quotaHolds().get(id) ?? 0, waitMs ? now + waitMs : 0);
  if (until > now) quotaHolds().set(id, until);
  // Positive counters alone cannot authenticate a reset or the ordering of concurrent responses.
  // Keep an existing exhausted-window hold until expiry, even after a positive/shorter observation.
  if (windows.length || retryWaitMs) logger.info("provider_rate_limit.quota_observed", {
    routeId: key.routeId, provider: key.provider, model: key.model, windows, retryWaitMs, waitMs,
    until: until > now ? new Date(until).toISOString() : null,
  });
  return until > now ? until : null;
}

/** Millisecond retry header; retain the existing one-hour witness bound. Used only by opt-in contracts. */
export function parseRetryAfterMillisecondsMs(value: string | null, maxMs = PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS): number | null {
  const parsed = headerInteger(value);
  return parsed === null ? null : Math.min(parsed, maxMs);
}

/** Retry-After 값(초 수 또는 HTTP-date) → ms. 읽을 수 없으면 null, 지난 시각이면 0, 상한(1시간)에서 자른다. */
export function parseRetryAfterMs(value: string | null | undefined, now: number, maxMs = PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d{1,10}$/.test(text)) return Math.min(Number(text) * 1_000, maxMs);
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), maxMs) : null;
}

/** 연속 429 n 번째의 최소 쉼. 명시적 계약 정책이 없으면 기존 30초·최대 30분 그대로다. */
function policyBackoffMs(consecutive: number, policy: ProviderRateLimitBackoffPolicy): number {
  const n = Math.min(Math.max(1, Math.floor(consecutive)), CONSECUTIVE_MAX);
  return Math.min(policy.initialBackoffMs * 2 ** (n - 1), policy.maxBackoffMs);
}
export function providerRateLimitBackoffMs(consecutive: number): number {
  return policyBackoffMs(consecutive, DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF);
}

/** 429 하나를 적는다. 이미 더 늦게까지 쉬고 있으면 그 시각을 줄이지 않는다. */
export function recordProviderRateLimit(key: ProviderRateLimitKey, retryAfterMs: number | null, now = Date.now(),
  policy: ProviderRateLimitBackoffPolicy = DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF):
  Readonly<{ consecutive: number; waitMs: number; until: number }> {
  const id = keyOf(key), previous = states().get(id);
  const consecutive = Math.min((previous?.consecutive ?? 0) + 1, CONSECUTIVE_MAX);
  const waitMs = Math.max(retryAfterMs ?? 0, policyBackoffMs(consecutive, policy));
  const until = Math.max(previous?.until ?? 0, now + waitMs);
  states().set(id, { consecutive, until });
  logger.warn("provider_rate_limit.cooling", { routeId: key.routeId, provider: key.provider, model: key.model, consecutive, waitMs,
    initialBackoffMs: policy.initialBackoffMs, maxBackoffMs: policy.maxBackoffMs,
    retryAfterMs, until: new Date(until).toISOString() });
  return Object.freeze({ consecutive, waitMs, until });
}

/** 공급자가 429 가 아닌 응답을 줬다 — 연속 429/backoff만 지운다. 별도 quota hold는 보존한다. */
export function clearProviderRateLimit(key: ProviderRateLimitKey): void {
  if (states().delete(keyOf(key))) logger.info("provider_rate_limit.cleared", { routeId: key.routeId, provider: key.provider, model: key.model });
}

/** 지금 쉬는 중이면 그 끝 시각(ms), 아니면 null. */
export function providerRateLimitedUntil(key: ProviderRateLimitKey, now = Date.now()): number | null {
  const id = keyOf(key), until = Math.max(states().get(id)?.until ?? 0, quotaHolds().get(id) ?? 0);
  return until > now ? until : null;
}

/** 시험 전용 — 모든 쉼을 지운다. */
export function resetProviderRateLimitsForTest(): void { states().clear(); quotaHolds().clear(); }

/**
 * 용량 호출자가 장부에 묻기 전에 부른다 — 이 경로·공급자·모델이 429 로 쉬는 중이면 모델 단위 미룸(`rate_limited`)을 던진다.
 * 대기·전송 행을 만들지 않으므로 순위(TextTaskRanks)는 그 순위만 쉬게 하고 같은 일을 다음 순위로 넘긴다.
 */
export function assertProviderNotRateLimited(key: ProviderRateLimitKey, now = Date.now()): void {
  if (providerRateLimitedUntil(key, now) !== null) throw new ModelCapacityDeferredError("rate_limited");
}
