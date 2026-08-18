import { describe, expect, it } from "vitest";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { clickChangePercent, cooldownFactor, rankRows } from "@/lib/domain/ranking/math";

describe("ranking math", () => {
  it("calculates click percentage and refuses a small baseline", () => {
    expect(clickChangePercent(12, 8, 5)).toBe(50);
    expect(clickChangePercent(3, 1, 5)).toBeNull();
    expect(clickChangePercent(0, 5, 5)).toBe(-100);
  });

  it("uses the strongest overlapping cooldown", () => {
    expect(cooldownFactor(DEFAULT_RANKING_POLICY.cooldown, [
      { rank: 2, seasonsAgo: 2 },
      { rank: 7, seasonsAgo: 1 },
    ])).toBe(5500);
  });

  it("sorts by adjusted score, clicks, verified time, then slug", () => {
    const rows = rankRows([
      { slug: "score", validClicks: 11, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "clicks", validClicks: 20, factorBasisPoints: 5000, verifiedAt: new Date("2026-01-01") },
      { slug: "verified-newer", validClicks: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-03-01") },
      { slug: "verified-older", validClicks: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-02-01") },
      { slug: "slug-b", validClicks: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "slug-a", validClicks: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
    ]);

    expect(rows.map((row) => [row.slug, row.rank])).toEqual([
      ["score", 1],
      ["clicks", 2],
      ["verified-newer", 3],
      ["verified-older", 4],
      ["slug-a", 5],
      ["slug-b", 6],
    ]);
  });
});
