import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { reconcileGatewayNotStarted, reconcileGatewayHttpRejected, readModelCapacityCallerControl, findOwnPendingModelRequest, requestReasonTranslationModelSlot,
  findOwnPendingReasonTranslationRequests, cancelOwnPendingReasonTranslationRequest,
  cancelReservedModelSlot, markModelDispatchIndeterminate, reconcileReasonTranslationGatewayTerminal } from '@/lib/llm/capacity-repository';
import { markUnsettledDispatch } from '@/lib/llm/capacity-unsettled';
import { reasonTranslationInputHash, reasonTranslationLogicalWorkKey, modelCapacityRequestIdentitySchema } from '@/lib/llm/capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { modelCapacityIndeterminateReason } from '@/lib/llm/capacity';
import { textHash } from './translate';
import { pendingReasonTranslationBatch, prepareReasonTranslationDispatch, type PendingTranslation, type ReasonTranslationWriteExpectation } from './translations';
import { prepareReasonTranslationGatewayCall, translateWithReservedReasonGateway } from './agent-review-gateway';
import type { JobLease } from '@/lib/jobs/control';
import { roleLeaseFromEnv, type RoleLease } from '@/lib/jobs/role-leader';
import { textRouteCallable } from "@/lib/llm/serving-contract-store";
import { reasonTranslationServingProvider } from "@/lib/llm/reason-translation-serving-contract";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { assertProviderNotRateLimited } from "@/lib/llm/provider-rate-limit";

/**
 * pendingClaims: 한 틱에 여러 줄이 함께 돌 때(「동시에」 칸 수) 이 틱이 이미 집은 장부 요청 id — 다른 줄이 같은 대기 요청을 이어받지 않게 한다
 * (product-translation-model-capacity.ts 와 같은 뜻). 한 줄로 돌 때는 없다(예전 그대로).
 */
type Options = { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease; pendingClaims?: { requestIds: Set<string> } };
type ReservedReasonTranslationResult = Awaited<ReturnType<typeof translateWithReservedReasonGateway>>['result'];
export type ReasonTranslationCapacityResult = { kind: 'skipped' }
  | { kind: 'ready'; batch: PendingTranslation[]; result: ReservedReasonTranslationResult; expectation: ReasonTranslationWriteExpectation; unknown: boolean };

/** Each queue API uses a short primary TX. No DB connection is held while native
 * transport or its body is pending, and local cancellation never refunds C. */
export async function translateReasonsWithModelCapacity(value: readonly PendingTranslation[], job: JobLease,
  valueOptions: Options): Promise<ReasonTranslationCapacityResult> {
  const batch = structuredClone(value), lease = structuredClone(job);
  const options = { signal: valueOptions.signal, timeoutMs: valueOptions.timeoutMs,
    roleLease: valueOptions.roleLease && structuredClone(valueOptions.roleLease) };
  // Tick-local lane scheduling only; durable admission/dispatch checks remain below.
  const pendingClaims = valueOptions.pendingClaims;
  // Capture only the owner tuple before awaiting; disabled never parses a new
  // role requirement. No missing owner is replaced by a generated boot.
  const env = Object.fromEntries(['ROLE_LEASE_ROLE','ROLE_LEASE_INSTANCE_ID','ROLE_LEASE_BOOT_ID','ROLE_LEASE_RELEASE',
    'ROLE_LEASE_EPOCH','ROLE_LEASE_BATCH_VERSION','ROLE_LEASE_BATCH_EPOCH','ROLE_LEASE_HOST'].map(key => [key, process.env[key]]));
  const provider = reasonTranslationServingProvider(textTaskModel("reason-translate"));
  // 순위(PR B)가 계약을 확인하고 범위를 열었다 — 그 사이 계약이 닫혔으면 이 모델만의 일이라 다음 순위로 넘긴다(옛 게이트웨이 길로 떨어지지 않는다)
  if (!textRouteCallable("reason-translate", textTaskModel("reason-translate"), provider)) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  // 공급자가 이 경로·모델에 429(빈도 한도)를 준 뒤 쉬는 중이면 장부에 묻지 않고 이 모델만 미룬다(다음 순위가 받는다, provider-rate-limit.ts)
  assertProviderNotRateLimited({ routeId: "reason-translate", provider, model: textTaskModel("reason-translate") });
  const control = await readModelCapacityCallerControl();
  if (control.mode === 'disabled') throw new ModelCapacityDeferredError('disabled');
  if (control.mode === 'draining') throw new ModelCapacityDeferredError('draining');
  if (control.mode !== 'open') throw new Error('model_capacity_control_invalid');
  if (!control.policy?.routes.some(route => route.routeId === 'reason-translate' && route.provider === provider && route.model === textTaskModel("reason-translate")))
    throw new ModelCapacityDeferredError('unmapped');
  let checked = z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), body: z.string(),
    attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()).min(1).max(4).parse(batch);
  if (new Set(checked.map(item => item.hash)).size !== checked.length || checked.some(item => textHash(item.body) !== item.hash))
    throw new Error('invalid_reason_translation_batch');
  let call = prepareReasonTranslationGatewayCall(checked.map(item => item.body), { model: textTaskModel("reason-translate"), timeoutMs: options.timeoutMs, provider });
  if (call.kind !== 'prepared') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const roleLease = options.roleLease ?? (env.ROLE_LEASE_ROLE === 'text' || env.ROLE_LEASE_ROLE === 'translation'
    ? roleLeaseFromEnv(env.ROLE_LEASE_ROLE, env) : undefined);
  if (!roleLease || roleLease.role !== 'text' && roleLease.role !== 'translation') throw new ModelCapacityDeferredError('owner_unavailable');
  let initial = await prepareReasonTranslationDispatch(checked, lease, { roleLease, call });
  if (initial.kind === 'disabled') throw new ModelCapacityDeferredError('disabled');
  if (initial.kind === 'skipped') return initial;
  if (!('members' in initial)) throw new Error('reason_translation_preparation_invalid');
  let adopted: { requestId: string; state: 'waiting' | 'reserved' } | undefined;
  const own = await findOwnPendingReasonTranslationRequests({ owner: { instanceId: initial.role.instanceId, bootId: initial.role.bootId }, model: textTaskModel("reason-translate"), provider });
  for (const candidate of own) {
    if (options.signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
    if (pendingClaims?.requestIds.has(candidate.request.requestId)) continue;
    const recovered = await pendingReasonTranslationBatch(candidate.memberKeys);
    if (pendingClaims?.requestIds.has(candidate.request.requestId)) continue;
    if (!recovered) { await cancelOwnPendingReasonTranslationRequest(candidate); continue; }
    const recoveredCall = prepareReasonTranslationGatewayCall(recovered.map(item => item.body), { model: textTaskModel("reason-translate"), timeoutMs: options.timeoutMs, provider });
    if (recoveredCall.kind !== 'prepared') throw new ModelCapacityDeferredError('provider_contract_unavailable');
    const current = await prepareReasonTranslationDispatch(recovered, lease, { roleLease, call: recoveredCall });
    if (pendingClaims?.requestIds.has(candidate.request.requestId)) continue;
    if (current.kind === 'disabled') throw new ModelCapacityDeferredError('disabled');
    if (current.kind === 'skipped') { await cancelOwnPendingReasonTranslationRequest(candidate); continue; }
    if (!('members' in current)) throw new Error('reason_translation_preparation_invalid');
    const recoveredKey = `${reasonTranslationLogicalWorkKey(current.members)}:${reasonTranslationInputHash({ members: current.members, model: textTaskModel("reason-translate") })}`;
    if (candidate.request.workKey !== recoveredKey) { await cancelOwnPendingReasonTranslationRequest(candidate); continue; }
    // claim and adoption do not yield
    pendingClaims?.requestIds.add(candidate.request.requestId);
    checked = recovered; call = recoveredCall; initial = current;
    adopted = { requestId: candidate.request.requestId, state: candidate.state }; break;
  }
  const { members } = initial, logical = reasonTranslationLogicalWorkKey(members);
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: initial.role.instanceId, bootId: initial.role.bootId },
    class: 'background', pool: 'text', routeId: 'reason-translate', provider: call.provider, model: textTaskModel("reason-translate"),
    workKey: `${logical}:${reasonTranslationInputHash({ members, model: textTaskModel("reason-translate") })}` });
  const pending = adopted ?? await findOwnPendingModelRequest(identity);
  if (pending?.state === 'dispatched') throw new ModelCapacityDeferredError('dispatched');
  // 다른 줄이 이 틱에 이미 집은 요청이다 — 이 묶음만 넘긴다
  if (!adopted && pending && pendingClaims?.requestIds.has(pending.requestId)) throw new ModelCapacityDeferredError('work_busy');
  const requestId = pending?.requestId ?? randomUUID();
  pendingClaims?.requestIds.add(requestId);
  const slot = await requestReasonTranslationModelSlot({ ...identity, requestId }, members);
  if (slot.kind !== 'granted') throw new ModelCapacityDeferredError(slot.reason);
  let prepared: Awaited<ReturnType<typeof prepareReasonTranslationDispatch>>;
  try {
    if (options.signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
    prepared = await prepareReasonTranslationDispatch(checked, lease, { roleLease, call,
      reserved: { reservation: slot.reservation, identity, members, role: initial.role } });
  } catch (error) {
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'reason_translation_reservation_cleanup_failed'); }
    throw error;
  }
  if (prepared.kind !== 'ready' || !('dispatch' in prepared)) {
    await cancelReservedModelSlot(slot.reservation);
    return { kind: 'skipped' };
  }
  const { dispatch, expectation } = prepared;
  let response: Awaited<ReturnType<typeof translateWithReservedReasonGateway>>;
  try { response = await translateWithReservedReasonGateway(checked.map(item => item.body), dispatch, call,
    { signal: options.signal, timeoutMs: options.timeoutMs }); }
  catch (error) {
    try { await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: options.signal, error })); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'reason_translation_transport_cleanup_failed'); }
    throw error;
  }
  // Historical physical proof is reconciled even after the job/role has expired
  // or the business signal aborted. Only the later writer decides current duty.
  try {
    if (response.terminal) await reconcileReasonTranslationGatewayTerminal(response.terminal);
    else if (response.notStarted) await reconcileGatewayNotStarted(response.notStarted);
    // 0174: 공급자가 처리하지 않고 거절한 완결 응답(429·401·403) — 결과 미확정 대신 확정 실패로 정산해 칸을 바로 비운다
    else if (response.rejected) await reconcileGatewayHttpRejected(response.rejected);
    else await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: options.signal, timedOut: !response.result.ok && response.result.error === 'timeout' }));
  } catch (cleanup) {
    if (response.terminal || response.notStarted || response.rejected) await markUnsettledDispatch(dispatch);
    if (!response.result.ok) throw new AggregateError([response.result, cleanup], 'reason_translation_result_cleanup_failed');
    throw cleanup;
  }
  return { kind: 'ready', batch: checked, result: response.result, expectation, unknown: !response.terminal && !response.notStarted && !response.rejected };
}
