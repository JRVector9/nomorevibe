import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { isAiLevel, type AiLevel } from "@/lib/domain/evidence/ai-level-labels";
import { observedToolPredicate } from "./observed-tool";
import { hasSearchQuery, productSearchPredicate, type SearchQuery } from "./search";
import type { Category } from "./schema";
import {
  productStarObservationRuns as runs,
  productStarObservations as observations,
  type ProductStarObservationRun,
} from "@/lib/db/product-star-observation-schema";
import { taglineKo } from "./korean-tagline";
import { aiLevelPredicate, listedByDefault, notDown, repoGone } from "./repository";
import { publicRead } from "./public-reads";
import {
  latestStarObservationCycleAt,
  nextStarObservationCycleAt,
  STAR_OBSERVATION_POLICY_VERSION,
  type StarObservationPolicy,
} from "./star-observation-policy";
import { toListItem, withProductHealth, type ProductListItem } from "./view";

const HOUR_MS = 60 * 60_000;
// Collection stays at KST 00/08/16; ranking compares adjacent completed cycles.
const COMPARISON_HOURS = 8;
const GROWTH_POLICY_VERSION = "growth-8h-v1";
const MAX_PAGE_SIZE = 100;
const baselineObservations = alias(observations, "baseline_star_observations");

export type StarGrowthItem = ProductListItem & {
  starGrowth: {
    gain: number;
    stars: number;
    baselineStars: number;
    observedAt: string;
    baselineObservedAt: string;
  };
};

export type StarGrowthRunSummary = {
  runId: number;
  asOf: string;
  status: ProductStarObservationRun["status"];
  policyVersion: string;
  targetCount: number;
  successCount: number;
  failureCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  closedAt: string | null;
};

export type StarGrowthSnapshot = {
  status: "ready" | "warming" | "late" | "no-results";
  reason: "missing-run" | "run-not-closed" | "run-failed" | "missing-baseline" | "baseline-not-closed"
    | "invalid-policy" | "invalid-cycle" | "cycle-changed" | "no-comparable-observations" | "below-threshold" | "filtered-out" | null;
  asOf: string;
  nextCycle: string;
  baselineAsOf: string;
  runId: number | null;
  policyVersion: string | null;
  policy: StarObservationPolicy | null;
  targetCount: number | null;
  successCount: number | null;
  failureCount: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  baseline: StarGrowthRunSummary | null;
  comparableCount: number;
};

export type StarGrowthFacets = {
  categories: Record<string, number>;
  aiLevels: { category: string; level: AiLevel; count: number }[];
};

export type StarGrowthPage = {
  items: StarGrowthItem[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  offset: number;
  /** Full eligible facet matrix, before the card slice and without selected category/AI. */
  facets: StarGrowthFacets | null;
  snapshot: StarGrowthSnapshot;
};

export type StarGrowthPageOptions = {
  page?: number | string;
  pageSize?: number;
  /** Pin pagination to the homepage cutoff. An older cutoff returns an empty late state. */
  cycle?: string;
  now?: Date;
  category?: Category;
  aiLevels?: readonly AiLevel[];
  query?: SearchQuery;
  builder?: string;
  observedTool?: string;
  includeFacets?: boolean;
  /** Browse cards use a bounded slice; page/pageSize remain the /rising contract. */
  limit?: number;
  offset?: number;
  /** Exclusive result endpoint, allowing a trailing window beyond the card limit. */
  end?: number;
};

/** Strict UTC cutoffs; reject normalized invalid dates and non-KST 00/08/16 times. */
export function parseStarGrowthCycle(value: string): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(value)) return null;
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return null;
  const canonical = value.replace(/:00Z$/, ":00.000Z");
  return at.toISOString() === canonical && latestStarObservationCycleAt(at).getTime() === at.getTime()
    ? canonical : null;
}

function requestedPage(value: StarGrowthPageOptions["page"]): number {
  const page = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof page === "number" && Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function boundedPageSize(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(value))) : 15;
}

function validPolicy(value: StarObservationPolicy | null): value is StarObservationPolicy {
  return value !== null && typeof value === "object"
    && [value.minStars, value.maxStarsExclusive, value.minGain, value.minIntervalHours, value.maxIntervalHours,
      value.maxAgeHours, value.collectionWindowHours, value.retentionDays].every(Number.isSafeInteger)
    && value.minStars >= 0 && value.maxStarsExclusive > value.minStars && value.minGain > 0
    && value.minIntervalHours > 0 && value.maxIntervalHours >= value.minIntervalHours
    && value.maxAgeHours > 0 && value.collectionWindowHours > 0 && value.retentionDays > 0;
}

async function loadRuns(asOf: Date, baselineAt: Date) {
  const rows = await db.select().from(runs).where(inArray(runs.cycleAt, [asOf, baselineAt]));
  const current = rows.find((run) => run.cycleAt.getTime() === asOf.getTime()) ?? null;
  const baseline = rows.find((run) => run.cycleAt.getTime() === baselineAt.getTime()) ?? null;
  const times = rows.length ? await db.select({
    runId: observations.runId,
    first: sql<Date | null>`min(${observations.observedAt})`.mapWith(observations.observedAt),
    last: sql<Date | null>`max(${observations.observedAt})`.mapWith(observations.observedAt),
  }).from(observations).where(and(inArray(observations.runId, rows.map((run) => run.id)), eq(observations.status, "ok")))
    .groupBy(observations.runId) : [];
  const summary = (run: ProductStarObservationRun): StarGrowthRunSummary => {
    const observed = times.find((time) => time.runId === run.id);
    return {
      runId: run.id, asOf: run.cycleAt.toISOString(), status: run.status, policyVersion: run.policyVersion,
      targetCount: run.targetCount, successCount: run.successCount, failureCount: run.failureCount,
      firstObservedAt: observed?.first?.toISOString() ?? null,
      lastObservedAt: observed?.last?.toISOString() ?? null, closedAt: run.closedAt?.toISOString() ?? null,
    };
  };
  const hasHistory = current || baseline || (await db.select({ id: runs.id }).from(runs).where(lt(runs.cycleAt, asOf)).limit(1)).length > 0;
  return { current, baseline, currentSummary: current ? summary(current) : null,
    baselineSummary: baseline ? summary(baseline) : null, hasHistory: Boolean(hasHistory) };
}

const observedListFields = {
  id: products.id, slug: products.slug, name: products.name, repoUrl: products.repoUrl, tagline: products.tagline,
  taglineSource: products.taglineSource, taglineKo, category: products.category, accessMode: products.accessMode,
  builder: products.builder, stack: products.stack, ogImage: products.ogImage, makerName: products.makerName,
  verifiedAt: products.verifiedAt, createdAt: products.createdAt, status: products.status,
  source: products.source, claimedAt: products.claimedAt, repoRenamedTo: products.repoRenamedTo, aiLevel: products.aiLevel,
  stars: observations.stars, starsAt: observations.observedAt,
};

function currentObservationConditions(current: ProductStarObservationRun, policy: StarObservationPolicy, now: Date) {
  return and(
    eq(observations.runId, current.id), eq(observations.status, "ok"), eq(observations.archived, false),
    gte(observations.stars, policy.minStars), lt(observations.stars, policy.maxStarsExclusive),
    gte(observations.observedAt, current.windowStartsAt), lt(observations.observedAt, current.deadlineAt),
    gte(observations.observedAt, new Date(current.cycleAt.getTime() - policy.collectionWindowHours * HOUR_MS)),
    gte(observations.observedAt, new Date(now.getTime() - policy.maxAgeHours * HOUR_MS)),
    inArray(products.status, ["verified", "seeded"]), listedByDefault, notDown, sql`not ${repoGone}`,
    eq(products.repoUrl, observations.repoUrl), eq(products.repoLinkVersion, observations.repoLinkVersion),
    sql`${products.repoStatus} is distinct from 'blocked'`,
  );
}

/** Only immutable T/T−8h evidence ranks growth; live rows can hide unsafe products. */
async function loadPage(current: ProductStarObservationRun, baseline: ProductStarObservationRun,
  policy: StarObservationPolicy, now: Date, requested: number, pageSize: number, options: StarGrowthPageOptions) {
  const gain = sql<number>`(${observations.stars} - ${baselineObservations.stars})`;
  const gap = sql`extract(epoch from (${observations.observedAt} - ${baselineObservations.observedAt}))`;
  const conditions = and(
    currentObservationConditions(current, policy, now),
    eq(baselineObservations.runId, baseline.id), eq(baselineObservations.status, "ok"),
    eq(baselineObservations.archived, false),
    gte(baselineObservations.observedAt, baseline.windowStartsAt), lt(baselineObservations.observedAt, baseline.deadlineAt),
    gte(baselineObservations.observedAt, new Date(baseline.cycleAt.getTime() - policy.collectionWindowHours * HOUR_MS)),
    sql`${gap} >= ${policy.minIntervalHours * 3600} and ${gap} <= ${policy.maxIntervalHours * 3600}`,
  );
  const sameRepository = and(eq(baselineObservations.productId, observations.productId),
    eq(baselineObservations.repositoryKey, observations.repositoryKey),
    isNotNull(observations.repositoryId), isNotNull(baselineObservations.repositoryId),
    eq(baselineObservations.repositoryId, observations.repositoryId),
    eq(baselineObservations.repoLinkVersion, observations.repoLinkVersion),
    eq(baselineObservations.repoUrl, observations.repoUrl));

  const textFilters = and(
    hasSearchQuery(options.query) ? productSearchPredicate(options.query!) : undefined,
    options.observedTool ? observedToolPredicate(options.observedTool) : undefined,
    options.builder ? sql`${products.builder} = ${options.builder} and (${products.source} <> 'crawler' or ${products.claimedAt} is not null)` : undefined,
  );
  const selectedFilters = and(textFilters,
    options.category ? eq(products.category, options.category) : undefined,
    options.aiLevels ? aiLevelPredicate(options.aiLevels) : undefined);
  const eligible = gte(gain, policy.minGain);
  // Counts, facets and slice share one read snapshot with the same live safety exclusions.
  const result = await db.transaction(async (tx) => {
    const [counts] = await tx.select({
      comparableCount: sql<number>`count(*)::int`,
      eligibleCount: sql<number>`count(*) filter (where ${eligible})::int`,
      total: sql<number>`count(*) filter (where ${and(eligible, selectedFilters)})::int`,
    }).from(observations).innerJoin(baselineObservations, sameRepository)
      .innerJoin(products, eq(products.id, observations.productId)).where(conditions);
    const total = Number(counts.total);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requested, pages);
    const limit = options.limit === undefined ? pageSize
      : Number.isSafeInteger(options.limit) ? Math.min(198, Math.max(0, options.limit)) : pageSize;
    const end = options.end !== undefined && Number.isSafeInteger(options.end) && options.end >= 0
      ? Math.min(options.end, total) : undefined;
    const offset = end !== undefined ? Math.max(0, end - limit)
      : options.offset !== undefined && Number.isSafeInteger(options.offset) && options.offset >= 0
        ? Math.min(options.offset, total) : (page - 1) * pageSize;
    const facetRows = options.includeFacets ? await tx.select({
      category: products.category, level: products.aiLevel, count: sql<number>`count(*)::int`,
    }).from(observations).innerJoin(baselineObservations, sameRepository)
      .innerJoin(products, eq(products.id, observations.productId))
      .where(and(conditions, eligible, textFilters)).groupBy(products.category, products.aiLevel) : null;
    const facets: StarGrowthFacets | null = facetRows ? {
      categories: {}, aiLevels: facetRows.flatMap(({ category, level, count }) => isAiLevel(level) ? [{ category, level, count }] : []),
    } : null;
    if (facets) for (const row of facetRows!) facets.categories[row.category] = (facets.categories[row.category] ?? 0) + row.count;
    const rows = total === 0 || limit === 0 ? [] : await tx.select({
      ...observedListFields,
      starsPrevious: baselineObservations.stars, starsPreviousAt: baselineObservations.observedAt, gain,
    }).from(observations).innerJoin(baselineObservations, sameRepository)
      .innerJoin(products, eq(products.id, observations.productId))
      .where(and(conditions, eligible, selectedFilters))
      .orderBy(sql`${gain} desc`, sql`${observations.stars} desc`, asc(observations.slug))
      .limit(end === undefined ? limit : end - offset).offset(offset);
    return { rows, total, eligibleCount: Number(counts.eligibleCount), comparableCount: Number(counts.comparableCount), page, pages, offset, facets };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const items = await withProductHealth(result.rows.map((row): StarGrowthItem => ({
    ...toListItem(row),
    starGrowth: { gain: row.gain, stars: row.stars!, baselineStars: row.starsPrevious!,
      observedAt: row.starsAt!.toISOString(), baselineObservedAt: row.starsPreviousAt!.toISOString() },
  })));
  return { items, total: result.total, eligibleCount: result.eligibleCount, comparableCount: result.comparableCount,
    page: result.page, pages: result.pages, offset: result.offset, facets: result.facets };
}

/** Homepage five and /rising pages use this same cutoff, policy, predicates and order. */
export async function getStarGrowthPage(options: StarGrowthPageOptions = {}): Promise<StarGrowthPage> {
  const now = options.now ?? new Date();
  const asOf = latestStarObservationCycleAt(now);
  const baselineAt = new Date(asOf.getTime() - COMPARISON_HOURS * HOUR_MS);
  const pageSize = boundedPageSize(options.pageSize);
  const requested = requestedPage(options.page);
  const context = await publicRead("list", ["star-growth-8h-runs", asOf, STAR_OBSERVATION_POLICY_VERSION],
    () => loadRuns(asOf, baselineAt));
  const { current, baseline, currentSummary } = context;
  const snapshot: StarGrowthSnapshot = {
    status: "warming", reason: "missing-run", asOf: asOf.toISOString(),
    nextCycle: nextStarObservationCycleAt(now).toISOString(), baselineAsOf: baselineAt.toISOString(),
    runId: current?.id ?? null, policyVersion: current ? `${current.policyVersion}/${GROWTH_POLICY_VERSION}` : null,
    // Preserve the immutable collector policy; these are the effective display criteria.
    policy: current && validPolicy(current.policy) ? { ...current.policy,
      minGain: 1, minIntervalHours: COMPARISON_HOURS - 1, maxIntervalHours: COMPARISON_HOURS + 1 } : null,
    targetCount: current?.targetCount ?? null, successCount: current?.successCount ?? null, failureCount: current?.failureCount ?? null,
    firstObservedAt: currentSummary?.firstObservedAt ?? null, lastObservedAt: currentSummary?.lastObservedAt ?? null,
    baseline: context.baselineSummary, comparableCount: 0,
  };
  const empty = (status: StarGrowthSnapshot["status"], reason: StarGrowthSnapshot["reason"]): StarGrowthPage =>
    ({ items: [], total: 0, page: 1, pages: 1, pageSize, offset: 0,
      facets: options.includeFacets ? { categories: {}, aiLevels: [] } : null, snapshot: { ...snapshot, status, reason } });
  if (options.cycle !== undefined) {
    const cycle = parseStarGrowthCycle(options.cycle);
    if (!cycle) return empty("late", "invalid-cycle");
    if (cycle !== snapshot.asOf) return empty("late", "cycle-changed");
  }
  if (!current) return empty(context.hasHistory ? "late" : "warming", "missing-run");
  if (current.status === "failed") return empty("late", "run-failed");
  if (current.status !== "closed") return empty("late", "run-not-closed");
  if (!snapshot.policy) return empty("late", "invalid-policy");
  if (!baseline) return empty("warming", "missing-baseline");
  if (baseline.status !== "closed") return empty("late", "baseline-not-closed");

  const page = await publicRead("list", ["star-growth-8h-page", snapshot.asOf, current.id, snapshot.policyVersion, snapshot.policy,
    baseline.id, baseline.policyVersion, baseline.policy, requested, pageSize,
    { category: options.category, aiLevels: options.aiLevels, query: options.query, builder: options.builder,
      observedTool: options.observedTool, includeFacets: options.includeFacets, limit: options.limit, offset: options.offset, end: options.end }],
    () => loadPage(current, baseline, snapshot.policy!, now, requested, pageSize, options));
  return {
    items: page.items, total: page.total, page: page.page, pages: page.pages, pageSize, offset: page.offset, facets: page.facets,
    snapshot: { ...snapshot, comparableCount: page.comparableCount,
      status: page.total > 0 ? "ready" : "no-results",
      reason: page.total > 0 ? null : page.eligibleCount > 0 ? "filtered-out"
        : page.comparableCount > 0 ? "below-threshold" : "no-comparable-observations" },
  };
}
