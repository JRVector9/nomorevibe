import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { secondReviews } from '@/lib/db/schema';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { interruptibleSleep, type RuntimeReport } from '@/scripts/worker';
import { executeSecondReviewConsumerItem } from '../second-review-item-lifecycle';

const PAGE_SIZE = 24, MAX_PAGES = 4, IDLE_MS = 5_000;
type Cursor = { id: number; fallback: boolean };

/** Hints only. The fixed lifecycle rechecks stage, current domain and ownership. */
async function hints(cursor: Cursor | null) {
  const fallback = sql<boolean>`${secondReviews.fallbackForId} IS NOT NULL`;
  return onPrimary(() => db.select({ id: secondReviews.id, fallback }).from(secondReviews)
    .where(and(eq(secondReviews.status, 'pending'), cursor ? or(
      and(eq(fallback, cursor.fallback), gt(secondReviews.id, cursor.id)),
      cursor.fallback ? isNull(secondReviews.fallbackForId) : undefined,
    ) : undefined)).orderBy(desc(fallback), secondReviews.id).limit(PAGE_SIZE));
}

export async function runSecondReviewConsumer(input: {
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
      cursor = { id: hint.id, fallback: hint.fallback };
      result.attempted++;
      report?.('running', 'second-review', Date.now());
      try {
        // One awaited lane; neither pool ownership nor HTTP crosses the hint query.
        const written = await executeSecondReviewConsumerItem({ secondReviewId: hint.id, owner, signal });
        if (written.state === 'recorded') { result.recorded++; completed = true; }
        else result.skipped++;
      } catch (error) {
        if (!(error instanceof ModelCapacityDeferredError)) throw error;
        result.deferred++; deferred = true;
        break;
      } finally { report?.('idle'); }
    }
    pages++;
    const end = queue.length < PAGE_SIZE;
    if (end && !deferred && !completed) cursor = null;
    if (signal?.aborted || once && (end || deferred || pages >= MAX_PAGES)) break;
    if (completed && !once) pages = 0;
    // Bound scans even when every pending row remains busy. Keep the keyset
    // across this backoff so low IDs cannot monopolize every pass.
    if (end && !completed || deferred || pages >= MAX_PAGES) {
      report?.('idle');
      await interruptibleSleep(IDLE_MS, signal);
      pages = 0;
    }
  }
  return result;
}
