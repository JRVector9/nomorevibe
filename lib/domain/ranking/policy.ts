import { z } from "zod";

const factorSchema = z.number().int().min(1).max(10_000);

const cooldownTierSchema = z.object({
  rankFrom: z.number().int().min(1).max(100),
  rankTo: z.number().int().min(1).max(100),
  factorsBasisPoints: z.array(factorSchema).min(1).max(52),
}).superRefine((tier, ctx) => {
  if (tier.rankTo < tier.rankFrom) {
    ctx.addIssue({ code: "custom", path: ["rankTo"], message: "끝 순위는 시작 순위 이상이어야 합니다" });
  }
  tier.factorsBasisPoints.slice(1).forEach((factor, index) => {
    if (factor < tier.factorsBasisPoints[index]) {
      ctx.addIssue({ code: "custom", path: ["factorsBasisPoints", index + 1], message: "쿨다운 배율은 시간이 갈수록 낮아질 수 없습니다" });
    }
  });
});

export const rankingPolicySchema = z.object({
  season: z.object({
    cadence: z.enum(["weekly", "monthly"]),
    timezone: z.literal("Asia/Seoul"),
  }),
  eligibility: z.object({
    launchWindowDays: z.number().int().min(1).max(3650),
    minimumProducts: z.number().int().min(1).max(50_000),
    maximumWindowDays: z.number().int().min(1).max(3650),
  }),
  leaderboard: z.object({ limit: z.number().int().min(1).max(100) }),
  cooldown: z.object({ enabled: z.boolean(), tiers: z.array(cooldownTierSchema).max(20) }),
  trend: z.object({
    windowHours: z.number().int().min(1).max(168),
    minimumPreviousClicks: z.number().int().min(1).max(100_000),
    limit: z.number().int().min(1).max(20),
  }),
  boards: z.object({
    weeklyLimit: z.number().int().min(1).max(20),
    verifiedNewLimit: z.number().int().min(1).max(20),
    discoveredNewLimit: z.number().int().min(1).max(20),
  }),
}).superRefine((policy, ctx) => {
  if (policy.eligibility.maximumWindowDays < policy.eligibility.launchWindowDays) {
    ctx.addIssue({ code: "custom", path: ["eligibility", "maximumWindowDays"], message: "최대 기간은 기본 참가 기간 이상이어야 합니다" });
  }
  if (policy.leaderboard.limit > policy.eligibility.minimumProducts) {
    ctx.addIssue({ code: "custom", path: ["leaderboard", "limit"], message: "표시 순위는 최소 참가 제품 수 이하여야 합니다" });
  }
  const tiers = [...policy.cooldown.tiers].sort((a, b) => a.rankFrom - b.rankFrom);
  let expected = 1;
  for (const [index, tier] of tiers.entries()) {
    if (tier.rankFrom !== expected) {
      ctx.addIssue({ code: "custom", path: ["cooldown", "tiers", index], message: "쿨다운 순위 범위는 1위부터 빈틈과 겹침 없이 이어져야 합니다" });
    }
    if (tier.rankTo > policy.leaderboard.limit) {
      ctx.addIssue({ code: "custom", path: ["cooldown", "tiers", index, "rankTo"], message: "쿨다운 범위는 공개 랭킹 안이어야 합니다" });
    }
    expected = tier.rankTo + 1;
  }
});

export type RankingPolicy = z.infer<typeof rankingPolicySchema>;

export const DEFAULT_RANKING_POLICY: RankingPolicy = rankingPolicySchema.parse({
  season: { cadence: "weekly", timezone: "Asia/Seoul" },
  eligibility: { launchWindowDays: 28, minimumProducts: 20, maximumWindowDays: 90 },
  leaderboard: { limit: 10 },
  cooldown: {
    enabled: true,
    tiers: [
      { rankFrom: 1, rankTo: 3, factorsBasisPoints: [3500, 5500, 7500, 9000] },
      { rankFrom: 4, rankTo: 10, factorsBasisPoints: [6500, 8000, 9000, 10_000] },
    ],
  },
  trend: { windowHours: 24, minimumPreviousClicks: 5, limit: 4 },
  boards: { weeklyLimit: 3, verifiedNewLimit: 3, discoveredNewLimit: 3 },
});

export function rankingPolicyWarnings(policy: RankingPolicy): string[] {
  const warnings: string[] = [];
  if (policy.season.cadence === "monthly" && policy.eligibility.launchWindowDays < 28) {
    warnings.push("월간 시즌보다 출시 참가 기간이 짧아 후보가 빨리 줄 수 있습니다.");
  }
  const longestCooldown = Math.max(0, ...policy.cooldown.tiers.map((tier) => tier.factorsBasisPoints.length));
  const approximateSeasonDays = policy.season.cadence === "weekly" ? 7 : 31;
  if (longestCooldown * approximateSeasonDays > policy.eligibility.maximumWindowDays) {
    warnings.push("쿨다운이 끝나기 전에 제품의 출시 참가 기간이 끝날 수 있습니다.");
  }
  return warnings;
}
