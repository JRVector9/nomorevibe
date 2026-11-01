import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
const mocks = vi.hoisted(() => ({ control: vi.fn(), legacy: vi.fn(), prepare: vi.fn(), domain: vi.fn(),
  pending: vi.fn(), batches: vi.fn(), batch: vi.fn(), abandon: vi.fn(), request: vi.fn(), cancel: vi.fn(), native: vi.fn(), unknown: vi.fn(), reconcile: vi.fn(), role: vi.fn() }));
vi.mock('@/lib/llm/capacity-repository', () => ({ readModelCapacityCallerControl: mocks.control,
  findOwnPendingModelRequest: mocks.pending, requestReasonTranslationModelSlot: mocks.request,
  findOwnPendingReasonTranslationRequests: mocks.batches, cancelOwnPendingReasonTranslationRequest: mocks.abandon,
  cancelReservedModelSlot: mocks.cancel, markModelDispatchIndeterminate: mocks.unknown,
  reconcileReasonTranslationGatewayTerminal: mocks.reconcile }));
vi.mock('@/lib/crawl/translate', async () => { const { createHash } = await import('node:crypto'); return {
  TRANSLATE_MODEL: 'Reason Model', translateToKorean: mocks.legacy,
  textHash: (value: string) => createHash('sha256').update(value).digest('hex') }; });
vi.mock('@/lib/crawl/translations', () => ({ prepareReasonTranslationDispatch: mocks.domain, pendingReasonTranslationBatch: mocks.batch }));
vi.mock('@/lib/crawl/agent-review-gateway', () => ({ prepareReasonTranslationGatewayCall: mocks.prepare,
  translateWithReservedReasonGateway: mocks.native }));
vi.mock('@/lib/jobs/role-leader', () => ({ roleLeaseFromEnv: mocks.role }));
import { translateReasonsWithModelCapacity } from '@/lib/crawl/reason-translation-model-capacity';
import { setServingContractSnapshotForTest } from '@/lib/llm/serving-contract-store';
const body = 'This original reason describes a deployed useful task tracker.';
const hash = createHash('sha256').update(body).digest('hex');
const batch = () => [{ hash, body, attempts: 0 }];
const lease = { name: 'reason-translate', token: randomUUID(), requestedVersion: 3 };
const role = { role: 'text', instanceId: 'reason-runtime-unit', bootId: randomUUID(), release: 'unit-release', epoch: 1, kind: 'primary' };
const call = Object.freeze({ kind: 'prepared', provider: 'abcllm', model: 'Reason Model', wireHash: 'a'.repeat(64),
  servingContractHash: 'b'.repeat(64), totalTokenBound: 8192, sourceHashes: [hash] });
const members = [{ sourceHash: hash, cache: { kind: 'absent' } }];
const reservation = { requestId: randomUUID(), token: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
  epoch: 1, revision: 1, policyHash: 'c'.repeat(64) };
const dispatch = { ...reservation, unitBoundary: 'committed-dispatch' };
const expectation = Object.freeze({ unitBoundary: 'private-writer-proof' });
const options = () => ({ timeoutMs: 45000 });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('ROLE_LEASE_ROLE', 'text');
  // The engine connected directly (admin contract, transport direct) opens the route; no gateway key exists any more.
  setServingContractSnapshotForTest([{ routeId: 'reason-translate', model: 'Reason Model', contract: {}, auth: 'none', apiKey: null, transport: 'direct' }]);
  mocks.control.mockResolvedValue({ mode: 'open', policy: { routes: [{ routeId: 'reason-translate', provider: 'abcllm', model: 'Reason Model' }] } });
  mocks.role.mockReturnValue(role); mocks.prepare.mockReturnValue(call); mocks.pending.mockResolvedValue(null);
  mocks.batches.mockResolvedValue([]);
  mocks.domain.mockImplementation(async (_batch, _lease, options) => options.reserved
    ? { kind: 'ready', dispatch, expectation } : { kind: 'ready', members, role });
  mocks.request.mockResolvedValue({ kind: 'granted', reservation });
  mocks.native.mockResolvedValue({ result: { ok: true, translations: ['한국어 사유'] }, terminal: Object.freeze({ native: 'opaque' }) });
  mocks.legacy.mockResolvedValue({ ok: true, translations: ['기존 번역'] });
});
afterEach(() => { setServingContractSnapshotForTest(null); vi.unstubAllEnvs(); });
it('ignores a process gateway key: without a direct contract it never reads capacity, prepares or reserves', async () => {
  setServingContractSnapshotForTest([]); vi.stubEnv('ABCLLM_API_KEY', 'ignored-gateway-key');
  expect(await translateReasonsWithModelCapacity(batch(), lease, options()))
    .toEqual({ kind: 'disabled', result: { ok: true, translations: ['기존 번역'] } });
  expect(mocks.control).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it('preserves disabled transport and the original ordered timeout/signal arguments', async () => {
  mocks.control.mockResolvedValue({ mode: 'disabled' });
  const controller = new AbortController();
  expect(await translateReasonsWithModelCapacity(batch(), lease, { ...options(), signal: controller.signal }))
    .toEqual({ kind: 'disabled', result: { ok: true, translations: ['기존 번역'] } });
  expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith([body], 45000, undefined, controller.signal);
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
});
it('fails closed before a request or native call when the serving contract is unsupported', async () => {
  mocks.prepare.mockReturnValue({ kind: 'unsupported' });
  await expect(translateReasonsWithModelCapacity(batch(), lease, options())).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it('preserves draining as typed defer without consuming an attempt', async () => {
  mocks.control.mockResolvedValue({ mode: 'draining' });
  await expect(translateReasonsWithModelCapacity(batch(), lease, options())).rejects.toMatchObject({ reason: 'draining' });
  expect(mocks.domain).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
});
it('resumes the exact pending ID and sends only the committed domain dispatch', async () => {
  mocks.pending.mockResolvedValue({ requestId: reservation.requestId, state: 'waiting' });
  const response = await translateReasonsWithModelCapacity(batch(), lease, options());
  expect(response).toMatchObject({ kind: 'ready', expectation, result: { ok: true } });
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ requestId: reservation.requestId,
    owner: reservation.owner, class: 'background', pool: 'text', workKey: expect.stringMatching(/^text:reason:ko:[a-f0-9]{64}:[a-f0-9]{64}$/) }), members);
  expect(mocks.native).toHaveBeenCalledExactlyOnceWith([body], dispatch, call, expect.objectContaining({ timeoutMs: 45000 }));
  expect(mocks.cancel).not.toHaveBeenCalled();
});
it('retains waiting and opens no native call when the slot is not granted', async () => {
  mocks.request.mockResolvedValue({ kind: 'deferred', reason: 'capacity' });
  await expect(translateReasonsWithModelCapacity(batch(), lease, options())).rejects.toMatchObject({ reason: 'capacity' });
  expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
});
it('refuses to re-dispatch an existing in-flight same-work request, but re-admits one whose call went indeterminate (2026-10-30)', async () => {
  mocks.pending.mockResolvedValue({ requestId: reservation.requestId, state: 'dispatched' });
  await expect(translateReasonsWithModelCapacity(batch(), lease, options())).rejects.toMatchObject({ reason: 'dispatched' });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  // 조정기 readback 은 미확인 행을 돌려주지 않는다(null) → 새 requestId 로 다시 접수한다.
  mocks.pending.mockResolvedValue(null);
  expect(await translateReasonsWithModelCapacity(batch(), lease, options())).toMatchObject({ kind: 'ready' });
  expect(mocks.request).toHaveBeenCalledOnce(); expect(mocks.request.mock.calls[0][0].requestId).not.toBe(reservation.requestId);
});
it('cancels only the original reservation when the locked cache changed', async () => {
  mocks.domain.mockResolvedValueOnce({ kind: 'ready', members, role }).mockResolvedValueOnce({ kind: 'skipped' });
  expect(await translateReasonsWithModelCapacity(batch(), lease, options())).toEqual({ kind: 'skipped' });
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(reservation); expect(mocks.native).not.toHaveBeenCalled();
});
it('settles the issued terminal even when native completion aborts the business signal', async () => {
  const controller = new AbortController(), terminal = Object.freeze({ native: 'opaque' });
  mocks.native.mockImplementation(async () => { controller.abort(); return { result: { ok: true, translations: ['번역'] }, terminal }; });
  expect(await translateReasonsWithModelCapacity(batch(), lease, { ...options(), signal: controller.signal })).toMatchObject({ kind: 'ready', unknown: false });
  expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(terminal); expect(mocks.unknown).not.toHaveBeenCalled();
});
it('preserves full-charge unknown independently of a local failure result', async () => {
  const result = { ok: false, error: 'timeout' }; mocks.native.mockResolvedValue({ result, terminal: null });
  expect(await translateReasonsWithModelCapacity(batch(), lease, options())).toMatchObject({ kind: 'ready', result, unknown: true });
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, 'client_timeout');
});
it('preserves returned failure and settlement error identities together', async () => {
  const result = { ok: false, error: 'invalid_output' }, cleanup = new Error('settlement failed');
  mocks.native.mockResolvedValue({ result, terminal: {} }); mocks.reconcile.mockRejectedValue(cleanup);
  const error = await translateReasonsWithModelCapacity(batch(), lease, options()).catch(value => value);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(result); expect(error.errors[1]).toBe(cleanup);
});
