import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, newsItems, type NewsState } from "@/lib/db/schema";
import type { NewsCandidate } from "./normalize";
import { HOME_NEWS_SOURCE_KEYS, NEWS_SOURCES, newsSource, type NewsSection, type NewsTone } from "./sources";

export const NEWS_JOB = "news-refresh";

/**
 * 모은 글을 넣는다. 이미 있는 주소는 건드리지 않는다 — 관리자가 숨긴 글이 다시 수집돼도
 * 되살아나지 않고, 승인한 글의 결정도 그대로다.
 *
 * 자동 승인이 켜져 있으면 곧바로 공개, 꺼져 있으면 승인 대기로 들어간다.
 */
export async function insertNewsItems(candidates: NewsCandidate[], autoApprove: boolean): Promise<number> {
  const unique = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
  if (!unique.length) return 0;
  const inserted = await db
    .insert(newsItems)
    .values(unique.map((candidate) => ({ ...candidate, state: autoApprove ? "approved" : "pending", decidedBy: "auto" }) as const))
    .onConflictDoNothing({ target: newsItems.url })
    .returning({ id: newsItems.id });
  return inserted.length;
}

export type HomeNewsItem = {
  url: string;
  title: string;
  publishedAt: Date;
  source: string;
  vendor: string;
  label: string;
  tone: "dark" | "mint" | "peach";
};

/**
 * 홈 카드에 오를 공개 글. 회사마다 가장 최근 것 하나씩 — 한 회사가 여러 출처를 가져도
 * (Google은 셋) 카드를 혼자 차지하지 않는다. 코딩 도구 릴리스는 오르지 않는다.
 */
export async function listHomeNews(limit = 3): Promise<HomeNewsItem[]> {
  const rows = await db
    .select({ sourceKey: newsItems.sourceKey, url: newsItems.url, title: newsItems.title, publishedAt: newsItems.publishedAt })
    .from(newsItems)
    .where(and(eq(newsItems.state, "approved"), inArray(newsItems.sourceKey, [...HOME_NEWS_SOURCE_KEYS])))
    .orderBy(desc(newsItems.publishedAt), desc(newsItems.id))
    .limit(60);
  const vendors = new Set<string>();
  const picked: HomeNewsItem[] = [];
  for (const row of rows) {
    const source = newsSource(row.sourceKey);
    if (!source || vendors.has(source.vendor)) continue;
    vendors.add(source.vendor);
    picked.push({ url: row.url, title: row.title, publishedAt: row.publishedAt, source: source.name, vendor: source.vendor, label: source.label, tone: source.tone });
    if (picked.length === limit) break;
  }
  return picked;
}

export type PublicNewsItem = {
  id: number;
  url: string;
  title: string;
  summary: string | null;
  publishedAt: Date;
  sourceKey: string;
  source: string;
  vendor: string;
  label: string;
  tone: NewsTone;
  section: NewsSection;
};

/** 소식 페이지·피드의 거르기. 비우면 전체 */
export type NewsFilter = { vendor?: string; section?: NewsSection };

function sourceKeysFor(filter: NewsFilter): string[] {
  return NEWS_SOURCES
    .filter((source) => (!filter.vendor || source.vendor === filter.vendor) && (!filter.section || source.section === filter.section))
    .map((source) => source.key);
}

/** 공개 글을 최신부터. 한 건 더 읽어 다음 쪽이 있는지 안다 */
export async function listPublicNews(filter: NewsFilter, limit: number, offset = 0): Promise<{ items: PublicNewsItem[]; hasMore: boolean }> {
  const keys = sourceKeysFor(filter);
  if (!keys.length) return { items: [], hasMore: false };
  const rows = await db
    .select({ id: newsItems.id, url: newsItems.url, title: newsItems.title, summary: newsItems.summary, publishedAt: newsItems.publishedAt, sourceKey: newsItems.sourceKey })
    .from(newsItems)
    .where(and(eq(newsItems.state, "approved"), inArray(newsItems.sourceKey, keys)))
    .orderBy(desc(newsItems.publishedAt), desc(newsItems.id))
    .limit(limit + 1)
    .offset(offset);
  const items = rows.slice(0, limit).flatMap((row) => {
    const source = newsSource(row.sourceKey);
    return source
      ? [{ ...row, source: source.name, vendor: source.vendor, label: source.label, tone: source.tone, section: source.section }]
      : [];
  });
  return { items, hasMore: rows.length > limit };
}

/** 회사별 공개 글 수 — 필터 칩에 붙인다 */
export async function publicNewsCountsByVendor(section?: NewsSection): Promise<Map<string, number>> {
  const rows = await db
    .select({ sourceKey: newsItems.sourceKey, count: sql<number>`count(*)::int` })
    .from(newsItems)
    .where(and(eq(newsItems.state, "approved"), inArray(newsItems.sourceKey, sourceKeysFor({ section }))))
    .groupBy(newsItems.sourceKey);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const vendor = newsSource(row.sourceKey)?.vendor;
    if (vendor) counts.set(vendor, (counts.get(vendor) ?? 0) + row.count);
  }
  return counts;
}

export async function listNewsForAdmin(state: NewsState | "all", limit = 200) {
  return db
    .select()
    .from(newsItems)
    .where(state === "all" ? undefined : eq(newsItems.state, state))
    .orderBy(desc(newsItems.publishedAt), desc(newsItems.id))
    .limit(limit);
}

export async function countNewsByState(): Promise<Record<NewsState, number>> {
  const rows = await db
    .select({ state: newsItems.state, count: sql<number>`count(*)::int` })
    .from(newsItems)
    .groupBy(newsItems.state);
  const counts: Record<NewsState, number> = { approved: 0, pending: 0, hidden: 0 };
  for (const row of rows) counts[row.state] = row.count;
  return counts;
}

export async function setNewsState(ids: number[], state: NewsState, actor: string): Promise<number> {
  if (!ids.length) return 0;
  const updated = await db
    .update(newsItems)
    .set({ state, decidedBy: actor, decidedAt: new Date() })
    .where(inArray(newsItems.id, ids))
    .returning({ id: newsItems.id });
  return updated.length;
}

/** 출처별 마지막 수집 결과 — 수집 잡의 커서에 남는다 */
export async function newsJobState() {
  const [row] = await db
    .select({ cursor: jobs.cursor, lastRunAt: jobs.lastRunAt, lastError: jobs.lastError })
    .from(jobs)
    .where(eq(jobs.name, NEWS_JOB))
    .limit(1);
  return row ?? null;
}
