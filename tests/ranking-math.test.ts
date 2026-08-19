import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANKING_POLICY,
  UNIQUE_FIRST_RANKING_POLICY,
} from "@/lib/domain/ranking/policy";
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

  it("calculates the approved unique-first score examples exactly", () => {
    const rows = rankRows([
      { slug: "one-hundred", validClicks: 150, uniqueVisitors: 100, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "ten", validClicks: 100, uniqueVisitors: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "eighty", validClicks: 80, uniqueVisitors: 80, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
    ], UNIQUE_FIRST_RANKING_POLICY.scoring);

    expect(Object.fromEntries(rows.map((row) => [row.slug, row.scoreUnits]))).toEqual({
      "one-hundred": 1_125_000,
      eighty: 800_000,
      ten: 125_000,
    });
  });

  it("caps repeat credit at the configured visits per unique visitor", () => {
    const rows = rankRows([
      { slug: "at-cap", validClicks: 20, uniqueVisitors: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "over-cap", validClicks: 100, uniqueVisitors: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
    ], UNIQUE_FIRST_RANKING_POLICY.scoring);

    expect(rows.map((row) => row.scoreUnits)).toEqual([125_000, 125_000]);
  });

  it("clamps repeat visits at zero when unique visitors exceed valid visits", () => {
    const [row] = rankRows([
      { slug: "lower-bound", validClicks: 5, uniqueVisitors: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
    ], UNIQUE_FIRST_RANKING_POLICY.scoring);

    expect(row.scoreUnits).toBe(100_000);
  });

  it("applies cooldown basis points and floors fractional unique-first score units", () => {
    const rows = rankRows([
      { slug: "cooldown", validClicks: 2, uniqueVisitors: 1, factorBasisPoints: 5_000, verifiedAt: new Date("2026-01-01") },
      { slug: "floor", validClicks: 2, uniqueVisitors: 1, factorBasisPoints: 3_333, verifiedAt: new Date("2026-01-01") },
    ], UNIQUE_FIRST_RANKING_POLICY.scoring);

    expect(Object.fromEntries(rows.map((row) => [row.slug, row.scoreUnits]))).toEqual({
      cooldown: 6_250,
      floor: 4_166,
    });
  });

  it("sorts unique-first ties by unique visitors, visits, verified time, then slug", () => {
    const rows = rankRows([
      { slug: "unique-eight", validClicks: 16, uniqueVisitors: 8, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "unique-ten", validClicks: 10, uniqueVisitors: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "visits-nine", validClicks: 9, uniqueVisitors: 4, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "visits-twenty", validClicks: 20, uniqueVisitors: 4, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "verified-older", validClicks: 4, uniqueVisitors: 4, factorBasisPoints: 10_000, verifiedAt: new Date("2026-02-01") },
      { slug: "verified-newer", validClicks: 4, uniqueVisitors: 4, factorBasisPoints: 10_000, verifiedAt: new Date("2026-03-01") },
      { slug: "slug-b", validClicks: 3, uniqueVisitors: 3, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "slug-a", validClicks: 3, uniqueVisitors: 3, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
    ], UNIQUE_FIRST_RANKING_POLICY.scoring);

    expect(rows.map((row) => row.slug)).toEqual([
      "unique-ten",
      "unique-eight",
      "visits-twenty",
      "visits-nine",
      "verified-newer",
      "verified-older",
      "slug-a",
      "slug-b",
    ]);
  });

  it("keeps one-argument ranking on legacy valid-click scoring", () => {
    const rows = rankRows([
      { slug: "more-clicks", validClicks: 11, uniqueVisitors: 1, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
      { slug: "more-unique", validClicks: 10, uniqueVisitors: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-01-01") },
    ]);

    expect(rows.map((row) => [row.slug, row.scoreUnits])).toEqual([
      ["more-clicks", 110_000],
      ["more-unique", 100_000],
    ]);
  });
});
