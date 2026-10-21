import { describe, expect, it } from "vitest";
import { freshWindowsLabel, signed, WINDOW_TITLE } from "@/lib/operations/windows";

describe("굴러가는 합계 옆의 짧은 창 글자", () => {
  it("1시간은 늘어난 수라 +를 붙이고, 오늘은 그날의 합이라 붙이지 않는다", () => {
    expect(freshWindowsLabel({ hour: 3, today: 1234 })).toBe("최근 1시간 +3 · 오늘(0시부터) 1,234");
    expect(freshWindowsLabel({ hour: 0, today: 0 })).toBe("최근 1시간 +0 · 오늘(0시부터) 0");
  });

  it("순증감은 오늘에도 부호를 단다", () => {
    expect(freshWindowsLabel({ hour: -2, today: 5 }, { signedToday: true })).toBe("최근 1시간 -2 · 오늘(0시부터) +5");
    expect(signed(-1500)).toBe("-1,500");
    expect(signed(0)).toBe("+0");
  });

  it("설명은 오늘이 한국 시각 0시부터라고 밝힌다", () => {
    expect(WINDOW_TITLE).toContain("한국 시각(KST) 0시부터");
  });
});
