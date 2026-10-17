import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { executeFirstReviewConsumerItem } from '@/lib/crawl/agent-review-item-lifecycle';
import { runFirstReviewConsumer } from '@/lib/crawl/consumers/first';
import { parsePipelineFirstConsumerArgs, runPipelineFirstConsumer } from '@/scripts/pipeline-first-consumer';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { consumerHealthPath, supervisorCommand, supervisorHealthPath } from '@/scripts/worker-supervisor';

const mocks = vi.hoisted(() => ({ load: vi.fn(), prepare: vi.fn(), claim: vi.fn(), observe: vi.fn(), renew: vi.fn(),
  record: vi.fn(), spam: vi.fn(), select: vi.fn(), where: vi.fn(), pages: [] as unknown[][], limit: vi.fn(),
  sleep: vi.fn(), runtime: vi.fn(), report: vi.fn(), settings: vi.fn(), predicate: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { select: mocks.select }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: () => null }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings }));
vi.mock('@/lib/crawl/agent-review-repository', () => ({ loadFirstReviewConsumerContext: mocks.load,
  claimConsumerItemAgentReview: mocks.claim, observeAgentReviewItemDispatch: mocks.observe,
  renewAgentReviewItemOwnership: mocks.renew, recordAgentReview: mocks.record,
  recordConsumerSuspectedSpam: mocks.spam, reviewCandidatePredicate: mocks.predicate }));
vi.mock('@/lib/crawl/agent-review-preparation', () => ({ prepareAgentReview: mocks.prepare }));
vi.mock('@/lib/crawl/agent-review', () => ({ firstReviewer: () => ({ provider: 'abcllm', model: 'same-model' }) }));
vi.mock('@/scripts/worker', () => ({ withRuntimeProcess: mocks.runtime, interruptibleSleep: mocks.sleep }));
vi.mock('@/lib/operations/observations', () => ({ observeService: vi.fn() }));
const owner = () => ({ instanceId: 'ai1-consumer-unit', bootId: 'f70bfcce-92d0-4ed8-a5db-bfd092d17950' });
const context = { candidate: { id: 4 }, document: {}, settings: { enabled: true, reviewMode: 'enforce' }, input: {} };
const receipt = { attemptId: 3, origin: 'fresh', ownership: { kind: 'item' } };
const outcome = { decision: 'reject', reason: 'Server rule', evidenceIds: ['product'] };
const hint = (id: number) => ({ id, reviewed: false, updatedAt: '2026-10-16 01:02:03.123456', ceiling: 1000 });
function gate<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.resetAllMocks(); mocks.pages = [];
  mocks.load.mockResolvedValue({ kind: 'current', context });
  mocks.prepare.mockResolvedValue({ provider: 'rules', model: 'rules-version', outcome, spam: false, ruleRejection: { reason: 'not_a_product' } });
  mocks.claim.mockResolvedValue({ kind: 'claimed', receipt, attempt: { id: 3, outcome: null } });
  mocks.observe.mockResolvedValue({ kind: 'current' }); mocks.renew.mockResolvedValue({});
  mocks.record.mockResolvedValue({ applied: true, state: 'succeeded' }); mocks.spam.mockResolvedValue({ applied: true, state: 'succeeded' });
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'enforce' });
  mocks.limit.mockImplementation(async () => mocks.pages.shift() ?? []);
  mocks.select.mockImplementation(() => ({ from: () => ({ where: (query: SQL) => { mocks.where(query);
    return { orderBy: () => ({ limit: mocks.limit }) }; } }) }));
  mocks.runtime.mockImplementation(async (_role, run) => run(new AbortController().signal, mocks.report));
});
afterEach(() => vi.useRealTimers());
it('has a separate fixed AI1 parser and default opt-out before runtime/database work', async () => {
  expect(parsePipelineFirstConsumerArgs(['--once'])).toEqual({ once: true });
  for (const args of [['--stage=ai1'], ['--stage=ai2'], ['--once', '--once'], ['--script=x']]) expect(() => parsePipelineFirstConsumerArgs(args)).toThrow();
  expect(await runPipelineFirstConsumer([], {})).toEqual({ state: 'disabled' });
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
});
it('strict target/owner and pre-aborted caller do not claim', async () => {
  const abort = new AbortController(); abort.abort();
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner(), signal: abort.signal })).toEqual({ state: 'skipped', reason: 'aborted' });
  await expect(executeFirstReviewConsumerItem({ candidateId: 0, owner: owner() })).rejects.toThrow();
  await expect(executeFirstReviewConsumerItem({ candidateId: 4, owner: { ...owner(), extra: true } as ReturnType<typeof owner> })).rejects.toThrow();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('stopClaims before the item or after preparation does not claim', async () => {
  const stopped = new AbortController(); stopped.abort();
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner(), stopClaims: stopped.signal })).toEqual({ state: 'skipped', reason: 'aborted' });
  const late = new AbortController();
  mocks.prepare.mockImplementationOnce(async () => { late.abort(); return { provider: 'rules', model: 'rules-version', outcome, spam: false }; });
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner(), stopClaims: late.signal })).toEqual({ state: 'skipped', reason: 'aborted' });
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('stopClaims ends the AI1 loop after the current item without a backoff', async () => {
  const cancel = new AbortController(), stopClaims = new AbortController();
  mocks.pages = [[hint(4), hint(5)]];
  mocks.record.mockImplementationOnce(async () => { stopClaims.abort(); return { applied: true, state: 'succeeded' }; });
  expect(await runFirstReviewConsumer({ owner: owner(), signal: cancel.signal, stopClaims: stopClaims.signal }))
    .toEqual({ attempted: 1, recorded: 1, skipped: 0, deferred: 0 });
  expect(mocks.load.mock.calls.map(call => call[0])).toEqual([4]); expect(mocks.sleep).not.toHaveBeenCalled(); expect(cancel.signal.aborted).toBe(false);
});
it('launches one fixed reviewer runtime with a fresh boot and matching observation identity', async () => {
  await runPipelineFirstConsumer(['--once'], { PIPELINE_ITEM_CONSUMER_VERSION: '1',
    PIPELINE_ITEM_CONSUMER_INSTANCE_ID: owner().instanceId, SERVICE_INSTANCE_ID: owner().instanceId });
  expect(mocks.runtime).toHaveBeenCalledExactlyOnceWith('reviewer', expect.any(Function));
  expect(mocks.select).toHaveBeenCalledOnce();
});
it('rejects mismatched identity/reserved health paths and unknown opt-in before runtime work', async () => {
  for (const env of [{ PIPELINE_ITEM_CONSUMER_VERSION: '2' }, { PIPELINE_ITEM_CONSUMER_VERSION: '1' },
    { PIPELINE_ITEM_CONSUMER_VERSION: '1', SERVICE_INSTANCE_ID: 'ai2-consumer-unit', PIPELINE_ITEM_CONSUMER_INSTANCE_ID: owner().instanceId },
    { PIPELINE_ITEM_CONSUMER_VERSION: '1', SERVICE_INSTANCE_ID: owner().instanceId, PIPELINE_ITEM_CONSUMER_INSTANCE_ID: 'different' }])
    await expect(runPipelineFirstConsumer([], env)).rejects.toThrow();
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
});
it('completes prepared server rules with the actual item receipt and mandatory writer', async () => {
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).toEqual({ applied: true, state: 'succeeded' });
  expect(mocks.claim).toHaveBeenCalledExactlyOnceWith({ ...context, provider: 'rules', model: 'rules-version', owner: owner(), ttlMs: 90_000 });
  expect(mocks.observe).toHaveBeenCalledExactlyOnceWith(context, receipt);
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ ...context, receipt, outcome, ruleRejection: { reason: 'not_a_product' } });
});
it('uses stored reused outcome without dispatch and passes spam only through its fixed writer', async () => {
  mocks.prepare.mockResolvedValueOnce({ provider: 'abcllm', model: 'same-model', spam: false });
  mocks.claim.mockResolvedValueOnce({ kind: 'reused', receipt: { ...receipt, origin: 'semantic_reuse' }, attempt: { outcome } });
  await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() });
  expect(mocks.record.mock.calls[0][0].outcome).toBe(outcome);
  mocks.prepare.mockResolvedValueOnce({ provider: 'rules', model: 'rules-version', spam: true, outcome });
  await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() });
  expect(mocks.spam).toHaveBeenCalledExactlyOnceWith({ ...context, receipt });
});
it('unprepared source and explicit settings stops never claim', async () => {
  mocks.load.mockResolvedValueOnce({ kind: 'skipped', reason: 'source_not_prepared' });
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).toEqual({ state: 'skipped', reason: 'source_not_prepared' });
  mocks.load.mockResolvedValueOnce({ kind: 'skipped', reason: 'disabled' });
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).toEqual({ state: 'skipped', reason: 'disabled' });
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('propagates fresh model typed refusal and genuine claim errors without a writer', async () => {
  const deferred = new ModelCapacityDeferredError('disabled'), original = new Error('actual SQL error');
  mocks.claim.mockRejectedValueOnce(deferred).mockRejectedValueOnce(original);
  await expect(executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).rejects.toBe(deferred);
  await expect(executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).rejects.toBe(original);
  expect(mocks.record).not.toHaveBeenCalled();
});
it('current-domain invalidation/caller abort goes to the original cancelled writer', async () => {
  mocks.observe.mockResolvedValue({ kind: 'changed' });
  await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() });
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ ...context, receipt, error: 'cancelled' });
});
it('drains the actual in-flight renewal before its single writer', async () => {
  vi.useFakeTimers(); const observed = gate<{ kind: string }>(), renewal = gate<object>();
  mocks.observe.mockReturnValue(observed.promise); mocks.renew.mockReturnValue(renewal.promise);
  const running = executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() });
  try {
    await vi.advanceTimersByTimeAsync(15_000); expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(context, receipt, 90_000);
    observed.resolve({ kind: 'current' }); await vi.advanceTimersByTimeAsync(0); expect(mocks.record).not.toHaveBeenCalled();
  } finally { renewal.resolve({}); await running; }
  expect(mocks.record).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(60_000); expect(mocks.renew).toHaveBeenCalledOnce();
});
it('renewal error survives drain with writer zero', async () => {
  vi.useFakeTimers(); const observed = gate<{ kind: string }>(), original = new Error('renew SQL failure');
  mocks.observe.mockReturnValue(observed.promise); mocks.renew.mockRejectedValue(original);
  const running = executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() }); void running.catch(() => {});
  await vi.advanceTimersByTimeAsync(15_000); observed.resolve({ kind: 'current' });
  await expect(running).rejects.toBe(original); expect(mocks.record).not.toHaveBeenCalled();
});
it('empty once pass does not claim or back off', async () => {
  expect(await runFirstReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 0, recorded: 0, skipped: 0, deferred: 0 });
  expect(mocks.limit).toHaveBeenCalledExactlyOnceWith(24); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.sleep).not.toHaveBeenCalled();
});
it('refills a short page immediately, then backs off empty, with a fresh per-item clock', async () => {
  const abort = new AbortController(); mocks.pages = [[hint(4)], [hint(5)], []];
  mocks.sleep.mockImplementation(async () => { abort.abort(); });
  expect(await runFirstReviewConsumer({ owner: owner(), signal: abort.signal, report: mocks.report })).toEqual({ attempted: 2, recorded: 2, skipped: 0, deferred: 0 });
  expect(mocks.load.mock.calls.map(call => call[0])).toEqual([4, 5]); expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(5_000, abort.signal);
  expect(mocks.report.mock.calls.filter(call => call[0] === 'running')).toEqual([
    ['running', 'crawl-agent-review', expect.any(Number)], ['running', 'crawl-agent-review', expect.any(Number)]]);
});
it('bounds once scans to four pages and keysets preserve microseconds and initial ceiling', async () => {
  mocks.pages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 24 }, (_, n) => hint(page * 24 + n + 1)));
  mocks.claim.mockResolvedValue({ kind: 'skipped', reason: 'running' });
  expect(await runFirstReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 96, recorded: 0, skipped: 96, deferred: 0 });
  expect(mocks.limit).toHaveBeenCalledTimes(4);
  const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[1][0]);
  expect(query.params).toContain('2026-10-16 01:02:03.123456'); expect(query.params).toContain(1000); expect(query.sql).not.toContain('offset');
});
it('backs off typed refusal then resumes past it; genuine error stays primary', async () => {
  const abort = new AbortController(); mocks.pages = [[hint(4)], [hint(5)], []];
  mocks.claim.mockRejectedValueOnce(new ModelCapacityDeferredError('disabled'));
  mocks.sleep.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { abort.abort(); });
  expect(await runFirstReviewConsumer({ owner: owner(), signal: abort.signal })).toEqual({ attempted: 2, recorded: 1, skipped: 0, deferred: 1 });
  const original = new Error('SQL failure'); mocks.pages = [[hint(6)]]; mocks.claim.mockRejectedValueOnce(original);
  await expect(runFirstReviewConsumer({ owner: owner(), once: true })).rejects.toBe(original);
});
it('routes fixed AI1 supervisor and health independently of legacy and AI2 files', () => {
  const env = { SERVICE_INSTANCE_ID: owner().instanceId };
  expect(supervisorCommand('reviewer', { consumer: 'ai1', once: true })).toEqual(['scripts/pipeline-first-consumer.ts', '--once']);
  expect(consumerHealthPath(env)).toBe('/tmp/nomorevibe-ai1-consumer-health.json');
  expect(supervisorHealthPath({ consumer: 'ai1' }, env)).toBe('/tmp/nomorevibe-ai1-consumer-health.json');
  for (const path of ['/tmp/nomorevibe-worker-health.json', '/tmp/./nomorevibe-ai2-consumer-health.json'])
    expect(() => supervisorHealthPath({ consumer: 'ai1', healthPath: path }, env)).toThrow();
});
