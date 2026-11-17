import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type ReviewHoldCounts = { holds: { reason: string; count: number; recent24h: number }[]; rejected: number };

/**
 * Only the attempt actually applied to the candidate identifies an AI hold: an
 * unlinked observe-mode verdict must not turn a rule hold into an AI hold.
 * candidate_id leads crawl_review_input_idx; the applied attempt uses its PK.
 * Repeated verdicts in the same bucket keep the earliest successful hold time.
 * Rule-only candidates have judged_at (the rule attempt), not a hold history.
 * Missing timestamps stay out of the recent count; updated_at is never evidence.
 * Rejected candidates are counted separately, without probing attempt history.
 */
export function reviewHoldCountsQuery() {
  return sql`
    SELECT 'needs_review' AS state,
      CASE WHEN c.reason = 'ambiguous' AND applied.kind = 'automatic'
        AND applied.provider IS NOT NULL AND applied.provider <> 'rules'
        THEN 'ai_first_ambiguous' ELSE coalesce(c.reason, 'unknown') END AS reason,
      count(*)::int AS count,
      count(*) FILTER (WHERE coalesce(first_hold.completed_at, applied.completed_at, c.judged_at)
        > now() - interval '24 hours')::int AS recent
    FROM crawl_candidates c
    LEFT JOIN crawl_review_attempts applied ON applied.id = CASE
      WHEN c.signals->>'agentReviewAttemptId' ~ '^[0-9]{1,10}$'
        THEN (c.signals->>'agentReviewAttemptId')::bigint END
      AND applied.candidate_id = c.id AND applied.state = 'succeeded'
      AND applied.outcome->>'decision' = 'needs_review'
      AND c.reason IN ('ambiguous', 'suspected_spam')
    LEFT JOIN LATERAL (
      SELECT min(a.completed_at) AS completed_at FROM crawl_review_attempts a
      WHERE applied.id IS NOT NULL AND a.candidate_id = c.id AND a.kind = applied.kind AND a.state = 'succeeded'
        AND (a.provider = 'rules') IS NOT DISTINCT FROM (applied.provider = 'rules')
        AND a.outcome->>'decision' = 'needs_review' AND a.id <= applied.id
    ) first_hold ON applied.id IS NOT NULL
    WHERE c.state = 'needs_review'
    GROUP BY 2
    UNION ALL
    SELECT 'rejected', 'unknown', count(*)::int, 0 FROM crawl_candidates WHERE state = 'rejected'`;
}

export async function readHoldCounts(): Promise<ReviewHoldCounts> {
  const rows = await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return tx.execute<{ state: string; reason: string; count: number; recent: number }>(reviewHoldCountsQuery());
  }, { accessMode: "read only" });
  return {
    holds: [...rows].filter(row => row.state === "needs_review")
      .map(row => ({ reason: row.reason, count: Number(row.count), recent24h: Number(row.recent) })),
    rejected: [...rows].filter(row => row.state === "rejected").reduce((total, row) => total + Number(row.count), 0),
  };
}
