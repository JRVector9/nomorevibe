import { z } from 'zod';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { STALE_LOCK_MS } from '@/lib/jobs/lease';
import type { AgentReviewResult } from './agent-review';
import type { Ai1ItemModelDispatch, CliModelDispatch } from '@/lib/llm/capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import type { PreparedAi1GatewayCall } from './agent-review-gateway';
import { agentReviewBinding } from './agent-review-ownership';
import { isDeepStrictEqual } from 'node:util';
import { prepareAgentReview } from './agent-review-preparation';
import type { ProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { FirstReviewModelDeferredError, firstReviewRankState, firstReviewerKey } from './first-reviewers';
import { claimConsumerItemAgentReview, loadFirstReviewConsumerContext, observeAgentReviewItemDispatch,
  renewAgentReviewItemOwnership, recordAgentReview, recordConsumerSuspectedSpam, AgentReviewItemCliModelReservationRequired,
  chooseFirstReviewForCandidate, type AgentReviewItemModelReservationRequired, type ItemModelCapacityReviewClaim, type CliModelCapacityReviewClaim } from './agent-review-repository';
import type { PreparedReviewCliCall } from './review-cli-call';
import { reviewGatewayLadder } from '@/lib/llm/deadline-ladder';
import { observeReviewCliHost } from './review-cli-host-observe';

export type FirstReviewConsumerOutcome = { state: 'skipped'; reason: string }
  | { applied: boolean; state: 'succeeded' | 'failed' | 'superseded' };

/** Fixed item lane; model admission rolls back before reserving physical capacity. */
export async function executeFirstReviewConsumerItem(input: {
  candidateId: number; owner: ItemOwner; signal?: AbortSignal;
  /** 새 claim·dispatch 만 막는 신호(replay 구간 끝). 이미 보낸 호출은 signal 이 끊기 전까지 끝까지 받는다 */
  stopClaims?: AbortSignal;
  /** provider 회로(PR06e)에 실제 호출 결과만 알린다. 호출이 없던 항목(규칙·재사용·취소 전)은 부르지 않는다 */
  onProviderResult?: (result: AgentReviewResult) => void;
  pausedReviewers?: ReadonlySet<string>;
  /** 물리 그룹이 미확인 점유로 꽉 찬 모델(읽기 전용 hint). 한 번도 보내지 않은 후보만 다른 모델로 돌린다 */
  blockedReviewers?: ReadonlySet<string>;
  reviewerCircuits?: ProviderCircuits;
}): Promise<FirstReviewConsumerOutcome> {
  const candidateId = z.number().int().positive().safe().parse(input.candidateId);
  const owner = itemOwnerSchema.parse(input.owner), { signal, stopClaims } = input;
  if (signal?.aborted || stopClaims?.aborted) return { state: 'skipped', reason: 'aborted' };
  const loaded = await loadFirstReviewConsumerContext(candidateId);
  if (loaded.kind === 'skipped') return { state: 'skipped', reason: loaded.reason };
  const context = loaded.context;
  // 늘 순위 고르기다(PR C1 — 「작업 ↔ 모델」 1차 AI 검수 1·2·3순위). 쓸 수 없는·쉬는·막힌 순위는 비켜 간다
  const avoid = new Set([...input.pausedReviewers ?? [], ...input.blockedReviewers ?? []]);
  const reviewer = await chooseFirstReviewForCandidate(context, undefined, avoid);
  if (!reviewer) {
    const ranks = firstReviewRankState(context.settings);
    if (ranks.degraded) return { state: 'skipped', reason: ranks.degraded.code };
    return { state: 'skipped', reason: ranks.pool.every(row => avoid.has(firstReviewerKey(row)) || ranks.unusable.has(firstReviewerKey(row)))
      ? 'all_ranks_unusable' : 'model_intent_protected' };
  }
  if (input.pausedReviewers?.has(firstReviewerKey(reviewer))) return { state: 'skipped', reason: 'model_paused' };
  const circuit = input.reviewerCircuits?.admit('ai1:' + firstReviewerKey(reviewer));
  if (circuit?.admitted === false) return { state: 'skipped', reason: 'provider_circuit_open' };
  try {
    const prepared = await prepareAgentReview(context, reviewer);
    // OpenCode 순위의 예약 전 계약 확인에 필요한 호스트 버전 관측 — claim TX 밖에서 낡았을 때만 채운다(실패하면 오늘처럼 미룸)
    await observeReviewCliHost('crawl-agent-review', { provider: prepared.provider, model: prepared.model });
    if (signal?.aborted || stopClaims?.aborted) return { state: 'skipped', reason: 'aborted' };
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
        if (current && !transportSignal.aborted && !stopClaims?.aborted && dispatch.binding.attemptId === receipt.attemptId
          && isDeepStrictEqual(dispatch.binding.review, agentReviewBinding(context.candidate.id, context.input,
            { provider: prepared.provider, model: prepared.model })))
          result = await capacity.reviewAgentReviewItemModelCapacity(context.input, dispatch, call, { timeoutMs: reviewGatewayLadder().clientMs, signal: transportSignal });
        else await capacity.abandonAgentReviewItemModelCapacity(dispatch, call);
      } else if (cli) {
        const binding = cli.dispatch.binding;
        if (current && !transportSignal.aborted && !stopClaims?.aborted && binding.kind === 'ai1_item_cli' && binding.attemptId === receipt.attemptId
          && isDeepStrictEqual(binding.review, agentReviewBinding(context.candidate.id, context.input,
            { provider: prepared.provider, model: prepared.model })))
          result = await cli.capacity.reviewCliModelCapacity(context.input, cli.dispatch, cli.call, { signal: transportSignal });
        else await cli.capacity.abandonCliModelCapacity(cli.dispatch, cli.call);
      } else if (claim.kind !== 'reused' && prepared.provider !== 'rules') throw new Error('unsupported_first_review_item_dispatch');
    } finally {
      stopping = true; cancelDelay?.(); await heartbeat;
    }
    if (result) { input.onProviderResult?.(result); if (circuit?.admitted) circuit.record(result); }
    if (renewalFailure) {
      if (result && !result.ok) throw new AggregateError([result, renewalFailure.error], 'ai1_item_model_result_renewal_failed');
      throw renewalFailure.error;
    }
    if (!current || transportSignal.aborted || result && !result.ok && result.error === 'cancelled') return cancelled();
    if (result) return recordAgentReview({ ...context, receipt, ...(result.ok
      ? { outcome: result.outcome, usage: result.usage }
      : { error: result.error, detail: result.detail, usage: result.usage, retryAfter: new Date(Date.now() + retryDelay()) }) });
    if (dispatch || cli) return cancelled();
    if (prepared.spam) return recordConsumerSuspectedSpam({ ...context, receipt });
    return recordAgentReview({ ...context, receipt, outcome: prepared.outcome ?? claim.attempt.outcome ?? undefined,
      ...(prepared.ruleRejection ? { ruleRejection: prepared.ruleRejection } : {}) });
  } catch (error) {
    if (error instanceof ModelCapacityDeferredError) throw new FirstReviewModelDeferredError(error.reason, reviewer);
    throw error;
  } finally { if (circuit?.admitted) circuit.done(); }
}
