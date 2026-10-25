import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { executeSecondReviewConsumerItem } from '@/lib/crawl/second-review-item-lifecycle';
import * as itemLifecycle from '@/lib/crawl/second-review-item-lifecycle';
import { runSecondReviewConsumer } from '@/lib/crawl/consumers/second';
import { parsePipelineConsumerArgs, runPipelineConsumer } from '@/scripts/pipeline-consumer';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';

const mocks = vi.hoisted(() => ({
  pages: [] as { id: number; fallback: boolean }[][], where: vi.fn(), limit: vi.fn(), select: vi.fn(),
  reservedPages: [] as ({ id: number; fallback: boolean; reserved: true; ordinal: number } | null)[], reservedJoin: vi.fn(), reservedWhere: vi.fn(), reservedLimit: vi.fn(),
  waitingPages: [] as ({ id: number; fallback: boolean; reserved: false; ordinal: number } | null)[], waitingJoin: vi.fn(), waitingWhere: vi.fn(), waitingLimit: vi.fn(),
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
  vi.resetAllMocks(); mocks.pages = []; mocks.reservedPages = []; mocks.waitingPages = [];
  mocks.limit.mockImplementation(async () => mocks.pages.shift() ?? []);
  mocks.reservedLimit.mockImplementation(async () => { const hint = mocks.reservedPages.shift(); return hint ? [hint] : []; });
  mocks.waitingLimit.mockImplementation(async () => { const hint = mocks.waitingPages.shift(); return hint ? [hint] : []; });
  mocks.select.mockImplementation((fields: Record<string, unknown>) => ({ from: () => ({ where: (condition: SQL) => {
    const reserved = 'reserved' in fields;
    (reserved ? mocks.reservedWhere : mocks.where)(condition);
    return { orderBy: () => ({ limit: reserved ? mocks.reservedLimit : mocks.limit }) };
  }, innerJoin: (_table: unknown, condition: SQL) => {
    const waiting = new PgDialect().sqlToQuery(fields.reserved as SQL).params[0] === false;
    (waiting ? mocks.waitingJoin : mocks.reservedJoin)(condition); return { where: (condition: SQL) => {
    (waiting ? mocks.waitingWhere : mocks.reservedWhere)(condition); return { orderBy: () => ({ limit: waiting ? mocks.waitingLimit : mocks.reservedLimit }) };
  } }; } }) }));
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
  expect(mocks.where).toHaveBeenCalledTimes(3); expect(mocks.sleep).toHaveBeenCalledTimes(1);
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
it('consumes an owned reservation on the next poll while the normal cursor moves past its deferred hint', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const abort = new AbortController(), calls: { id: number; at: number }[] = [];
  mocks.pages = [[{ id: 4, fallback: false }, { id: 5, fallback: false }], [{ id: 5, fallback: false }], []];
  mocks.reservedPages = [null, { id: 4, fallback: false, reserved: true, ordinal: 1 }];
  mocks.claim.mockImplementation(async (id: number) => {
    calls.push({ id, at: Date.now() });
    if (id !== 4) return { kind: 'skipped', reason: 'running' };
    if (Date.now() === 0) throw new ModelCapacityDeferredError('capacity');
    return { kind: 'claimed', row, receipt };
  });
  mocks.sleep.mockImplementation(async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    if (mocks.sleep.mock.calls.length >= 2) abort.abort();
  });
  expect(await runSecondReviewConsumer({ owner: owner(), signal: abort.signal }))
    .toEqual({ attempted: 3, recorded: 1, skipped: 1, deferred: 1 });
  expect(calls).toEqual([{ id: 4, at: 0 }, { id: 4, at: 5_000 }, { id: 5, at: 5_000 }]);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1); expect(mocks.record).toHaveBeenCalledTimes(1);
});
it.each([3, 1000])('keeps the normal keyset when reserved hint %s is outside its next page', async id => {
  mocks.pages = [Array.from({ length: 24 }, (_, index) => ({ id: index + 1, fallback: false })),
    Array.from({ length: 24 }, (_, index) => ({ id: index + 25, fallback: false })), []];
  mocks.reservedPages = [null, { id, fallback: false, reserved: true, ordinal: 1 }];
  await runSecondReviewConsumer({ owner: owner(), once: true });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([
    ...Array.from({ length: 24 }, (_, index) => index + 1), id,
    ...Array.from({ length: 24 }, (_, index) => index + 25),
  ]);
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(mocks.where.mock.calls[1][0]).params).toContain(24);
  expect(dialect.sqlToQuery(mocks.where.mock.calls[2][0]).params).toContain(48);
  expect(mocks.reservedLimit.mock.calls.flat().every(limit => limit === 1)).toBe(true);
});
it('continues normal work after a stale reserved hint defers and never attempts a duplicate hint', async () => {
  mocks.reservedPages = [{ id: 4, fallback: false, reserved: true, ordinal: 1 }];
  mocks.pages = [[{ id: 4, fallback: false }, { id: 5, fallback: false }]];
  mocks.claim.mockImplementation(async (id: number) => {
    if (id === 4) throw new ModelCapacityDeferredError('capacity');
    return { kind: 'claimed', row: { ...row, id }, receipt };
  });
  expect(await runSecondReviewConsumer({ owner: owner(), once: true }))
    .toEqual({ attempted: 2, recorded: 1, skipped: 0, deferred: 1 });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([4, 5]);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
});
it('rotates reserved hints past stale reservations without changing the normal scan', async () => {
  const abort = new AbortController();
  mocks.sleep.mockImplementation(async () => { if (mocks.sleep.mock.calls.length >= 3) abort.abort(); });
  mocks.reservedPages = [
    { id: 4, fallback: false, reserved: true, ordinal: 1 },
    { id: 5, fallback: false, reserved: true, ordinal: 2 },
    { id: 6, fallback: false, reserved: true, ordinal: 3 },
  ];
  mocks.pages = [[{ id: 100, fallback: false }], [{ id: 101, fallback: false }], []];
  mocks.claim.mockImplementation(async (id: number) => {
    if (id === 4 || id === 5) throw new ModelCapacityDeferredError('capacity');
    if (id === 6) { abort.abort(); return { kind: 'claimed', row: { ...row, id }, receipt }; }
    return { kind: 'skipped', reason: 'running' };
  });
  await runSecondReviewConsumer({ owner: owner(), signal: abort.signal });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([4, 100, 5, 101, 6]);
  const dialect = new PgDialect();
  const second = dialect.sqlToQuery(mocks.reservedWhere.mock.calls[1][0]);
  const third = dialect.sqlToQuery(mocks.reservedWhere.mock.calls[2][0]);
  expect(second.params).toEqual(expect.arrayContaining([1, 4]));
  expect(third.params).toEqual(expect.arrayContaining([2, 5]));
  expect(second.sql).toContain('queue_ordinal');
});
it('queries reserved hints only for the current owner boot and live matching AI2 route/model', async () => {
  await runSecondReviewConsumer({ owner: owner(), once: true });
  expect(mocks.reservedWhere).toHaveBeenCalledTimes(1);
  const dialect = new PgDialect(), query = dialect.sqlToQuery(mocks.reservedWhere.mock.calls[0][0]);
  const join = dialect.sqlToQuery(mocks.reservedJoin.mock.calls[0][0]);
  expect(query.params).toEqual(expect.arrayContaining([owner().instanceId, owner().bootId]));
  for (const column of ['owner_instance_id', 'owner_boot_id', 'reserved_until', 'logical_work_key', 'candidate_id', 'fallback_for_id', 'provider', 'model'])
    expect(query.sql + join.sql).toContain(column);
  expect(query.sql).toContain('clock_timestamp()'); expect(query.params).toContain('reserved');
  expect(mocks.reservedLimit).toHaveBeenCalledExactlyOnceWith(1);
  for (const [fields] of mocks.select.mock.calls) expect(fields).toHaveProperty('model');
});
it('wraps the normal scan at EOF even when a stale reservation defers on every following poll', async () => {
  const abort = new AbortController();
  const stale = { id: 1000, fallback: false, reserved: true as const, ordinal: 1 };
  mocks.reservedPages = [null, stale, null, stale];
  mocks.limit.mockImplementation(async () => {
    if (mocks.limit.mock.calls.length === 1) return Array.from({ length: 24 }, (_, index) => ({ id: index + 1, fallback: false }));
    if (mocks.limit.mock.calls.length === 2) return [];
    const query = new PgDialect().sqlToQuery(mocks.where.mock.calls.at(-1)![0]);
    return query.params.includes(24) ? [] : [{ id: 4, fallback: false }];
  });
  mocks.claim.mockImplementation(async (id: number) => {
    if (id === 1000) throw new ModelCapacityDeferredError('capacity');
    return id === 4 && mocks.limit.mock.calls.length >= 3 ? { kind: 'claimed', row, receipt } : { kind: 'skipped', reason: 'running' };
  });
  mocks.record.mockImplementation(async () => { abort.abort(); return { state: 'recorded' }; });
  mocks.sleep.mockImplementation(async () => { if (mocks.sleep.mock.calls.length >= 2) abort.abort(); });
  expect(await runSecondReviewConsumer({ owner: owner(), signal: abort.signal })).toMatchObject({ recorded: 1 });
  expect(mocks.claim.mock.calls.filter(call => call[0] === 4)).toHaveLength(2);
  const next = new PgDialect().sqlToQuery(mocks.where.mock.calls[2][0]);
  expect(next.params).not.toContain(24);
  expect(mocks.limit).toHaveBeenCalledTimes(3); expect(mocks.reservedLimit).toHaveBeenCalledTimes(4);
});
it('wraps the reserved scan once at EOF and keeps each priority query bounded to one hint', async () => {
  mocks.reservedPages = [{ id: 1000, fallback: false, reserved: true, ordinal: 10 }, null,
    { id: 2000, fallback: false, reserved: true, ordinal: 1 }];
  mocks.pages = [Array.from({ length: 24 }, (_, index) => ({ id: index + 1, fallback: false })), []];
  expect(await runSecondReviewConsumer({ owner: owner(), once: true })).toMatchObject({ attempted: 26 });
  expect(mocks.reservedLimit.mock.calls.flat()).toEqual([1, 1, 1]);
  expect(mocks.limit.mock.calls.flat()).toEqual([24, 24]);
  const query = new PgDialect().sqlToQuery(mocks.reservedWhere.mock.calls[2][0]);
  expect(query.params).not.toContain(10); expect(query.params).not.toContain(1000);
});
it('bounds a once pass with a priority hint on every page to 100 attempts', async () => {
  mocks.reservedPages = Array.from({ length: 5 }, (_, index) => ({ id: index + 1000, fallback: false, reserved: true, ordinal: index + 1 }));
  mocks.pages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 24 }, (_, index) => ({ id: page * 24 + index + 1, fallback: false })));
  expect(await runSecondReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 100, recorded: 0, skipped: 100, deferred: 0 });
  expect(mocks.reservedLimit).toHaveBeenCalledTimes(4); expect(mocks.limit).toHaveBeenCalledTimes(4);
});
it('revisits an aged capacity waiter before the normal cursor reaches EOF', async () => {
  const abort = new AbortController();
  mocks.pages = [Array.from({ length: 24 }, (_, index) => ({ id: index + 1, fallback: false })), [{ id: 5, fallback: false }]];
  mocks.waitingPages = [null, { id: 1, fallback: false, reserved: false, ordinal: 1 }];
  mocks.claim.mockImplementation(async (id: number) => {
    if (id === 1 && mocks.waitingLimit.mock.calls.length === 1) throw new ModelCapacityDeferredError('capacity');
    if (id === 1) { abort.abort(); return { kind: 'skipped', reason: 'running' }; }
    return { kind: 'skipped', reason: 'running' };
  });
  expect(await runSecondReviewConsumer({ owner: owner(), signal: abort.signal })).toMatchObject({ attempted: 2, deferred: 1 });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([1, 1]);
  expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[1][0]).params).toContain(1);
  const query = new PgDialect().sqlToQuery(mocks.waitingWhere.mock.calls[0][0]);
  expect(query.params).toEqual(expect.arrayContaining(['waiting', 'local-direct', owner().instanceId, owner().bootId]));
  for (const fragment of ['queued_at', 'queue_until', '15 seconds', 'fallback_for_id']) expect(query.sql).toContain(fragment);
});
it('runs a granted reservation before an aged waiter and still makes normal progress', async () => {
  mocks.reservedPages = [{ id: 1000, fallback: false, reserved: true, ordinal: 10 }];
  mocks.waitingPages = [{ id: 2000, fallback: false, reserved: false, ordinal: 2 }];
  mocks.pages = [[{ id: 1000, fallback: false }, { id: 2000, fallback: false }, { id: 3, fallback: false }]];
  mocks.claim.mockImplementation(async (id: number) => {
    if (id === 2000) throw new ModelCapacityDeferredError('capacity');
    return { kind: 'skipped', reason: 'running' };
  });
  expect(await runSecondReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 3, recorded: 0, skipped: 2, deferred: 1 });
  expect(mocks.claim.mock.calls.map(call => call[0])).toEqual([1000, 2000, 3]);
});
it('keeps separate waiting rotation and caps a once pass with both priorities at 100 attempts', async () => {
  mocks.reservedPages = Array.from({ length: 4 }, (_, index) => ({ id: index + 1000, fallback: false, reserved: true, ordinal: index + 1 }));
  mocks.waitingPages = Array.from({ length: 4 }, (_, index) => ({ id: index + 2000, fallback: false, reserved: false, ordinal: index + 10 }));
  mocks.pages = Array.from({ length: 4 }, (_, page) => Array.from({ length: 24 }, (_, index) => ({ id: page * 24 + index + 1, fallback: false })));
  expect(await runSecondReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 100, recorded: 0, skipped: 100, deferred: 0 });
  const query = new PgDialect().sqlToQuery(mocks.waitingWhere.mock.calls[1][0]);
  expect(query.params).toEqual(expect.arrayContaining([10, 2000])); expect(query.params).not.toContain(1000);
  expect(mocks.reservedLimit).toHaveBeenCalledTimes(4); expect(mocks.waitingLimit).toHaveBeenCalledTimes(4);
});
it('restarts the normal fallback scan after rerouting before another aged waiter can end the batch', async () => {
  const abort = new AbortController(), attempted: number[] = [];
  mocks.pages = [Array.from({ length: 24 }, (_, index) => ({ id: index + 1, fallback: false })),
    [{ id: 25, fallback: false }], [{ id: 200, fallback: true }, { id: 25, fallback: false }]];
  mocks.reservedPages = [null, { id: 90, fallback: false, reserved: true, ordinal: 1 },
    { id: 91, fallback: false, reserved: true, ordinal: 2 }];
  mocks.waitingPages = [null, { id: 1, fallback: false, reserved: false, ordinal: 1 },
    { id: 2, fallback: false, reserved: false, ordinal: 2 }];
  const execute = vi.spyOn(itemLifecycle, 'executeSecondReviewConsumerItem').mockImplementation(async input => {
    attempted.push(input.secondReviewId);
    if (input.secondReviewId === 1 && mocks.limit.mock.calls.length === 2) return { state: 'rerouted' };
    if (input.secondReviewId === 200) { abort.abort(); return { state: 'recorded' }; }
    return { state: 'skipped', reason: 'running' };
  });
  try {
    expect(await runSecondReviewConsumer({ owner: owner(), signal: abort.signal }))
      .toEqual({ attempted: 28, recorded: 1, skipped: 27, deferred: 0 });
    expect(attempted).toEqual([...Array.from({ length: 24 }, (_, index) => index + 1), 90, 1, 91, 200]);
    expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[2][0]).params).not.toContain(24);
    expect(mocks.waitingLimit).toHaveBeenCalledTimes(2); expect(mocks.sleep).not.toHaveBeenCalled();
  } finally { execute.mockRestore(); }
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
