import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { executeSecondReviewConsumerItem } from '@/lib/crawl/second-review-item-lifecycle';
import { runSecondReviewConsumer } from '@/lib/crawl/consumers/second';
import { parsePipelineConsumerArgs, runPipelineConsumer } from '@/scripts/pipeline-consumer';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';

const mocks = vi.hoisted(() => ({
  pages: [] as { id: number; fallback: boolean }[][], where: vi.fn(), limit: vi.fn(), select: vi.fn(),
  claim: vi.fn(), compatibility: vi.fn(), observe: vi.fn(), renew: vi.fn(), record: vi.fn(), dispatch: vi.fn(),
  sleep: vi.fn(), report: vi.fn(), runtime: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: { select: mocks.select }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: () => null }));
vi.mock('@/lib/crawl/second-review-ownership', () => ({
  claimConsumerItemSecondReview: mocks.claim, claimItemSecondReview: mocks.compatibility,
  observeSecondReviewItemDispatch: mocks.observe, renewSecondReviewOwnership: mocks.renew,
}));
vi.mock('@/lib/crawl/second-review', () => ({ recordSecondReview: mocks.record }));
vi.mock('@/lib/crawl/second-review-transport', () => ({ dispatchSecondReviewTransport: mocks.dispatch,
  secondReviewTransportTimeoutMs: () => 60_000 }));
vi.mock('@/scripts/worker', () => ({ interruptibleSleep: mocks.sleep, withRuntimeProcess: mocks.runtime }));

const owner = () => ({ instanceId: 'pr06-unit', bootId: 'f70bfcce-92d0-4ed8-a5db-bfd092d17950' });
const row = { id: 4, candidateId: 3, firstAttemptId: 2, fallbackForId: null, generationKey: 'unit-generation',
  provider: 'abcllm', model: 'unchanged-model' };
const receipt = { binding: { secondReviewId: 4 }, ownership: { kind: 'item' } };
const success = { ok: true, outcome: { decision: 'approve', confidence: .95, reason: 'Application' } };
function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.pages = [];
  mocks.limit.mockImplementation(async () => mocks.pages.shift() ?? []);
  mocks.select.mockImplementation(() => ({ from: () => ({ where: (condition: SQL) => {
    mocks.where(condition); return { orderBy: () => ({ limit: mocks.limit }) };
  } }) }));
  mocks.claim.mockResolvedValue({ kind: 'skipped', reason: 'running' });
  mocks.compatibility.mockResolvedValue({ kind: 'skipped', reason: 'running' });
  mocks.observe.mockResolvedValue({ kind: 'current', row, input: { actual: 'observed' } });
  mocks.renew.mockResolvedValue({}); mocks.record.mockResolvedValue({ state: 'recorded' });
  mocks.dispatch.mockResolvedValue(success);
  mocks.runtime.mockImplementation(async (_role, load) => load(new AbortController().signal, mocks.report));
});
afterEach(() => { vi.useRealTimers(); });

it('parses only the fixed AI2 command and rejects duplicate or arbitrary flags', () => {
  expect(parsePipelineConsumerArgs(['--stage=ai2', '--once'])).toEqual({ stage: 'ai2', once: true });
  for (const args of [[], ['--stage=ai1'], ['--stage=ai2', '--stage=ai2'], ['--stage=ai2', '--once', '--once'],
    ['--stage=ai2', '--script=anything'], ['--stage=ai2', '--interval-seconds=1']]) expect(() => parsePipelineConsumerArgs(args)).toThrow();
});
it('default opt-out does not start a runtime, query a queue or claim an item', async () => {
  expect(await runPipelineConsumer(['--stage=ai2'], {})).toEqual({ state: 'disabled' });
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled();
});
it('rejects unknown versions and invalid process identity before database work', async () => {
  for (const env of [{ PIPELINE_ITEM_CONSUMER_VERSION: '2' }, { PIPELINE_ITEM_CONSUMER_VERSION: '0' },
    { PIPELINE_ITEM_CONSUMER_VERSION: '1' }, { PIPELINE_ITEM_CONSUMER_VERSION: '1', PIPELINE_ITEM_CONSUMER_INSTANCE_ID: ' bad ' }]) {
    await expect(runPipelineConsumer(['--stage=ai2', '--once'], env)).rejects.toThrow();
  }
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
});
it('explicit launch uses one new process boot and the existing runtime drain wrapper', async () => {
  mocks.pages = [[{ id: 4, fallback: false }]];
  await runPipelineConsumer(['--stage=ai2', '--once'], { PIPELINE_ITEM_CONSUMER_VERSION: '1', PIPELINE_ITEM_CONSUMER_INSTANCE_ID: 'item-process' });
  expect(mocks.runtime).toHaveBeenCalledExactlyOnceWith('reviewer', expect.any(Function));
  expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(4, { instanceId: 'item-process', bootId: expect.any(String) }, 90_000);
  expect(mocks.claim.mock.calls[0][1].bootId).toMatch(/^[a-f0-9-]{36}$/);
});
it('uses the fixed consumer claim and the original observed input, receipt and mandatory writer', async () => {
  mocks.claim.mockResolvedValue({ kind: 'claimed', row, receipt });
  expect(await executeSecondReviewConsumerItem({ secondReviewId: 4, owner: owner() })).toEqual({ state: 'recorded' });
  expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(4, owner(), 90_000); expect(mocks.compatibility).not.toHaveBeenCalled();
  expect(mocks.dispatch.mock.calls[0][1]).toEqual({ actual: 'observed' });
  expect(mocks.record.mock.calls[0][0].receipt).toBe(receipt);
});
it('consumer lifecycle snapshots strict identity and rejects a pre-aborted caller without a claim', async () => {
  const abort = new AbortController(); abort.abort();
  expect(await executeSecondReviewConsumerItem({ secondReviewId: 4, owner: owner(), signal: abort.signal })).toEqual({ state: 'skipped', reason: 'aborted' });
  await expect(executeSecondReviewConsumerItem({ secondReviewId: 0, owner: owner() })).rejects.toThrow();
  await expect(executeSecondReviewConsumerItem({ secondReviewId: 4, owner: { ...owner(), extra: true } as ReturnType<typeof owner> })).rejects.toThrow();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('an empty bounded pass does not call a model, claim, writer or sleep in once mode', async () => {
  expect(await runSecondReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 0, recorded: 0, skipped: 0, deferred: 0 });
  expect(mocks.limit).toHaveBeenCalledExactlyOnceWith(24);
  expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.sleep).not.toHaveBeenCalled();
});
it('refills one lane immediately after completion and resets its per-item runtime clock', async () => {
  mocks.pages = [[{ id: 4, fallback: true }, { id: 5, fallback: false }]];
  mocks.claim.mockImplementation(async (id: number) => ({ kind: 'claimed', row: { ...row, id }, receipt }));
  const result = await runSecondReviewConsumer({ owner: owner(), once: true, report: mocks.report });
  expect(result).toEqual({ attempted: 2, recorded: 2, skipped: 0, deferred: 0 });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([4, 5]); expect(mocks.sleep).not.toHaveBeenCalled();
  expect(mocks.report.mock.calls.filter(call => call[0] === 'running')).toEqual([
    ['running', 'second-review', expect.any(Number)], ['running', 'second-review', expect.any(Number)],
  ]);
});
it('queries immediately after a short completed page before taking the empty-queue backoff', async () => {
  const abort = new AbortController();
  mocks.pages = [[{ id: 4, fallback: false }], [{ id: 5, fallback: false }], []];
  mocks.claim.mockImplementation(async (id: number) => ({ kind: 'claimed', row: { ...row, id }, receipt }));
  mocks.sleep.mockImplementation(async () => { abort.abort(); });
  expect(await runSecondReviewConsumer({ owner: owner(), signal: abort.signal })).toMatchObject({ attempted: 2, recorded: 2 });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([4, 5]);
  expect(mocks.select).toHaveBeenCalledTimes(3); expect(mocks.sleep).toHaveBeenCalledTimes(1);
});
it('advances fallback-first keysets past busy low IDs to later rows without an unbounded scan', async () => {
  mocks.pages = [Array.from({ length: 24 }, (_, index) => ({ id: index + 1, fallback: true })), [{ id: 25, fallback: false }]];
  const result = await runSecondReviewConsumer({ owner: owner(), once: true });
  expect(result).toEqual({ attempted: 25, recorded: 0, skipped: 25, deferred: 0 });
  expect(mocks.claim.mock.calls.at(-1)?.[0]).toBe(25);
  const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[1][0]);
  expect(query.sql).toContain('fallback_for_id'); expect(query.sql).toContain(' > '); expect(query.params).toContain(24);
  expect(mocks.limit.mock.calls.flat()).toEqual([24, 24]);
});
it('limits a once pass to four pages even when every hint stays busy', async () => {
  mocks.pages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 24 }, (_, index) => ({ id: page * 24 + index + 1, fallback: false })));
  expect(await runSecondReviewConsumer({ owner: owner(), once: true })).toMatchObject({ attempted: 96, skipped: 96 });
  expect(mocks.limit).toHaveBeenCalledTimes(4); expect(mocks.claim).toHaveBeenCalledTimes(96);
});
it('limits a successful once pass to four pages even when every page records work', async () => {
  mocks.pages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 24 }, (_, index) => ({ id: page * 24 + index + 1, fallback: false })));
  mocks.claim.mockImplementation(async (id: number) => ({ kind: 'claimed', row: { ...row, id }, receipt }));
  expect(await runSecondReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 96, recorded: 96, skipped: 0, deferred: 0 });
  expect(mocks.limit).toHaveBeenCalledTimes(4); expect(mocks.claim).toHaveBeenCalledTimes(96);
  expect(mocks.record).toHaveBeenCalledTimes(96); expect(mocks.sleep).not.toHaveBeenCalled();
});

it('backs off a typed model refusal and resumes past that hint without a hot loop', async () => {
  const abort = new AbortController();
  mocks.pages = [[{ id: 4, fallback: false }, { id: 5, fallback: false }], [{ id: 5, fallback: false }]];
  mocks.claim.mockRejectedValueOnce(new ModelCapacityDeferredError('disabled'));
  mocks.sleep.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { abort.abort(); });
  const result = await runSecondReviewConsumer({ owner: owner(), signal: abort.signal });
  expect(result).toEqual({ attempted: 2, recorded: 0, skipped: 1, deferred: 1 });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([4, 5]);
  expect(mocks.sleep).toHaveBeenNthCalledWith(1, 5_000, abort.signal); expect(mocks.record).not.toHaveBeenCalled();
});
it('re-polls an empty AI2 queue after 1s while a model deferral still waits 5s', async () => {
  const abort = new AbortController();
  mocks.pages = [[]];
  mocks.sleep.mockImplementation(async () => { abort.abort(); });
  await runSecondReviewConsumer({ owner: owner(), signal: abort.signal });
  expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(1_000, abort.signal);
});
it('stopClaims ends the loop and blocks new claims while the in-flight item keeps only the cancel signal', async () => {
  const cancel = new AbortController(), stopClaims = new AbortController(), sent = gate<typeof success>();
  mocks.pages = [[{ id: 4, fallback: false }, { id: 5, fallback: false }]];
  mocks.claim.mockImplementation(async (id: number) => ({ kind: 'claimed', row: { ...row, id }, receipt }));
  mocks.dispatch.mockImplementationOnce(async () => { stopClaims.abort(); return sent.promise; });
  const running = runSecondReviewConsumer({ owner: owner(), signal: cancel.signal, stopClaims: stopClaims.signal });
  await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
  const options = mocks.dispatch.mock.calls[0][2] as { signal: AbortSignal };
  expect(options.signal.aborted).toBe(false);
  sent.resolve(success);
  expect(await running).toEqual({ attempted: 1, recorded: 1, skipped: 0, deferred: 0 });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([4]); expect(mocks.sleep).not.toHaveBeenCalled();
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result: expect.objectContaining({ ok: true }) }));
});
it('stopClaims before the item starts skips it without a claim', async () => {
  const stopClaims = new AbortController(); stopClaims.abort();
  expect(await executeSecondReviewConsumerItem({ secondReviewId: 4, owner: owner(), stopClaims: stopClaims.signal }))
    .toEqual({ state: 'skipped', reason: 'aborted' });
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('stopClaims after the claim but before dispatch cancels without sending', async () => {
  const stopClaims = new AbortController();
  mocks.claim.mockImplementation(async (id: number) => { stopClaims.abort(); return { kind: 'claimed', row: { ...row, id }, receipt }; });
  await executeSecondReviewConsumerItem({ secondReviewId: 4, owner: owner(), stopClaims: stopClaims.signal });
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result: expect.objectContaining({ ok: false, error: 'cancelled' }) }));
});
it('preserves a genuine claim error instead of converting it to model defer', async () => {
  const original = new Error('actual database failure'); mocks.pages = [[{ id: 4, fallback: false }]];
  mocks.claim.mockRejectedValue(original);
  await expect(runSecondReviewConsumer({ owner: owner(), once: true })).rejects.toBe(original);
  expect(mocks.sleep).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
});
it('on abort awaits the current transport and its cancelled writer before loop completion', async () => {
  const abort = new AbortController(), transport = gate<typeof success>();
  mocks.pages = [[{ id: 4, fallback: false }, { id: 5, fallback: false }]];
  mocks.claim.mockResolvedValue({ kind: 'claimed', row, receipt }); mocks.dispatch.mockReturnValue(transport.promise);
  let finished = false;
  const running = runSecondReviewConsumer({ owner: owner(), signal: abort.signal }).finally(() => { finished = true; });
  try {
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce()); abort.abort();
    await Promise.resolve(); expect(finished).toBe(false); expect(mocks.record).not.toHaveBeenCalled();
  } finally { transport.resolve(success); await running; }
  expect(mocks.claim).toHaveBeenCalledTimes(1); expect(mocks.record).toHaveBeenCalledOnce();
  expect(mocks.record.mock.calls[0][0].result.error).toBe('cancelled');
});
it('does no DB work for an aborted loop and snapshots the caller owner across pages', async () => {
  const abort = new AbortController(); abort.abort();
  await runSecondReviewConsumer({ owner: owner(), signal: abort.signal }); expect(mocks.select).not.toHaveBeenCalled();
  const identity = owner(), started = gate<never>();
  void started.promise.catch(() => {});
  mocks.pages = [[{ id: 4, fallback: false }]]; mocks.claim.mockReturnValue(started.promise);
  const running = runSecondReviewConsumer({ owner: identity, once: true }); void running.catch(() => {});
  try {
    await vi.waitFor(() => expect(mocks.claim).toHaveBeenCalledOnce()); identity.bootId = randomUUID();
    expect(mocks.claim.mock.calls[0][1]).toEqual(owner());
  } finally { started.reject(new Error('end snapshot fixture')); await expect(running).rejects.toThrow('end snapshot fixture'); }
});
