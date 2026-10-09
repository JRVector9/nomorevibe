import { describe, expect, it } from "vitest";
import { formatApprox, formatCount } from "@/lib/format/number";

/** 공개 화면의 수(UX-27) — 늘 천 단위 쉼표 */
describe("formatCount", () => {
  it("천 단위마다 쉼표", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(2126)).toBe("2,126");
    expect(formatCount(36155)).toBe("36,155");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(-1500)).toBe("-1,500");
  });
  it("셀 수 없으면 빈 표시, 바꿀 수 있다", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY, "")).toBe("");
  });
});

describe("formatApprox", () => {
  it("유효숫자 두 자리로 반올림하고 '약'을 붙인다", () => {
    expect(formatApprox(1779)).toBe("약 1,800");
    expect(formatApprox(1812)).toBe("약 1,800");
    expect(formatApprox(36155)).toBe("약 36,000");
    expect(formatApprox(1250)).toBe("약 1,300");
    expect(formatApprox(999)).toBe("약 1,000");
  });
  it("두 자리 이하는 그 수 그대로", () => {
    expect(formatApprox(85)).toBe("약 85");
    expect(formatApprox(7)).toBe("약 7");
  });
  it("0 이하는 '약' 없이, 셀 수 없으면 빈 표시", () => {
    expect(formatApprox(0)).toBe("0");
    expect(formatApprox(null)).toBe("—");
  });
});
