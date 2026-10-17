import { z } from 'zod';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { STALE_LOCK_MS } from '@/lib/jobs/lease';
import { firstReviewer } from './agent-review';
import { prepareAgentReview } from './agent-review-preparation';
import { claimConsumerItemAgentReview, loadFirstReviewConsumerContext, observeAgentReviewItemDispatch,
  renewAgentReviewItemOwnership, recordAgentReview, recordConsumerSuspectedSpam } from './agent-review-repository';

export type FirstReviewConsumerOutcome = { state: 'skipped'; reason: string }
  | { applied: boolean; state: 'succeeded' | 'failed' | 'superseded' };

/** Model-free item lane. Fresh model admission rolls back inside the fixed claim. */
export async function executeFirstReviewConsumerItem(input: {
  candidateId: number; owner: ItemOwner; signal?: AbortSignal;
}): Promise<FirstReviewConsumerOutcome> {
  const candidateId = z.number().int().positive().safe().parse(input.candidateId);
  const owner = itemOwnerSchema.parse(input.owner), { signal } = input;
  if (signal?.aborted) return { state: 'skipped', reason: 'aborted' };
  const loaded = await loadFirstReviewConsumerContext(candidateId);
  if (loaded.kind === 'skipped') return { state: 'skipped', reason: loaded.reason };
  const context = loaded.context;
  const reviewer = firstReviewer(context.settings);
  if (!reviewer) throw new Error('1차 심사자를 설정하거나 CRAWL_REVIEW_MODEL 을 넣어야 AI 심사를 켤 수 있습니다');
  const prepared = await prepareAgentReview(context, reviewer);
  if (signal?.aborted) return { state: 'skipped', reason: 'aborted' };
  const claim = await claimConsumerItemAgentReview({ ...context, owner, ttlMs: STALE_LOCK_MS,
    provider: prepared.provider, model: prepared.model });
  if (claim.kind === 'skipped') return { state: 'skipped', reason: claim.reason };
  if (claim.receipt.ownership.kind !== 'item') throw new Error('invalid_first_review_consumer_claim');
  const receipt = claim.receipt;
  const cancelled = () => recordAgentReview({ ...context, receipt, error: 'cancelled' });
  let stopping = false, lost = false, cancelDelay: (() => void) | undefined, renewalFailure: { error: unknown } | undefined;
  const heartbeat = (async () => {
    while (!stopping) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15_000);
        cancelDelay = () => { clearTimeout(timer); resolve(); };
      });
      cancelDelay = undefined;
      if (stopping) return;
      try {
        if (!await renewAgentReviewItemOwnership(context, receipt, STALE_LOCK_MS)) { lost = true; return; }
      } catch (error) { renewalFailure = { error }; return; }
    }
  })();
  let current = false;
  try {
    current = (await observeAgentReviewItemDispatch(context, receipt)).kind === 'current';
    if (claim.kind !== 'reused' && prepared.provider !== 'rules') throw new Error('unsupported_first_review_item_dispatch');
  } finally {
    stopping = true; cancelDelay?.(); await heartbeat;
  }
  if (renewalFailure) throw renewalFailure.error;
  if (!current || lost || signal?.aborted) return cancelled();
  if (prepared.spam) return recordConsumerSuspectedSpam({ ...context, receipt });
  return recordAgentReview({ ...context, receipt, outcome: prepared.outcome ?? claim.attempt.outcome ?? undefined,
    ...(prepared.ruleRejection ? { ruleRejection: prepared.ruleRejection } : {}) });
}
