import "server-only";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { secondReviews } from "@/lib/db/schema";
import { translationsFor } from "./translations";
import type { PublishedSecondRow } from "@/app/(operator)/admin/review/PublishedSecondReviews";
import { encodePublishedReviewCursor, publishedReviewCursorPredicate, type PublishedReviewCursor } from "./published-review-cursor";

export const PUBLISHED_REVIEW_PAGE_SIZE = 30;
export const publishedReviewPriority = sql<number>`case ${secondReviews.autoOpinion}->>'decision' when 'reject' then 0 when 'needs_review' then 1 else 2 end`;
/** position() preserves the old literal substring match, including % and _, without wildcard interpretation. */
export const publishedReviewMembership = (q = "") => and(eq(secondReviews.status, "needs_human"), isNotNull(secondReviews.publishedSlug),
  q.trim() ? sql`position(lower(${q.trim()}) in lower(coalesce(${secondReviews.publishedSlug}, '') || ' ' || ${secondReviews.repo} || ' ' || coalesce(${secondReviews.secondReason}, ''))) > 0` : undefined);
const columns = { priority: publishedReviewPriority, at: sql`${secondReviews.reviewedAt}`, id: sql`${secondReviews.id}` };
export function publishedReviewPageAfter(after?: PublishedReviewCursor, q = "") {
  return and(publishedReviewMembership(q), after ? publishedReviewCursorPredicate(after, columns) : undefined);
}
export type PublishedReviewPage = { rows: PublishedSecondRow[]; total: number; nextCursor: string | null };

/** Only one page of public recheck decisions and their translations is serialized to the client. */
export async function readPublishedReviewPage(after?: PublishedReviewCursor, q = ""): Promise<PublishedReviewPage> {
  const { rows, total } = await onReplica(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    const rows = await tx.select({ id: secondReviews.id, slug: secondReviews.publishedSlug, repo: secondReviews.repo,
      decision: secondReviews.secondDecision, confidence: secondReviews.secondConfidence, reason: secondReviews.secondReason,
      trigger: secondReviews.trigger, signals: secondReviews.signals, autoOpinion: secondReviews.autoOpinion,
      priority: publishedReviewPriority, rawReviewedAt: sql<string | null>`${secondReviews.reviewedAt}::text`,
    }).from(secondReviews).where(publishedReviewPageAfter(after, q))
      .orderBy(publishedReviewPriority, sql`${secondReviews.reviewedAt} DESC NULLS LAST`, sql`${secondReviews.id} DESC`).limit(PUBLISHED_REVIEW_PAGE_SIZE + 1);
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(secondReviews).where(publishedReviewMembership(q));
    return { rows, total: count.total };
  }, { accessMode: "read only", isolationLevel: "repeatable read" }));
  const shown = rows.slice(0, PUBLISHED_REVIEW_PAGE_SIZE), last = shown.at(-1);
  const korean = await onReplica(() => translationsFor(shown.flatMap(row => [row.reason, row.autoOpinion?.reason ?? null])));
  return { total, nextCursor: rows.length > PUBLISHED_REVIEW_PAGE_SIZE && last
    ? encodePublishedReviewCursor({ priority: last.priority, at: last.rawReviewedAt, id: last.id }, q) : null,
    rows: shown.map(row => ({ id: row.id, slug: row.slug ?? "", repo: row.repo, decision: row.decision,
      confidence: row.confidence, reason: row.reason, reasonKo: row.reason ? korean.get(row.reason) ?? null : null,
      trigger: row.trigger, signals: row.signals, qwen: row.autoOpinion ? { decision: row.autoOpinion.decision,
        confidence: row.autoOpinion.confidence, reason: row.autoOpinion.reason,
        reasonKo: row.autoOpinion.reason ? korean.get(row.autoOpinion.reason) ?? null : null } : null })) };
}
