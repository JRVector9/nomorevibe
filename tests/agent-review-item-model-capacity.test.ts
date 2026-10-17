import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReviewInput, reviewHash } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { agentReviewBinding } from '@/lib/crawl/agent-review-ownership';
import { itemBindingHash } from '@/lib/jobs/items/types';
import type { CrawlCandidate, CrawlDocument, CrawlReviewAttempt } from '@/lib/db/schema';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { modelCapacityDispatchSchema } from '@/lib/llm/capacity';
const mocks = vi.hoisted(() => ({ pending: vi.fn(), request: vi.fn(), cancel: vi.fn(), unknown: vi.fn(), reconcile: vi.fn(),
  prepare: vi.fn(), native: vi.fn(), atomic: vi.fn(), claim: vi.fn(), load: vi.fn(), preparation: vi.fn(), observe: vi.fn(),
  renew: vi.fn(), record: vi.fn(), spam: vi.fn() }));
vi.mock('@/lib/llm/capacity-repository', () => ({ findOwnPendingModelRequest: mocks.pending, requestAi1ModelSlot: mocks.request,
  cancelReservedModelSlot: mocks.cancel, markModelDispatchIndeterminate: mocks.unknown, reconcileAi1ItemGatewayTerminal: mocks.reconcile,
  reconcileAi1GatewayTerminal: vi.fn() }));
vi.mock('@/lib/crawl/agent-review-gateway', () => ({ prepareAi1GatewayCall: mocks.prepare, reviewWithReservedAi1ItemGateway: mocks.native,
  reviewWithReservedAi1Gateway: vi.fn() }));
vi.mock('@/lib/crawl/agent-review-repository', async load => ({ ...await load<typeof import('@/lib/crawl/agent-review-repository')>(),
  claimConsumerItemAgentReviewWithModelReservation: mocks.atomic, claimConsumerItemAgentReview: mocks.claim,
  loadFirstReviewConsumerContext: mocks.load, observeAgentReviewItemDispatch: mocks.observe,
  renewAgentReviewItemOwnership: mocks.renew, recordAgentReview: mocks.record, recordConsumerSuspectedSpam: mocks.spam }));
vi.mock('@/lib/crawl/agent-review-preparation', () => ({ prepareAgentReview: mocks.preparation }));
vi.mock('@/lib/crawl/agent-review', async load => ({ ...await load<typeof import('@/lib/crawl/agent-review')>(),
  firstReviewer: () => ({ provider: 'abcllm', model: 'Exact Model' }) }));
import { AgentReviewItemModelReservationRequired } from '@/lib/crawl/agent-review-repository';
import { claimAgentReviewItemModelCapacity, reviewAgentReviewItemModelCapacity, abandonAgentReviewItemModelCapacity } from '@/lib/crawl/agent-review-model-capacity';
import { executeFirstReviewConsumerItem } from '@/lib/crawl/agent-review-item-lifecycle';
const owner = { instanceId: 'ai1-consumer-native-unit', bootId: randomUUID() };
function fixture() {
  const now = new Date(), settings = structuredClone({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'enforce' as const });
  const candidate = { id: 3, repo: 'ai1-native-unit/app', productUrl: 'https://ai1-native-unit.example', state: 'needs_review', decidedBy: 'auto', judgedAt: now, updatedAt: now } as CrawlCandidate;
  const document = { id: 5, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: 'Task application' }, pageMeta: { title: 'Tasks' } } as CrawlDocument;
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] });
  const context = { candidate, document, settings, input }, binding = agentReviewBinding(3, input, { provider: 'abcllm', model: 'Exact Model' });
  const intent = new AgentReviewItemModelReservationRequired({ context, provider: 'abcllm', model: 'Exact Model', owner });
  const reservation = { requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 1, policyHash: 'e'.repeat(64) };
  const call = Object.freeze({ kind: 'prepared' as const, model: 'Exact Model', inputHash: input.inputHash, wireHash: 'f'.repeat(64), servingContractHash: 'a'.repeat(64), totalTokenBound: 4096 });
  const lease = { stage: 'ai1' as const, workKey: 'ai1:3', binding, bindingHash: itemBindingHash(binding), owner,
    token: randomUUID(), stageEpoch: 1, itemEpoch: 1, leaseUntil: new Date(Date.now() + 90_000) };
  const receipt = { attemptId: 7, origin: 'fresh' as const, ownership: { kind: 'item' as const, lease } };
  const attempt = { id: 7, candidateId: 3, state: 'running', kind: 'automatic', leaseToken: lease.token,
    attemptNumber: 2, reusedFromAttemptId: null, outcome: null } as CrawlReviewAttempt;
  const dispatchBinding = { kind: 'ai1_item_gateway' as const, version: 1 as const, logicalWorkKey: 'ai1:3', attemptId: 7, review: binding,
    item: { workKey: lease.workKey, owner, token: lease.token, stageEpoch: 1, itemEpoch: 1, bindingHash: lease.bindingHash },
    routeId: 'crawl-agent-review' as const, provider: 'abcllm' as const, model: 'Exact Model', wireHash: call.wireHash,
    servingContractHash: call.servingContractHash, totalTokenBound: 4096, chargedTokens: 4096 };
  const dispatch = { ...modelCapacityDispatchSchema.parse(reservation), binding: dispatchBinding, bindingHash: reviewHash(dispatchBinding) };
  return { input, context, intent, receipt, attempt, dispatch, reservation, call };
}
function gate<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); void promise.catch(() => {}); return { promise, resolve, reject }; }
let value: ReturnType<typeof fixture>;
const success = { ok: true as const, outcome: { decision: 'approve' as const, reason: 'A deployed task application', evidenceIds: ['product'] }, usage: { inputTokens: 6, outputTokens: 2 } };
const terminal = Object.freeze({ kind: 'ai1_item_gateway_terminal' as const });
beforeEach(() => {
  vi.resetAllMocks(); value = fixture(); mocks.pending.mockResolvedValue(null); mocks.prepare.mockReturnValue(value.call);
  mocks.request.mockResolvedValue({ kind: 'granted', reservation: value.reservation }); mocks.cancel.mockResolvedValue(true);
  mocks.atomic.mockResolvedValue({ kind: 'claimed', receipt: value.receipt, attempt: value.attempt, dispatch: value.dispatch });
  mocks.load.mockResolvedValue({ kind: 'current', context: value.context }); mocks.preparation.mockResolvedValue({ provider: 'abcllm', model: 'Exact Model', spam: false });
  mocks.claim.mockRejectedValue(value.intent); mocks.observe.mockResolvedValue({ kind: 'current' }); mocks.renew.mockResolvedValue(value.receipt.ownership.lease);
  mocks.native.mockResolvedValue({ result: success, terminal }); mocks.reconcile.mockResolvedValue({ kind: 'settled' }); mocks.unknown.mockResolvedValue(true);
  mocks.record.mockResolvedValue({ applied: true, state: 'succeeded' }); mocks.spam.mockResolvedValue({ applied: true, state: 'succeeded' });
});
afterEach(() => vi.useRealTimers());
it('keeps strict cloned intent input serialization and rejects malformed identity', () => {
  expect(value.intent.intent.context.input).toEqual(value.input);
  expect(JSON.stringify(value.intent.intent.context.input)).toBe(JSON.stringify(value.input));
  expect(value.intent.intent.context.input).not.toBe(value.input);
  expect(Object.isFrozen(value.intent.intent.context.input.snapshot)).toBe(true);
  value.input.snapshot.product.name = 'changed'; expect(value.intent.intent.context.input.snapshot.product.name).not.toBe('changed');
  expect(() => new AgentReviewItemModelReservationRequired({ ...value.intent.intent, provider: 'grok-cli' as 'abcllm' })).toThrow();
});
it('refuses unsupported preparation before pending request or claim', async () => {
  mocks.prepare.mockReturnValue({ kind: 'unsupported', reason: 'provider_contract_unavailable' });
  await expect(claimAgentReviewItemModelCapacity(value.intent)).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  expect(mocks.pending).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.atomic).not.toHaveBeenCalled();
});
it('requires the genuine intent class rather than a reason or copied object', async () => {
  for (const fake of [new ModelCapacityDeferredError('reservation_required'), { ...value.intent }])
    await expect(claimAgentReviewItemModelCapacity(fake as AgentReviewItemModelReservationRequired)).rejects.toThrow('invalid_agent_review_item_model_intent');
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.pending).not.toHaveBeenCalled();
});
it('resumes the same pending request and binds the original owner candidate and input', async () => {
  const requestId = randomUUID(); mocks.pending.mockResolvedValue({ requestId, state: 'reserved' });
  expect((await claimAgentReviewItemModelCapacity(value.intent)).claim).toMatchObject({ kind: 'claimed', dispatch: value.dispatch });
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ requestId, owner, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review',
    provider: 'abcllm', model: 'Exact Model', workKey: `ai1:3:${value.receipt.ownership.lease.bindingHash}` }, 3);
  expect(mocks.atomic).toHaveBeenCalledExactlyOnceWith({ expected: value.intent.intent, reservation: value.reservation,
    identity: mocks.pending.mock.calls[0][0], call: value.call });
});
it('waiting and already unknown work cannot create an attempt or dispatch', async () => {
  mocks.request.mockResolvedValueOnce({ kind: 'deferred', reason: 'capacity' });
  await expect(claimAgentReviewItemModelCapacity(value.intent)).rejects.toMatchObject({ reason: 'capacity' });
  mocks.pending.mockResolvedValue({ requestId: randomUUID(), state: 'indeterminate' });
  await expect(claimAgentReviewItemModelCapacity(value.intent)).rejects.toMatchObject({ reason: 'dispatched' }); expect(mocks.atomic).not.toHaveBeenCalled();
});
it('cancels an unused reservation if current work becomes skipped or reused', async () => {
  mocks.atomic.mockResolvedValueOnce({ kind: 'skipped', reason: 'running' });
  expect((await claimAgentReviewItemModelCapacity(value.intent)).claim).toEqual({ kind: 'skipped', reason: 'running' });
  mocks.atomic.mockResolvedValueOnce({ kind: 'reused', attempt: value.attempt, receipt: { ...value.receipt, origin: 'direct_reuse' } });
  expect((await claimAgentReviewItemModelCapacity(value.intent)).claim.kind).toBe('reused'); expect(mocks.cancel).toHaveBeenCalledTimes(2);
  expect(mocks.native).not.toHaveBeenCalled();
});
it('commit acknowledgement failure stays primary and only cancels an original reserved CAS', async () => {
  const original = new Error('commit ack unknown'), cleanup = new Error('reservation cancel'); mocks.atomic.mockRejectedValue(original);
  await expect(claimAgentReviewItemModelCapacity(value.intent)).rejects.toBe(original); expect(mocks.native).not.toHaveBeenCalled();
  mocks.cancel.mockRejectedValue(cleanup); const error = await claimAgentReviewItemModelCapacity(value.intent).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([original, cleanup]);
});
it('awaits physical historical terminal reconciliation before returning the original business result', async () => {
  const settled = gate<unknown>(); mocks.reconcile.mockReturnValue(settled.promise); let done = false;
  const run = reviewAgentReviewItemModelCapacity(value.input, value.dispatch, value.call, {}).finally(() => { done = true; });
  try { await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(terminal)); expect(done).toBe(false); }
  finally { settled.resolve({ kind: 'settled' }); expect(await run).toBe(success); }
  expect(mocks.unknown).not.toHaveBeenCalled();
});
it('EOF without terminal keeps original full charge unknown', async () => {
  const failure = { ok: false, error: 'invalid_output', detail: 'invalid_native_terminal' }; mocks.native.mockResolvedValue({ result: failure, terminal: null });
  expect(await reviewAgentReviewItemModelCapacity(value.input, value.dispatch, value.call, {})).toBe(failure);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(value.dispatch, 'transport_unknown');
});
it('preserves native failure identity and a second ledger cleanup error', async () => {
  const original = new Error('native'), cleanup = new Error('ledger'); mocks.native.mockRejectedValue(original);
  await expect(reviewAgentReviewItemModelCapacity(value.input, value.dispatch, value.call, {})).rejects.toBe(original);
  mocks.unknown.mockRejectedValue(cleanup); const error = await reviewAgentReviewItemModelCapacity(value.input, value.dispatch, value.call, {}).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([original, cleanup]);
});
it('preserves failed business output together with reconciliation failure', async () => {
  const failure = { ok: false, error: 'invalid_output' }, cleanup = new Error('settlement');
  mocks.native.mockResolvedValue({ result: failure, terminal }); mocks.reconcile.mockRejectedValue(cleanup);
  const error = await reviewAgentReviewItemModelCapacity(value.input, value.dispatch, value.call, {}).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([failure, cleanup]);
});
it('abandon marks historical indeterminate and never refunds a reservation', async () => {
  expect(await abandonAgentReviewItemModelCapacity(value.dispatch)).toBe(true);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(value.dispatch, 'local_abort'); expect(mocks.cancel).not.toHaveBeenCalled();
});
it('waits for atomic commit then one native call then terminal before the mandatory writer', async () => {
  const commit = gate<unknown>(), order: string[] = []; mocks.atomic.mockReturnValue(commit.promise);
  mocks.native.mockImplementation(async () => { order.push('native'); return { result: success, terminal }; });
  mocks.reconcile.mockImplementation(async () => { order.push('settled'); return { kind: 'settled' }; });
  mocks.record.mockImplementation(async () => { order.push('writer'); return { applied: true, state: 'succeeded' }; });
  const run = executeFirstReviewConsumerItem({ candidateId: 3, owner }); void run.catch(() => {});
  try { await vi.waitFor(() => expect(mocks.atomic).toHaveBeenCalledOnce()); expect(mocks.native).not.toHaveBeenCalled(); }
  finally { commit.resolve({ kind: 'claimed', receipt: value.receipt, attempt: value.attempt, dispatch: value.dispatch }); await run; }
  expect(order).toEqual(['native', 'settled', 'writer']); expect(mocks.record.mock.calls[0][0]).toMatchObject({ receipt: value.receipt, outcome: success.outcome, usage: success.usage });
});
it('current source change keeps dispatch unknown and uses original cancelled writer', async () => {
  mocks.observe.mockResolvedValue({ kind: 'changed' }); await executeFirstReviewConsumerItem({ candidateId: 3, owner });
  expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(value.dispatch, 'local_abort');
  expect(mocks.record.mock.calls[0][0]).toMatchObject({ receipt: value.receipt, error: 'cancelled' });
});
it('caller abort drains native and terminal before preserving the AI1 cancellation writer', async () => {
  const abort = new AbortController(), native = gate<unknown>(), settled = gate<unknown>(); mocks.native.mockReturnValue(native.promise); mocks.reconcile.mockReturnValue(settled.promise);
  const run = executeFirstReviewConsumerItem({ candidateId: 3, owner, signal: abort.signal }); void run.catch(() => {});
  try { await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledOnce()); abort.abort(); expect(mocks.record).not.toHaveBeenCalled();
    native.resolve({ result: success, terminal }); await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce()); expect(mocks.record).not.toHaveBeenCalled(); }
  finally { native.resolve({ result: success, terminal }); settled.resolve({ kind: 'settled' }); await run; }
  expect(mocks.record.mock.calls[0][0].error).toBe('cancelled'); expect(mocks.native.mock.calls[0][3].signal.aborted).toBe(true);
});
it('heartbeat remains active through terminal reconciliation and drains its current renewal before writer', async () => {
  vi.useFakeTimers(); const settled = gate<unknown>(), renewed = gate<unknown>(); mocks.reconcile.mockReturnValue(settled.promise); mocks.renew.mockReturnValue(renewed.promise);
  const run = executeFirstReviewConsumerItem({ candidateId: 3, owner }); void run.catch(() => {});
  try { await vi.advanceTimersByTimeAsync(15_000); expect(mocks.reconcile).toHaveBeenCalledOnce(); expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(value.context, value.receipt, 90_000);
    settled.resolve({ kind: 'settled' }); await vi.advanceTimersByTimeAsync(0); expect(mocks.record).not.toHaveBeenCalled(); }
  finally { settled.resolve({ kind: 'settled' }); renewed.resolve(value.receipt.ownership.lease); await run; }
  expect(mocks.record).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(60_000); expect(mocks.renew).toHaveBeenCalledOnce();
});
it('renewal loss aborts transport but waits for its actual settlement', async () => {
  vi.useFakeTimers(); const native = gate<unknown>(); mocks.native.mockReturnValue(native.promise); mocks.renew.mockResolvedValue(null);
  const run = executeFirstReviewConsumerItem({ candidateId: 3, owner }); void run.catch(() => {});
  try { await vi.advanceTimersByTimeAsync(15_000); expect(mocks.native.mock.calls[0][3].signal.aborted).toBe(true); expect(mocks.record).not.toHaveBeenCalled(); }
  finally { native.resolve({ result: success, terminal }); await run; }
  expect(mocks.reconcile).toHaveBeenCalledOnce(); expect(mocks.record.mock.calls[0][0].error).toBe('cancelled');
});
it('unexpected renewal failure drains terminal then propagates its original error without writer', async () => {
  vi.useFakeTimers(); const native = gate<unknown>(), original = new Error('renew'); mocks.native.mockReturnValue(native.promise); mocks.renew.mockRejectedValue(original);
  const run = executeFirstReviewConsumerItem({ candidateId: 3, owner }); void run.catch(() => {});
  await vi.advanceTimersByTimeAsync(15_000); native.resolve({ result: success, terminal });
  await expect(run).rejects.toBe(original); expect(mocks.reconcile).toHaveBeenCalledOnce(); expect(mocks.record).not.toHaveBeenCalled();
});
it('native throw stays primary even when a renewal also failed', async () => {
  vi.useFakeTimers(); const native = gate<unknown>(), original = new Error('native'), renewal = new Error('renew'); mocks.native.mockReturnValue(native.promise); mocks.renew.mockRejectedValue(renewal);
  const run = executeFirstReviewConsumerItem({ candidateId: 3, owner }); void run.catch(() => {});
  await vi.advanceTimersByTimeAsync(15_000); native.reject(original); await expect(run).rejects.toBe(original); expect(mocks.record).not.toHaveBeenCalled();
});
it('failed AI1 business output keeps original exponential retry mapping and MAX3 policy untouched', async () => {
  const failure = { ok: false, error: 'timeout', usage: { inputTokens: 6, outputTokens: 2 } }; mocks.native.mockResolvedValue({ result: failure, terminal: null });
  const before = Date.now(); await executeFirstReviewConsumerItem({ candidateId: 3, owner }); const written = mocks.record.mock.calls[0][0];
  expect(written.error).toBe('timeout'); expect(written.usage).toEqual(failure.usage); expect(written.retryAfter.getTime()).toBeGreaterThanOrEqual(before + 120_000);
  expect(written.retryAfter.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
});
it('reused and server rules retain their original writers without capacity or native calls', async () => {
  mocks.claim.mockResolvedValueOnce({ kind: 'reused', attempt: { ...value.attempt, outcome: success.outcome }, receipt: { ...value.receipt, origin: 'direct_reuse' } });
  await executeFirstReviewConsumerItem({ candidateId: 3, owner }); expect(mocks.record.mock.calls[0][0].outcome).toBe(success.outcome);
  mocks.preparation.mockResolvedValue({ provider: 'rules', model: 'rules-version', spam: true });
  mocks.claim.mockResolvedValueOnce({ kind: 'claimed', attempt: value.attempt, receipt: value.receipt }); await executeFirstReviewConsumerItem({ candidateId: 3, owner });
  expect(mocks.spam).toHaveBeenCalledOnce(); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it('preserves a returned native failure together with an unexpected renewal error', async () => {
  vi.useFakeTimers(); const native = gate<unknown>(), renewal = new Error('renew');
  const failure = Object.freeze({ ok: false as const, error: 'timeout' as const, usage: success.usage });
  mocks.native.mockReturnValue(native.promise); mocks.renew.mockRejectedValue(renewal);
  const run = executeFirstReviewConsumerItem({ candidateId: 3, owner }); const rejected = run.catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.native.mock.calls[0][3].signal.aborted).toBe(true); expect(mocks.record).not.toHaveBeenCalled();
    native.resolve({ result: failure, terminal: null }); const error = await rejected;
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(failure); expect(error.errors[1]).toBe(renewal);
    expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(value.dispatch, 'local_abort'); expect(mocks.record).not.toHaveBeenCalled();
  } finally { native.resolve({ result: failure, terminal: null }); await Promise.allSettled([run]); }
});
