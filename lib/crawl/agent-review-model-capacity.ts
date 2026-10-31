import { randomUUID } from 'node:crypto';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { modelCapacityIndeterminateReason } from '@/lib/llm/capacity';
import { ai1ModelDispatchSchema, modelCapacityOwnerSchema, modelCapacityRequestIdentitySchema, type Ai1ModelDispatch, ai1ItemModelDispatchSchema, type Ai1ItemModelDispatch,
  type ModelCapacityRequest, type ModelSlotResult } from '@/lib/llm/capacity';
import { findOwnPendingModelRequest, requestAi1ModelSlot, cancelReservedModelSlot,
  markModelDispatchIndeterminate, reconcileAi1GatewayTerminal, reconcileAi1ItemGatewayTerminal, reconcileGatewayNotStarted } from '@/lib/llm/capacity-repository';
import { markUnsettledDispatch } from '@/lib/llm/capacity-unsettled';
import { capacityRefusalReason } from '@/lib/llm/capacity-busy-targets';
import { roleLeaseFromEnv } from '@/lib/jobs/role-leader';
import type { JobLease } from '@/lib/jobs/control';
import { itemBindingHash } from '@/lib/jobs/items/types';
import { agentReviewBinding } from './agent-review-ownership';
import { claimAgentReviewWithModelReservation, AgentReviewItemModelReservationRequired, claimConsumerItemAgentReviewWithModelReservation, type ItemModelCapacityReviewClaim, type ReviewDomainContext, type ModelCapacityReviewClaim } from './agent-review-repository';
import { prepareAi1DirectCall, prepareAi1GatewayCall, reviewWithReservedAi1Gateway, reviewWithReservedAi1ItemGateway, settleAi1GatewayNotStarted,
  settleAi1ItemGatewayNotStarted, type GatewayNotStarted, type PreparedAi1GatewayCall } from './agent-review-gateway';
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
  const { context, owner, model, provider } = expected;
  if (signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
  // abcllm 은 예전 그대로(동기·게이트웨이 계약), local-direct 는 엔진 직접 계약(PR 3b-C) — 같은 장부 kind·같은 전송 함수로 간다.
  const call = provider === 'local-direct' ? await prepareAi1DirectCall(context.input, { model, signal }) : prepareAi1GatewayCall(context.input, { model });
  if (call.kind !== 'prepared') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const binding = agentReviewBinding(context.candidate.id, context.input, { provider, model });
  const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: 'first', pool: 'reviewer',
    routeId: 'crawl-agent-review', provider, model, workKey: `ai1:${context.candidate.id}:${itemBindingHash(binding)}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending?.state === 'dispatched') throw new ModelCapacityDeferredError('dispatched');
  const request = { ...identity, requestId: pending?.requestId ?? randomUUID() };
  const slot = await requestAi1ModelSlot(request, context.candidate.id);
  // 행 없는 capacity(같은 후보 fence)는 이 후보 하나의 일이다 — work_busy 로 돌려 모델을 멈추지 않게 한다(2026-10-30 결정)
  if (slot.kind !== 'granted') throw new ModelCapacityDeferredError(await capacityRefusalReason(request, slot.reason));
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

/** 전송 전에 포기한 item dispatch. 준비 호출을 받으면(아직 미사용) 전송 0 으로 not_started 정산하고, 아니면 지금처럼 indeterminate 로 둔다 */
export function abandonAgentReviewItemModelCapacity(dispatch: Ai1ItemModelDispatch, call?: PreparedAi1GatewayCall): Promise<boolean> {
  return abandonUnsent(dispatch, call && (() => settleAi1ItemGatewayNotStarted(call, dispatch)));
}

/**
 * fetch 를 부르지 않은 dispatch 의 포기(CLI D5 의 게이트웨이판). one-use 준비 호출이 아직 쓰이지 않았다는 것이 전송 0 의 증명이라
 * not_started 로 정산해 슬롯·후보 키를 남기지 않는다. 증명이 없거나(준비 호출 없음·이미 쓰임·대조 실패) 정산하지 못하면 점유를 유지한다.
 */
async function abandonUnsent(dispatch: Ai1ModelDispatch | Ai1ItemModelDispatch, settle?: () => GatewayNotStarted | null): Promise<boolean> {
  let unsent: GatewayNotStarted | null = null;
  try { unsent = settle?.() ?? null; } catch { unsent = null; }
  if (!unsent) return markModelDispatchIndeterminate(dispatch, 'local_abort');
  try { await reconcileGatewayNotStarted(unsent); }
  catch (error) { await markUnsettledDispatch(dispatch); throw error; }
  return true;
}

/** Original historical terminal settlement finishes before current business writing. */
export async function reviewAgentReviewItemModelCapacity(input: ReviewInput, dispatch: Ai1ItemModelDispatch,
  call: PreparedAi1GatewayCall, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<AgentReviewResult> {
  dispatch = ai1ItemModelDispatchSchema.parse(dispatch);
  options = { signal: options.signal, timeoutMs: options.timeoutMs };
  let response: Awaited<ReturnType<typeof reviewWithReservedAi1ItemGateway>>;
  try { response = await reviewWithReservedAi1ItemGateway(input, dispatch, call, options); }
  catch (error) {
    try { await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: options.signal, error })); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'ai1_item_model_transport_cleanup_failed'); }
    throw error;
  }
  try {
    if (response.terminal) await reconcileAi1ItemGatewayTerminal(response.terminal);
    else if (response.notStarted) await reconcileGatewayNotStarted(response.notStarted);
    else await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: options.signal, timedOut: !response.result.ok && response.result.error === 'timeout' }));
  } catch (cleanup) {
    if (response.terminal || response.notStarted) await markUnsettledDispatch(dispatch);
    if (!response.result.ok) throw new AggregateError([response.result, cleanup], 'ai1_item_model_result_cleanup_failed');
    throw cleanup;
  }
  return response.result;
}

/**
 * 틱 안의 짧은 예약 대기(2026-10-29 AI1 처리량). 슬롯이 차서 이 요청이 waiting 으로 줄에 섰으면 틱을 미루고 떠나는 대신
 * 같은 requestId 로 다시 묻는다. 줄 순서·물리 한도·class 가중치·TTL·정책 세대는 장부(requestSlot)가 그대로 정한다 — 이 대기는
 * 장부를 바꾸지 않고, 슬롯이 풀려 이 행이 reserved 가 되는 순간을 놓치지 않을 뿐이다. 떠나 있는 사이 받은 예약이 TTL(30초)로
 * 만료돼 물리 슬롯이 놀던 경로(2026-10-29 실측: AI1 예약 시간의 46~54%가 미사용 만료)를 닫는다.
 */
export type Ai1ReservationWait = {
  /** 이 시각(epoch ms)까지 받은 예약이어야 전체 호출 제한과 기록 여유를 지킨다. 지나면 다시 묻지 않는다 */
  until: number;
  /** 틱 전체의 멈춤 조건(stage·전역 미룸·종료·같은 모델 pause). false 면 그대로 미룬다 — 줄의 행은 남는다 */
  active?: () => boolean;
  /** 관측만. 결과·장부에 끼어들지 않는다 */
  observe?: (event: Ai1ReservationWaitEvent) => void;
};
/**
 * ended: 왜 끝났나 — granted(받음)·deadline(틱의 시작 가능 시각이 지남, 슬롯 문제가 아니다)·cap(상한 동안 슬롯이 계속 참)·
 * not_queued(줄에 선 행이 없다 — fence·중복 작업)·stopped(종료·틱 멈춤 조건)·refused(capacity 아닌 장부 거절)
 */
export type Ai1ReservationWaitEvent = { granted: boolean; queued: boolean; polls: number; waitedMs: number;
  ended: 'granted' | 'deadline' | 'cap' | 'not_queued' | 'stopped' | 'refused' };
/** 다시 묻는 간격. 한 번이 짧은 control 잠금 TX 하나다(전송 중에는 연결을 잡지 않는다) */
export const AI1_RESERVATION_POLL_MS = 500;
/** 한 후보가 기다리는 상한 — 정책의 예약 TTL(30초)과 같다. 그보다 오래 차 있는 슬롯은 틱이 pause 해 다른 모델에 줄을 내준다 */
export const AI1_RESERVATION_WAIT_MAX_MS = 30_000;

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * 첫 요청이 capacity 로 돌아온 같은 요청을, 줄에 선 행이 있을 때만 정해진 시각까지 다시 묻는다. 행을 취소하거나 새 행을 만들지 않는다.
 * fence·중복 작업으로 행 없이 돌아온 capacity 는 기다려도 풀리지 않으므로 바로 돌려준다. 결과가 granted 가 아니면 처음 사유 그대로 미룬다.
 */
export async function awaitQueuedAi1Reservation(request: ModelCapacityRequest, candidateId: number, first: ModelSlotResult,
  wait: Ai1ReservationWait, signal?: AbortSignal): Promise<ModelSlotResult> {
  const startedAt = Date.now(), until = Math.min(wait.until, startedAt + AI1_RESERVATION_WAIT_MAX_MS);
  const limit = wait.until <= startedAt + AI1_RESERVATION_WAIT_MAX_MS ? 'deadline' as const : 'cap' as const;
  const stopped = () => signal?.aborted === true || wait.active?.() === false;
  let slot = first, polls = 0, queued = false, ended: Ai1ReservationWaitEvent['ended'] | null = null;
  if (slot.kind !== 'deferred' || slot.reason !== 'capacity') ended = slot.kind === 'granted' ? 'granted' : 'refused';
  else if (stopped()) ended = 'stopped';
  else if (Date.now() >= until) ended = limit;
  else {
    const { requestId, ...identity } = request;
    const own = await findOwnPendingModelRequest(identity);
    queued = own?.requestId === requestId && (own.state === 'waiting' || own.state === 'reserved');
    if (!queued) ended = 'not_queued';
    // 이미 다른 호출의 grant 로 reserved 가 됐으면 쉬지 않고 바로 받는다
    let immediate = queued && own?.state === 'reserved';
    while (ended === null) {
      if (!immediate) {
        if (Date.now() + AI1_RESERVATION_POLL_MS > until) { ended = limit; break; }
        await pause(AI1_RESERVATION_POLL_MS, signal);
        if (stopped()) { ended = 'stopped'; break; }
      }
      immediate = false;
      polls++;
      slot = await requestAi1ModelSlot(request, candidateId);
      if (slot.kind === 'granted') ended = 'granted';
      else if (slot.reason !== 'capacity') ended = 'refused';
    }
  }
  try { wait.observe?.({ granted: slot.kind === 'granted', queued, polls, waitedMs: Date.now() - startedAt, ended: ended ?? 'refused' }); }
  catch { /* 관측 실패는 대기 결과가 아니다 */ }
  return slot;
}

/** Called only after the fresh-intent claim transaction has actually rolled back.
 * Each queue read/poll is its own short primary transaction; none spans transport.
 * `wait` 가 있으면 capacity 로 줄에 선 이 요청을 그 범위 안에서만 다시 묻는다(awaitQueuedAi1Reservation). */
export async function claimAgentReviewModelCapacity(input: Context, wait?: Ai1ReservationWait): Promise<{ claim: ModelCapacityReviewClaim; call: PreparedAi1GatewayCall }> {
  assertLiveReviewAdapterAllowed();
  // Preserve the exact intent and job while the standalone queue calls await.
  const signal = input.signal;
  input = { ...structuredClone({ candidate: input.candidate, document: input.document, settings: input.settings,
    input: input.input, provider: input.provider, model: input.model, lease: input.lease }), signal };
  if (input.provider !== 'abcllm' && input.provider !== 'local-direct') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const call = input.provider === 'local-direct' ? await prepareAi1DirectCall(input.input, { model: input.model, signal })
    : prepareAi1GatewayCall(input.input, { model: input.model });
  if (call.kind !== 'prepared') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const lease = roleLeaseFromEnv('reviewer', process.env);
  if (!lease) throw new ModelCapacityDeferredError('owner_unavailable');
  const owner = modelCapacityOwnerSchema.parse({ instanceId: lease.instanceId, bootId: lease.bootId });
  const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: 'first', pool: 'reviewer',
    routeId: 'crawl-agent-review', provider: input.provider, model: input.model,
    workKey: `ai1:${input.candidate.id}:${itemBindingHash(agentReviewBinding(input.candidate.id, input.input, { provider: input.provider, model: input.model }))}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending?.state === 'dispatched') throw new ModelCapacityDeferredError('dispatched');
  const request = { ...identity, requestId: pending?.requestId ?? randomUUID() };
  let slot = await requestAi1ModelSlot(request, input.candidate.id);
  if (wait && slot.kind === 'deferred' && slot.reason === 'capacity') slot = await awaitQueuedAi1Reservation(request, input.candidate.id, slot, wait, input.signal);
  // 줄에 서지 못한 capacity(같은 후보 fence·중복 작업)는 work_busy — 호출자는 이 후보만 건너뛴다(2026-10-30 결정)
  if (slot.kind !== 'granted') throw new ModelCapacityDeferredError(await capacityRefusalReason(request, slot.reason));
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

/** A committed dispatch with no started transport has no fabricated terminal. 준비 호출을 받으면(아직 미사용) 전송 0 으로 not_started 정산한다 */
export function abandonAgentReviewModelCapacity(dispatch: Ai1ModelDispatch, call?: PreparedAi1GatewayCall): Promise<boolean> {
  return abandonUnsent(dispatch, call && (() => settleAi1GatewayNotStarted(call, dispatch)));
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
    try { await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: options.signal, error })); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'ai1_model_transport_cleanup_failed'); }
    throw error;
  }
  try {
    if (response.terminal) await reconcileAi1GatewayTerminal(response.terminal);
    else if (response.notStarted) await reconcileGatewayNotStarted(response.notStarted);
    else await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: options.signal, timedOut: !response.result.ok && response.result.error === 'timeout' }));
  } catch (cleanup) {
    if (response.terminal || response.notStarted) await markUnsettledDispatch(dispatch);
    if (!response.result.ok) throw new AggregateError([response.result, cleanup], 'ai1_model_result_cleanup_failed');
    throw cleanup;
  }
  return response.result;
}
