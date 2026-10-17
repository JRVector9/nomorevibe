import { randomUUID } from 'node:crypto';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { ai2ModelDispatchSchema, modelCapacityRequestIdentitySchema, type Ai2ModelDispatch } from '@/lib/llm/capacity';
import { findOwnPendingModelRequest, requestAi2ItemModelSlot, cancelReservedModelSlot,
  markModelDispatchIndeterminate, reconcileAi2GatewayTerminal, reconcileGatewayNotStarted } from '@/lib/llm/capacity-repository';
import { markUnsettledDispatch } from '@/lib/llm/capacity-unsettled';
import { itemBindingHash } from '@/lib/jobs/items/types';
import { prepareAi2GatewayCall, reviewWithReservedAi2Gateway, settleAi2GatewayNotStarted, type GatewayNotStarted, type PreparedAi2GatewayCall } from './agent-review-gateway';
import { SecondReviewModelReservationRequired, claimSecondReviewItemWithModelReservation, type SecondReviewModelClaim } from './second-review-ownership';
import type { ReviewInput } from './agent-review-contract';
import type { AgentReviewResult } from './agent-review';
import { assertLiveReviewAdapterAllowed } from './review-fixture-transport';

/** Called only after the ordinary claim's intent transaction has rolled back.
 * Queue polls and the fixed atomic item/dispatch claim each have short own TXs. */
export async function claimSecondReviewModelCapacity(intent: SecondReviewModelReservationRequired, signal?: AbortSignal):
  Promise<{ claim: SecondReviewModelClaim; call: PreparedAi2GatewayCall }> {
  assertLiveReviewAdapterAllowed();
  if (!(intent instanceof SecondReviewModelReservationRequired)) throw new Error('invalid_second_review_model_intent');
  const expected = structuredClone(intent.intent), { binding, owner } = expected;
  if (signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
  const call = prepareAi2GatewayCall(expected.input, { model: binding.reviewer.model });
  if (call.kind !== 'prepared') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: 'second', pool: 'reviewer',
    routeId: 'second-review', provider: 'abcllm', model: binding.reviewer.model,
    workKey: `ai2:${binding.candidateId}:${binding.vote}:${itemBindingHash(binding)}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === 'dispatched' || pending.state === 'indeterminate')) throw new ModelCapacityDeferredError('dispatched');
  const slot = await requestAi2ItemModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() },
    { candidateId: binding.candidateId, vote: binding.vote });
  if (slot.kind !== 'granted') throw new ModelCapacityDeferredError(slot.reason);
  let claim: SecondReviewModelClaim;
  try {
    if (signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
    claim = await claimSecondReviewItemWithModelReservation({ secondReviewId: binding.secondReviewId, owner, expected,
      reservation: slot.reservation, identity, call });
    if (claim.kind !== 'skipped' && (claim.kind !== 'claimed' || !claim.dispatch || claim.receipt.ownership.kind !== 'item'))
      throw new Error('ai2_model_dispatch_missing');
  } catch (error) {
    // Commit acknowledgement can be unknown: only a still-reserved row can be
    // cancelled. This never refunds a committed dispatch or revokes its owner.
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'ai2_model_reservation_cleanup_failed'); }
    throw error;
  }
  if (claim.kind === 'skipped') await cancelReservedModelSlot(slot.reservation);
  return { claim, call };
}

/** A committed dispatch without a verified terminal retains its full C charge. 준비 호출을 받으면(아직 미사용) 전송 0 으로
 * not_started 정산해 표 키·슬롯을 남기지 않는다(CLI D5 의 게이트웨이판). 증명이 없거나 정산하지 못하면 점유를 유지한다. */
export async function abandonSecondReviewModelCapacity(dispatch: Ai2ModelDispatch, call?: PreparedAi2GatewayCall): Promise<boolean> {
  let unsent: GatewayNotStarted | null = null;
  try { unsent = call ? settleAi2GatewayNotStarted(call, dispatch) : null; } catch { unsent = null; }
  if (!unsent) return markModelDispatchIndeterminate(dispatch, 'local_abort');
  try { await reconcileGatewayNotStarted(unsent); }
  catch (error) { await markUnsettledDispatch(dispatch); throw error; }
  return true;
}

/** Historical physical settlement precedes cancellation/current business writing. */
export async function reviewSecondReviewModelCapacity(input: ReviewInput, dispatch: Ai2ModelDispatch,
  call: PreparedAi2GatewayCall, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<AgentReviewResult> {
  dispatch = ai2ModelDispatchSchema.parse(dispatch);
  options = { signal: options.signal, timeoutMs: options.timeoutMs };
  let response: Awaited<ReturnType<typeof reviewWithReservedAi2Gateway>>;
  try { response = await reviewWithReservedAi2Gateway(input, dispatch, call, options); }
  catch (error) {
    try { await markModelDispatchIndeterminate(dispatch, options.signal?.aborted ? 'local_abort' : 'transport_unknown'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'ai2_model_transport_cleanup_failed'); }
    throw error;
  }
  try {
    if (response.terminal) await reconcileAi2GatewayTerminal(response.terminal);
    else if (response.notStarted) await reconcileGatewayNotStarted(response.notStarted);
    else await markModelDispatchIndeterminate(dispatch, options.signal?.aborted ? 'local_abort' : 'transport_unknown');
  } catch (cleanup) {
    if (response.terminal || response.notStarted) await markUnsettledDispatch(dispatch);
    if (!response.result.ok) throw new AggregateError([response.result, cleanup], 'ai2_model_result_cleanup_failed');
    throw cleanup;
  }
  return response.result;
}
