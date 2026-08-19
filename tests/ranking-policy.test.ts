import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANKING_POLICY,
  UNIQUE_FIRST_RANKING_POLICY,
  parseRankingPolicy,
  rankingPolicySchema,
  rankingPolicyWarnings,
} from "@/lib/domain/ranking/policy";

describe("ranking policy", () => {
  it("accepts the approved default", () => {
    expect(rankingPolicySchema.parse(DEFAULT_RANKING_POLICY)).toEqual(DEFAULT_RANKING_POLICY);
  });

  it("normalizes a legacy policy with valid-visit scoring and unique trend defaults", () => {
    const legacyPolicy = {
      season: DEFAULT_RANKING_POLICY.season,
      eligibility: DEFAULT_RANKING_POLICY.eligibility,
      leaderboard: DEFAULT_RANKING_POLICY.leaderboard,
      cooldown: DEFAULT_RANKING_POLICY.cooldown,
      trend: {
        windowHours: DEFAULT_RANKING_POLICY.trend.windowHours,
        minimumPreviousClicks: DEFAULT_RANKING_POLICY.trend.minimumPreviousClicks,
        limit: DEFAULT_RANKING_POLICY.trend.limit,
      },
      boards: DEFAULT_RANKING_POLICY.boards,
    };

    expect(parseRankingPolicy(legacyPolicy)).toMatchObject({
      scoring: { mode: "valid_visits", version: "valid-visits-v1" },
      trend: { minimumPreviousUniqueVisitors: 5 },
    });
  });

  it("keeps the default policy on the legacy scoring version", () => {
    expect(DEFAULT_RANKING_POLICY.scoring).toEqual({
      mode: "valid_visits",
      version: "valid-visits-v1",
    });
  });

  it("exports the approved unique-first policy", () => {
    expect(UNIQUE_FIRST_RANKING_POLICY.scoring).toEqual({
      mode: "unique_visitors",
      version: "unique-visitors-v1",
      repeatVisitWeightBasisPoints: 2_500,
      maxExtraVisitsPerUnique: 1,
      minimumUniqueVisitors: 1,
    });
    expect(UNIQUE_FIRST_RANKING_POLICY.trend.minimumPreviousUniqueVisitors).toBe(5);
  });

  it.each([
    ["repeatVisitWeightBasisPoints", -1],
    ["repeatVisitWeightBasisPoints", 10_001],
    ["maxExtraVisitsPerUnique", -1],
    ["maxExtraVisitsPerUnique", 11],
    ["minimumUniqueVisitors", 0],
    ["minimumUniqueVisitors", 100_001],
  ] as const)("rejects unique scoring with %s=%s outside its bounds", (field, value) => {
    expect(rankingPolicySchema.safeParse({
      ...UNIQUE_FIRST_RANKING_POLICY,
      scoring: { ...UNIQUE_FIRST_RANKING_POLICY.scoring, [field]: value },
    }).success).toBe(false);
  });

  it("rejects overlapping cooldown tiers", () => {
    const result = rankingPolicySchema.safeParse({
      ...DEFAULT_RANKING_POLICY,
      cooldown: {
        enabled: true,
        tiers: [
          { rankFrom: 1, rankTo: 3, factorsBasisPoints: [3500] },
          { rankFrom: 3, rankTo: 10, factorsBasisPoints: [6500] },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a decreasing recovery curve", () => {
    const result = rankingPolicySchema.safeParse({
      ...DEFAULT_RANKING_POLICY,
      cooldown: {
        enabled: true,
        tiers: [{ rankFrom: 1, rankTo: 10, factorsBasisPoints: [7000, 5000] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("keeps the leaderboard inside the minimum pool", () => {
    expect(rankingPolicySchema.safeParse({
      ...DEFAULT_RANKING_POLICY,
      eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, minimumProducts: 5 },
      leaderboard: { limit: 10 },
    }).success).toBe(false);
  });

  it("warns when a monthly launch window is shorter than a calendar month", () => {
    const policy = rankingPolicySchema.parse({
      ...DEFAULT_RANKING_POLICY,
      season: { ...DEFAULT_RANKING_POLICY.season, cadence: "monthly" },
      eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, launchWindowDays: 14 },
    });
    expect(rankingPolicyWarnings(policy).join(" ")).toContain("월간");
  });

  it("warns when the launch window is shorter than the cooldown", () => {
    const policy = rankingPolicySchema.parse({
      ...DEFAULT_RANKING_POLICY,
      eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, launchWindowDays: 14 },
    });
    expect(rankingPolicyWarnings(policy).join(" ")).toContain("쿨다운");
  });

  it("does not warn about cooldown when cooldown is disabled", () => {
    const policy = rankingPolicySchema.parse({
      ...DEFAULT_RANKING_POLICY,
      eligibility: {
        ...DEFAULT_RANKING_POLICY.eligibility,
        launchWindowDays: 14,
        maximumWindowDays: 21,
      },
      cooldown: { ...DEFAULT_RANKING_POLICY.cooldown, enabled: false },
    });
    expect(rankingPolicyWarnings(policy).join(" ")).not.toContain("쿨다운");
  });
});
