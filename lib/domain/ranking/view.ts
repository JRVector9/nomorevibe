import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  products,
  rankingEntries,
  rankingSeasons,
  type RankingPolicyRevision,
  type RankingSeason,
} from "@/lib/db/schema";
import { topClickedSince } from "@/lib/domain/products/clicks";
import type { Category } from "@/lib/domain/products/schema";
import {
  getDiscoveryList,
  getVerifiedList,
  toListItem,
  withProductHealth,
  type ProductListItem,
} from "@/lib/domain/products/view";
import { getScheduledPolicy, listPolicyRevisions } from "./policies";
import { DEFAULT_RANKING_POLICY, type RankingPolicy } from "./policy";
import { previewRanking, slugArrayPredicate, type CalculatedEntry } from "./refresh";

export const RANKING_STALE_MS = 2 * 60 * 60 * 1000;

export type RankingListItem = ProductListItem & {
  rank: number;
  validClicks: number;
  changePercent: number | null;
  cooldownFactorBasisPoints: number;
  previousRank: number | null;
};

export type SeasonSummary = {
  key: string;
  cadence: "weekly" | "monthly";
  startsAt: Date;
  endsAt: Date;
  isTransition: boolean;
  effectiveLaunchWindowDays: number;
  policy: RankingPolicy;
  refreshedAt: Date | null;
  state: "active" | "closed";
};

function toSeasonSummary(season: RankingSeason): SeasonSummary {
  return {
    key: season.key,
    cadence: season.cadence,
    startsAt: season.startsAt,
    endsAt: season.endsAt,
    isTransition: season.isTransition,
    effectiveLaunchWindowDays: season.effectiveLaunchWindowDays,
    policy: season.policySnapshot,
    refreshedAt: season.refreshedAt,
    state: season.state,
  };
}

async function findSeason(key?: string): Promise<RankingSeason | undefined> {
  const [season] = await db
    .select()
    .from(rankingSeasons)
    .where(key ? eq(rankingSeasons.key, key) : eq(rankingSeasons.state, "active"))
    .limit(1);
  return season;
}

function likePattern(query: string): string {
  return `%${query.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export async function getCurrentSeason(): Promise<SeasonSummary | null> {
  const season = await findSeason();
  return season ? toSeasonSummary(season) : null;
}

export async function getSeasonRanking(options: {
  seasonKey?: string;
  order?: "rank" | "trending";
  category?: Category;
  query?: string;
  limit: number;
}): Promise<{ season: SeasonSummary | null; items: RankingListItem[] }> {
  const season = await findSeason(options.seasonKey);
  if (!season) return { season: null, items: [] };

  const conditions = [
    eq(rankingEntries.seasonId, season.id),
    eq(products.status, "verified"),
  ];
  if (options.order !== "trending") {
    conditions.push(lte(rankingEntries.rank, season.policySnapshot.leaderboard.limit));
  }
  if (options.category) conditions.push(eq(products.category, options.category));
  if (options.query?.trim()) {
    const pattern = likePattern(options.query);
    conditions.push(or(ilike(products.name, pattern), ilike(products.tagline, pattern))!);
  }
  if (options.order === "trending") {
    conditions.push(isNotNull(rankingEntries.changePercent));
  }

  const rows = await db
    .select({
      ...getTableColumns(products),
      rank: rankingEntries.rank,
      validClicks: rankingEntries.validClicks,
      changePercent: rankingEntries.changePercent,
      cooldownFactorBasisPoints: rankingEntries.cooldownFactorBasisPoints,
      recentClicks: rankingEntries.recentClicks,
    })
    .from(rankingEntries)
    .innerJoin(products, eq(products.slug, rankingEntries.slug))
    .where(and(...conditions))
    .orderBy(
      ...(options.order === "trending"
        ? [
          desc(rankingEntries.changePercent),
          desc(rankingEntries.recentClicks),
          rankingEntries.slug,
        ]
        : [rankingEntries.rank]),
    )
    .limit(options.limit);

  const [previousSeason] = rows.length === 0
    ? []
    : await db
      .select({ id: rankingSeasons.id })
      .from(rankingSeasons)
      .where(and(
        eq(rankingSeasons.state, "closed"),
        lte(rankingSeasons.endsAt, season.startsAt),
      ))
      .orderBy(desc(rankingSeasons.endsAt), desc(rankingSeasons.id))
      .limit(1);
  const previousRows = previousSeason
    ? await db
      .select({ slug: rankingEntries.slug, rank: rankingEntries.rank })
      .from(rankingEntries)
      .where(and(
        eq(rankingEntries.seasonId, previousSeason.id),
        inArray(rankingEntries.slug, rows.map((row) => row.slug)),
      ))
    : [];
  const previousRanks = new Map(previousRows.map((row) => [row.slug, row.rank]));
  const items: RankingListItem[] = rows.map((row) => ({
    ...toListItem(row),
    rank: row.rank,
    validClicks: row.validClicks,
    changePercent: row.changePercent,
    cooldownFactorBasisPoints: row.cooldownFactorBasisPoints,
    previousRank: previousRanks.get(row.slug) ?? null,
  }));

  return {
    season: toSeasonSummary(season),
    items: await withProductHealth(items),
  };
}

export async function getDiscoveryBoards(): Promise<{
  weekly: RankingListItem[];
  trending: RankingListItem[];
  verifiedNew: ProductListItem[];
  discoveredNew: ProductListItem[];
}> {
  const current = await getCurrentSeason();
  const policy = current?.policy ?? DEFAULT_RANKING_POLICY;
  const ranking = current
    ? Promise.all([
      getSeasonRanking({
        seasonKey: current.key,
        order: "rank",
        limit: policy.boards.weeklyLimit,
      }),
      getSeasonRanking({
        seasonKey: current.key,
        order: "trending",
        limit: policy.trend.limit,
      }),
    ])
    : Promise.resolve([
      { season: null, items: [] as RankingListItem[] },
      { season: null, items: [] as RankingListItem[] },
    ]);
  const [[weekly, trending], verifiedNew, discoveredNew] = await Promise.all([
    ranking,
    getVerifiedList(policy.boards.verifiedNewLimit, { sort: "recent" }),
    getDiscoveryList(policy.boards.discoveredNewLimit),
  ]);

  return {
    weekly: weekly.items,
    trending: trending.items,
    verifiedNew,
    discoveredNew,
  };
}

export async function getSeasonHistory(limit = 12): Promise<SeasonSummary[]> {
  const seasons = await db
    .select()
    .from(rankingSeasons)
    .where(eq(rankingSeasons.state, "closed"))
    .orderBy(desc(rankingSeasons.endsAt), desc(rankingSeasons.id))
    .limit(limit);
  return seasons.map(toSeasonSummary);
}

export async function getAllTimeRanking(options: {
  category?: Category;
  query?: string;
  limit: number;
}): Promise<RankingListItem[]> {
  const totals = (await topClickedSince(3650, 50_000))
    .sort((left, right) => right.clicks - left.clicks || left.slug.localeCompare(right.slug));
  if (totals.length === 0) return [];

  const rows = await db
    .select()
    .from(products)
    .where(and(
      eq(products.status, "verified"),
      slugArrayPredicate(products.slug, totals.map((row) => row.slug)),
    ));
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const query = options.query?.trim().toLocaleLowerCase();
  const items: RankingListItem[] = [];
  let rank = 0;

  for (const total of totals) {
    const product = bySlug.get(total.slug);
    if (!product) continue;
    rank += 1;
    if (options.category && product.category !== options.category) continue;
    if (query && !product.name.toLocaleLowerCase().includes(query)
      && !product.tagline.toLocaleLowerCase().includes(query)) continue;

    items.push({
      ...toListItem(product),
      rank,
      validClicks: total.clicks,
      changePercent: null,
      cooldownFactorBasisPoints: 10_000,
      previousRank: null,
    });
    if (items.length === options.limit) break;
  }

  return withProductHealth(items);
}

export async function getRankingAdminState(now = new Date()): Promise<{
  active: SeasonSummary | null;
  activeMetrics: { eligibleProducts: number; validClicks: number };
  scheduled: RankingPolicyRevision | null;
  revisions: RankingPolicyRevision[];
  preview: CalculatedEntry[];
}> {
  const [activeSeason, scheduled, revisions] = await Promise.all([
    findSeason(),
    getScheduledPolicy(),
    listPolicyRevisions(),
  ]);
  const active = activeSeason ? toSeasonSummary(activeSeason) : null;
  const [metrics] = activeSeason
    ? await db
      .select({
        eligibleProducts: count(),
        validClicks: sql<number>`coalesce(sum(${rankingEntries.validClicks}), 0)::integer`,
      })
      .from(rankingEntries)
      .where(eq(rankingEntries.seasonId, activeSeason.id))
    : [{ eligibleProducts: 0, validClicks: 0 }];
  const policy = scheduled?.values ?? active?.policy ?? DEFAULT_RANKING_POLICY;

  return {
    active,
    activeMetrics: metrics,
    scheduled: scheduled ?? null,
    revisions,
    preview: await previewRanking(policy, now),
  };
}
