import { describe, expect, it } from "vitest";
import { AUTO_CLOSE_KEEP_DAYS, AUTO_CLOSE_MIN_CONFIDENCE, autoCloseVerdict, autoRunInfo, autoRunLabel, utcDay,
  type AutoCloseState } from "@/lib/crawl/audit-auto-close";

/**
 * 감사 두 번째 의견으로 닫는 규칙(2026-10-22 "승인은 유지, 거절은 숨김") — 무엇을 할지만 가르는 순수 함수. 쓰기·일지·되돌리기는
 * tests/integration/audit-auto-close.test.ts 가 본다
 */
const open: AutoCloseState = { open: true, otherReject: false, unowned: true, held: false, settled: false, keptElsewhere: false, superseded: false };
const on = { autoClose: true, holdEnabled: true };
const verdict = (decision: string, confidence: number | null, state: Partial<AutoCloseState> = {}, switches: Partial<typeof on> = {}) =>
  autoCloseVerdict({ decision, confidence }, { ...open, ...state }, { ...on, ...switches });

describe("autoCloseVerdict", () => {
  it("문턱은 확신 0.90 이상(두 결정 모두), 기한은 정책 처리의 기본 90일", () => {
    expect(AUTO_CLOSE_MIN_CONFIDENCE).toBe(0.9);
    expect(AUTO_CLOSE_KEEP_DAYS).toBe(90);
    expect(verdict("approve", 0.9)).toEqual({ action: "keep" });
    expect(verdict("approve", 0.89)).toEqual({ action: null, skip: "low_confidence" });
    expect(verdict("approve", null)).toEqual({ action: null, skip: "low_confidence" });
    expect(verdict("reject", 0.9)).toEqual({ action: "hold" });
    expect(verdict("reject", 0.8999)).toEqual({ action: null, skip: "low_confidence" });
    expect(verdict("reject", Number.NaN)).toEqual({ action: null, skip: "low_confidence" });
  });

  it("판단 보류·꺼짐·열린 거절이 아님은 열어 둔다", () => {
    expect(verdict("needs_review", 1)).toEqual({ action: null, skip: "needs_review" });
    expect(verdict("approve", 1, {}, { autoClose: false })).toEqual({ action: null, skip: "off" });
    expect(verdict("reject", 1, {}, { autoClose: false })).toEqual({ action: null, skip: "off" });
    expect(verdict("approve", 1, { open: false })).toEqual({ action: null, skip: "not_open" });
    expect(verdict("reject", 1, { open: false })).toEqual({ action: null, skip: "not_open" });
  });

  it("승인 — 다른 모델이 거절했으면(갈림) 열어 둔다. 주인·보류·감사 보류 스위치와 상관없이 유지한다", () => {
    expect(verdict("approve", 0.95, { otherReject: true })).toEqual({ action: null, skip: "split" });
    expect(verdict("approve", 0.95, { unowned: false })).toEqual({ action: "keep" });
    expect(verdict("approve", 0.95, { held: true })).toEqual({ action: "keep" });
    expect(verdict("approve", 0.95, {}, { holdEnabled: false })).toEqual({ action: "keep" });
  });

  it("거절 — 주인 없는 것만 숨긴다. 다른 모델의 승인·첫 감사의 확신과 상관없다. 이미 보류·푼 적 있음·살아 있는 유지·더 새 답·스위치 끔은 열어 둔다", () => {
    expect(verdict("reject", 0.95, { otherReject: true })).toEqual({ action: "hold" });
    expect(verdict("reject", 0.95, { unowned: false })).toEqual({ action: null, skip: "owned" });
    expect(verdict("reject", 0.95, { held: true })).toEqual({ action: null, skip: "held_already" });
    expect(verdict("reject", 0.95, { settled: true })).toEqual({ action: null, skip: "settled" });
    expect(verdict("reject", 0.95, { keptElsewhere: true })).toEqual({ action: null, skip: "kept" });
    expect(verdict("reject", 0.95, { superseded: true })).toEqual({ action: null, skip: "superseded" });
    expect(verdict("reject", 0.95, {}, { holdEnabled: false })).toEqual({ action: null, skip: "hold_off" });
  });
});

describe("autoRunInfo", () => {
  it("자동 실행은 options.auto 로 가른다 — 사람이 만든 실행·깨진 값은 null", () => {
    const options = { auto: { by: "qwen-v2-auto", action: "hold", day: "2026-10-22", model: "qwen3.8-flash-next", promptVersion: "2026-10-21.v2", minConfidence: 0.9 } };
    expect(autoRunInfo({ options })).toEqual(options.auto);
    expect(autoRunLabel(autoRunInfo({ options })!)).toBe("m1 자동 숨김 · 2026-10-22(UTC)");
    expect(autoRunLabel({ ...options.auto, action: "keep" })).toBe("m1 자동 유지 · 2026-10-22(UTC)");
    for (const value of [{}, { keepDays: 90 }, { auto: null }, { auto: { action: "remove" } }, null, "x"]) expect(autoRunInfo({ options: value })).toBeNull();
  });

  it("하루는 UTC 날짜다", () => {
    expect(utcDay(new Date("2026-10-22T23:59:59.999Z"))).toBe("2026-10-22");
    expect(utcDay(new Date("2026-10-23T00:00:00.000+09:00"))).toBe("2026-10-22");
  });
});
