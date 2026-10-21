import { afterEach, describe, expect, it, vi } from "vitest";

// 관측 기록(운영 관측 qwen-endpoint)은 DB 를 쓴다 — 여기서는 프로세스 안의 값만 본다(통합 시험이 관측을 본다)
vi.mock("@/lib/db", () => ({ db: { transaction: async () => undefined, select: () => ({ from: () => ({ where: async () => [] }) }) } }));
import { noteQwenEndpointFailure, noteQwenEndpointSuccess, qwenBackoffMs, qwenEndpointBackingOff, qwenEndpointBackoff, resetQwenAuditBackoff,
  withQwenSecondarySlot } from "@/lib/crawl/qwen-endpoint-backoff";
import { qwenAuditBackoffMs } from "@/lib/crawl/jobs/product-audit";

/**
 * gpu3090 Qwen 을 부르는 모든 쪽(감사 직접 심사·두 번째 의견·공개분 거르기·갈림 판가름)이 함께 쓰는 물러나기와 두 번째 자리.
 */
afterEach(() => resetQwenAuditBackoff());

describe("함께 쓰는 물러나기", () => {
  it("누가 탈을 만나든 모두 같은 시각까지 물러난다 — 1분부터 두 배씩 15분까지, 답을 받으면 처음부터", async () => {
    const now = 1_000_000;
    expect(qwenEndpointBackingOff(now)).toBe(false);
    expect(await noteQwenEndpointFailure("qwen_http_503", { now })).toBe(60_000);
    expect(qwenEndpointBackingOff(now + 59_000)).toBe(true);
    expect(qwenEndpointBackingOff(now + 60_000)).toBe(false);
    expect(await noteQwenEndpointFailure("qwen_timeout", { now })).toBe(120_000);
    // 이 틱에서 이미 답을 받았으면 연속 탈을 처음부터 센다
    expect(await noteQwenEndpointFailure("qwen_timeout", { now, freshStreak: true })).toBe(60_000);
    expect(await noteQwenEndpointFailure("qwen_timeout", { now })).toBe(120_000);
    expect(qwenEndpointBackoff).toMatchObject({ failures: 2, lastError: "qwen_timeout", retryAt: now + 120_000 });
    expect([1, 2, 3, 4, 5, 6].map(qwenBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    // 감사 잡의 물러나기도 같은 표다
    expect(qwenAuditBackoffMs).toBe(qwenBackoffMs);
    // 마지막 탈보다 먼저 띄운 호출의 답은 물러나기를 풀지 않는다 — 같은 틱의 다른 자리·다른 단계가 곧바로 다시 부르지 않게
    await noteQwenEndpointSuccess(now - 1);
    await noteQwenEndpointSuccess(now);
    expect(qwenEndpointBackoff).toMatchObject({ failures: 2, retryAt: now + 120_000 });
    await noteQwenEndpointSuccess(now + 1);
    expect(qwenEndpointBackoff).toEqual({ failures: 0, retryAt: 0, lastError: null, failedAt: 0 });
  });
});

describe("두 번째 자리", () => {
  it("감사가 아닌 쪽은 한 번에 한 호출만 띄운다 — 앞 호출이 실패해도 다음이 이어진다", async () => {
    let inFlight = 0, max = 0;
    const order: string[] = [];
    const call = (name: string, ms: number, fail = false) => withQwenSecondarySlot(async () => {
      inFlight += 1; max = Math.max(max, inFlight); order.push(`start:${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight -= 1; order.push(`end:${name}`);
      if (fail) throw new Error(`failed:${name}`);
      return name;
    });
    const results = await Promise.allSettled([call("opinion", 20), call("tiebreak", 5, true), call("published", 1)]);
    expect(results.map((result) => result.status === "fulfilled" ? result.value : (result.reason as Error).message))
      .toEqual(["opinion", "failed:tiebreak", "published"]);
    expect(max).toBe(1);
    expect(order).toEqual(["start:opinion", "end:opinion", "start:tiebreak", "end:tiebreak", "start:published", "end:published"]);
  });
});
