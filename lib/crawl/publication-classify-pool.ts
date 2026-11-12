import { randomUUID } from 'node:crypto';
import { bindApiTaskRank } from '@/lib/llm/ai-task-resolver';
import type { AiTaskExecutionConfig } from '@/lib/llm/ai-task-execution-config';
import { chooseTaskWorkloadMember } from '@/lib/llm/ai-task-workload-selector';
import { ensureServingContracts } from '@/lib/llm/serving-contract-store';
import { runInTextTaskRank } from '@/lib/llm/ai-task-rank-scope';
import { publicationClassifyApiInputHash, publicationClassifyLogicalWorkKey, modelCapacityIndeterminateReason,
  modelCapacityRequestIdentitySchema } from '@/lib/llm/capacity';
import { readModelCapacityControlObservation, findOwnPendingModelRequest, requestPublicationApiSlot, cancelReservedModelSlot, cancelOwnPendingPublicationApiBatch, reconcilePublicationApiTerminal,
  reconcileGatewayNotStarted, markModelDispatchIndeterminate, type OwnPendingPublicationApiBatch } from '@/lib/llm/capacity-repository';
import { markUnsettledDispatch } from '@/lib/llm/capacity-unsettled';
import { capacityRefusalReason } from '@/lib/llm/capacity-busy-targets';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import type { JobContext } from '@/lib/jobs/runner';
import { roleLeaseFromEnv } from '@/lib/jobs/role-leader';
import { dispatchPublicationApi, publicationApiSources, type PublicationClassificationExpected } from './publication-classify-capacity';
import { preparePublicationClassifyCall, runPublicationClassifyCall } from './publication-classify-gateway';
import { reviewHash } from './agent-review-contract';
import type { ClassifyInput } from './classify';
import type { CategoryDefinitions } from './settings-schema';
import '@/lib/llm/publication-classify-serving-contract';

/** One distinct publication input batch selects one API route. Selection is a hint, never a dispatch permit. */
export async function classifyPublicationPool(expected: readonly PublicationClassificationExpected[], payload: { inputs: ClassifyInput[]; definitions: CategoryDefinitions },
  config: AiTaskExecutionConfig, ctx: JobContext<null>, resume?: OwnPendingPublicationApiBatch) {
  const abandonResume = async () => {
    const owner = roleLeaseFromEnv('publisher', process.env);
    if (resume && owner) await cancelOwnPendingPublicationApiBatch(resume, { instanceId: owner.instanceId, bootId: owner.bootId });
  };
  if (!ctx.lease || config.task !== 'publish-classify' || config.mode !== 'workload_pool' || config.revision === null) {
    await abandonResume();
    throw new ModelCapacityDeferredError('assignments_unavailable');
  }
  // Observe mode without the slot-only early throw so exact unstarted cleanup can run.
  // API pool never enters legacy; admission/dispatch still recheck control under lock.
  const control = await readModelCapacityControlObservation();
  if (control.mode !== 'open') {
    await abandonResume();
    throw new ModelCapacityDeferredError(control.mode === 'disabled' ? 'disabled' : 'draining');
  }
  await ensureServingContracts();
  const lease = ctx.lease, initial = await publicationApiSources(expected, payload, lease).catch(async error => {
    if (error instanceof ModelCapacityDeferredError && error.reason === 'reservation_lost') await abandonResume();
    throw error;
  });
  const candidates = config.members.flatMap(member => {
    const rank = { task: config.task, slot: 1, rank: 0, model: member.model, enabled: true, options: member.options, connection: member.connection };
    const resolved = bindApiTaskRank('crawl-publish-classify', rank), binding = resolved.binding;
    if (!binding) { ctx.log('ai_task.ranks', { pool_members: config.members.length, pool_revision: config.revision!,
      [`member_unusable.${member.memberId}.${resolved.unusable ?? 'provider_contract_unavailable'}`]: 1 }); return []; }
    const input = { members: initial.members, provider: binding.provider, model: binding.identity, payloadHash: reviewHash(payload.inputs),
      definitionsHash: reviewHash(payload.definitions), configRevision: config.revision!, memberId: member.memberId };
    const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: initial.publisherRole.instanceId, bootId: initial.publisherRole.bootId },
      class: 'background', pool: 'reviewer', routeId: 'crawl-publish-classify', provider: binding.provider, model: binding.identity,
      workKey: `${publicationClassifyLogicalWorkKey(initial.members)}:${publicationClassifyApiInputHash(input)}` });
    return [{ ...binding, memberId: member.memberId, input, requestIdentity: identity }];
  });
  const resumed = resume && candidates.find(candidate => candidate.provider === resume.provider && candidate.identity === resume.model
    && candidate.requestIdentity.workKey === resume.workKey
    && publicationClassifyLogicalWorkKey(initial.members) === resume.logicalWorkKey);
  // A changed source/payload/member/config is never rebound to the old reservation or a newly selected route.
  if (resume && !resumed) { await abandonResume(); throw new ModelCapacityDeferredError('reservation_lost'); }
  // Restore an exact own waiting/reserved identity before considering a newly idle connection.
  const pending = await Promise.all(candidates.map(async candidate => ({ candidate, row: await findOwnPendingModelRequest(candidate.requestIdentity) })));
  if (pending.some(item => item.row?.state === 'dispatched')) throw new ModelCapacityDeferredError('dispatched');
  const own = pending.filter(item => item.row && ['waiting', 'reserved'].includes(item.row.state));
  if (own.length > 1) throw new ModelCapacityDeferredError('ledger_mismatch');
  if (resume && !own.some(item => item.candidate === resumed && item.row?.requestId === resume.requestId)) {
    await abandonResume();
    throw new ModelCapacityDeferredError('reservation_lost');
  }
  // 빈 칸이 없으면 줄에 설 구성원을 고른다 — requestSlot 이 대기 행을 쓰고 다음 틱이 그 묶음을 이어받는다(findOwnPendingPublicationApiBatches).
  // 한 틱에 줄에 서는 묶음은 첫 미룸까지다(발행 잡이 그 뒤로는 묻지 않는다 — publish.ts classificationSaturated). 2026-11-12 검토
  const choice = await chooseTaskWorkloadMember(config, candidates, { preferIdentity: own[0]?.candidate.identity, preferMemberId: own[0]?.candidate.memberId,
    queueWhenFull: true });
  if (!choice) throw new ModelCapacityDeferredError(candidates.length ? 'capacity' : 'provider_contract_unavailable');
  return runInTextTaskRank({ ...choice, poolSelection: choice.poolSelection }, async () => {
    if (!ctx.hasBudget() || ctx.signal?.aborted) throw new ModelCapacityDeferredError('reservation_lost');
    const timeoutMs = Math.max(1, Math.min(60_000, (ctx.deadlineAt ?? Date.now() + 60_000) - Date.now()));
    const call = preparePublicationClassifyCall(payload, { model: choice.identity, provider: choice.provider, timeoutMs });
    if (call.kind !== 'prepared') throw new ModelCapacityDeferredError(call.reason);
    const row = pending.find(item => item.candidate.memberId === choice.memberId)?.row;
    const request = { ...choice.requestIdentity, requestId: row?.requestId ?? randomUUID() };
    const slot = await requestPublicationApiSlot(request, choice.input);
    if (slot.kind !== 'granted') throw new ModelCapacityDeferredError(await capacityRefusalReason(request, slot.reason));
    let dispatch: Awaited<ReturnType<typeof dispatchPublicationApi>>;
    try { dispatch = await dispatchPublicationApi(expected, payload, lease, initial, choice.input, call, slot.reservation, choice.requestIdentity); }
    catch (error) { try { await cancelReservedModelSlot(slot.reservation); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'publication_api_reservation_cleanup_failed'); } throw error; }
    let result: Awaited<ReturnType<typeof runPublicationClassifyCall>>;
    try { result = await runPublicationClassifyCall(payload, dispatch, call, { signal: ctx.signal, canStart: ctx.hasBudget }); }
    catch (error) { try { if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: ctx.signal, error })))
      throw new Error('publication_api_dispatch_not_marked'); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'publication_api_transport_cleanup_failed'); } throw error; }
    try {
      if (result.terminal) await reconcilePublicationApiTerminal(result.terminal);
      else if (result.notStarted) await reconcileGatewayNotStarted(result.notStarted);
      else if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: ctx.signal })))
        throw new Error('publication_api_dispatch_not_marked');
    } catch (error) { if (result.terminal || result.notStarted) await markUnsettledDispatch(dispatch); throw error; }
    if (!result.terminal) throw new ModelCapacityDeferredError(result.notStarted ? 'provider_contract_unavailable' : 'dispatched');
    ctx.log('ai_task.ranks', { pool_members: config.members.length, pool_revision: config.revision!,
      ...(result.categories ? { [`member_served.${choice.memberId}`]: result.categories.length } : { [`member_unusable.${choice.memberId}.engine_failed`]: 1 }) });
    return result.categories ?? payload.inputs.map(() => null);
  });
}
