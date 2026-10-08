import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts, crawlTaglines } from "@/lib/db/schema";
import { HUMAN_ONLY_REASONS, reviewQueueAiDecisions } from "./admin-review";
import { secondReviewSummary } from "./second-review";
import type { CrawlSettings } from "./settings-schema";
import { buildHumanQueueOverview, type HumanQueueOverview } from "./human-queue";

/**
 * 심사 큐 머리의 숫자 — 사람이 오늘 얼마나 처리했고, 쌓인 것이 얼마나 오래됐는가.
 *
 * 시각은 publicationChange24h 와 같은 DB 시계(UTC)로 잰다. 시각 열은 시간대 없이 UTC 로 저장된다
 * (overrideCandidate·judge 가 JS Date 를 쓴다) — 노드 시계로 빼면 서버 시간대만큼 밀린다.
 */
const clock = (now?: Date) => now ? sql`${now.toISOString()}::timestamp` : sql`(current_timestamp at time zone 'UTC')`;

/**
 * 사람이 최근 24시간에 내린 결정. 한 건씩·일괄 모두 overrideCandidate 를 거쳐 admin_override 행으로 남는다.
 * 되돌린 결정(undoAdminDecision 이 superseded 로 닫는다)은 세지 않는다.
 */
export async function humanDecisions24h(now?: Date): Promise<{ approve: number; reject: number }> {
  const end = clock(now);
  const [row] = await db.select({
    approve: sql<number>`count(*) filter (where ${crawlReviewAttempts.outcome}->>'decision' = 'approve')::int`,
    reject: sql<number>`count(*) filter (where ${crawlReviewAttempts.outcome}->>'decision' = 'reject')::int`,
  }).from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.kind, "admin_override"), eq(crawlReviewAttempts.state, "succeeded"),
    sql`${crawlReviewAttempts.startedAt} > ${end} - interval '24 hours'`, sql`${crawlReviewAttempts.startedAt} <= ${end}`));
  return { approve: row?.approve ?? 0, reject: row?.reject ?? 0 };
}

/**
 * 구간에 선 후보들이 얼마나 기다렸나 — 가장 오래된 것의 날수, 2주 넘은 수, 최근 24시간에 들어온 수.
 * 대기는 상세의 waitingDays 와 같은 기준(판정 시각, 없으면 갱신 시각 — human-queue.ts WAIT_REFERENCE)이다.
 */
export async function waitingAge(ids: number[], now?: Date): Promise<{ oldestDays: number | null; new24h: number; stalled: number }> {
  if (ids.length === 0) return { oldestDays: null, new24h: 0, stalled: 0 };
  const end = clock(now);
  const at = sql`coalesce(${crawlCandidates.judgedAt}, ${crawlCandidates.updatedAt})`;
  const [row] = await db.select({
    oldestDays: sql<number | null>`floor(extract(epoch from (${end} - min(${at}))) / 86400)::int`,
    new24h: sql<number>`count(*) filter (where ${at} > ${end} - interval '24 hours')::int`,
    stalled: sql<number>`count(*) filter (where ${at} < ${end} - interval '14 days')::int`,
  }).from(crawlCandidates).where(inArray(crawlCandidates.id, ids));
  return { oldestDays: row?.oldestDays ?? null, new24h: row?.new24h ?? 0, stalled: row?.stalled ?? 0 };
}

/** 사람만 가르는 사유로 보류된 후보 — 사유 목록(HUMAN_ONLY_REASONS)이 늘면 그대로 따라 센다 */
export async function humanOnlyCandidateIds(): Promise<number[]> {
  const rows = await db.select({ id: crawlCandidates.id }).from(crawlCandidates)
    .where(and(eq(crawlCandidates.state, "needs_review"), inArray(crawlCandidates.reason, [...HUMAN_ONLY_REASONS])));
  return rows.map((row) => row.id);
}

/**
 * 운영센터와 심사 큐가 함께 그리는 "사람이 볼 것"(human-queue.ts) — 두 화면은 이 함수 하나만 부른다.
 * 갈래 셈(reviewQueueCauses)처럼 원본을 다시 판정하지 않으므로 싸다. 나이·결정 수는 못 읽어도 나머지는 그린다.
 */
export async function humanQueueOverview(settings: CrawlSettings, now?: Date): Promise<HumanQueueOverview> {
  const [aiDecisions, seconds, humanOnly, decided24h] = await Promise.all([
    reviewQueueAiDecisions(), secondReviewSummary(settings.secondReview.agreeAt), humanOnlyCandidateIds(),
    humanDecisions24h(now).catch(() => null),
  ]);
  const overview = buildHumanQueueOverview({ aiDecisions, seconds, humanOnly, wait: null, decided24h });
  const age = await waitingAge(overview.ids.human, now).catch(() => null);
  return { ...overview, wait: age && { oldestDays: age.oldestDays, stalled: age.stalled, in24h: age.new24h } };
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
