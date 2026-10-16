import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { crawlCandidates, crawlReviewAttempts } from '@/lib/db/schema';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { interruptibleSleep, type RuntimeReport } from '@/scripts/worker';
import { getSettings } from '../settings';
import { reviewCandidatePredicate } from '../agent-review-repository';
import { executeFirstReviewConsumerItem } from '../agent-review-item-lifecycle';

const PAGE_SIZE = 24, MAX_PAGES = 4, IDLE_MS = 5_000;
type Cursor = { id: number; reviewed: boolean; updatedAt: string; ceiling: number };
/** Fixed bounded hints; only the actual claim/writer can grant authority. */
async function hints(cursor: Cursor | null) {
  return onPrimary(async () => {
    const settings = await getSettings();
    const reviewed = sql<boolean>`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} seen
      WHERE seen.candidate_id = ${crawlCandidates.id} AND seen.state = 'succeeded')`;
    const ceiling = cursor ? sql<number>`${cursor.ceiling}::integer` : sql<number>`(SELECT coalesce(max(id), 0) FROM ${crawlCandidates})`;
    return db.select({ id: crawlCandidates.id, reviewed, updatedAt: sql<string>`${crawlCandidates.updatedAt}::text`, ceiling })
      .from(crawlCandidates).where(and(reviewCandidatePredicate(settings, { readyOnly: true }),
        cursor ? lte(crawlCandidates.id, cursor.ceiling) : undefined,
        cursor ? or(gt(reviewed, cursor.reviewed), and(eq(reviewed, cursor.reviewed), or(
          sql`${crawlCandidates.updatedAt} > (${cursor.updatedAt}::text)::timestamp`,
          and(sql`${crawlCandidates.updatedAt} = (${cursor.updatedAt}::text)::timestamp`, gt(crawlCandidates.id, cursor.id)),
        ))) : undefined)).orderBy(asc(reviewed), asc(crawlCandidates.updatedAt), asc(crawlCandidates.id)).limit(PAGE_SIZE);
  });
}
export async function runFirstReviewConsumer(input: {
  owner: ItemOwner; signal?: AbortSignal; once?: boolean; report?: RuntimeReport;
}): Promise<{ attempted: number; recorded: number; skipped: number; deferred: number }> {
  const owner = itemOwnerSchema.parse(input.owner), { signal, once, report } = input;
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const result = { attempted: 0, recorded: 0, skipped: 0, deferred: 0 };
  let cursor: Cursor | null = null, pages = 0;
  while (!signal?.aborted) {
    report?.('polling');
    const queue = await hints(cursor);
    let deferred = false, completed = false;
    for (const hint of queue) {
      if (signal?.aborted) break;
      cursor = hint;
      result.attempted++; report?.('running', 'crawl-agent-review', Date.now());
      try {
        const written = await executeFirstReviewConsumerItem({ candidateId: hint.id, owner, signal });
        if (written.state === 'succeeded') { result.recorded++; completed = true; }
        else result.skipped++;
      } catch (error) {
        if (!(error instanceof ModelCapacityDeferredError)) throw error;
        result.deferred++; deferred = true; break;
      } finally { report?.('idle'); }
    }
    pages++;
    const end = queue.length < PAGE_SIZE;
    if (end && !deferred && !completed) cursor = null;
    if (signal?.aborted || once && (end || deferred || pages >= MAX_PAGES)) break;
    if (completed && !once) pages = 0;
    if (end && !completed || deferred || pages >= MAX_PAGES) {
      report?.('idle'); await interruptibleSleep(IDLE_MS, signal); pages = 0;
    }
  }
  return result;
}
