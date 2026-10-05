import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts, crawlTaglines } from "@/lib/db/schema";

/**
 * 심사 큐 머리의 숫자 — 사람이 오늘 얼마나 처리했고, 쌓인 것이 얼마나 오래됐는가.
 *
 * 시각은 publicationChange24h 와 같은 DB 시계(UTC)로 잰다. 시각 열은 시간대 없이 UTC 로 저장된다
 * (overrideCandidate·judge 가 JS Date 를 쓴다) — 노드 시계로 빼면 서버 시간대만큼 밀린다.
 */
const clock = (now?: Date) => now ? sql`${now.toISOString()}::timestamp` : sql`(current_timestamp at time zone 'UTC')`;

/** 사람이 최근 24시간에 내린 결정. 한 건씩·일괄 모두 overrideCandidate 를 거쳐 admin_override 행으로 남는다 */
export async function humanDecisions24h(now?: Date): Promise<{ approve: number; reject: number }> {
  const end = clock(now);
  const [row] = await db.select({
    approve: sql<number>`count(*) filter (where ${crawlReviewAttempts.outcome}->>'decision' = 'approve')::int`,
    reject: sql<number>`count(*) filter (where ${crawlReviewAttempts.outcome}->>'decision' = 'reject')::int`,
  }).from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.kind, "admin_override"),
    sql`${crawlReviewAttempts.startedAt} > ${end} - interval '24 hours'`, sql`${crawlReviewAttempts.startedAt} <= ${end}`));
  return { approve: row?.approve ?? 0, reject: row?.reject ?? 0 };
}

/**
 * 구간에 선 후보들이 얼마나 기다렸나 — 가장 오래된 것의 날수와 최근 24시간에 들어온 수.
 * 대기는 상세의 waitingDays 와 같은 기준(판정 시각, 없으면 갱신 시각)이다.
 */
export async function waitingAge(ids: number[], now?: Date): Promise<{ oldestDays: number | null; new24h: number }> {
  if (ids.length === 0) return { oldestDays: null, new24h: 0 };
  const end = clock(now);
  const at = sql`coalesce(${crawlCandidates.judgedAt}, ${crawlCandidates.updatedAt})`;
  const [row] = await db.select({
    oldestDays: sql<number | null>`floor(extract(epoch from (${end} - min(${at}))) / 86400)::int`,
    new24h: sql<number>`count(*) filter (where ${at} > ${end} - interval '24 hours')::int`,
  }).from(crawlCandidates).where(inArray(crawlCandidates.id, ids));
  return { oldestDays: row?.oldestDays ?? null, new24h: row?.new24h ?? 0 };
}

/**
 * 소개가 없어 멈춘 후보에 AI 가 한 줄을 지었는가(crawl-tagline 잡). 상세의 "AI 한 줄 소개" 칸과 같은 갈래다 —
 * 지음 · 근거로는 모름 · 게이트웨이 실패 · 아직 시도 전.
 */
export async function taglineProgress(ids: number[]): Promise<{ written: number; unknown: number; failed: number; untried: number }> {
  if (ids.length === 0) return { written: 0, unknown: 0, failed: 0, untried: 0 };
  const [row] = await db.select({
    written: sql<number>`count(*) filter (where ${crawlTaglines.tagline} <> '')::int`,
    unknown: sql<number>`count(*) filter (where ${crawlTaglines.repo} is not null and ${crawlTaglines.tagline} = '' and ${crawlTaglines.errorCode} is null)::int`,
    failed: sql<number>`count(*) filter (where ${crawlTaglines.repo} is not null and ${crawlTaglines.tagline} = '' and ${crawlTaglines.errorCode} is not null)::int`,
    untried: sql<number>`count(*) filter (where ${crawlTaglines.repo} is null)::int`,
  }).from(crawlCandidates).leftJoin(crawlTaglines, eq(crawlTaglines.repo, crawlCandidates.repo))
    .where(inArray(crawlCandidates.id, ids));
  return { written: row?.written ?? 0, unknown: row?.unknown ?? 0, failed: row?.failed ?? 0, untried: row?.untried ?? 0 };
}
