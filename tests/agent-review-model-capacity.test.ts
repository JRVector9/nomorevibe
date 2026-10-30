import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createReviewInput } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import type { CrawlCandidate, CrawlDocument } from '@/lib/db/schema';
import { randomUUID } from 'node:crypto';
import { ai1DispatchBindingHash, ai1ModelDispatchSchema } from '@/lib/llm/capacity';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';

const mocks = vi.hoisted(() => ({ settings: null as CrawlSettings | null, list: vi.fn(), document: vi.fn(), input: vi.fn(),
  atomic: vi.fn(), prepare: vi.fn(), native: vi.fn(), pending: vi.fn(), request: vi.fn(), cancel: vi.fn(), unknown: vi.fn(), reconcile: vi.fn(), claim: vi.fn(), record: vi.fn(), resume: vi.fn(), reservedReview: vi.fn(), abandon: vi.fn(), gateway: vi.fn(), cli: vi.fn() }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));
vi.mock('@/lib/crawl/repository', () => ({ getDocument: mocks.document, setReadmeSample: vi.fn() }));
vi.mock('@/lib/crawl/readme', () => ({ fetchReadmeSample: async () => '', README_SAMPLE_LIMIT: 3000, README_SAMPLE_VERSION: '2026-09-14.1' }));
vi.mock('@/lib/domain/products/repository', () => ({ findRepositoryProduct: async () => null }));
vi.mock('@/lib/crawl/agent-review-repository', () => ({ canStartLegacyAgentReview: async () => true,
  requeueStaleReviewSources: async () => 0, handOffExhaustedFirstReviews: async () => 0,
  listReviewCandidates: mocks.list, loadReviewInput: mocks.input, claimAgentReviewWithModelReservation: mocks.atomic, claimAgentReview: mocks.claim, recordAgentReview: mocks.record }));
vi.mock('@/lib/crawl/agent-review-model-capacity', () => ({ claimAgentReviewModelCapacity: mocks.resume,
  reviewAgentReviewModelCapacity: mocks.reservedReview, abandonAgentReviewModelCapacity: mocks.abandon }));
vi.mock('@/lib/crawl/agent-review', () => ({ firstReviewer: (s: CrawlSettings) => s.firstReview,
  reviewWithAgent: mocks.cli, REVIEW_CLI_TIMEOUT_MS: 20_000 }));
vi.mock('@/lib/crawl/agent-review-gateway', () => ({ prepareAi1GatewayCall: mocks.prepare, reviewWithReservedAi1Gateway: mocks.native, reviewWithGateway: mocks.gateway, REVIEW_GATEWAY_TIMEOUT_MS: 60_000 }));
vi.mock('@/lib/crawl/agent-review-grok', () => ({ reviewWithGrokCli: vi.fn(), GROK_REVIEW_TIMEOUT_MS: 90_000 }));
vi.mock('@/lib/llm/capacity-repository', () => ({ findOwnPendingModelRequest: mocks.pending, requestAi1ModelSlot: mocks.request,
  cancelReservedModelSlot: mocks.cancel, markModelDispatchIndeterminate: mocks.unknown, reconcileAi1GatewayTerminal: mocks.reconcile }));
import { reviewCrawlCandidates } from '@/lib/crawl/jobs/agent-review';

const lease = { name: 'crawl-agent-review', token: randomUUID(), requestedVersion: 4 };
const outcome = { decision: 'approve', reason: 'Deployed task tracker', evidenceIds: ['product'] };
const receipt = { attemptId: 1, origin: 'fresh', ownership: { kind: 'legacy', stageEpoch: 1, job: lease } };
const positive = () => ({ claim: { kind: 'claimed', attempt: { id: 1, attemptNumber: 1 }, receipt, dispatch: { fixture: 'opaque-dispatch-boundary' } },
  call: { fixture: 'opaque-prepared-boundary' } });
const freshIntent = () => Reflect.construct(ModelCapacityDeferredError, ['reservation_required']) as ModelCapacityDeferredError;
const context = (signal?: AbortSignal) => ({ cursor: null, lease, signal, hasBudget: () => true, save: vi.fn(), log: vi.fn() });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'observe', reviewConcurrency: 1,
    firstReview: { provider: 'abcllm', model: 'Exact Model' } };
  const now = new Date();
  const candidate = { id: 1, repo: 'capacity-unit/app', productUrl: 'https://capacity.example', state: 'approved',
    decidedBy: 'auto', judgedAt: now, updatedAt: now } as CrawlCandidate;
  const document = { id: 1, repo: candidate.repo, productUrl: candidate.productUrl, pageStatus: 200,
    repoMeta: { description: 'Task tracker', homepage: candidate.productUrl, pushed_at: now.toISOString(), stargazers_count: 0, owner: { type: 'User' } },
    pageMeta: { title: 'Tracker' }, fetchedAt: now } as CrawlDocument;
  mocks.list.mockResolvedValue([candidate]); mocks.document.mockResolvedValue(document);
  mocks.input.mockImplementation(async (c, d, s) => createReviewInput(c, d, s, { scan: null, observations: [] }));
  mocks.claim.mockRejectedValue(freshIntent()); mocks.resume.mockResolvedValue(positive());
  mocks.reservedReview.mockResolvedValue({ ok: true, outcome, usage: {} });
  mocks.gateway.mockResolvedValue({ ok: true, outcome, usage: {} });
  mocks.record.mockResolvedValue({ applied: false, state: 'succeeded' });
});
it('keeps an unsupported fresh admission deferred without calling a model or allocating a request', async () => {
  mocks.claim.mockRejectedValue(new ModelCapacityDeferredError('provider_contract_unavailable'));
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false, deferred: 'model_capacity' });
  expect(mocks.resume).not.toHaveBeenCalled(); expect(mocks.gateway).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
});
it('keeps the disabled legacy gateway path and its existing result writer unchanged', async () => {
  mocks.claim.mockResolvedValue({ kind: 'claimed', attempt: { id: 1, attemptNumber: 1 }, receipt });
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false });
  expect(mocks.gateway).toHaveBeenCalledTimes(1); expect(mocks.reservedReview).not.toHaveBeenCalled();
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
});
it('resumes only a rolled-back fresh intent and dispatches the committed reserved claim once', async () => {
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false });
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lease, provider: 'abcllm', model: 'Exact Model' }),
    expect.objectContaining({ until: expect.any(Number), active: expect.any(Function) }));
  expect(mocks.reservedReview).toHaveBeenCalledTimes(1); expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ receipt, outcome }));
});
it('preserves waiting as typed deferred without a failure, provider call, or result write', async () => {
  mocks.resume.mockRejectedValue(Reflect.construct(ModelCapacityDeferredError, ['capacity']));
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false, deferred: 'model_capacity' });
  expect(mocks.resume).toHaveBeenCalledTimes(1); expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.reservedReview).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
});
it('settles physical terminal before a caller abort changes the domain result to cancelled', async () => {
  const controller = new AbortController(); const order: string[] = [];
  mocks.reservedReview.mockImplementation(async () => { order.push('physical_terminal_settled'); controller.abort(); return { ok: true, outcome, usage: {} }; });
  mocks.record.mockImplementation(async value => { order.push(value.error); return { applied: false, state: 'failed' }; });
  expect(await reviewCrawlCandidates(context(controller.signal))).toEqual({ done: false });
  expect(order).toEqual(['physical_terminal_settled', 'cancelled']);
  expect(mocks.gateway).not.toHaveBeenCalled();
});


// Direct coordinator checks mock ledger/native boundaries only. They are not
// actual slot/terminal authority evidence; the DB driver supplies that separately.
const actualCoordinator = () => vi.importActual<typeof import('@/lib/crawl/agent-review-model-capacity')>('@/lib/crawl/agent-review-model-capacity');
const owner = { instanceId: 'capacity-unit-reviewer', bootId: randomUUID() };
function realShapeDispatch() {
  const binding = { kind: 'ai1_legacy_gateway' as const, version: 1 as const, logicalWorkKey: 'ai1:1', candidateId: 1, attemptId: 1,
    inputHash: 'a'.repeat(64), sourceRevisionHash: 'b'.repeat(64), reviewPolicyHash: 'c'.repeat(64),
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: 'abcllm' as const,
    model: 'Exact Model', routeId: 'crawl-agent-review' as const, stageEpoch: 1, wireHash: 'd'.repeat(64),
    servingContractHash: 'e'.repeat(64), totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: 'crawl-agent-review' as const, token: lease.token, requestedVersion: lease.requestedVersion } };
  return ai1ModelDispatchSchema.parse({ requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 1,
    policyHash: 'f'.repeat(64), binding, bindingHash: ai1DispatchBindingHash(binding) });
}
async function coordinatorInput() {
  const candidate = (await mocks.list())[0] as CrawlCandidate;
  const document = await mocks.document() as CrawlDocument;
  const input = await mocks.input(candidate, document, mocks.settings);
  return { candidate, document, input, settings: mocks.settings!, provider: 'abcllm', model: 'Exact Model', lease };
}
function roleEnvironment() {
  vi.stubEnv('ROLE_LEASE_ROLE', 'reviewer'); vi.stubEnv('ROLE_LEASE_INSTANCE_ID', owner.instanceId);
  vi.stubEnv('ROLE_LEASE_BOOT_ID', owner.bootId); vi.stubEnv('ROLE_LEASE_RELEASE', 'capacity-unit-release'); vi.stubEnv('ROLE_LEASE_EPOCH', '1');
}
afterAll(() => vi.unstubAllEnvs());
it('does not create a queue row when the production preparation contract is unsupported', async () => {
  const api = await actualCoordinator(); mocks.prepare.mockReturnValue({ kind: 'unsupported' });
  await expect(api.claimAgentReviewModelCapacity(await coordinatorInput())).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  expect(mocks.pending).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.atomic).not.toHaveBeenCalled();
});
it('requires an existing reviewer boot identity for positive admission', async () => {
  const api = await actualCoordinator();
  for (const key of ['ROLE_LEASE_ROLE','ROLE_LEASE_INSTANCE_ID','ROLE_LEASE_BOOT_ID','ROLE_LEASE_RELEASE','ROLE_LEASE_EPOCH','ROLE_LEASE_BATCH_VERSION']) vi.stubEnv(key, undefined);
  mocks.prepare.mockReturnValue({ kind: 'prepared' });
  await expect(api.claimAgentReviewModelCapacity(await coordinatorInput())).rejects.toMatchObject({ reason: 'owner_unavailable' });
  expect(mocks.pending).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
});
it('re-polls the same persisted pending ID and binds only its committed fresh claim', async () => {
  const api = await actualCoordinator(); roleEnvironment();
  const input = await coordinatorInput(), dispatch = realShapeDispatch(), requestId = dispatch.requestId;
  const call = Object.freeze({ kind: 'prepared', model: input.model, inputHash: input.input.inputHash });
  mocks.prepare.mockReturnValue(call); mocks.pending.mockResolvedValue({ requestId, state: 'reserved' });
  mocks.request.mockResolvedValue({ kind: 'granted', reservation: { ...dispatch, binding: undefined } });
  mocks.atomic.mockResolvedValue({ ...positive().claim, dispatch });
  const result = await api.claimAgentReviewModelCapacity(input);
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ requestId, owner, workKey: expect.stringMatching(/^ai1:1:[a-f0-9]{64}$/) }), 1);
  expect(result.claim).toHaveProperty('dispatch', dispatch); expect(result.call).toBe(call); expect(mocks.cancel).not.toHaveBeenCalled();
});
it.each(['waiting', 'reserved'] as const)('preserves a %s request ID when the next tick is still waiting', async state => {
  const api = await actualCoordinator(); roleEnvironment(); const requestId = randomUUID();
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue({ requestId, state });
  mocks.request.mockResolvedValue({ kind: 'deferred', reason: 'capacity' });
  await expect(api.claimAgentReviewModelCapacity(await coordinatorInput())).rejects.toMatchObject({ reason: 'capacity' });
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ requestId }), 1);
  expect(mocks.atomic).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
});
it.each(['dispatched'] as const)('never re-polls or replaces a same-work %s request (an indeterminate one is not returned by the readback since 2026-10-30)', async state => {
  const api = await actualCoordinator(); roleEnvironment(); mocks.prepare.mockReturnValue({ kind: 'prepared' });
  mocks.pending.mockResolvedValue({ requestId: randomUUID(), state });
  await expect(api.claimAgentReviewModelCapacity(await coordinatorInput())).rejects.toMatchObject({ reason: 'dispatched' });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.atomic).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
});
it.each(['skipped', 'reused'] as const)('cancels only its reserved handle when the locked domain returns %s', async kind => {
  const api = await actualCoordinator(); roleEnvironment(); const reservation = { unit: 'original-reserved-boundary' };
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue(null);
  mocks.request.mockResolvedValue({ kind: 'granted', reservation }); mocks.atomic.mockResolvedValue({ kind });
  expect((await api.claimAgentReviewModelCapacity(await coordinatorInput())).claim.kind).toBe(kind);
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(reservation); expect(mocks.native).not.toHaveBeenCalled();
});
it('preserves an atomic claim error and its exact reservation cleanup error together', async () => {
  const api = await actualCoordinator(); roleEnvironment(); const original = new Error('claim commit unknown'), cleanup = new Error('cancel failed');
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue(null);
  mocks.request.mockResolvedValue({ kind: 'granted', reservation: {} }); mocks.atomic.mockRejectedValue(original); mocks.cancel.mockRejectedValue(cleanup);
  await expect(api.claimAgentReviewModelCapacity(await coordinatorInput())).rejects.toMatchObject({ errors: [original, cleanup] });
  expect(mocks.native).not.toHaveBeenCalled();
});
it('reconciles an issued physical terminal even when the caller signal is already aborted', async () => {
  const api = await actualCoordinator(); const dispatch = realShapeDispatch(), terminal = Object.freeze({ boundary: 'native-issued-opaque' });
  const controller = new AbortController(); controller.abort(); const result = { ok: true, outcome, usage: {} };
  mocks.native.mockResolvedValue({ result, terminal }); mocks.reconcile.mockResolvedValue({ kind: 'settled' });
  expect(await api.reviewAgentReviewModelCapacity((await coordinatorInput()).input, dispatch, {} as never, { signal: controller.signal })).toBe(result);
  expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(terminal); expect(mocks.unknown).not.toHaveBeenCalled();
});
it('records the client deadline as client_timeout when a settled local Promise has no physical terminal', async () => {
  const api = await actualCoordinator(); const dispatch = realShapeDispatch(), result = { ok: false, error: 'timeout' };
  mocks.native.mockResolvedValue({ result, terminal: null });
  expect(await api.reviewAgentReviewModelCapacity((await coordinatorInput()).input, dispatch, {} as never, {})).toBe(result);
  expect(mocks.unknown).toHaveBeenCalledWith(dispatch, 'client_timeout'); expect(mocks.reconcile).not.toHaveBeenCalled();
});
it('propagates the original provider exception and preserves simultaneous unknown-write failure', async () => {
  const api = await actualCoordinator(); const dispatch = realShapeDispatch(), original = new Error('native reject'), cleanup = new Error('unknown write');
  mocks.native.mockRejectedValue(original); mocks.unknown.mockRejectedValue(cleanup);
  await expect(api.reviewAgentReviewModelCapacity((await coordinatorInput()).input, dispatch, {} as never, {})).rejects.toMatchObject({ errors: [original, cleanup] });
  expect(mocks.native).toHaveBeenCalledTimes(1); expect(mocks.reconcile).not.toHaveBeenCalled();
});

it.each([false, true])('preserves the original returned failure and exact settlement error (terminal=%s)', async issued => {
  const api = await actualCoordinator(); const dispatch = realShapeDispatch();
  const result = { ok: false as const, error: issued ? 'invalid_output' : 'timeout' };
  const cleanup = new Error('settlement write failed');
  mocks.native.mockResolvedValue({ result, terminal: issued ? Object.freeze({ boundary: 'native-issued-opaque' }) : null });
  (issued ? mocks.reconcile : mocks.unknown).mockRejectedValue(cleanup);
  const error = await api.reviewAgentReviewModelCapacity((await coordinatorInput()).input, dispatch, {} as never, {}).catch(value => value);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toHaveLength(2); expect(error.errors[0]).toBe(result); expect(error.errors[1]).toBe(cleanup);
});
it('preserves an exact settlement exception when the original returned result succeeded', async () => {
  const api = await actualCoordinator(); const dispatch = realShapeDispatch(), cleanup = new Error('successful terminal reconcile failed');
  mocks.native.mockResolvedValue({ result: { ok: true, outcome, usage: {} }, terminal: Object.freeze({ boundary: 'native-issued-opaque' }) });
  mocks.reconcile.mockRejectedValue(cleanup);
  await expect(api.reviewAgentReviewModelCapacity((await coordinatorInput()).input, dispatch, {} as never, {})).rejects.toBe(cleanup);
});

// 틱 안의 예약 대기(2026-10-29). 장부 경계는 mock 이다 — 실제 grant·TTL 은 tests/integration/ai1-reservation-wait.test.ts 가 본다.
it('claims a reservation granted while it waits on the same queued request ID, without cancelling or re-queueing', async () => {
  const api = await actualCoordinator(); roleEnvironment();
  const input = await coordinatorInput(), dispatch = realShapeDispatch(), requestId = dispatch.requestId;
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue({ requestId, state: 'waiting' });
  const reservation = { ...dispatch, binding: undefined };
  mocks.request.mockResolvedValueOnce({ kind: 'deferred', reason: 'capacity' }).mockResolvedValueOnce({ kind: 'deferred', reason: 'capacity' })
    .mockResolvedValue({ kind: 'granted', reservation });
  mocks.atomic.mockResolvedValue({ ...positive().claim, dispatch });
  const events: unknown[] = [];
  const started = Date.now();
  const result = await api.claimAgentReviewModelCapacity(input, { until: Date.now() + 10_000, observe: event => events.push(event) });
  expect(result.claim).toHaveProperty('dispatch', dispatch);
  expect(Date.now() - started).toBeGreaterThanOrEqual(2 * api.AI1_RESERVATION_POLL_MS - 50);
  expect(mocks.request).toHaveBeenCalledTimes(3);
  const ids = mocks.request.mock.calls.map(([value]) => value.requestId);
  expect(new Set(ids).size).toBe(1);
  expect(mocks.atomic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reservation }));
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(events).toEqual([expect.objectContaining({ granted: true, queued: true, polls: 2, ended: 'granted' })]);
});
it('takes an already promoted own reservation immediately instead of sleeping first', async () => {
  const api = await actualCoordinator(); roleEnvironment(); const requestId = randomUUID(), reservation = { unit: 'promoted-while-away' };
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValueOnce({ requestId, state: 'waiting' }).mockResolvedValue({ requestId, state: 'reserved' });
  mocks.request.mockResolvedValueOnce({ kind: 'deferred', reason: 'capacity' }).mockResolvedValue({ kind: 'granted', reservation });
  mocks.atomic.mockResolvedValue({ kind: 'skipped' });
  const started = Date.now();
  await api.claimAgentReviewModelCapacity(await coordinatorInput(), { until: Date.now() + 10_000 });
  expect(Date.now() - started).toBeLessThan(api.AI1_RESERVATION_POLL_MS);
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(reservation);
});
it('does not wait when the capacity refusal left no own queued row (fence or duplicate work)', async () => {
  const api = await actualCoordinator(); roleEnvironment();
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue(null);
  mocks.request.mockResolvedValue({ kind: 'deferred', reason: 'capacity' });
  const events: unknown[] = [];
  await expect(api.claimAgentReviewModelCapacity(await coordinatorInput(), { until: Date.now() + 10_000, observe: event => events.push(event) }))
    .rejects.toMatchObject({ reason: 'capacity' });
  expect(mocks.request).toHaveBeenCalledTimes(1); expect(mocks.cancel).not.toHaveBeenCalled();
  expect(events).toEqual([expect.objectContaining({ granted: false, queued: false, polls: 0, ended: 'not_queued' })]);
});
it.each([
  ['deadline', { until: () => Date.now() + 1_200 }],
  ['stopped', { until: () => Date.now() + 10_000, active: true }],
] as const)('leaves the queued row untouched and defers as capacity when the wait ends by %s', async (ended, shape) => {
  const api = await actualCoordinator(); roleEnvironment(); const requestId = randomUUID();
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue({ requestId, state: 'waiting' });
  mocks.request.mockResolvedValue({ kind: 'deferred', reason: 'capacity' });
  let polls = 0;
  const events: Array<{ ended: string; polls: number }> = [];
  const wait = { until: shape.until(), observe: (event: { ended: string; polls: number }) => events.push(event),
    ...('active' in shape ? { active: () => ++polls < 3 } : {}) };
  await expect(api.claimAgentReviewModelCapacity(await coordinatorInput(), wait)).rejects.toMatchObject({ reason: 'capacity' });
  expect(mocks.atomic).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  expect(events).toEqual([expect.objectContaining({ ended })]);
  expect(mocks.request.mock.calls.length).toBe(1 + events[0].polls);
  if (ended === 'deadline') expect(events[0].polls).toBeLessThanOrEqual(2);
});
it('stops waiting at once on abort and on a non-capacity ledger refusal', async () => {
  const api = await actualCoordinator(); roleEnvironment(); const requestId = randomUUID();
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue({ requestId, state: 'waiting' });
  mocks.request.mockResolvedValueOnce({ kind: 'deferred', reason: 'capacity' }).mockResolvedValue({ kind: 'deferred', reason: 'withdrawn' });
  await expect(api.claimAgentReviewModelCapacity(await coordinatorInput(), { until: Date.now() + 10_000 })).rejects.toMatchObject({ reason: 'withdrawn' });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  vi.clearAllMocks();
  mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue({ requestId, state: 'waiting' });
  mocks.request.mockResolvedValue({ kind: 'deferred', reason: 'capacity' });
  const controller = new AbortController();
  const started = Date.now();
  const pending = api.claimAgentReviewModelCapacity({ ...await coordinatorInput(), signal: controller.signal }, { until: Date.now() + 10_000 });
  setTimeout(() => controller.abort(), 50);
  await expect(pending).rejects.toMatchObject({ reason: 'capacity' });
  expect(Date.now() - started).toBeLessThan(api.AI1_RESERVATION_POLL_MS);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it('caps one candidate wait at the reservation TTL even with a later tick deadline', async () => {
  const api = await actualCoordinator();
  expect(api.AI1_RESERVATION_WAIT_MAX_MS).toBe(30_000);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    roleEnvironment(); const requestId = randomUUID();
    mocks.prepare.mockReturnValue({ kind: 'prepared' }); mocks.pending.mockResolvedValue({ requestId, state: 'waiting' });
    mocks.request.mockResolvedValue({ kind: 'deferred', reason: 'capacity' });
    const events: Array<{ ended: string; polls: number; waitedMs: number }> = [];
    const pending = api.claimAgentReviewModelCapacity(await coordinatorInput(), { until: Date.now() + 100_000, observe: event => events.push(event) });
    const settled = pending.catch(error => error);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await settled).toMatchObject({ reason: 'capacity' });
    expect(events).toEqual([expect.objectContaining({ ended: 'cap' })]);
    expect(events[0].waitedMs).toBeLessThanOrEqual(30_000);
    expect(events[0].polls).toBeLessThanOrEqual(60);
  } finally { vi.useRealTimers(); }
});
