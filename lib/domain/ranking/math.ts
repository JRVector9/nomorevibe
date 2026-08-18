import type { RankingPolicy } from "./policy";

export type PriorFinish = { rank: number; seasonsAgo: number };

export type ScoreInput = {
  slug: string;
  validClicks: number;
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

export function rankRows(rows: ScoreInput[]): RankedScore[] {
  return rows
    .map((row) => ({ ...row, scoreUnits: row.validClicks * row.factorBasisPoints }))
    .sort((a, b) => (
      b.scoreUnits - a.scoreUnits
      || b.validClicks - a.validClicks
      || b.verifiedAt.getTime() - a.verifiedAt.getTime()
      || a.slug.localeCompare(b.slug)
    ))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
