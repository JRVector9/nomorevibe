import { afterEach, describe, expect, it } from "vitest";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel } from "@/lib/llm/capacity-deferred";
import { assertProviderNotRateLimited, clearProviderRateLimit, parseRetryAfterMs, providerRateLimitBackoffMs, providerRateLimitedUntil,
  recordProviderRateLimit, resetProviderRateLimitsForTest, PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS, PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS } from "@/lib/llm/provider-rate-limit";

/** 공급자 429 쉼(2026-11-11) — 경로·공급자·장부 모델마다, Retry-After 는 최소값, 없으면 지수 backoff. 운영 값이 아니다(시각은 고정 숫자). */
const NOW = Date.parse("2026-11-11T01:47:26.000Z");
const exaone = { routeId: "product-tagline-ko", provider: "abcllm", model: "k-exaone_v2.5" } as const;
afterEach(() => resetProviderRateLimitsForTest());

describe("Retry-After 읽기", () => {
  it("초 수·HTTP-date 를 ms 로 읽고, 지난 시각은 0, 1시간에서 자르며, 읽을 수 없으면 null", () => {
    expect(parseRetryAfterMs("1", NOW)).toBe(1_000);
    expect(parseRetryAfterMs(" 120 ", NOW)).toBe(120_000);
    expect(parseRetryAfterMs("0", NOW)).toBe(0);
    expect(parseRetryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(parseRetryAfterMs(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfterMs("999999", NOW)).toBe(PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS);
    for (const bad of [null, undefined, "", "-1", "1.5", "soon", "2026-11-11T02:00:00Z"]) expect(parseRetryAfterMs(bad, NOW), String(bad)).toBeNull();
  });
});

describe("쉼 기록", () => {
  it("연속 429 마다 30초부터 두 배(최대 30분), Retry-After 가 더 길면 그 값을 지킨다", () => {
    expect([1, 2, 3, 6, 7, 40].map(providerRateLimitBackoffMs)).toEqual([30_000, 60_000, 120_000, 960_000, PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS, PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS]);
    expect(recordProviderRateLimit(exaone, 1_000, NOW)).toEqual({ consecutive: 1, waitMs: 30_000, until: NOW + 30_000 });
    expect(recordProviderRateLimit(exaone, null, NOW)).toEqual({ consecutive: 2, waitMs: 60_000, until: NOW + 60_000 });
    expect(recordProviderRateLimit(exaone, 600_000, NOW)).toEqual({ consecutive: 3, waitMs: 600_000, until: NOW + 600_000 });
    // 짧은 Retry-After 가 이미 더 늦은 쉼을 줄이지 않는다
    expect(recordProviderRateLimit(exaone, 0, NOW + 1_000).until).toBe(NOW + 600_000);
  });
  it("경로·공급자·모델 하나만 쉬고, 끝 시각이 지나거나 429 가 아닌 응답이면 다시 부른다", () => {
    recordProviderRateLimit(exaone, 60_000, NOW);
    expect(providerRateLimitedUntil(exaone, NOW + 59_999)).toBe(NOW + 60_000);
    expect(providerRateLimitedUntil(exaone, NOW + 60_000)).toBeNull();
    for (const other of [{ ...exaone, routeId: "reason-translate" }, { ...exaone, model: "gpt-oss-120b" }, { ...exaone, provider: "local-direct" }])
      expect(providerRateLimitedUntil(other, NOW + 1)).toBeNull();
    expect(() => assertProviderNotRateLimited(exaone, NOW + 1)).toThrow(ModelCapacityDeferredError);
    try { assertProviderNotRateLimited(exaone, NOW + 1); } catch (error) {
      expect(error).toMatchObject({ reason: "rate_limited" });
      expect(modelCapacityDeferralIsPerModel((error as ModelCapacityDeferredError).reason)).toBe(true);
    }
    expect(() => assertProviderNotRateLimited({ ...exaone, routeId: "reason-translate" }, NOW + 1)).not.toThrow();
    clearProviderRateLimit(exaone);
    expect(providerRateLimitedUntil(exaone, NOW + 1)).toBeNull();
    // 지운 뒤의 429 는 연속 1 부터 다시 센다
    expect(recordProviderRateLimit(exaone, null, NOW).consecutive).toBe(1);
  });
});
