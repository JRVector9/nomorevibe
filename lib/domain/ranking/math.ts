import { DEFAULT_RANKING_POLICY, type RankingPolicy } from "./policy";

export type PriorFinish = { rank: number; seasonsAgo: number };

export type ScoreInput = {
  slug: string;
  validClicks: number;
  uniqueVisitors?: number;
  factorBasisPoints: number;
  verifiedAt: Date;
};

export type RankedScore = ScoreInput & { scoreUnits: number; rank: number };

export function clickChangePercent(recent: number, previous: number, minimumPrevious: number) {
  if (previous < minimumPrevious) return null;
  return Math.round((((recent - previous) / previous) * 100) * 10) / 10;
}

export function cooldownFactor(
  cooldown: RankingPolicy["cooldown"],
  finishes: PriorFinish[],
): number {
  if (!cooldown.enabled) return 10_000;
  return finishes.reduce((strongest, finish) => {
    const tier = cooldown.tiers.find(
      (item) => finish.rank >= item.rankFrom && finish.rank <= item.rankTo,
    );
    const factor = tier?.factorsBasisPoints[finish.seasonsAgo - 1] ?? 10_000;
    return Math.min(strongest, factor);
  }, 10_000);
}

export function rankRows(
  rows: ScoreInput[],
  scoring: RankingPolicy["scoring"] = DEFAULT_RANKING_POLICY.scoring,
): RankedScore[] {
  return rows
    .map((row) => {
      if (scoring.mode === "valid_visits") {
        return { ...row, scoreUnits: row.validClicks * row.factorBasisPoints };
      }
      const uniqueVisitors = row.uniqueVisitors ?? 0;
      const extraVisits = Math.min(
        Math.max(row.validClicks - uniqueVisitors, 0),
        uniqueVisitors * scoring.maxExtraVisitsPerUnique,
      );
      const base = uniqueVisitors * 10_000
        + extraVisits * scoring.repeatVisitWeightBasisPoints;
      return {
        ...row,
        scoreUnits: Math.floor(base * row.factorBasisPoints / 10_000),
      };
    })
    .sort((a, b) => (
      b.scoreUnits - a.scoreUnits
      || (scoring.mode === "unique_visitors"
        ? (b.uniqueVisitors ?? 0) - (a.uniqueVisitors ?? 0)
        : 0)
      || b.validClicks - a.validClicks
      || b.verifiedAt.getTime() - a.verifiedAt.getTime()
      || a.slug.localeCompare(b.slug)
    ))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
