import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { crawlCandidates, crawlDocuments, crawlFrontier } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";

export type ReviewBacklogSnapshot = {
  recentNew: number;
  queuedRepositories: number;
  downstreamRepositories: number;
  timedOut?: boolean;
};
const WINDOW_MS = 5 * 60_000;
const READ_MS = 3_000;

/** Storage admission counts waiting repositories, not model slots or runnable votes.
 * Retries, manual work and in-flight collection remain counted. A repository that
 * occurs in several stages consumes one place. Terminal candidates consume none
 * unless new source collection is pending for them.
 */
export async function readReviewBacklogInTransaction(tx: ProductTransaction, now: Date | string,
  deadlineAt: number): Promise<ReviewBacklogSnapshot> {
  // Atomic admission passes PostgreSQL's full microsecond wall time. A JavaScript
  // Date would hide insertions in the current millisecond from the rate window.
  const wallTime = typeof now === 'string' ? now : now.toISOString();
  const remaining = Math.floor(deadlineAt - Date.now() - 50);
  if (remaining < 1) throw new Error("review_backlog_deadline");
  await tx.execute(sql`select set_config(name, (case when setting::bigint = 0 then ${remaining}
    else least(setting::bigint, ${remaining}) end)::text || 'ms', true)
    from pg_settings where name in ('statement_timeout', 'lock_timeout')`);
  const [row] = await tx.execute<ReviewBacklogSnapshot>(sql`
    with downstream as materialized (
      select lower(${crawlCandidates.repo}) as repo from ${crawlCandidates}
      where ${crawlCandidates.state} in ('new', 'approved', 'needs_review')
      union
      select lower(${crawlDocuments.repo}) from ${crawlDocuments}
      -- Most documents already have a byte-identical candidate. Remove those
      -- by byte equality before the indexed case-insensitive fallback;
      -- folding both complete histories made each admission read scan ~800k rows.
      where not exists (select 1 from ${crawlCandidates}
        where ${crawlCandidates.repo} = ${crawlDocuments.repo})
      and not exists (select 1 from ${crawlCandidates}
        where lower(${crawlCandidates.repo}) = lower(${crawlDocuments.repo}))
    ), queued as (
      select repo from downstream
      union
      select lower(${crawlFrontier.repo}) from ${crawlFrontier}
      where ${crawlFrontier.state} in ('pending', 'fetching') and ${crawlFrontier.aliasOf} is null
    )
    select (select count(*)::int from queued) as "queuedRepositories",
      (select count(*)::int from downstream) as "downstreamRepositories",
      (select count(*)::int from ${crawlFrontier}
        where ${crawlFrontier.discoveredAt} > ${wallTime}::timestamp - ${WINDOW_MS} * interval '1 millisecond'
          and ${crawlFrontier.discoveredAt} <= ${wallTime}::timestamp
          and ${crawlFrontier.aliasOf} is null
          and ${crawlFrontier.signal} not in ('review-source-refresh', 'star-auto-source-refresh', 'admin-evidence-refresh')) as "recentNew"
  `);
  if (Date.now() >= deadlineAt) throw new Error("review_backlog_deadline");
  if (!row || ![row.recentNew, row.queuedRepositories, row.downstreamRepositories].every(value => Number.isSafeInteger(value) && value >= 0)
    || row.downstreamRepositories > row.queuedRepositories) throw new Error("invalid_review_backlog_snapshot");
  return row;
}

function readTimedOut(error: unknown): boolean {
  for (let value = error, depth = 0; value && typeof value === "object" && depth < 5; depth++) {
    if (value instanceof Error && value.message === "review_backlog_deadline") return true;
    if ("code" in value && ["57014", "55P03", "DB_POOL_WAIT_TIMEOUT"].includes(String(value.code))) return true;
    value = "cause" in value ? value.cause : null;
  }
  return false;
}

/** One bounded, read-only transaction. Unknown depth cannot grant new capacity. */
export async function readReviewBacklog(now = new Date()): Promise<ReviewBacklogSnapshot> {
  const deadlineAt = Date.now() + READ_MS;
  try {
    return await withDbDeadline(deadlineAt, () => db.transaction(tx => readReviewBacklogInTransaction(tx, now, deadlineAt),
      { accessMode: "read only", isolationLevel: "repeatable read" }));
  } catch (error) {
    if (!readTimedOut(error)) throw error;
    return { recentNew: 0, queuedRepositories: 0, downstreamRepositories: 0, timedOut: true };
  }
}

export function reviewBacklogAdmission(snapshot: ReviewBacklogSnapshot, maxNewPerHour: number, maxReviewBacklog: number) {
  const remaining = snapshot.timedOut ? 0 : Math.max(0, maxReviewBacklog - snapshot.queuedRepositories);
  const rateRemaining = Math.max(0, Math.floor(maxNewPerHour * WINDOW_MS / 3_600_000) - snapshot.recentNew);
  return { throttled: remaining === 0, remainingNew: Math.min(remaining, rateRemaining) };
}
