import { z } from 'zod';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { STALE_LOCK_MS } from '@/lib/jobs/lease';
import { firstReviewer, type AgentReviewResult } from './agent-review';
import type { Ai1ItemModelDispatch, CliModelDispatch } from '@/lib/llm/capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import type { PreparedAi1GatewayCall } from './agent-review-gateway';
import { agentReviewBinding } from './agent-review-ownership';
import { isDeepStrictEqual } from 'node:util';
import { prepareAgentReview } from './agent-review-preparation';
import { claimConsumerItemAgentReview, loadFirstReviewConsumerContext, observeAgentReviewItemDispatch,
  renewAgentReviewItemOwnership, recordAgentReview, recordConsumerSuspectedSpam, AgentReviewItemCliModelReservationRequired,
  type AgentReviewItemModelReservationRequired, type ItemModelCapacityReviewClaim, type CliModelCapacityReviewClaim } from './agent-review-repository';
import type { PreparedReviewCliCall } from './review-cli-call';

export type FirstReviewConsumerOutcome = { state: 'skipped'; reason: string }
  | { applied: boolean; state: 'succeeded' | 'failed' | 'superseded' };

/** Fixed item lane; model admission rolls back before reserving physical capacity. */
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
  let claim: ItemModelCapacityReviewClaim | CliModelCapacityReviewClaim, capacity: typeof import('./agent-review-model-capacity') | undefined;
  let dispatch: Ai1ItemModelDispatch | undefined, call: PreparedAi1GatewayCall | undefined;
  // CLI 심사자(05c-4): 고정 CLI 의도 class 만 CLI coordinator 로 간다
  let cli: { capacity: typeof import('./review-cli-model-capacity'); call: PreparedReviewCliCall; dispatch: CliModelDispatch } | undefined;
  try { claim = await claimConsumerItemAgentReview({ ...context, owner, ttlMs: STALE_LOCK_MS,
    provider: prepared.provider, model: prepared.model }); }
  catch (error) {
    if (!(error instanceof ModelCapacityDeferredError) || error.reason !== 'reservation_required') throw error;
    if (error instanceof AgentReviewItemCliModelReservationRequired) {
      const cliCapacity = await import('./review-cli-model-capacity');
      const admitted = await cliCapacity.claimAgentReviewItemCliModelCapacity(error, signal);
      claim = admitted.claim;
      if (admitted.claim.dispatch) cli = { capacity: cliCapacity, call: admitted.call, dispatch: admitted.claim.dispatch };
    } else {
      capacity = await import('./agent-review-model-capacity');
      // Only the coordinator's actual fixed class may request reserved re-entry.
      const admitted = await capacity.claimAgentReviewItemModelCapacity(error as AgentReviewItemModelReservationRequired, signal);
      claim = admitted.claim; dispatch = admitted.claim.dispatch; call = admitted.call;
    }
  }
  if (claim.kind === 'skipped') return { state: 'skipped', reason: claim.reason };
  if (claim.receipt.ownership.kind !== 'item') throw new Error('invalid_first_review_consumer_claim');
  const receipt = claim.receipt;
  let result: AgentReviewResult | undefined;
  const retryDelay = () => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, claim.attempt.attemptNumber - 1));
  const cancelled = () => recordAgentReview({ ...context, receipt, error: 'cancelled',
    ...(dispatch || cli ? { retryAfter: new Date(Date.now() + (result ? retryDelay() : 60_000)) } : {}) });
  const ownerLost = new AbortController();
  const transportSignal = AbortSignal.any([ownerLost.signal, ...(signal ? [signal] : [])]);
  let stopping = false, cancelDelay: (() => void) | undefined, renewalFailure: { error: unknown } | undefined;
  const heartbeat = (async () => {
    while (!stopping) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15_000);
        cancelDelay = () => { clearTimeout(timer); resolve(); };
      });
      cancelDelay = undefined;
      if (stopping) return;
      try {
        if (!await renewAgentReviewItemOwnership(context, receipt, STALE_LOCK_MS)) { ownerLost.abort(); return; }
      } catch (error) { renewalFailure = { error }; ownerLost.abort(); return; }
    }
  })();
  let current = false;
  try {
    current = (await observeAgentReviewItemDispatch(context, receipt)).kind === 'current';
    if (dispatch) {
      if (!capacity || !call) throw new Error('ai1_item_model_dispatch_missing');
      if (current && !transportSignal.aborted && dispatch.binding.attemptId === receipt.attemptId
        && isDeepStrictEqual(dispatch.binding.review, agentReviewBinding(context.candidate.id, context.input,
          { provider: prepared.provider, model: prepared.model })))
        result = await capacity.reviewAgentReviewItemModelCapacity(context.input, dispatch, call, { timeoutMs: 60_000, signal: transportSignal });
      else await capacity.abandonAgentReviewItemModelCapacity(dispatch);
    } else if (cli) {
      const binding = cli.dispatch.binding;
      if (current && !transportSignal.aborted && binding.kind === 'ai1_item_cli' && binding.attemptId === receipt.attemptId
        && isDeepStrictEqual(binding.review, agentReviewBinding(context.candidate.id, context.input,
          { provider: prepared.provider, model: prepared.model })))
        result = await cli.capacity.reviewCliModelCapacity(context.input, cli.dispatch, cli.call, { signal: transportSignal });
      else await cli.capacity.abandonCliModelCapacity(cli.dispatch, cli.call);
    } else if (claim.kind !== 'reused' && prepared.provider !== 'rules') throw new Error('unsupported_first_review_item_dispatch');
  } finally {
    stopping = true; cancelDelay?.(); await heartbeat;
  }
  if (renewalFailure) {
    if (result && !result.ok) throw new AggregateError([result, renewalFailure.error], 'ai1_item_model_result_renewal_failed');
    throw renewalFailure.error;
  }
  if (!current || transportSignal.aborted || result && !result.ok && result.error === 'cancelled') return cancelled();
  if (result) return recordAgentReview({ ...context, receipt, ...(result.ok
    ? { outcome: result.outcome, usage: result.usage }
    : { error: result.error, usage: result.usage, retryAfter: new Date(Date.now() + retryDelay()) }) });
  if (dispatch || cli) return cancelled();
  if (prepared.spam) return recordConsumerSuspectedSpam({ ...context, receipt });
  return recordAgentReview({ ...context, receipt, outcome: prepared.outcome ?? claim.attempt.outcome ?? undefined,
    ...(prepared.ruleRejection ? { ruleRejection: prepared.ruleRejection } : {}) });
}
