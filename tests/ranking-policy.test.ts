import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANKING_POLICY,
  rankingPolicySchema,
  rankingPolicyWarnings,
} from "@/lib/domain/ranking/policy";

describe("ranking policy", () => {
  it("accepts the approved default", () => {
    expect(rankingPolicySchema.parse(DEFAULT_RANKING_POLICY)).toEqual(DEFAULT_RANKING_POLICY);
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
});
