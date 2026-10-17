import { randomUUID } from 'node:crypto';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { cliModelDispatchSchema, modelCapacityOwnerSchema, modelCapacityRequestIdentitySchema, type CliModelDispatch,
  type ModelCapacityRequestIdentity, type ModelSlotResult } from '@/lib/llm/capacity';
import { findOwnPendingModelRequest, requestCliModelSlot, cancelReservedModelSlot, markModelDispatchIndeterminate,
  reconcileCliProcessTerminal, type CliTarget } from '@/lib/llm/capacity-repository';
import { markUnsettledDispatch } from '@/lib/llm/capacity-unsettled';
import { roleLeaseFromEnv } from '@/lib/jobs/role-leader';
import type { JobLease } from '@/lib/jobs/control';
import { itemBindingHash } from '@/lib/jobs/items/types';
import { agentReviewBinding } from './agent-review-ownership';
import { claimAgentReviewWithCliModelReservation, claimConsumerItemAgentReviewWithCliModelReservation, AgentReviewItemCliModelReservationRequired,
  type CliModelCapacityReviewClaim, type ReviewDomainContext } from './agent-review-repository';
import { claimSecondReviewItemWithCliModelReservation, SecondReviewCliModelReservationRequired, type SecondReviewCliModelClaim } from './second-review-ownership';
import { isReviewCliProvider, prepareReviewCliCall, releaseReviewCliCall, reviewWithReservedCli, settleReviewCliNotStarted,
  type PreparedReviewCliCall, type ReviewCliOutcome } from './review-cli-call';
import { REVIEW_CLI_TIMEOUT_MS, type AgentReviewResult } from './agent-review';
import { GROK_REVIEW_TIMEOUT_MS } from './agent-review-grok';
import type { ReviewInput } from './agent-review-contract';
import { assertLiveReviewAdapterAllowed } from './review-fixture-transport';

/**
 * AI1(legacy job·item consumer)·AI2(item consumer) CLI 심사자의 공통 모델 슬롯 coordinator(PR05c-4). gateway coordinator 와 같은 순서다:
 * 되감은 claim 뒤에만 들어오고 → CLI 호출을 준비하고(계약 밖이면 provider_contract_unavailable) → 같은 owner·boot 의 대기 요청을 다시
 * 묻고 → requestCliModelSlot → 같은 TX 의 lockCli·도메인 증명·finishCli(claim 함수) → commit 뒤 실행 → terminal 이면 정산, 아니면 indeterminate.
 * 슬롯 대기는 attempt·실패·예비모델 행을 쓰기 전에 deferred 로 끝난다. spawn 전에 포기한 dispatch 는 not_started 로 정산한다(D5).
 */
type Context = ReviewDomainContext & { provider: string; model: string; lease: JobLease; timeoutMs: number; signal?: AbortSignal };
const providerTimeout = (provider: string) => provider === 'grok-cli' ? GROK_REVIEW_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;

function reviewerOwner() {
  const lease = roleLeaseFromEnv('reviewer', process.env);
  if (!lease) throw new ModelCapacityDeferredError('owner_unavailable');
  return modelCapacityOwnerSchema.parse({ instanceId: lease.instanceId, bootId: lease.bootId });
}
/** 같은 work 의 대기 요청은 같은 requestId 로 다시 묻는다(순번 유지). 이미 dispatch 된 호출은 다시 띄우지 않는다. */
async function requestSlot(identity: ModelCapacityRequestIdentity, target: CliTarget): Promise<Extract<ModelSlotResult, { kind: 'granted' }>> {
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === 'dispatched' || pending.state === 'indeterminate')) throw new ModelCapacityDeferredError('dispatched');
  const slot = await requestCliModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, target);
  if (slot.kind !== 'granted') throw new ModelCapacityDeferredError(slot.reason);
  return slot;
}
/** 준비한 호출을 claim 까지 가져간다. commit 된 fresh dispatch 가 아니면 예약을 돌려주고 임시 디렉터리를 지운다. */
async function admit<C extends { kind: string; dispatch?: CliModelDispatch }>(call: PreparedReviewCliCall, identity: ModelCapacityRequestIdentity,
  target: CliTarget, signal: AbortSignal | undefined, claim: (slot: Extract<ModelSlotResult, { kind: 'granted' }>) => Promise<C>,
  fresh: (claim: C) => boolean): Promise<{ claim: C; call: PreparedReviewCliCall }> {
  let kept = false;
  try {
    const slot = await requestSlot(identity, target);
    let claimed: C;
    try {
      if (signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
      claimed = await claim(slot);
      if (claimed.kind === 'claimed' && (!claimed.dispatch || !fresh(claimed))) throw new Error('cli_model_dispatch_missing');
    } catch (error) {
      // commit 응답을 모를 수 있다 — 이 CAS 는 아직 reserved 인 원래 행만 취소하고 commit 된 dispatch 는 풀지 않는다
      try { await cancelReservedModelSlot(slot.reservation); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'cli_model_reservation_cleanup_failed'); }
      throw error;
    }
    if (claimed.kind !== 'claimed') await cancelReservedModelSlot(slot.reservation);
    kept = claimed.kind === 'claimed';
    return { claim: claimed, call };
  } finally { if (!kept) await releaseReviewCliCall(call); }
}
async function prepare(input: ReviewInput, routeId: 'crawl-agent-review' | 'second-review', provider: string, model: string, timeoutMs: number) {
  if (!isReviewCliProvider(provider)) throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const call = await prepareReviewCliCall(input, { routeId, provider, model, timeoutMs });
  if (call.kind !== 'prepared_cli') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  return call;
}

/** AI1 legacy job: 되감은 fresh claim 뒤에만 부른다. 큐 조회·poll 은 각자 짧은 primary TX 이고 실행을 감싸지 않는다. */
export async function claimAgentReviewCliModelCapacity(input: Context): Promise<{ claim: CliModelCapacityReviewClaim; call: PreparedReviewCliCall }> {
  assertLiveReviewAdapterAllowed();
  const signal = input.signal;
  input = { ...structuredClone({ candidate: input.candidate, document: input.document, settings: input.settings, input: input.input,
    provider: input.provider, model: input.model, lease: input.lease, timeoutMs: input.timeoutMs }), signal };
  const owner = reviewerOwner();
  const call = await prepare(input.input, 'crawl-agent-review', input.provider, input.model, input.timeoutMs);
  const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review',
    provider: input.provider, model: input.model,
    workKey: `ai1:${input.candidate.id}:${itemBindingHash(agentReviewBinding(input.candidate.id, input.input, { provider: input.provider, model: input.model }))}` });
  return admit(call, identity, { kind: 'ai1', candidateId: input.candidate.id }, signal,
    slot => claimAgentReviewWithCliModelReservation({ ...input, reservation: slot.reservation, identity, call }),
    claim => claim.kind === 'claimed' && claim.receipt.origin === 'fresh' && claim.dispatch?.binding.kind === 'ai1_legacy_cli');
}

/** AI1 item consumer: CLI 의도 class 만 받는다. */
export async function claimAgentReviewItemCliModelCapacity(intent: AgentReviewItemCliModelReservationRequired, signal?: AbortSignal):
  Promise<{ claim: CliModelCapacityReviewClaim; call: PreparedReviewCliCall }> {
  assertLiveReviewAdapterAllowed();
  if (!(intent instanceof AgentReviewItemCliModelReservationRequired)) throw new Error('invalid_agent_review_item_model_intent');
  const expected = new AgentReviewItemCliModelReservationRequired(intent.intent).intent;
  const { context, owner, provider, model } = expected;
  if (signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
  const call = await prepare(context.input, 'crawl-agent-review', provider, model, providerTimeout(provider));
  const binding = agentReviewBinding(context.candidate.id, context.input, { provider, model });
  const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review',
    provider, model, workKey: `ai1:${context.candidate.id}:${itemBindingHash(binding)}` });
  return admit(call, identity, { kind: 'ai1', candidateId: context.candidate.id }, signal,
    slot => claimConsumerItemAgentReviewWithCliModelReservation({ expected, reservation: slot.reservation, identity, call }),
    claim => claim.kind === 'claimed' && claim.receipt.origin === 'fresh' && claim.receipt.ownership.kind === 'item'
      && claim.dispatch?.binding.kind === 'ai1_item_cli');
}

/** AI2 item consumer: CLI 의도 class 만 받는다. 슬롯 deferred 는 recordSecondReview 앞에서 끝나 예비모델 행이 생기지 않는다. */
export async function claimSecondReviewCliModelCapacity(intent: SecondReviewCliModelReservationRequired, signal?: AbortSignal):
  Promise<{ claim: SecondReviewCliModelClaim; call: PreparedReviewCliCall }> {
  assertLiveReviewAdapterAllowed();
  if (!(intent instanceof SecondReviewCliModelReservationRequired)) throw new Error('invalid_second_review_model_intent');
  const expected = structuredClone(intent.intent), { binding, owner } = expected;
  if (signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
  const { provider, model } = binding.reviewer;
  const call = await prepare(expected.input, 'second-review', provider, model, providerTimeout(provider));
  const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: 'second', pool: 'reviewer', routeId: 'second-review',
    provider, model, workKey: `ai2:${binding.candidateId}:${binding.vote}:${itemBindingHash(binding)}` });
  return admit(call, identity, { kind: 'ai2', candidateId: binding.candidateId, vote: binding.vote }, signal,
    slot => claimSecondReviewItemWithCliModelReservation({ secondReviewId: binding.secondReviewId, owner, expected,
      reservation: slot.reservation, identity, call }),
    claim => claim.kind === 'claimed' && claim.receipt.ownership.kind === 'item' && claim.dispatch?.binding.kind === 'ai2_item_cli');
}

/**
 * commit 된 dispatch 하나를 실행하고 역사적 dispatch 로 정산한다 — 정산은 업무 결과 기록(취소 포함)보다 먼저다.
 * terminal 이 없으면(pipe 쥔 손자·kill 뒤 exit 없음) indeterminate 로 점유를 유지한다.
 */
export async function reviewCliModelCapacity(input: ReviewInput, dispatch: CliModelDispatch, call: PreparedReviewCliCall,
  options: { signal?: AbortSignal }): Promise<AgentReviewResult> {
  dispatch = cliModelDispatchSchema.parse(dispatch);
  let response: ReviewCliOutcome;
  try { response = await reviewWithReservedCli(input, dispatch, call, { signal: options.signal }); }
  catch (error) {
    try { await abandonCliModelCapacity(dispatch, call, 'transport_unknown'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'cli_model_transport_cleanup_failed'); }
    throw error;
  }
  try {
    if (response.terminal) await reconcileCliProcessTerminal(response.terminal);
    else await markModelDispatchIndeterminate(dispatch, response.indeterminate ?? 'transport_unknown');
  } catch (cleanup) {
    if (response.terminal) await markUnsettledDispatch(dispatch);
    if (!response.result.ok) throw new AggregateError([response.result, cleanup], 'cli_model_result_cleanup_failed');
    throw cleanup;
  }
  return response.result;
}

/** spawn 하지 않고 포기한 commit 된 dispatch(D5): one-use 호출이 실행되지 않았다는 증명으로 not_started 정산한다. 증명이 없으면 점유를 유지한다. */
export async function abandonCliModelCapacity(dispatch: CliModelDispatch, call: PreparedReviewCliCall,
  reason: 'local_abort' | 'transport_unknown' = 'local_abort'): Promise<boolean> {
  dispatch = cliModelDispatchSchema.parse(dispatch);
  const terminal = await settleReviewCliNotStarted(call, dispatch).catch(() => null);
  await releaseReviewCliCall(call);
  if (!terminal) return markModelDispatchIndeterminate(dispatch, reason);
  try { await reconcileCliProcessTerminal(terminal); }
  catch (error) { await markUnsettledDispatch(dispatch); throw error; }
  return true;
}
