import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import type { CrawlCandidate, CrawlDocument, SecondReview } from '@/lib/db/schema';
import { itemBindingHash, type Ai2ItemBinding } from '@/lib/jobs/items/types';
import { ai2DispatchBindingHash, ai2ModelDispatchSchema } from '@/lib/llm/capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
const mocks = vi.hoisted(() => ({ pending: vi.fn(), request: vi.fn(), cancel: vi.fn(), unknown: vi.fn(), reconcile: vi.fn(),
  prepare: vi.fn(), native: vi.fn(), atomic: vi.fn(), compatibility: vi.fn(), consumer: vi.fn(), observe: vi.fn(), renew: vi.fn(), record: vi.fn(), transport: vi.fn() }));
vi.mock('@/lib/llm/capacity-repository', () => ({ findOwnPendingModelRequest: mocks.pending, requestAi2ItemModelSlot: mocks.request,
  cancelReservedModelSlot: mocks.cancel, markModelDispatchIndeterminate: mocks.unknown, reconcileAi2GatewayTerminal: mocks.reconcile }));
vi.mock('@/lib/crawl/agent-review-gateway', () => ({ prepareAi2GatewayCall: mocks.prepare, reviewWithReservedAi2Gateway: mocks.native }));
vi.mock('@/lib/crawl/second-review-ownership', async load => ({ ...await load<typeof import('@/lib/crawl/second-review-ownership')>(),
  claimSecondReviewItemWithModelReservation: mocks.atomic, claimItemSecondReview: mocks.compatibility, claimConsumerItemSecondReview: mocks.consumer,
  observeSecondReviewItemDispatch: mocks.observe, renewSecondReviewOwnership: mocks.renew }));
vi.mock('@/lib/crawl/second-review', () => ({ recordSecondReview: mocks.record }));
vi.mock('@/lib/crawl/second-review-transport', () => ({ dispatchSecondReviewTransport: mocks.transport, secondReviewTransportTimeoutMs: () => 60_000 }));
import { SecondReviewModelReservationRequired } from '@/lib/crawl/second-review-ownership';
import { claimSecondReviewModelCapacity, reviewSecondReviewModelCapacity, abandonSecondReviewModelCapacity } from '@/lib/crawl/second-review-model-capacity';
import { executeSecondReviewConsumerItem, executeSecondReviewItem } from '@/lib/crawl/second-review-item-lifecycle';
const owner = { instanceId: 'ai2-native-unit', bootId: randomUUID() };
function fixture() {
  const now = new Date(), settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'enforce' as const };
  const candidate = { id: 3, repo: 'native-unit/app', productUrl: 'https://native-unit.example', state: 'approved', decidedBy: 'auto', judgedAt: now, updatedAt: now } as CrawlCandidate;
  const document = { id: 5, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: now, pageStatus: 200, repoMeta: { description: 'A task application' }, pageMeta: { title: 'Tasks' } } as CrawlDocument;
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] });
  const binding: Ai2ItemBinding = { stage: 'ai2', secondReviewId: 8, candidateId: 3, source: { kind: 'first_attempt', firstAttemptId: 7 },
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: 'c'.repeat(64), promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    reviewer: { provider: 'abcllm', model: 'Exact Model' }, generationKey: 'd'.repeat(64), vote: 8, fallbackForId: null };
  const row = { id: 8, candidateId: 3, firstAttemptId: 7, fallbackForId: null, generationKey: binding.generationKey, provider: 'abcllm', model: 'Exact Model', failureCount: 0 } as SecondReview;
  const intent = new SecondReviewModelReservationRequired({ binding, input, rowIdentityHash: 'b'.repeat(64), failureCount: 0, owner });
  const reservation = { requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 1, policyHash: 'e'.repeat(64) };
  const call = Object.freeze({ kind: 'prepared' as const, model: 'Exact Model', inputHash: input.inputHash, wireHash: 'f'.repeat(64), servingContractHash: 'a'.repeat(64), totalTokenBound: 4096 });
  const lease = { stage: 'ai2' as const, workKey: 'ai2:8', binding, bindingHash: itemBindingHash(binding), owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1, leaseUntil: new Date(Date.now() + 90_000) };
  const receipt = { binding, rowIdentityHash: intent.intent.rowIdentityHash, ownership: { kind: 'item' as const, lease } };
  const dispatchBinding = { kind: 'ai2_item_gateway' as const, version: 1 as const, logicalWorkKey: 'ai2:3:8', review: binding,
    rowIdentityHash: intent.intent.rowIdentityHash, failureCount: 0, inputPolicyHash: input.policyHash, item: { workKey: lease.workKey, bindingHash: lease.bindingHash, owner, token: lease.token, stageEpoch: 1, itemEpoch: 1 },
    routeId: 'second-review' as const, provider: 'abcllm' as const, model: 'Exact Model', wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: 4096, chargedTokens: 4096 };
  const dispatch = ai2ModelDispatchSchema.parse({ ...reservation, binding: dispatchBinding, bindingHash: ai2DispatchBindingHash(dispatchBinding) });
  return { input, intent, row, receipt, call, dispatch, reservation };
}
let value: ReturnType<typeof fixture>;
const success = { ok: true as const, outcome: { decision: 'approve' as const, reason: 'Deployed application', evidenceIds: ['product'] } };
const terminal = Object.freeze({ kind: 'ai2_gateway_terminal' as const });
function gate<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.resetAllMocks(); value = fixture(); mocks.prepare.mockReturnValue(value.call); mocks.pending.mockResolvedValue(null);
  mocks.request.mockResolvedValue({ kind: 'granted', reservation: value.reservation });
  mocks.atomic.mockResolvedValue({ kind: 'claimed', row: value.row, input: value.input, receipt: value.receipt, dispatch: value.dispatch });
  mocks.compatibility.mockRejectedValue(value.intent); mocks.consumer.mockRejectedValue(value.intent);
  mocks.observe.mockResolvedValue({ kind: 'current', row: value.row, input: value.input }); mocks.renew.mockResolvedValue(value.receipt.ownership.lease);
  mocks.native.mockResolvedValue({ result: success, terminal }); mocks.reconcile.mockResolvedValue({ kind: 'settled' }); mocks.unknown.mockResolvedValue(true);
  mocks.cancel.mockResolvedValue(true); mocks.record.mockResolvedValue({ state: 'recorded' }); mocks.transport.mockResolvedValue(success);
});
afterEach(() => vi.useRealTimers());
it('does not allocate or dispatch when the production preparation remains unsupported', async () => {
  mocks.prepare.mockReturnValue({ kind: 'unsupported', reason: 'provider_contract_unavailable' });
  await expect(claimSecondReviewModelCapacity(value.intent)).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  expect(mocks.pending).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it('rejects a reason-only or copied intent before preparation or SQL', async () => {
  for (const forged of [new ModelCapacityDeferredError('reservation_required'), { ...value.intent }])
    await expect(claimSecondReviewModelCapacity(forged as SecondReviewModelReservationRequired)).rejects.toThrow('invalid_second_review_model_intent');
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
});
it('resumes the original pending ID and binds only actual owner/chain/input identity', async () => {
  const id = randomUUID(); mocks.pending.mockResolvedValue({ requestId: id, state: 'reserved' });
  expect((await claimSecondReviewModelCapacity(value.intent)).claim).toMatchObject({ kind: 'claimed', dispatch: value.dispatch });
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ requestId: id, owner, class: 'second', pool: 'reviewer', routeId: 'second-review', provider: 'abcllm', model: 'Exact Model',
    workKey: `ai2:3:8:${itemBindingHash(value.intent.intent.binding)}` }, { candidateId: 3, vote: 8 });
  expect(mocks.atomic).toHaveBeenCalledExactlyOnceWith({ secondReviewId: 8, owner, expected: value.intent.intent, reservation: value.reservation, identity: mocks.pending.mock.calls[0][0], call: value.call });
});
it('waiting and an existing unknown dispatch defer without an item claim', async () => {
  mocks.request.mockResolvedValueOnce({ kind: 'deferred', reason: 'capacity' });
  await expect(claimSecondReviewModelCapacity(value.intent)).rejects.toMatchObject({ reason: 'capacity' });
  mocks.pending.mockResolvedValue({ requestId: randomUUID(), state: 'indeterminate' });
  await expect(claimSecondReviewModelCapacity(value.intent)).rejects.toMatchObject({ reason: 'dispatched' });
  expect(mocks.atomic).not.toHaveBeenCalled();
});
it('cancels only the original reservation after a skipped or failed atomic claim', async () => {
  mocks.atomic.mockResolvedValueOnce({ kind: 'skipped', reason: 'input_changed' });
  expect((await claimSecondReviewModelCapacity(value.intent)).claim).toEqual({ kind: 'skipped', reason: 'input_changed' });
  const original = new Error('actual claim SQL failure'); mocks.atomic.mockRejectedValueOnce(original);
  await expect(claimSecondReviewModelCapacity(value.intent)).rejects.toBe(original);
  expect(mocks.cancel).toHaveBeenCalledTimes(2); expect(mocks.cancel.mock.calls[0][0]).toEqual(value.reservation);
});
it('preserves both the atomic error and actual cancellation failure', async () => {
  const original = new Error('claim'), cleanup = new Error('cancel'); mocks.atomic.mockRejectedValue(original); mocks.cancel.mockRejectedValue(cleanup);
  const error = await claimSecondReviewModelCapacity(value.intent).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([original, cleanup]);
});
it('physical terminal settlement is awaited before returning its business result', async () => {
  const settle = gate<{ kind: string }>(); mocks.reconcile.mockReturnValue(settle.promise); let done = false;
  const running = reviewSecondReviewModelCapacity(value.input, value.dispatch, value.call, {}).finally(() => { done = true; });
  try { await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(terminal)); expect(done).toBe(false); }
  finally { settle.resolve({ kind: 'settled' }); await running; }
  expect(mocks.unknown).not.toHaveBeenCalled();
});
it('EOF/no-terminal preserves the full original dispatch as unknown', async () => {
  const result = { ok: false, error: 'invalid_output', detail: 'invalid_native_terminal' }; mocks.native.mockResolvedValue({ result, terminal: null });
  expect(await reviewSecondReviewModelCapacity(value.input, value.dispatch, value.call, {})).toBe(result);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(value.dispatch, 'transport_unknown'); expect(mocks.reconcile).not.toHaveBeenCalled();
});
it('unexpected native failure remains primary and preserves a second ledger failure', async () => {
  const original = new Error('native'), cleanup = new Error('ledger'); mocks.native.mockRejectedValue(original);
  await expect(reviewSecondReviewModelCapacity(value.input, value.dispatch, value.call, {})).rejects.toBe(original);
  mocks.unknown.mockRejectedValue(cleanup);
  const error = await reviewSecondReviewModelCapacity(value.input, value.dispatch, value.call, {}).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([original, cleanup]);
});
it('abandon is a historical indeterminate CAS, never reservation cancellation', async () => {
  expect(await abandonSecondReviewModelCapacity(value.dispatch)).toBe(true);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(value.dispatch, 'local_abort'); expect(mocks.cancel).not.toHaveBeenCalled();
});
it('awaits atomic commit before native and terminal settlement before the mandatory writer', async () => {
  const committed = gate<unknown>(), order: string[] = []; mocks.atomic.mockReturnValue(committed.promise);
  mocks.native.mockImplementation(async () => { order.push('native'); return { result: success, terminal }; });
  mocks.reconcile.mockImplementation(async () => { order.push('settled'); return { kind: 'settled' }; });
  mocks.record.mockImplementation(async () => { order.push('writer'); return { state: 'recorded' }; });
  const running = executeSecondReviewConsumerItem({ secondReviewId: 8, owner }); void running.catch(() => {});
  try { await vi.waitFor(() => expect(mocks.atomic).toHaveBeenCalledOnce()); expect(mocks.native).not.toHaveBeenCalled(); }
  finally { committed.resolve({ kind: 'claimed', row: value.row, input: value.input, receipt: value.receipt, dispatch: value.dispatch }); await running; }
  expect(order).toEqual(['native', 'settled', 'writer']); expect(mocks.transport).not.toHaveBeenCalled();
});
it('stopped observer keeps a committed dispatch unknown and settles its cancelled original writer', async () => {
  mocks.observe.mockResolvedValue({ kind: 'stopped', reason: 'input_changed' });
  expect(await executeSecondReviewConsumerItem({ secondReviewId: 8, owner })).toEqual({ state: 'recorded' });
  expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(value.dispatch, 'local_abort');
  expect(mocks.record.mock.calls[0][0]).toMatchObject({ receipt: value.receipt, result: { ok: false, error: 'cancelled' } });
});
it('a changed failure count cannot dispatch under an older admission snapshot', async () => {
  mocks.observe.mockResolvedValue({ kind: 'current', row: { ...value.row, failureCount: 1 }, input: value.input });
  await executeSecondReviewConsumerItem({ secondReviewId: 8, owner });
  expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.unknown).toHaveBeenCalledOnce();
  expect(mocks.record.mock.calls[0][0].result.error).toBe('cancelled');
});
it('caller abort waits for native plus terminal reconciliation and only then cancels business writing', async () => {
  const abort = new AbortController(), native = gate<unknown>(), settle = gate<unknown>();
  mocks.native.mockReturnValue(native.promise); mocks.reconcile.mockReturnValue(settle.promise); let done = false;
  const running = executeSecondReviewConsumerItem({ secondReviewId: 8, owner, signal: abort.signal }).finally(() => { done = true; }); void running.catch(() => {});
  try {
    await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledOnce()); abort.abort(); expect(done).toBe(false); expect(mocks.record).not.toHaveBeenCalled();
    native.resolve({ result: success, terminal }); await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce()); expect(mocks.record).not.toHaveBeenCalled();
  } finally { native.resolve({ result: success, terminal }); settle.resolve({ kind: 'settled' }); await running; }
  expect(mocks.record.mock.calls[0][0].result.error).toBe('cancelled');
});
it('the current renewal is awaited after native and ledger settle; no writer can overtake it', async () => {
  vi.useFakeTimers(); const native = gate<unknown>(), renewal = gate<unknown>(); mocks.native.mockReturnValue(native.promise); mocks.renew.mockReturnValue(renewal.promise);
  const running = executeSecondReviewConsumerItem({ secondReviewId: 8, owner }); void running.catch(() => {});
  try { await vi.advanceTimersByTimeAsync(15_000); expect(mocks.renew).toHaveBeenCalledOnce(); native.resolve({ result: success, terminal });
    await vi.advanceTimersByTimeAsync(0); expect(mocks.reconcile).toHaveBeenCalledOnce(); expect(mocks.record).not.toHaveBeenCalled(); }
  finally { native.resolve({ result: success, terminal }); renewal.resolve(value.receipt.ownership.lease); await running; }
  expect(mocks.record).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(60_000); expect(mocks.renew).toHaveBeenCalledOnce();
});
it('renew throw aborts but drains physical settlement before preserving its error with writer zero', async () => {
  vi.useFakeTimers(); const native = gate<unknown>(), original = new Error('renew'); mocks.native.mockReturnValue(native.promise); mocks.renew.mockRejectedValue(original);
  const running = executeSecondReviewConsumerItem({ secondReviewId: 8, owner }); void running.catch(() => {});
  await vi.advanceTimersByTimeAsync(15_000); native.resolve({ result: success, terminal });
  await expect(running).rejects.toBe(original); expect(mocks.reconcile).toHaveBeenCalledOnce(); expect(mocks.record).not.toHaveBeenCalled();
});
it('disabled compatibility still uses its original transport and mandatory writer', async () => {
  mocks.compatibility.mockResolvedValue({ kind: 'claimed', row: value.row, input: value.input, receipt: value.receipt });
  expect(await executeSecondReviewItem({ secondReviewId: 8, owner })).toEqual({ state: 'recorded' });
  expect(mocks.transport).toHaveBeenCalledOnce(); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it('preserves the exact factory input serialization through strict cloned intent validation', () => {
  expect(value.intent.intent.input).not.toBe(value.input);
  expect(value.intent.intent.input).toEqual(value.input);
  expect(JSON.stringify(value.intent.intent.input)).toBe(JSON.stringify(value.input));
  expect(Object.isFrozen(value.intent.intent.input.snapshot)).toBe(true);
});
