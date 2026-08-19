import {
  and,
  eq,
  gte,
  inArray,
  lt,
  sql,
  type DriverValueEncoder,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { clickEvents, productClickDaily, visitCollectionState } from "@/lib/db/schema";
import { clickChangePercent } from "@/lib/domain/ranking/math";
import { productVisitorHash } from "@/lib/domain/products/visitors";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";

/**
 * 아웃바운드 클릭.
 *
 * 지표가 있어야 랭킹이 생긴다. 다만 세는 것 자체가 어뷰징 대상이므로, 같은 사람이 연타한
 * 것을 한 번으로 묶는다 — 한 번 누른 것과 백 번 누른 것이 같은 무게일 수는 없다.
 */

/** 같은 방문자의 같은 제품 클릭을 이 시간 안에서는 한 번으로 본다 */
const DEDUPE_MS = 10 * 60 * 1000;

/** 방문자를 구분하는 1st-party 쿠키. 신원이 아니라 "같은 브라우저인가"만 본다 */
export const VISITOR_COOKIE = "nmv_visitor";

export const visitorCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 365 * 24 * 60 * 60,
};

/**
 * 세지 않을 방문자.
 *
 * /go는 robots.txt로 막아두지만 그것을 지키지 않는 크롤러와 링크 미리보기(슬랙·트위터)가
 * 남는다. 그것들이 만든 클릭이 랭킹에 들어가면 순위가 크롤 빈도순이 된다.
 */
const BOT_AGENT =
  /bot\b|bot\/|crawler|spider|slurp|facebookexternalhit|embedly|quora link preview|whatsapp|telegrambot|slackbot|discordbot|twitterbot|linkedinbot|pinterest|redditbot|applebot|petalbot|bytespider|ahrefs|semrush|mj12|dotbot|curl\/|wget\/|python-requests|axios\/|go-http-client|headless|lighthouse|pingdom|uptimerobot|monitoring/i;

export function isBotAgent(userAgent: string | null | undefined): boolean {
  return Boolean(userAgent) && BOT_AGENT.test(userAgent!);
}

/**
 * 방문자 식별자.
 *
 * 예전에는 clientIp()로 묶었는데, TRUSTED_PROXY_HOPS가 0(기본값)이면 그 값이 모든 요청에서
 * "direct"라 전 세계 방문자가 한 버킷으로 묶였다 — 제품당 10분에 한 번만 세지고 있었다.
 * 프록시 설정에 기대지 않도록 우리 쿠키로 구분한다.
 */
export function visitorId(cookie: string | undefined): string {
  return cookie && /^[a-f0-9-]{8,64}$/i.test(cookie) ? cookie : crypto.randomUUID();
}

/**
 * 클릭 기록. 이미 센 클릭이면 조용히 넘긴다.
 *
 * 기록 실패가 이동을 막아서는 안 된다 — 지표는 부가물이고 사용자는 제품으로 가는 중이다.
 */
export async function recordClick(slug: string, visitor: string): Promise<void> {
  try {
    const hash = productVisitorHash(slug, visitor);
    if (!hash) {
      logger.warn("visit.hash_unavailable", { slug });
      return;
    }
    await markUniqueCollectionStarted();
    const fresh = await rateLimit(`visit:${slug}:${hash}`, 1, DEDUPE_MS);
    if (!fresh) return;
    await db.insert(clickEvents).values({ slug, visitorHash: hash });
  } catch {
    logger.warn("click.record_failed", { slug });
  }
}

async function markUniqueCollectionStarted(): Promise<void> {
  const dbNow = sql`timezone('UTC', now())`;
  await db
    .insert(visitCollectionState)
    .values({ id: 1, uniqueVisitorStartedAt: dbNow })
    .onConflictDoUpdate({
      target: visitCollectionState.id,
      set: {
        uniqueVisitorStartedAt: sql`coalesce(${visitCollectionState.uniqueVisitorStartedAt}, ${dbNow})`,
      },
    });
}

/** 창 안의 클릭 수 (지금부터 과거 windowMs 동안) */
export async function clicksSince(slug: string, windowMs: number, offsetMs = 0): Promise<number> {
  const end = new Date(Date.now() - offsetMs);
  const start = new Date(end.getTime() - windowMs);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clickEvents)
    .where(
      and(
        sql`${clickEvents.slug} = ${slug}`,
        gte(clickEvents.occurredAt, start),
        lt(clickEvents.occurredAt, end),
      ),
    );
  return row?.count ?? 0;
}

/** 목록이 함께 보여줄 지표 */
export type ClickMetricOptions = { windowHours: number; minimumPreviousClicks: number };
export type ClickMetrics = { clicks: number; changePercent: number | null };

/** 랭킹과 표시가 보는 창 */
export const METRICS_WINDOW_DAYS = 7;

/**
 * 여러 제품의 지표를 한 번에.
 *
 * 목록마다 제품 수만큼 쿼리를 돌리면 홈이 느려진다. 두 창(최근 24시간·그 이전 24시간)을
 * 한 쿼리에서 함께 센다.
 */
export async function clickMetrics(
  slugs: string[],
  options: ClickMetricOptions = { windowHours: 24, minimumPreviousClicks: 5 },
): Promise<Map<string, ClickMetrics>> {
  if (slugs.length === 0) return new Map();

  const currentTime = sql`timezone('UTC', now())`;
  const recentStart = sql`${currentTime} - ${options.windowHours} * interval '1 hour'`;
  const previousStart = sql`${currentTime} - ${options.windowHours * 2} * interval '1 hour'`;
  const metricsStart = sql`${currentTime} - ${METRICS_WINDOW_DAYS} * interval '1 day'`;
  const rows = await db
    .select({
      slug: clickEvents.slug,
      window: sql<number>`count(*) filter (where ${clickEvents.occurredAt} >= ${metricsStart})::int`,
      recent: sql<number>`count(*) filter (where ${clickEvents.occurredAt} >= ${recentStart})::int`,
      previous: sql<number>`count(*) filter (where ${clickEvents.occurredAt} >= ${previousStart} and ${clickEvents.occurredAt} < ${recentStart})::int`,
    })
    .from(clickEvents)
    .where(and(
      inArray(clickEvents.slug, slugs),
      gte(clickEvents.occurredAt, sql`least(${metricsStart}, ${previousStart})`),
      lt(clickEvents.occurredAt, currentTime),
    ))
    .groupBy(clickEvents.slug);

  return new Map(
    rows.map((r) => [
      r.slug,
      {
        clicks: r.window,
        changePercent: clickChangePercent(
          r.recent,
          r.previous,
          options.minimumPreviousClicks,
        ),
      },
    ]),
  );
}

export type VisitMetricOptions = {
  windowHours: number;
  minimumPreviousUniqueVisitors: number;
};

export type VisitMetrics = {
  validVisits: number;
  uniqueVisitors: number | null;
  uniqueChangePercent: number | null;
  collectionStartedAt: Date | null;
  collecting: boolean;
};

const visitSlugArrayEncoder: DriverValueEncoder<string[], string> = {
  mapToDriverValue(values) {
    return `{${values.map((value) => (
      `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    )).join(",")}}`;
  },
};

export function visitSlugPredicate(slugs: string[]): SQL {
  if (slugs.length === 0) return sql`false`;
  return sql`${clickEvents.slug} = any(${sql.param(slugs, visitSlugArrayEncoder)}::text[])`;
}

const DAILY_ROLLUP_WRITE_BATCH_SIZE = 1_000;

export function dailyRollupBatches<T>(rows: T[]): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < rows.length; start += DAILY_ROLLUP_WRITE_BATCH_SIZE) {
    batches.push(rows.slice(start, start + DAILY_ROLLUP_WRITE_BATCH_SIZE));
  }
  return batches;
}

type DailyRollupRow = {
  slug: string;
  day: string;
  clicks: number;
  uniqueVisitors: number;
};

type ClickTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ClickExecutor = typeof db | ClickTransaction;

async function upsertDailyRollups(
  executor: ClickExecutor,
  rows: DailyRollupRow[],
): Promise<void> {
  for (const batch of dailyRollupBatches(rows)) {
    await executor
      .insert(productClickDaily)
      .values(batch)
      .onConflictDoUpdate({
        target: [productClickDaily.slug, productClickDaily.day],
        set: {
          clicks: sql`excluded.clicks`,
          uniqueVisitors: sql`excluded.unique_visitors`,
        },
      });
  }
}

function kstDayStartDaysAgo(days: number): SQL {
  return sql`timezone(
    'UTC',
    (
      date_trunc('day', now() at time zone 'Asia/Seoul')
      - ${days} * interval '1 day'
    ) at time zone 'Asia/Seoul'
  )`;
}

/** 여러 제품의 유효 방문과 제품별 고유 방문자를 한 번에 센다. */
export async function visitMetrics(
  slugs: string[],
  options: VisitMetricOptions = {
    windowHours: 24,
    minimumPreviousUniqueVisitors: 5,
  },
): Promise<Map<string, VisitMetrics>> {
  if (slugs.length === 0) return new Map();

  const currentTime = sql`timezone('UTC', now())`;
  const recentStart = sql`${currentTime} - ${options.windowHours} * interval '1 hour'`;
  const previousStart = sql`${currentTime} - ${options.windowHours * 2} * interval '1 hour'`;
  const metricsStart = sql`${currentTime} - ${METRICS_WINDOW_DAYS} * interval '1 day'`;
  const rows = await db
    .select({
      slug: clickEvents.slug,
      collectionStartedAt: visitCollectionState.uniqueVisitorStartedAt,
      collecting: sql<boolean>`${visitCollectionState.uniqueVisitorStartedAt} is null
        or ${currentTime} < ${visitCollectionState.uniqueVisitorStartedAt} + ${METRICS_WINDOW_DAYS} * interval '1 day'`,
      validVisits: sql<number>`count(*) filter (
        where ${clickEvents.id} is not null
          and ${clickEvents.occurredAt} >= ${metricsStart}
      )::int`,
      uniqueVisitors: sql<number>`count(distinct ${clickEvents.visitorHash}) filter (
        where ${clickEvents.visitorHash} is not null
          and ${clickEvents.occurredAt} >= ${metricsStart}
      )::int`,
      recentUniqueVisitors: sql<number>`count(distinct ${clickEvents.visitorHash}) filter (
        where ${clickEvents.visitorHash} is not null
          and ${clickEvents.occurredAt} >= ${recentStart}
      )::int`,
      previousUniqueVisitors: sql<number>`count(distinct ${clickEvents.visitorHash}) filter (
        where ${clickEvents.visitorHash} is not null
          and ${clickEvents.occurredAt} >= ${previousStart}
          and ${clickEvents.occurredAt} < ${recentStart}
      )::int`,
    })
    .from(visitCollectionState)
    .leftJoin(clickEvents, and(
      visitSlugPredicate(slugs),
      gte(clickEvents.occurredAt, sql`least(${metricsStart}, ${previousStart})`),
      lt(clickEvents.occurredAt, currentTime),
    ))
    .where(eq(visitCollectionState.id, 1))
    .groupBy(visitCollectionState.uniqueVisitorStartedAt, clickEvents.slug);

  const state = rows[0];
  const collecting = state?.collecting ?? true;
  const collectionStartedAt = state?.collectionStartedAt ?? null;
  const metrics = new Map<string, VisitMetrics>(slugs.map((slug) => [slug, {
    validVisits: 0,
    uniqueVisitors: collecting ? null : 0,
    uniqueChangePercent: null,
    collectionStartedAt,
    collecting,
  }]));

  for (const row of rows) {
    if (!row.slug) continue;
    metrics.set(row.slug, {
      validVisits: row.validVisits,
      uniqueVisitors: row.collecting ? null : row.uniqueVisitors,
      uniqueChangePercent: row.collecting
        ? null
        : clickChangePercent(
          row.recentUniqueVisitors,
          row.previousUniqueVisitors,
          options.minimumPreviousUniqueVisitors,
        ),
      collectionStartedAt: row.collectionStartedAt,
      collecting: row.collecting,
    });
  }

  return metrics;
}

/**
 * 원천을 하루 단위로 굴린다.
 *
 * 최근 며칠을 매번 다시 계산해 덮어쓴다. 멱등이라 커서가 필요 없고, 잡이 몇 틱 걸러 돌아도
 * 빈 날이 생기지 않는다.
 */
export async function rollupDaily(days = 3): Promise<number> {
  const rows = await db
    .select({
      slug: clickEvents.slug,
      day: sql<string>`timezone('Asia/Seoul', ${clickEvents.occurredAt} AT TIME ZONE 'UTC')::date`,
      clicks: sql<number>`count(*)::int`,
      uniqueVisitors: sql<number>`count(distinct ${clickEvents.visitorHash}) filter (
        where ${clickEvents.visitorHash} is not null
      )::int`,
    })
    .from(clickEvents)
    .where(gte(
      clickEvents.occurredAt,
      kstDayStartDaysAgo(days),
    ))
    .groupBy(clickEvents.slug, sql`2`);

  if (rows.length === 0) return 0;
  await upsertDailyRollups(db, rows);
  return rows.length;
}

/**
 * 굴린 집계에서 많이 눌린 제품.
 *
 * 목록·랭킹은 원천(click_events)을 보지만 그쪽은 35일이면 지워진다. 오래된 구간을 답할 수
 * 있는 것은 이 표뿐이고, 읽는 데가 없으면 굴리는 일 자체가 의미가 없다.
 */
export async function topClickedSince(
  days: number,
  limit = 10,
  now = new Date(),
): Promise<{ slug: string; clicks: number }[]> {
  const instant = now.toISOString();
  return db
    .select({
      slug: productClickDaily.slug,
      clicks: sql<number>`sum(${productClickDaily.clicks})::int`,
    })
    .from(productClickDaily)
    .where(gte(
      productClickDaily.day,
      sql<string>`(timezone('Asia/Seoul', ${instant}::timestamptz)::date - ${days}::integer)`,
    ))
    .groupBy(productClickDaily.slug)
    .orderBy(sql`sum(${productClickDaily.clicks}) desc`)
    .limit(limit);
}

/** 오래된 원천을 일별 값으로 보존한 뒤 같은 트랜잭션에서 정리한다. */
export async function pruneEvents(olderThanDays = 35): Promise<void> {
  await db.transaction(async (tx) => {
    const [clock] = await tx
      .select({
        cutoff: kstDayStartDaysAgo(olderThanDays).mapWith(clickEvents.occurredAt),
      })
      .from(visitCollectionState)
      .where(eq(visitCollectionState.id, 1))
      .limit(1);
    if (!clock) return;

    const rows = await tx
      .select({
        slug: clickEvents.slug,
        day: sql<string>`timezone('Asia/Seoul', ${clickEvents.occurredAt} AT TIME ZONE 'UTC')::date`,
        clicks: sql<number>`count(*)::int`,
        uniqueVisitors: sql<number>`count(distinct ${clickEvents.visitorHash}) filter (
          where ${clickEvents.visitorHash} is not null
        )::int`,
      })
      .from(clickEvents)
      .where(lt(clickEvents.occurredAt, clock.cutoff))
      .groupBy(clickEvents.slug, sql`2`);

    if (rows.length === 0) return;
    await upsertDailyRollups(tx, rows);
    await tx
      .delete(clickEvents)
      .where(lt(clickEvents.occurredAt, clock.cutoff));
  });
}
