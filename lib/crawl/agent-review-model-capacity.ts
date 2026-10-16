import { randomUUID } from 'node:crypto';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { ai1ModelDispatchSchema, modelCapacityOwnerSchema, modelCapacityRequestIdentitySchema, type Ai1ModelDispatch, ai1ItemModelDispatchSchema, type Ai1ItemModelDispatch } from '@/lib/llm/capacity';
import { findOwnPendingModelRequest, requestAi1ModelSlot, cancelReservedModelSlot,
  markModelDispatchIndeterminate, reconcileAi1GatewayTerminal, reconcileAi1ItemGatewayTerminal } from '@/lib/llm/capacity-repository';
import { roleLeaseFromEnv } from '@/lib/jobs/role-leader';
import type { JobLease } from '@/lib/jobs/control';
import { itemBindingHash } from '@/lib/jobs/items/types';
import { agentReviewBinding } from './agent-review-ownership';
import { claimAgentReviewWithModelReservation, AgentReviewItemModelReservationRequired, claimConsumerItemAgentReviewWithModelReservation, type ItemModelCapacityReviewClaim, type ReviewDomainContext, type ModelCapacityReviewClaim } from './agent-review-repository';
import { prepareAi1GatewayCall, reviewWithReservedAi1Gateway, reviewWithReservedAi1ItemGateway, type PreparedAi1GatewayCall } from './agent-review-gateway';
import type { AgentReviewResult } from './agent-review';
import type { ReviewInput } from './agent-review-contract';
import { assertLiveReviewAdapterAllowed } from './review-fixture-transport';

type Context = ReviewDomainContext & { provider: string; model: string; lease: JobLease; signal?: AbortSignal };

/** The ordinary consumer claim has rolled back before entering this fixed coordinator. */
export async function claimAgentReviewItemModelCapacity(intent: AgentReviewItemModelReservationRequired, signal?: AbortSignal):
  Promise<{ claim: ItemModelCapacityReviewClaim; call: PreparedAi1GatewayCall }> {
  assertLiveReviewAdapterAllowed();
  if (!(intent instanceof AgentReviewItemModelReservationRequired)) throw new Error('invalid_agent_review_item_model_intent');
  const expected = new AgentReviewItemModelReservationRequired(intent.intent).intent;
  const { context, owner, model } = expected;
  if (signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
  const call = prepareAi1GatewayCall(context.input, { model });
  if (call.kind !== 'prepared') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const binding = agentReviewBinding(context.candidate.id, context.input, { provider: 'abcllm', model });
  const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: 'first', pool: 'reviewer',
    routeId: 'crawl-agent-review', provider: 'abcllm', model, workKey: `ai1:${context.candidate.id}:${itemBindingHash(binding)}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === 'dispatched' || pending.state === 'indeterminate')) throw new ModelCapacityDeferredError('dispatched');
  const slot = await requestAi1ModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, context.candidate.id);
  if (slot.kind !== 'granted') throw new ModelCapacityDeferredError(slot.reason);
  let claim: ItemModelCapacityReviewClaim;
  try {
    if (signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
    claim = await claimConsumerItemAgentReviewWithModelReservation({ expected, reservation: slot.reservation, identity, call });
    if (claim.kind !== 'skipped' && (claim.receipt.ownership.kind !== 'item'
      || claim.kind === 'claimed' && (!claim.dispatch || claim.receipt.origin !== 'fresh')))
      throw new Error('ai1_item_model_dispatch_missing');
  } catch (error) {
    // Unknown commit acknowledgement cannot cancel an already committed dispatch.
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'ai1_item_model_reservation_cleanup_failed'); }
    throw error;
  }
  if (claim.kind !== 'claimed') await cancelReservedModelSlot(slot.reservation);
  return { claim, call };
}

export function abandonAgentReviewItemModelCapacity(dispatch: Ai1ItemModelDispatch): Promise<boolean> {
  return markModelDispatchIndeterminate(dispatch, 'local_abort');
}

/** Original historical terminal settlement finishes before current business writing. */
export async function reviewAgentReviewItemModelCapacity(input: ReviewInput, dispatch: Ai1ItemModelDispatch,
  call: PreparedAi1GatewayCall, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<AgentReviewResult> {
  dispatch = ai1ItemModelDispatchSchema.parse(dispatch);
  options = { signal: options.signal, timeoutMs: options.timeoutMs };
  let response: Awaited<ReturnType<typeof reviewWithReservedAi1ItemGateway>>;
  try { response = await reviewWithReservedAi1ItemGateway(input, dispatch, call, options); }
  catch (error) {
    try { await markModelDispatchIndeterminate(dispatch, options.signal?.aborted ? 'local_abort' : 'transport_unknown'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'ai1_item_model_transport_cleanup_failed'); }
    throw error;
  }
  try {
    if (response.terminal) await reconcileAi1ItemGatewayTerminal(response.terminal);
    else await markModelDispatchIndeterminate(dispatch, options.signal?.aborted ? 'local_abort' : 'transport_unknown');
  } catch (cleanup) {
    if (!response.result.ok) throw new AggregateError([response.result, cleanup], 'ai1_item_model_result_cleanup_failed');
    throw cleanup;
  }
  return response.result;
}

/** Called only after the fresh-intent claim transaction has actually rolled back.
 * Each queue read/poll is its own short primary transaction; none spans transport. */
export async function claimAgentReviewModelCapacity(input: Context): Promise<{ claim: ModelCapacityReviewClaim; call: PreparedAi1GatewayCall }> {
  assertLiveReviewAdapterAllowed();
  // Preserve the exact intent and job while the standalone queue calls await.
  const signal = input.signal;
  input = { ...structuredClone({ candidate: input.candidate, document: input.document, settings: input.settings,
    input: input.input, provider: input.provider, model: input.model, lease: input.lease }), signal };
  if (input.provider !== 'abcllm') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const call = prepareAi1GatewayCall(input.input, { model: input.model });
  if (call.kind !== 'prepared') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const lease = roleLeaseFromEnv('reviewer', process.env);
  if (!lease) throw new ModelCapacityDeferredError('owner_unavailable');
  const owner = modelCapacityOwnerSchema.parse({ instanceId: lease.instanceId, bootId: lease.bootId });
  const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: 'first', pool: 'reviewer',
    routeId: 'crawl-agent-review', provider: 'abcllm', model: input.model,
    workKey: `ai1:${input.candidate.id}:${itemBindingHash(agentReviewBinding(input.candidate.id, input.input, { provider: input.provider, model: input.model }))}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === 'dispatched' || pending.state === 'indeterminate')) throw new ModelCapacityDeferredError('dispatched');
  const slot = await requestAi1ModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, input.candidate.id);
  if (slot.kind !== 'granted') throw new ModelCapacityDeferredError(slot.reason);
  let claim: ModelCapacityReviewClaim;
  try {
    if (input.signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
    claim = await claimAgentReviewWithModelReservation({ ...input, reservation: slot.reservation, identity, call });
    if (claim.kind === 'claimed') {
      if (!claim.dispatch || claim.receipt.origin !== 'fresh') throw new Error('ai1_model_dispatch_missing');
    }
  } catch (error) {
    // A commit acknowledgement may be unknown. This CAS can only cancel an
    // original still-reserved row; it never frees a committed dispatch.
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'ai1_model_reservation_cleanup_failed'); }
    throw error;
  }
  if (claim.kind !== 'claimed') await cancelReservedModelSlot(slot.reservation);
  return { claim, call };
}

/** A committed dispatch with no started transport has no fabricated terminal. */
export function abandonAgentReviewModelCapacity(dispatch: Ai1ModelDispatch): Promise<boolean> {
  return markModelDispatchIndeterminate(dispatch, 'local_abort');
}

/** Physical terminal reconciliation precedes the job's cancellation/current-input
 * result policy. A late job does not prevent settling this original physical call. */
export async function reviewAgentReviewModelCapacity(input: ReviewInput, dispatch: Ai1ModelDispatch,
  call: PreparedAi1GatewayCall, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<AgentReviewResult> {
  dispatch = ai1ModelDispatchSchema.parse(dispatch);
  options = { signal: options.signal, timeoutMs: options.timeoutMs };
  let response: Awaited<ReturnType<typeof reviewWithReservedAi1Gateway>>;
  try { response = await reviewWithReservedAi1Gateway(input, dispatch, call, options); }
  catch (error) {
    try { await markModelDispatchIndeterminate(dispatch, options.signal?.aborted ? 'local_abort' : 'transport_unknown'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'ai1_model_transport_cleanup_failed'); }
    throw error;
  }
  try {
    if (response.terminal) await reconcileAi1GatewayTerminal(response.terminal);
    else await markModelDispatchIndeterminate(dispatch, options.signal?.aborted ? 'local_abort' : 'transport_unknown');
  } catch (cleanup) {
    if (!response.result.ok) throw new AggregateError([response.result, cleanup], 'ai1_model_result_cleanup_failed');
    throw cleanup;
  }
  return response.result;
}
