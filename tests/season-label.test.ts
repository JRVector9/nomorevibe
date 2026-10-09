import { describe, expect, it } from "vitest";
import { pageTitle } from "@/lib/copy/brand";
import { periodContaining, nextSeasonPeriod } from "@/lib/domain/ranking/period";
import { seasonLabel } from "@/lib/domain/ranking/season-label";

/** 시즌 열쇠 → 사람이 읽는 이름(UX-09·UX-39) — 랭킹 제목과 푸터 시즌 줄이 쓴다 */
describe("seasonLabel", () => {
  it("주간 열쇠는 '2026년 41주'", () => {
    expect(seasonLabel("2026-W41")).toBe("2026년 41주");
    expect(seasonLabel("2026-W01")).toBe("2026년 1주");
    expect(pageTitle(`${seasonLabel("2026-W41")} 랭킹`)).toBe("2026년 41주 랭킹 — nomorevibe");
  });

  it("월간 열쇠는 '2026년 10월'", () => {
    expect(seasonLabel("2026-10")).toBe("2026년 10월");
    expect(seasonLabel("2027-01")).toBe("2027년 1월");
  });

  it("전환 시즌은 시작한 날을 붙인다", () => {
    expect(seasonLabel("2026-W41-transition-20261008")).toBe("2026년 41주(10월 8일부터)");
  });

  it("period.ts 가 만드는 열쇠를 모두 읽는다", () => {
    const now = new Date("2026-10-08T03:00:00.000Z");
    expect(seasonLabel(periodContaining(now, "weekly").key)).toBe("2026년 41주");
    expect(seasonLabel(periodContaining(now, "monthly").key)).toBe("2026년 10월");
    expect(seasonLabel(nextSeasonPeriod(now, "weekly").key)).toBe("2026년 41주(10월 8일부터)");
  });

  it("모르는 꼴은 열쇠를 그대로", () => {
    expect(seasonLabel("legacy-key")).toBe("legacy-key");
    expect(seasonLabel("")).toBe("");
  });
});
