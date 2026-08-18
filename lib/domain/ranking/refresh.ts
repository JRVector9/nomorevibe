import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  sql,
  type DriverValueEncoder,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clickEvents,
  productClickDaily,
  products,
  rankingEntries,
  rankingPolicyRevisions,
  rankingSeasons,
  type RankingPolicyRevision,
  type RankingSeason,
} from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { clickChangePercent, cooldownFactor, rankRows } from "./math";
import { nextSeasonPeriod, periodContaining, type SeasonPeriod } from "./period";
import {
  DEFAULT_RANKING_POLICY,
  rankingPolicySchema,
  type RankingPolicy,
} from "./policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_RETENTION_MS = 35 * DAY_MS;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ENTRY_WRITE_BATCH_SIZE = 1_000;

const policyLock = sql`select pg_advisory_xact_lock(hashtext('ranking-policy'))`;
const refreshLock = sql`select pg_advisory_xact_lock(hashtext('ranking-refresh'))`;

type RankingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RankingExecutor = typeof db | RankingTransaction;

export type CalculatedEntry = {
  slug: string;
  validClicks: number;
  cooldownFactorBasisPoints: number;
  scoreUnits: number;
  rank: number;
  recentClicks: number;
  previousClicks: number;
  changePercent: number | null;
};

export type RankingRefreshResult = {
  createdSeason: boolean;
  closedSeasons: number;
  entries: number;
  seasonKey: string;
};

type ClickCounts = { recent: number; previous: number };
type RevisionPolicy = { revision: RankingPolicyRevision; policy: RankingPolicy };

const textArrayEncoder: DriverValueEncoder<string[], string> = {
  mapToDriverValue(values) {
    return `{${values.map((value) => (
      `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    )).join(",")}}`;
  },
};

export function slugArrayPredicate(
  column: SQLWrapper,
  slugs: string[],
  exclude = false,
): SQL {
  if (slugs.length === 0) return exclude ? sql`true` : sql`false`;
  const matches = sql`${column} = any(${sql.param(slugs, textArrayEncoder)}::text[])`;
  return exclude ? sql`not (${matches})` : matches;
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() < right.getTime() ? left : right;
}

function kstDay(date: Date): string {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function effectiveLaunchWindowDays(
  executor: RankingExecutor,
  startsAt: Date,
  cutoff: Date,
  policy: RankingPolicy,
): Promise<number> {
  const { launchWindowDays, maximumWindowDays, minimumProducts } = policy.eligibility;
  const maximumStart = new Date(startsAt.getTime() - maximumWindowDays * DAY_MS);
  const rows = await executor
    .select({ verifiedAt: products.verifiedAt })
    .from(products)
    .where(and(
      eq(products.status, "verified"),
      gte(products.verifiedAt, maximumStart),
      lt(products.verifiedAt, cutoff),
    ))
    .orderBy(desc(products.verifiedAt));

  const configuredStart = new Date(startsAt.getTime() - launchWindowDays * DAY_MS);
  const configuredCount = rows.filter(
    (row) => row.verifiedAt && row.verifiedAt.getTime() >= configuredStart.getTime(),
  ).length;
  if (configuredCount >= minimumProducts || rows.length < minimumProducts) {
    return rows.length < minimumProducts ? maximumWindowDays : launchWindowDays;
  }

  const threshold = rows[minimumProducts - 1]?.verifiedAt;
  if (!threshold) return maximumWindowDays;
  const requiredDays = Math.ceil((startsAt.getTime() - threshold.getTime()) / DAY_MS);
  return Math.min(maximumWindowDays, Math.max(launchWindowDays, requiredDays));
}

async function aggregateSeasonClicks(
  executor: RankingExecutor,
  startsAt: Date,
  endsAt: Date,
  slugs: string[],
  retentionAt: Date,
): Promise<Map<string, number>> {
  if (slugs.length === 0 || endsAt.getTime() <= startsAt.getTime()) return new Map();

  const rawCutoff = new Date(retentionAt.getTime() - RAW_RETENTION_MS);
  if (startsAt.getTime() >= rawCutoff.getTime()) {
    const rows = await executor
      .select({
        slug: clickEvents.slug,
        clicks: sql<number>`count(*)::int`,
      })
      .from(clickEvents)
      .where(and(
        slugArrayPredicate(clickEvents.slug, slugs),
        gte(clickEvents.occurredAt, startsAt),
        lt(clickEvents.occurredAt, endsAt),
      ))
      .groupBy(clickEvents.slug);
    return new Map(rows.map((row) => [row.slug, row.clicks]));
  }

  const rows = await executor
    .select({
      slug: productClickDaily.slug,
      clicks: sql<number>`sum(${productClickDaily.clicks})::int`,
    })
    .from(productClickDaily)
    .where(and(
      slugArrayPredicate(productClickDaily.slug, slugs),
      gte(productClickDaily.day, kstDay(startsAt)),
      lt(productClickDaily.day, kstDay(endsAt)),
    ))
    .groupBy(productClickDaily.slug);
  return new Map(rows.map((row) => [row.slug, row.clicks]));
}

async function aggregateTrendClicks(
  executor: RankingExecutor,
  cutoff: Date,
  windowHours: number,
  slugs: string[],
): Promise<Map<string, ClickCounts>> {
  if (slugs.length === 0) return new Map();
  const windowMs = windowHours * 60 * 60 * 1000;
  const recentStart = new Date(cutoff.getTime() - windowMs);
  const previousStart = new Date(recentStart.getTime() - windowMs);
  const recentStartIso = recentStart.toISOString();
  const rows = await executor
    .select({
      slug: clickEvents.slug,
      recent: sql<number>`count(*) filter (where ${clickEvents.occurredAt} >= ${recentStartIso}::timestamp)::int`,
      previous: sql<number>`count(*) filter (where ${clickEvents.occurredAt} < ${recentStartIso}::timestamp)::int`,
    })
    .from(clickEvents)
    .where(and(
      slugArrayPredicate(clickEvents.slug, slugs),
      gte(clickEvents.occurredAt, previousStart),
      lt(clickEvents.occurredAt, cutoff),
    ))
    .groupBy(clickEvents.slug);
  return new Map(rows.map((row) => [row.slug, { recent: row.recent, previous: row.previous }]));
}

async function priorFinishes(
  executor: RankingExecutor,
  season: RankingSeason,
  policy: RankingPolicy,
  slugs: string[],
) {
  const historyLength = Math.max(
    0,
    ...policy.cooldown.tiers.map((tier) => tier.factorsBasisPoints.length),
  );
  if (!policy.cooldown.enabled || historyLength === 0 || slugs.length === 0) return new Map();

  const seasons = await executor
    .select({ id: rankingSeasons.id })
    .from(rankingSeasons)
    .where(and(
      eq(rankingSeasons.state, "closed"),
      lte(rankingSeasons.endsAt, season.startsAt),
    ))
    .orderBy(desc(rankingSeasons.endsAt), desc(rankingSeasons.id))
    .limit(historyLength);
  if (seasons.length === 0) return new Map();

  const seasonsAgo = new Map(seasons.map((row, index) => [row.id, index + 1]));
  const finishes = await executor
    .select({
      seasonId: rankingEntries.seasonId,
      slug: rankingEntries.slug,
      rank: rankingEntries.rank,
    })
    .from(rankingEntries)
    .where(and(
      inArray(rankingEntries.seasonId, seasons.map((row) => row.id)),
      slugArrayPredicate(rankingEntries.slug, slugs),
    ));

  const bySlug = new Map<string, { rank: number; seasonsAgo: number }[]>();
  for (const finish of finishes) {
    const age = seasonsAgo.get(finish.seasonId);
    if (!age) continue;
    const values = bySlug.get(finish.slug) ?? [];
    values.push({ rank: finish.rank, seasonsAgo: age });
    bySlug.set(finish.slug, values);
  }
  return bySlug;
}

async function calculateRankingSnapshotAt(
  executor: RankingExecutor,
  season: RankingSeason,
  at: Date,
  policy: RankingPolicy,
  retentionAt: Date,
): Promise<CalculatedEntry[]> {
  const cutoff = minDate(at, season.endsAt);
  const eligibleSince = new Date(
    season.startsAt.getTime() - season.effectiveLaunchWindowDays * DAY_MS,
  );
  const candidates = await executor
    .select({ slug: products.slug, verifiedAt: products.verifiedAt })
    .from(products)
    .where(and(
      eq(products.status, "verified"),
      gte(products.verifiedAt, eligibleSince),
      lt(products.verifiedAt, cutoff),
    ));
  if (candidates.length === 0) return [];

  const slugs = candidates.map((candidate) => candidate.slug);
  const [seasonClicks, trendClicks, finishes] = await Promise.all([
    aggregateSeasonClicks(executor, season.startsAt, cutoff, slugs, retentionAt),
    aggregateTrendClicks(executor, cutoff, policy.trend.windowHours, slugs),
    priorFinishes(executor, season, policy, slugs),
  ]);

  const ranked = rankRows(candidates.map((candidate) => ({
    slug: candidate.slug,
    validClicks: seasonClicks.get(candidate.slug) ?? 0,
    factorBasisPoints: cooldownFactor(policy.cooldown, finishes.get(candidate.slug) ?? []),
    verifiedAt: candidate.verifiedAt!,
  })));

  return ranked.map((row) => {
    const trend = trendClicks.get(row.slug) ?? { recent: 0, previous: 0 };
    return {
      slug: row.slug,
      validClicks: row.validClicks,
      cooldownFactorBasisPoints: row.factorBasisPoints,
      scoreUnits: row.scoreUnits,
      rank: row.rank,
      recentClicks: trend.recent,
      previousClicks: trend.previous,
      changePercent: clickChangePercent(
        trend.recent,
        trend.previous,
        policy.trend.minimumPreviousClicks,
      ),
    };
  });
}

export async function calculateRankingSnapshot(
  executor: RankingExecutor,
  season: RankingSeason,
  at: Date,
  policy: RankingPolicy = season.policySnapshot,
): Promise<CalculatedEntry[]> {
  return calculateRankingSnapshotAt(executor, season, at, policy, new Date());
}

async function ensureAppliedPolicy(
  tx: RankingTransaction,
  now: Date,
): Promise<RankingPolicyRevision> {
  const [existing] = await tx
    .select()
    .from(rankingPolicyRevisions)
    .where(eq(rankingPolicyRevisions.state, "applied"))
    .orderBy(desc(rankingPolicyRevisions.appliedAt), desc(rankingPolicyRevisions.id))
    .limit(1);
  if (existing) return existing;

  const [created] = await tx
    .insert(rankingPolicyRevisions)
    .values({
      values: DEFAULT_RANKING_POLICY,
      state: "applied",
      createdBy: "system",
      createdAt: now,
      appliedAt: now,
    })
    .returning();
  return created;
}

async function createSeason(
  tx: RankingTransaction,
  period: SeasonPeriod,
  revision: RankingPolicyRevision,
  policy: RankingPolicy,
  eligibilityCutoff: Date,
): Promise<RankingSeason> {
  const windowDays = await effectiveLaunchWindowDays(
    tx,
    period.startsAt,
    eligibilityCutoff,
    policy,
  );
  const [season] = await tx
    .insert(rankingSeasons)
    .values({
      key: period.key,
      cadence: period.cadence,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      state: "active",
      policyRevisionId: revision.id,
      policySnapshot: policy,
      effectiveLaunchWindowDays: windowDays,
      isTransition: period.isTransition,
      startedAt: eligibilityCutoff,
    })
    .returning();
  return season;
}

async function replaceEntries(
  tx: RankingTransaction,
  seasonId: number,
  entries: CalculatedEntry[],
  at: Date,
  finalizedAt: Date | null,
): Promise<void> {
  if (entries.length === 0) {
    await tx.delete(rankingEntries).where(eq(rankingEntries.seasonId, seasonId));
    return;
  }

  await tx
    .delete(rankingEntries)
    .where(and(
      eq(rankingEntries.seasonId, seasonId),
      slugArrayPredicate(rankingEntries.slug, entries.map((entry) => entry.slug), true),
    ));
  const values = entries.map((entry) => ({
    seasonId,
    ...entry,
    updatedAt: at,
    finalizedAt,
  }));
  for (let index = 0; index < values.length; index += ENTRY_WRITE_BATCH_SIZE) {
    await tx
      .insert(rankingEntries)
      .values(values.slice(index, index + ENTRY_WRITE_BATCH_SIZE))
      .onConflictDoUpdate({
        target: [rankingEntries.seasonId, rankingEntries.slug],
        set: {
          validClicks: sql`excluded.valid_clicks`,
          cooldownFactorBasisPoints: sql`excluded.cooldown_factor_basis_points`,
          scoreUnits: sql`excluded.score_units`,
          rank: sql`excluded.rank`,
          recentClicks: sql`excluded.recent_clicks`,
          previousClicks: sql`excluded.previous_clicks`,
          changePercent: sql`excluded.change_percent`,
          updatedAt: at,
          finalizedAt,
        },
      });
  }
}

async function nextRevisionPolicy(
  tx: RankingTransaction,
  active: RankingSeason,
  boundary: Date,
): Promise<RevisionPolicy> {
  const [scheduled] = await tx
    .select()
    .from(rankingPolicyRevisions)
    .where(and(
      eq(rankingPolicyRevisions.state, "scheduled"),
      lte(rankingPolicyRevisions.createdAt, boundary),
    ))
    .limit(1);
  if (!scheduled) {
    const [revision] = await tx
      .select()
      .from(rankingPolicyRevisions)
      .where(eq(rankingPolicyRevisions.id, active.policyRevisionId))
      .limit(1);
    if (!revision) throw new Error(`Ranking policy revision ${active.policyRevisionId} is missing`);
    return { revision, policy: active.policySnapshot };
  }

  const parsed = rankingPolicySchema.safeParse(scheduled.values);
  if (!parsed.success) {
    logger.error("ranking.policy_invalid", {
      revisionId: scheduled.id,
      issues: parsed.error.issues.map((issue) => issue.message),
    });
    await tx
      .update(rankingPolicyRevisions)
      .set({ state: "cancelled", cancelledAt: boundary })
      .where(eq(rankingPolicyRevisions.id, scheduled.id));
    const [revision] = await tx
      .select()
      .from(rankingPolicyRevisions)
      .where(eq(rankingPolicyRevisions.id, active.policyRevisionId))
      .limit(1);
    if (!revision) throw new Error(`Ranking policy revision ${active.policyRevisionId} is missing`);
    return { revision, policy: active.policySnapshot };
  }

  const [applied] = await tx
    .update(rankingPolicyRevisions)
    .set({ state: "applied", appliedAt: boundary })
    .where(eq(rankingPolicyRevisions.id, scheduled.id))
    .returning();
  return { revision: applied, policy: parsed.data };
}

export async function refreshRanking(now = new Date()): Promise<RankingRefreshResult> {
  return db.transaction(async (tx) => {
    await tx.execute(policyLock);
    await tx.execute(refreshLock);

    const applied = await ensureAppliedPolicy(tx, now);
    const parsedApplied = rankingPolicySchema.parse(applied.values);
    let active = await tx.query.rankingSeasons.findFirst({
      where: eq(rankingSeasons.state, "active"),
    });
    let createdSeason = false;
    let closedSeasons = 0;

    if (!active) {
      const period = periodContaining(now, parsedApplied.season.cadence);
      active = await createSeason(tx, period, applied, parsedApplied, now);
      createdSeason = true;
    }

    while (now.getTime() >= active.endsAt.getTime()) {
      const finalized = await calculateRankingSnapshotAt(
        tx,
        active,
        active.endsAt,
        active.policySnapshot,
        now,
      );
      await replaceEntries(tx, active.id, finalized, active.endsAt, active.endsAt);
      await tx
        .update(rankingSeasons)
        .set({ state: "closed", refreshedAt: active.endsAt, closedAt: active.endsAt })
        .where(eq(rankingSeasons.id, active.id));
      closedSeasons += 1;

      const next = await nextRevisionPolicy(tx, active, active.endsAt);
      const period = nextSeasonPeriod(active.endsAt, next.policy.season.cadence);
      active = await createSeason(tx, period, next.revision, next.policy, period.startsAt);
      createdSeason = true;
    }

    const entries = await calculateRankingSnapshotAt(
      tx,
      active,
      now,
      active.policySnapshot,
      now,
    );
    await replaceEntries(tx, active.id, entries, now, null);
    await tx
      .update(rankingSeasons)
      .set({ refreshedAt: now })
      .where(eq(rankingSeasons.id, active.id));

    return {
      createdSeason,
      closedSeasons,
      entries: entries.length,
      seasonKey: active.key,
    };
  });
}

export async function previewRanking(
  policy: RankingPolicy,
  now = new Date(),
): Promise<CalculatedEntry[]> {
  const active = await db.query.rankingSeasons.findFirst({
    where: eq(rankingSeasons.state, "active"),
  });
  const period = active
    ? nextSeasonPeriod(active.endsAt, policy.season.cadence)
    : periodContaining(now, policy.season.cadence);
  const previewStartsAt = new Date(now.getTime() - (
    period.endsAt.getTime() - period.startsAt.getTime()
  ));
  const windowDays = await effectiveLaunchWindowDays(db, previewStartsAt, now, policy);
  const season: RankingSeason = {
    id: 0,
    key: period.key,
    cadence: period.cadence,
    startsAt: previewStartsAt,
    endsAt: now,
    state: "active",
    policyRevisionId: 0,
    policySnapshot: policy,
    effectiveLaunchWindowDays: windowDays,
    isTransition: period.isTransition,
    refreshedAt: null,
    startedAt: now,
    closedAt: null,
  };
  return calculateRankingSnapshotAt(db, season, now, policy, now);
}
