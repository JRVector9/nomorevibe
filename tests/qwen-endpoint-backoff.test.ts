import { afterEach, describe, expect, it, vi } from "vitest";

// 관측 기록(운영 관측 qwen-endpoint)은 DB 를 쓴다 — 여기서는 프로세스 안의 값만 본다(통합 시험이 관측을 본다)
vi.mock("@/lib/db", () => ({ db: { transaction: async () => undefined, select: () => ({ from: () => ({ where: async () => [] }) }) } }));
import { noteQwenAnswered, noteQwenCallFailure, noteQwenEndpointFailure, noteQwenEndpointSuccess, QWEN_CALLERS, QWEN_SOFT_FAILURE_STREAK, qwenBackoffMs,
  qwenEndpointBackingOff, qwenEndpointBackoffOf, qwenSoftFailuresOf, resetQwenAuditBackoff, withQwenSecondarySlot } from "@/lib/crawl/qwen-endpoint-backoff";
import { qwenAuditBackoffMs } from "@/lib/crawl/jobs/product-audit";

/**
 * gpu3090 Qwen 을 부르는 쪽(감사 직접 심사·두 번째 의견·공개분 거르기·갈림 판가름·보류 재심사)마다 따로 쓰는 물러나기와, 감사가 아닌 쪽이 나눠 쓰는 두 번째 자리.
 * 2026-10-31 소유자 결정("하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다"): 예전의 "누가 탈을 만나든 모두 같은 시각까지 물러난다"는 없앴다.
 */
afterEach(() => resetQwenAuditBackoff());

describe("호출자마다 따로 쓰는 물러나기", () => {
  it("탈을 만난 호출자만 물러난다 — 1분부터 두 배씩 15분까지, 답을 받으면 처음부터", async () => {
    const now = 1_000_000;
    expect(qwenEndpointBackingOff("audit", now)).toBe(false);
    expect(await noteQwenEndpointFailure("audit", "qwen_http_503", { now })).toBe(60_000);
    expect(qwenEndpointBackingOff("audit", now + 59_000)).toBe(true);
    expect(qwenEndpointBackingOff("audit", now + 60_000)).toBe(false);
    expect(await noteQwenEndpointFailure("audit", "qwen_timeout", { now })).toBe(120_000);
    // 이 틱에서 이미 답을 받았으면 연속 탈을 처음부터 센다
    expect(await noteQwenEndpointFailure("audit", "qwen_timeout", { now, freshStreak: true })).toBe(60_000);
    expect(await noteQwenEndpointFailure("audit", "qwen_timeout", { now })).toBe(120_000);
    expect(qwenEndpointBackoffOf("audit")).toMatchObject({ failures: 2, lastError: "qwen_timeout", retryAt: now + 120_000 });
    expect([1, 2, 3, 4, 5, 6].map(qwenBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    // 감사 잡의 물러나기도 같은 표다
    expect(qwenAuditBackoffMs).toBe(qwenBackoffMs);
    // 마지막 탈보다 먼저 띄운 호출의 답은 물러나기를 풀지 않는다 — 같은 틱의 다른 자리가 곧바로 다시 부르지 않게
    await noteQwenEndpointSuccess("audit", now - 1);
    await noteQwenEndpointSuccess("audit", now);
    expect(qwenEndpointBackoffOf("audit")).toMatchObject({ failures: 2, retryAt: now + 120_000 });
    await noteQwenEndpointSuccess("audit", now + 1);
    expect(qwenEndpointBackoffOf("audit")).toEqual({ failures: 0, retryAt: 0, lastError: null, failedAt: 0 });
    expect(qwenSoftFailuresOf("audit")).toEqual({ streak: 0, lastCode: null });
  });

  // 2026-10-31 결정: 감사의 탈이 판가름·보류 재심사·두 번째 의견을 세우지 않는다 — 하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다
  it("한 호출자의 탈은 다른 호출자를 물러나게 하지 않는다 — 넷이 각자 센다", async () => {
    const now = 2_000_000;
    expect(QWEN_CALLERS).toEqual(["audit", "second_opinion", "split_tiebreak", "held_qwen"]);
    await noteQwenEndpointFailure("audit", "qwen_http_503", { now });
    expect(qwenEndpointBackingOff("audit", now)).toBe(true);
    for (const other of ["second_opinion", "split_tiebreak", "held_qwen"] as const) {
      expect(qwenEndpointBackingOff(other, now), other).toBe(false);
      expect(qwenEndpointBackoffOf(other), other).toEqual({ failures: 0, retryAt: 0, lastError: null, failedAt: 0 });
    }
    // 붐빔 연속도 호출자마다 — 판가름의 시간 초과 둘이 보류 재심사의 셈에 더해지지 않는다
    await noteQwenCallFailure("split_tiebreak", "qwen_timeout");
    await noteQwenCallFailure("split_tiebreak", "qwen_timeout");
    expect(await noteQwenCallFailure("held_qwen", "qwen_timeout")).toEqual({ outage: false, soft: true });
    expect(qwenSoftFailuresOf("split_tiebreak").streak).toBe(2);
    expect(qwenSoftFailuresOf("held_qwen").streak).toBe(1);
    // 다른 호출자의 답은 이 호출자의 물러나기를 풀지 않는다
    await noteQwenEndpointSuccess("second_opinion", now + 1);
    expect(qwenEndpointBackingOff("audit", now)).toBe(true);
    await noteQwenEndpointSuccess("audit", now + 1);
    expect(qwenEndpointBackingOff("audit", now)).toBe(false);
    // 시험용 초기화는 모두를 처음으로
    resetQwenAuditBackoff();
    for (const caller of QWEN_CALLERS) expect(qwenSoftFailuresOf(caller).streak, caller).toBe(0);
  });

  it("모르는 호출자는 거절한다", () => {
    expect(() => qwenEndpointBackoffOf("screen" as never)).toThrow("qwen_caller_unknown:screen");
  });
});

describe("무엇이 서버 탈인가 — noteQwenCallFailure", () => {
  it("닿지 않음·5xx·401/403/404 는 한 번이면 바로 탈이다", async () => {
    for (const code of ["qwen_unreachable", "qwen_http_503", "qwen_http_500", "qwen_http_401", "qwen_http_403", "qwen_http_404"] as const) {
      resetQwenAuditBackoff();
      expect(await noteQwenCallFailure("audit", code), code).toEqual({ outage: true, soft: false });
      expect(qwenEndpointBackingOff("audit"), code).toBe(true);
    }
  });

  it("진짜 시간 초과·429 는 그 호출자의 호출을 통틀어 성공 없이 세 번 잇달아야 탈이다 — 한 번은 물러나지 않는다", async () => {
    expect(QWEN_SOFT_FAILURE_STREAK).toBe(3);
    expect(await noteQwenCallFailure("audit", "qwen_timeout")).toEqual({ outage: false, soft: true });
    expect(qwenEndpointBackingOff("audit")).toBe(false);
    expect(await noteQwenCallFailure("audit", "qwen_http_429")).toEqual({ outage: false, soft: true });
    expect(qwenSoftFailuresOf("audit")).toEqual({ streak: 2, lastCode: "qwen_http_429" });
    expect(await noteQwenCallFailure("audit", "qwen_timeout")).toEqual({ outage: true, soft: true });
    expect(qwenEndpointBackingOff("audit")).toBe(true);
    expect(qwenEndpointBackoffOf("audit")).toMatchObject({ failures: 1, lastError: "qwen_timeout" });
    // 탈로 센 뒤에는 연속을 처음부터 센다
    expect(qwenSoftFailuresOf("audit").streak).toBe(0);
  });

  it("사이에 답(성공·서버가 답한 항목 탓 실패)이 끼면 연속을 끊는다 — 멈춤은 끊지 않는다", async () => {
    await noteQwenCallFailure("audit", "qwen_timeout");
    await noteQwenCallFailure("audit", "qwen_timeout");
    await noteQwenEndpointSuccess("audit", Date.now());
    expect(qwenSoftFailuresOf("audit").streak).toBe(0);
    await noteQwenCallFailure("audit", "qwen_timeout");
    await noteQwenCallFailure("audit", "qwen_timeout");
    expect(await noteQwenCallFailure("audit", "qwen_invalid_json")).toEqual({ outage: false, soft: false });
    expect(qwenSoftFailuresOf("audit").streak).toBe(0);
    await noteQwenCallFailure("audit", "qwen_timeout");
    await noteQwenCallFailure("audit", "qwen_timeout");
    expect(await noteQwenCallFailure("audit", "qwen_cancelled")).toEqual({ outage: false, soft: false });
    expect(qwenSoftFailuresOf("audit").streak).toBe(2);
    noteQwenAnswered("audit");
    expect(qwenSoftFailuresOf("audit").streak).toBe(0);
    expect(qwenEndpointBackingOff("audit")).toBe(false);
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
