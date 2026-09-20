import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { searchQueries } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { normalizeQuery } from "./search-translation";

/**
 * 검색 질의 기록.
 *
 * 무엇을 찾다가 못 찾았는지가 남아야 다음 수를 고를 수 있다 — 색인을 고칠지, 낱말을 더 넣을지,
 * 벡터 검색까지 갈지. 지금은 "한국어 질의가 0건"이라는 것을 사람이 손으로 쳐 보고 알았다.
 *
 * 기록은 검색을 막지 않는다. 응답을 보낸 뒤에 적고(after), 적다가 실패해도 검색은 그대로다.
 */

/** 기록을 남기는 최대 길이 — 화면이 받는 길이와 같다 */
const MAX_QUERY = 200;

export async function recordSearch(entry: {
  query: string; keywords: string | null; results: number; filtered: boolean;
  /** 이 화면을 만들기 시작한 때. 걸린 시간은 여기서 잰다 — 부르는 쪽(렌더)은 시계를 읽지 않는다 */
  startedAt: Date;
}): Promise<void> {
  const query = entry.query.trim().slice(0, MAX_QUERY);
  if (!query) return;
  const durationMs = Date.now() - entry.startedAt.getTime();
  try {
    await db.insert(searchQueries).values({
      query,
      normalized: normalizeQuery(query).slice(0, MAX_QUERY),
      keywords: entry.keywords?.slice(0, MAX_QUERY) ?? null,
      results: Math.max(0, Math.trunc(entry.results)),
      filtered: entry.filtered,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.trunc(durationMs)) : null,
    });
  } catch (error) {
    // 기록을 못 남겼다고 검색이 실패하면 안 된다
    logger.warn("search.log_failed", { error });
  }
}

/** 오래된 기록은 지운다. 며칠짜리 흐름을 보는 표라 영원히 둘 이유가 없다 */
export async function pruneSearchQueries(days = 90): Promise<number> {
  const result = await db.delete(searchQueries)
    .where(sql`${searchQueries.searchedAt} < now() - make_interval(days => ${days})`)
    .returning({ id: searchQueries.id });
  return result.length;
}

export type SearchLogSummary = {
  days: number;
  searches: number;
  zero: number;
  translated: number;
  p95Ms: number | null;
  /** 못 찾은 말 — 같은 말을 묶어 잦은 순으로 */
  misses: { query: string; count: number; keywords: string | null }[];
  /** 찾은 말 중 잦은 것 — 무엇을 보러 오는지 */
  hits: { query: string; count: number; results: number }[];
};

/**
 * 며칠치 요약. 운영센터가 이것만 보고도 "무엇이 여전히 안 찾아지나"에 답할 수 있어야 한다.
 *
 * 거르기가 걸려 0건이던 것은 못 찾은 말에서 뺀다 — 말이 안 통한 것이 아니라 사용자가 좁힌 것이다.
 */
export async function searchLogSummary(days = 7, limit = 10): Promise<SearchLogSummary> {
  const window = sql`${searchQueries.searchedAt} > now() - make_interval(days => ${days})`;
  const [totals] = await db.select({
    searches: sql<number>`count(*)::int`,
    zero: sql<number>`count(*) filter (where ${searchQueries.results} = 0)::int`,
    translated: sql<number>`count(*) filter (where ${searchQueries.keywords} is not null)::int`,
    p95: sql<number | null>`percentile_disc(0.95) within group (order by ${searchQueries.durationMs})`,
  }).from(searchQueries).where(window);

  const misses = await db.select({
    query: sql<string>`min(${searchQueries.query})`,
    count: sql<number>`count(*)::int`,
    keywords: sql<string | null>`max(${searchQueries.keywords})`,
  }).from(searchQueries)
    .where(sql`${window} and ${searchQueries.results} = 0 and not ${searchQueries.filtered}`)
    .groupBy(searchQueries.normalized)
    .orderBy(sql`count(*) desc, min(${searchQueries.query})`)
    .limit(limit);

  const hits = await db.select({
    query: sql<string>`min(${searchQueries.query})`,
    count: sql<number>`count(*)::int`,
    results: sql<number>`max(${searchQueries.results})::int`,
  }).from(searchQueries)
    .where(sql`${window} and ${searchQueries.results} > 0`)
    .groupBy(searchQueries.normalized)
    .orderBy(sql`count(*) desc, min(${searchQueries.query})`)
    .limit(limit);

  return {
    days,
    searches: Number(totals?.searches ?? 0),
    zero: Number(totals?.zero ?? 0),
    translated: Number(totals?.translated ?? 0),
    p95Ms: totals?.p95 === null || totals?.p95 === undefined ? null : Number(totals.p95),
    misses: misses.map((row) => ({ query: row.query, count: Number(row.count), keywords: row.keywords })),
    hits: hits.map((row) => ({ query: row.query, count: Number(row.count), results: Number(row.results) })),
  };
}
