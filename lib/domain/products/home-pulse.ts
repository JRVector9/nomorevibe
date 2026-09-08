import { and, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clickEvents,
  products,
  productUpdates,
  visitCollectionState,
  type ProductStatus,
} from "@/lib/db/schema";
import { clickChangePercent } from "@/lib/domain/ranking/math";
import { CATEGORIES, type Category } from "./schema";

const DAY_MS = 86_400_000;
const LISTED: ProductStatus[] = ["verified", "seeded"];
export const LAUNCH_CHANGE_MIN = 20;
export const INTEREST_CHANGE_MIN = 100;
export const TOOL_PERCENT_MIN = 20;
export const METHOD_VERSION = "1.0";

const listedAt = sql`coalesce(${products.verifiedAt}, ${products.createdAt})`;
const builderIsReported = or(ne(products.source, "crawler"), isNotNull(products.claimedAt))!;

export type LaunchDay = { date: string; count: number; weekday: string };

export type HomePulse = {
  asOf: Date;
  timezone: "Asia/Seoul";
  methodVersion: typeof METHOD_VERSION;
  launches: {
    current: number;
    previous: number;
    change: number | null;
    days: LaunchDay[];
  };
  tools: {
    total: number;
    reported: number;
    coverage: number | null;
    rows: { name: string; count: number; percent: number | null }[];
  };
  interestReady: boolean;
  categories: {
    key: Category;
    current: number;
    previous: number;
    change: number | null;
    qualified: boolean;
  }[];
  updates: { projects: number; releases: number };
  total: number;
};

export function kstCalendarDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 오늘 KST 0시. 아직 끝나지 않은 오늘은 집계에 넣지 않는다. */
export function kstMidnightUtc(now: Date): Date {
  return new Date(`${kstCalendarDate(now)}T00:00:00+09:00`);
}

export function completedWindows(now: Date) {
  const asOf = kstMidnightUtc(now);
  return {
    asOf,
    weekStart: new Date(asOf.getTime() - 7 * DAY_MS),
    prevStart: new Date(asOf.getTime() - 14 * DAY_MS),
    monthStart: new Date(asOf.getTime() - 30 * DAY_MS),
  };
}

export function formatAsOfKst(asOf: Date): string {
  const [, month, day] = kstCalendarDate(asOf).split("-");
  return `${month}.${day} 00:00 KST 기준`;
}

/** 증감률은 최근·직전 7일 구간을 모두 빠짐없이 수집했을 때만 계산한다. */
export function interestWindowReady(startedAt: Date | null | undefined, previousStart: Date): boolean {
  return Boolean(startedAt && startedAt.getTime() <= previousStart.getTime());
}

export function kstWeekday(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    weekday: "short",
  }).format(date).replace("요일", "");
}

export function bucketDailyCounts(occurredAt: Date[], weekStart: Date): LaunchDay[] {
  const days: LaunchDay[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const start = new Date(weekStart.getTime() + offset * DAY_MS);
    const end = new Date(start.getTime() + DAY_MS);
    const count = occurredAt.filter((at) => at >= start && at < end).length;
    days.push({ date: start.toISOString(), count, weekday: kstWeekday(start) });
  }
  return days;
}

function toolPercent(count: number, reported: number): number | null {
  if (reported <= 0) return null;
  return Math.round((count / reported) * 1000) / 10;
}

export function emptyHomePulse(now: Date): HomePulse {
  const { asOf, weekStart } = completedWindows(now);
  return {
    asOf,
    timezone: "Asia/Seoul",
    methodVersion: METHOD_VERSION,
    launches: {
      current: 0,
      previous: 0,
      change: null,
      days: bucketDailyCounts([], weekStart),
    },
    tools: { total: 0, reported: 0, coverage: null, rows: [] },
    interestReady: false,
    categories: [],
    updates: { projects: 0, releases: 0 },
    total: 0,
  };
}

/**
 * 홈 상단 네 칸.
 *
 * 검색·필터와 분리된 전역 내부 집계다. 표본이 모자라면 비율을 0으로 채우지 않는다.
 */
function at(date: Date) {
  return sql`${date.toISOString()}::timestamptz`;
}

export async function getHomePulse(now = new Date()): Promise<HomePulse> {
  const { asOf, weekStart, prevStart, monthStart } = completedWindows(now);
  const listed = inArray(products.status, LISTED);
  const asOfAt = at(asOf);
  const weekAt = at(weekStart);
  const prevAt = at(prevStart);
  const monthAt = at(monthStart);

  const [summary, launchRows, toolRows, interestRows, updateRow, collectionState] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*) filter (where ${listedAt} < ${asOfAt})::int`,
        week: sql<number>`count(*) filter (where ${listedAt} >= ${weekAt} and ${listedAt} < ${asOfAt})::int`,
        prev: sql<number>`count(*) filter (where ${listedAt} >= ${prevAt} and ${listedAt} < ${weekAt})::int`,
        month: sql<number>`count(*) filter (where ${listedAt} >= ${monthAt} and ${listedAt} < ${asOfAt})::int`,
        reported: sql<number>`count(*) filter (where ${listedAt} >= ${monthAt} and ${listedAt} < ${asOfAt} and ${builderIsReported} and ${products.builder} is not null and btrim(${products.builder}) <> '')::int`,
      })
      .from(products)
      .where(listed)
      .then((rows) => rows[0]),
    db
      .select({ at: sql<Date>`${listedAt}` })
      .from(products)
      .where(and(listed, sql`${listedAt} >= ${weekAt}`, sql`${listedAt} < ${asOfAt}`)),
    db
      .select({
        name: products.builder,
        count: sql<number>`count(*)::int`,
      })
      .from(products)
      .where(and(
        listed,
        builderIsReported,
        sql`${listedAt} >= ${monthAt}`,
        sql`${listedAt} < ${asOfAt}`,
        isNotNull(products.builder),
        sql`btrim(${products.builder}) <> ''`,
      ))
      .groupBy(products.builder),
    db
      .select({
        category: products.category,
        current: sql<number>`count(distinct ${clickEvents.visitorHash}) filter (where ${clickEvents.occurredAt} >= ${weekAt} and ${clickEvents.occurredAt} < ${asOfAt})::int`,
        previous: sql<number>`count(distinct ${clickEvents.visitorHash}) filter (where ${clickEvents.occurredAt} >= ${prevAt} and ${clickEvents.occurredAt} < ${weekAt})::int`,
      })
      .from(clickEvents)
      .innerJoin(products, eq(products.slug, clickEvents.slug))
      .where(and(
        listed,
        isNotNull(clickEvents.visitorHash),
        gte(clickEvents.occurredAt, prevStart),
        lt(clickEvents.occurredAt, asOf),
      ))
      .groupBy(products.category),
    db
      .select({
        releases: sql<number>`count(*)::int`,
        projects: sql<number>`count(distinct ${productUpdates.slug})::int`,
      })
      .from(productUpdates)
      .innerJoin(products, eq(products.slug, productUpdates.slug))
      .where(and(
        listed,
        eq(productUpdates.visible, true),
        sql`${productUpdates.makerDeletedAt} is null`,
        inArray(productUpdates.sourceKind, ["github_release", "maker"]),
        sql`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt}) >= ${weekAt}`,
        sql`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt}) < ${asOfAt}`,
      ))
      .then((rows) => rows[0]),
    db
      .select({ startedAt: visitCollectionState.uniqueVisitorStartedAt })
      .from(visitCollectionState)
      .where(eq(visitCollectionState.id, 1))
      .limit(1)
      .then((rows) => rows[0]),
  ]);

  const current = summary?.week ?? 0;
  const previous = summary?.prev ?? 0;
  const reported = summary?.reported ?? 0;
  const monthTotal = summary?.month ?? 0;
  const interestByKey = new Map(interestRows.map((row) => [row.category, row]));
  const interestReady = interestWindowReady(collectionState?.startedAt, prevStart);

  return {
    asOf,
    timezone: "Asia/Seoul",
    methodVersion: METHOD_VERSION,
    launches: {
      current,
      previous,
      change: clickChangePercent(current, previous, LAUNCH_CHANGE_MIN),
      days: bucketDailyCounts(launchRows.map((row) => new Date(row.at)), weekStart),
    },
    tools: {
      total: monthTotal,
      reported,
      coverage: toolPercent(reported, monthTotal),
      rows: toolRows
        .filter((row): row is { name: string; count: number } => Boolean(row.name))
        .map((row) => ({
          name: row.name,
          count: row.count,
          percent: toolPercent(row.count, reported),
        }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    },
    interestReady,
    categories: CATEGORIES.map((key) => {
      const row = interestByKey.get(key);
      const currentCount = row?.current ?? 0;
      const previousCount = row?.previous ?? 0;
      const change = interestReady
        ? clickChangePercent(currentCount, previousCount, INTEREST_CHANGE_MIN)
        : null;
      return {
        key,
        current: currentCount,
        previous: previousCount,
        change,
        qualified: interestReady && previousCount >= INTEREST_CHANGE_MIN && change !== null,
      };
    }).sort((left, right) => (
      (right.change ?? Number.NEGATIVE_INFINITY) - (left.change ?? Number.NEGATIVE_INFINITY)
      || right.current - left.current
      || left.key.localeCompare(right.key)
    )),
    updates: {
      projects: updateRow?.projects ?? 0,
      releases: updateRow?.releases ?? 0,
    },
    total: summary?.total ?? 0,
  };
}
