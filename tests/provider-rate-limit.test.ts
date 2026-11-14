import { afterEach, describe, expect, it } from "vitest";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel } from "@/lib/llm/capacity-deferred";
import { assertProviderNotRateLimited, clearProviderRateLimit, parseRetryAfterMs, providerRateLimitBackoffMs, providerRateLimitedUntil,
  parseRetryAfterMillisecondsMs, parseProviderQuotaHeaders, recordProviderQuotaHeaders,
  recordProviderRateLimit, resetProviderRateLimitsForTest, PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS, PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS } from "@/lib/llm/provider-rate-limit";
import { providerRateLimitBackoffSchema } from "@/lib/llm/provider-rate-limit-policy";

/** 공급자 429 쉼(2026-11-11) — 경로·공급자·장부 모델마다, Retry-After 는 최소값, 없으면 지수 backoff. 운영 값이 아니다(시각은 고정 숫자). */
const NOW = Date.parse("2026-11-11T01:47:26.000Z");
const exaone = { routeId: "product-tagline-ko", provider: "abcllm", model: "k-exaone_v2.5" } as const;
afterEach(() => resetProviderRateLimitsForTest());

describe("Retry-After 읽기", () => {
  it("reads opt-in millisecond values strictly and retains the one-hour witness bound", () => {
    expect(parseRetryAfterMillisecondsMs(" 120001 ")).toBe(120001);
    expect(parseRetryAfterMillisecondsMs("0")).toBe(0);
    expect(parseRetryAfterMillisecondsMs("9007199254740991")).toBe(PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS);
    for (const bad of [null, "", "-1", "1.5", "1e3", "+10", "01", "9007199254740992", "soon"])
      expect(parseRetryAfterMillisecondsMs(bad), String(bad)).toBeNull();
  });
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

describe("opt-in response quotas", () => {
  const quota = (window: string, limit = "7", remaining = "0") => new Headers({
    [`x-${window}-rate-limit`]: limit, [`x-${window}-rate-limit-remaining`]: remaining,
  });
  it("uses actual validated limit/remaining pairs rather than example account limits", () => {
    expect(parseProviderQuotaHeaders(new Headers({
      "x-second-rate-limit": "7", "x-second-rate-limit-remaining": "0",
      "x-minute-rate-limit": "113", "x-minute-rate-limit-remaining": "12",
      "x-day-rate-limit": "9123", "x-day-rate-limit-remaining": "0",
    }))).toEqual([{ window: "second", limit: 7, remaining: 0 }, { window: "minute", limit: 113, remaining: 12 },
      { window: "day", limit: 9123, remaining: 0 }]);
    for (const [limit, remaining] of [["0", "0"], ["7", "8"], ["-7", "0"], ["7", "-1"], ["7.0", "0"],
      ["7", "0.0"], ["+7", "0"], ["07", "0"], ["9007199254740992", "0"], ["7", "1e0"], ["", "0"]])
      expect(parseProviderQuotaHeaders(quota("day", limit, remaining)), `${limit}/${remaining}`).toEqual([]);
    expect(parseProviderQuotaHeaders(new Headers({ "x-day-rate-limit-remaining": "0" }))).toEqual([]);
    expect(parseProviderQuotaHeaders(new Headers({ "x-day-rate-limit": "7" }))).toEqual([]);
  });
  it.each([["second", 1_000], ["minute", 60_000], ["day", 86_400_000]] as const)(
    "holds an exhausted %s for a full conservative window without counting a 429", (window, duration) => {
      expect(recordProviderQuotaHeaders(exaone, quota(window), NOW)).toBe(NOW + duration);
      expect(providerRateLimitedUntil(exaone, NOW + duration - 1)).toBe(NOW + duration);
      expect(() => assertProviderNotRateLimited(exaone, NOW)).toThrow(ModelCapacityDeferredError);
      expect(providerRateLimitedUntil(exaone, NOW + duration)).toBeNull();
      expect(recordProviderRateLimit(exaone, null, NOW).consecutive).toBe(1);
    });
  it.each([
    ["retry-after", "7200", 7_200_000],
    ["retry-after", new Date(NOW + 7_200_000).toUTCString(), 7_200_000],
    ["retry-after-ms", "7200000", 7_200_000],
    ["retry-after-ms", "9007199254740991", 86_400_000],
  ])("honors long %s for admission independently of bounded rejection evidence", (header, value, duration) => {
    const headers = new Headers({ [header]: String(value) });
    expect(recordProviderQuotaHeaders(exaone, headers, NOW)).toBeNull();
    expect(recordProviderQuotaHeaders(exaone, headers, NOW, true)).toBe(NOW + Number(duration));
    clearProviderRateLimit(exaone);
    expect(providerRateLimitedUntil(exaone, NOW)).toBe(NOW + Number(duration));
    expect(providerRateLimitedUntil(exaone, NOW + Number(duration))).toBeNull();
  });
  it("keeps the longest hold across 429, non-429, positive and shorter observations until expiry", () => {
    const until = NOW + 86_400_000;
    recordProviderQuotaHeaders(exaone, quota("day"), NOW);
    recordProviderRateLimit(exaone, 3_600_000, NOW, { initialBackoffMs: 1_800_000, maxBackoffMs: 21_600_000 });
    expect(providerRateLimitedUntil(exaone, NOW)).toBe(until);
    clearProviderRateLimit(exaone);
    expect(recordProviderQuotaHeaders(exaone, quota("day", "7", "6"), NOW + 1_000)).toBe(until);
    expect(recordProviderQuotaHeaders(exaone, quota("minute"), NOW + 2_000)).toBe(until);
    expect(recordProviderQuotaHeaders(exaone, new Headers(), NOW + 3_000)).toBe(until);
    expect(providerRateLimitedUntil({ ...exaone, model: "other" }, NOW)).toBeNull();
    expect(recordProviderQuotaHeaders(exaone, quota("day", "7", "6"), until)).toBeNull();
    expect(providerRateLimitedUntil(exaone, until)).toBeNull();
    expect(recordProviderRateLimit(exaone, null, until).consecutive).toBe(1);
  });
});

describe("쉼 기록", () => {
  it("uses an explicit selected-contract policy for persistent 429 without changing default models or other keys", () => {
    const policy = providerRateLimitBackoffSchema.parse({ initialBackoffMs: 30 * 60_000, maxBackoffMs: 6 * 60 * 60_000 });
    expect(Array.from({ length: 7 }, () => recordProviderRateLimit(exaone, null, NOW, policy).waitMs))
      .toEqual([30, 60, 120, 240, 360, 360, 360].map(minutes => minutes * 60_000));
    resetProviderRateLimitsForTest();
    const first = recordProviderRateLimit(exaone, null, NOW, policy);
    expect(first).toEqual({ consecutive: 1, waitMs: 30 * 60_000, until: NOW + 30 * 60_000 });
    expect(() => assertProviderNotRateLimited(exaone, NOW + 29 * 60_000)).toThrow(ModelCapacityDeferredError);
    expect(() => assertProviderNotRateLimited({ ...exaone, model: "gpt-oss-120b" }, NOW + 1)).not.toThrow();
    expect(recordProviderRateLimit(exaone, 3_600_000, NOW, policy).waitMs).toBe(3_600_000);
    expect(providerRateLimitBackoffMs(8)).toBe(PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS);
    clearProviderRateLimit(exaone);
    expect(providerRateLimitedUntil(exaone, NOW + 1)).toBeNull();
    expect(recordProviderRateLimit(exaone, null, NOW, policy).consecutive).toBe(1);
  });

  it("rejects malformed opt-in policies instead of shortening or inventing a cooldown", () => {
    for (const policy of [
      { initialBackoffMs: 1, maxBackoffMs: 3_600_000 },
      { initialBackoffMs: 60_000, maxBackoffMs: 30_000 },
      { initialBackoffMs: 30_000, maxBackoffMs: 86_400_001 },
      { initialBackoffMs: 30_000, maxBackoffMs: 60_000, extra: true },
      { initialBackoffMs: 30_000, maxBackoffMs: 60_000, honorQuotaHeaders: "true" },
    ]) expect(providerRateLimitBackoffSchema.safeParse(policy).success).toBe(false);
  });

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
