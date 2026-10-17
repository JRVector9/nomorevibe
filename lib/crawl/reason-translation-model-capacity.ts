import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readModelCapacityCallerControl, findOwnPendingModelRequest, requestReasonTranslationModelSlot,
  cancelReservedModelSlot, markModelDispatchIndeterminate, reconcileReasonTranslationGatewayTerminal } from '@/lib/llm/capacity-repository';
import { markUnsettledDispatch } from '@/lib/llm/capacity-unsettled';
import { reasonTranslationInputHash, reasonTranslationLogicalWorkKey, modelCapacityRequestIdentitySchema } from '@/lib/llm/capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { TRANSLATE_MODEL, textHash, translateToKorean, type TranslateResult } from './translate';
import { prepareReasonTranslationDispatch, type PendingTranslation, type ReasonTranslationWriteExpectation } from './translations';
import { prepareReasonTranslationGatewayCall, translateWithReservedReasonGateway } from './agent-review-gateway';
import type { JobLease } from '@/lib/jobs/control';
import { roleLeaseFromEnv, type RoleLease } from '@/lib/jobs/role-leader';

type Options = { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease };
export type ReasonTranslationCapacityResult = { kind: 'disabled'; result: TranslateResult } | { kind: 'skipped' }
  | { kind: 'ready'; result: TranslateResult; expectation: ReasonTranslationWriteExpectation; unknown: boolean };

/** Each queue API uses a short primary TX. No DB connection is held while native
 * transport or its body is pending, and local cancellation never refunds C. */
export async function translateReasonsWithModelCapacity(value: readonly PendingTranslation[], job: JobLease,
  valueOptions: Options): Promise<ReasonTranslationCapacityResult> {
  const batch = structuredClone(value), lease = structuredClone(job);
  const options = { signal: valueOptions.signal, timeoutMs: valueOptions.timeoutMs,
    roleLease: valueOptions.roleLease && structuredClone(valueOptions.roleLease) };
  // Capture only the owner tuple before awaiting; disabled never parses a new
  // role requirement. No missing owner is replaced by a generated boot.
  const env = Object.fromEntries(['ROLE_LEASE_ROLE','ROLE_LEASE_INSTANCE_ID','ROLE_LEASE_BOOT_ID','ROLE_LEASE_RELEASE',
    'ROLE_LEASE_EPOCH','ROLE_LEASE_BATCH_VERSION','ROLE_LEASE_BATCH_EPOCH','ROLE_LEASE_HOST'].map(key => [key, process.env[key]]));
  const legacy = async () => ({ kind: 'disabled' as const,
    result: await translateToKorean(batch.map(item => item.body), options.timeoutMs, undefined, options.signal) });
  if (!process.env.ABCLLM_API_KEY?.trim()) return legacy();
  const control = await readModelCapacityCallerControl();
  if (control.mode === 'disabled') return legacy();
  if (control.mode === 'draining') throw new ModelCapacityDeferredError('draining');
  if (control.mode !== 'open') throw new Error('model_capacity_control_invalid');
  if (!control.policy?.routes.some(route => route.routeId === 'reason-translate' && route.provider === 'abcllm' && route.model === TRANSLATE_MODEL))
    throw new ModelCapacityDeferredError('unmapped');
  const checked = z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), body: z.string(),
    attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()).min(1).max(4).parse(batch);
  if (new Set(checked.map(item => item.hash)).size !== checked.length || checked.some(item => textHash(item.body) !== item.hash))
    throw new Error('invalid_reason_translation_batch');
  const call = prepareReasonTranslationGatewayCall(checked.map(item => item.body), { model: TRANSLATE_MODEL, timeoutMs: options.timeoutMs });
  if (call.kind !== 'prepared') throw new ModelCapacityDeferredError('provider_contract_unavailable');
  const roleLease = options.roleLease ?? (env.ROLE_LEASE_ROLE === 'text' || env.ROLE_LEASE_ROLE === 'translation'
    ? roleLeaseFromEnv(env.ROLE_LEASE_ROLE, env) : undefined);
  if (!roleLease || roleLease.role !== 'text' && roleLease.role !== 'translation') throw new ModelCapacityDeferredError('owner_unavailable');
  const initial = await prepareReasonTranslationDispatch(checked, lease, { roleLease, call });
  if (initial.kind === 'disabled') return legacy();
  if (initial.kind === 'skipped') return initial;
  if (!('members' in initial)) throw new Error('reason_translation_preparation_invalid');
  const { members } = initial, logical = reasonTranslationLogicalWorkKey(members);
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: initial.role.instanceId, bootId: initial.role.bootId },
    class: 'background', pool: 'text', routeId: 'reason-translate', provider: 'abcllm', model: TRANSLATE_MODEL,
    workKey: `${logical}:${reasonTranslationInputHash({ members, model: TRANSLATE_MODEL })}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === 'dispatched' || pending.state === 'indeterminate')) throw new ModelCapacityDeferredError('dispatched');
  const slot = await requestReasonTranslationModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, members);
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
    try { await markModelDispatchIndeterminate(dispatch, options.signal?.aborted ? 'local_abort' : 'transport_unknown'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'reason_translation_transport_cleanup_failed'); }
    throw error;
  }
  // Historical physical proof is reconciled even after the job/role has expired
  // or the business signal aborted. Only the later writer decides current duty.
  try {
    if (response.terminal) await reconcileReasonTranslationGatewayTerminal(response.terminal);
    else await markModelDispatchIndeterminate(dispatch, options.signal?.aborted ? 'local_abort' : 'transport_unknown');
  } catch (cleanup) {
    if (response.terminal) await markUnsettledDispatch(dispatch);
    if (!response.result.ok) throw new AggregateError([response.result, cleanup], 'reason_translation_result_cleanup_failed');
    throw cleanup;
  }
  return { kind: 'ready', result: response.result, expectation, unknown: response.terminal === null };
}
