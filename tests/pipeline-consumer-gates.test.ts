import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runFirstReviewConsumer } from '@/lib/crawl/consumers/first';
import { runSecondReviewConsumer } from '@/lib/crawl/consumers/second';
import { createProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { pinReviewRanks } from './review-task-ranks-fixture';

/*
 * PR06e AI1/AI2 consumer 의 claim 전 관문 — provider 회로와 host 장부 admission. lifecycle 은 경계만 흉내 낸다(실제 claim 은 integration).
 * 관문이 없으면 lifecycle 인자가 지금과 같고, 관문이 미루면 lifecycle(=claim)을 부르지 않는다.
 */
const mocks = vi.hoisted(() => ({ pages: [] as unknown[][], reservedPages: [] as unknown[][], select: vi.fn(), limit: vi.fn(), reservedLimit: vi.fn(), sleep: vi.fn(), first: vi.fn(), second: vi.fn(),
  settings: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { select: mocks.select }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: () => null }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings }));
vi.mock('@/lib/crawl/agent-review-repository', () => ({ reviewCandidatePredicate: () => undefined }));
vi.mock('@/lib/crawl/agent-review-item-lifecycle', () => ({ executeFirstReviewConsumerItem: mocks.first }));
vi.mock('@/lib/crawl/second-review-item-lifecycle', () => ({ executeSecondReviewConsumerItem: mocks.second }));
vi.mock('@/lib/crawl/first-reviewer-blocks', () => ({ readBlockedFirstReviewerKeys: async () => new Set<string>() }));
vi.mock('@/scripts/worker', () => ({ interruptibleSleep: mocks.sleep }));
vi.mock('@/lib/observability/logger', () => ({ logger: { info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() } }));

const owner = { instanceId: 'pr06e-unit', bootId: 'f70bfcce-92d0-4ed8-a5db-bfd092d17950' };
const first = (id: number) => ({ id, reviewed: false, updatedAt: '2026-10-17 00:00:00.000001', ceiling: 100 });
type Reply = { ok: boolean; error?: string } | null;
function replies(values: Reply[], written: object) {
  return async (input: { onProviderResult?: (result: Reply) => void }) => {
    const value = values.shift();
    if (value) input.onProviderResult?.(value);
    return written;
  };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.pages = []; mocks.reservedPages = [];
  mocks.limit.mockImplementation(async () => mocks.pages.shift() ?? []);
  mocks.reservedLimit.mockImplementation(async () => mocks.reservedPages.shift() ?? []);
  mocks.select.mockImplementation((fields: Record<string, unknown>) => ({ from: () => ({
    innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit:
      new PgDialect().sqlToQuery(fields.reserved as SQL).params[0] === false ? async () => [] : mocks.reservedLimit }) }) }),
    where: () => ({ orderBy: () => ({ limit: mocks.limit }) }),
  }) }));
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true });
  // 두 소비자는 「작업 ↔ 모델」 순위만 읽는다(PR C1) — 순위가 없으면 쪽을 보지 않고 쉰다(아래 degraded 시험)
  pinReviewRanks({ first: [{ provider: 'abcllm', model: 'first-model' }], second: [[{ provider: 'abcllm', model: 'fallback-model' }]] });
});
afterEach(() => pinReviewRanks(null));

it('without gates passes the exact previous lifecycle arguments', async () => {
  mocks.pages = [[first(4)]]; mocks.first.mockResolvedValue({ applied: true, state: 'succeeded' });
  mocks.second.mockResolvedValue({ state: 'recorded' });
  expect(await runFirstReviewConsumer({ owner, once: true })).toEqual({ attempted: 1, recorded: 1, skipped: 0, deferred: 0 });
  // AI1 은 늘 순위 고르기다(PR C1): 쉬는·막힌 모델 집합과 모델별 회로를 항목에 넘긴다(관문이 없으면 회로는 undefined)
  expect(mocks.first).toHaveBeenCalledExactlyOnceWith({ candidateId: 4, owner, signal: undefined,
    pausedReviewers: new Set(), blockedReviewers: new Set(), reviewerCircuits: undefined });
  mocks.pages = [[{ id: 9, fallback: false, provider: 'abcllm' }]];
  expect(await runSecondReviewConsumer({ owner, once: true })).toEqual({ attempted: 1, recorded: 1, skipped: 0, deferred: 0 });
  expect(mocks.second).toHaveBeenCalledExactlyOnceWith({ secondReviewId: 9, owner, signal: undefined });
  expect(mocks.info).not.toHaveBeenCalled();
});

// PR C1: 소비자 쪽의 AI1 단일 회로(쪽 끝 쉼)는 없앴다 — 회로는 고른 모델마다 항목 생애(agent-review-item-lifecycle)가 'ai1:<모델>' 로 연다
// (tests/agent-review-item-model-capacity.test.ts). 소비자는 같은 회로 묶음을 모든 항목에 넘기고, 회로가 열린 항목의 건너뜀은 쪽을 멈추지 않는다.
it('AI1 hands the same per-model circuits to every item and keeps scanning past a circuit-held item', async () => {
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 1, openMs: 60_000 }, { log: () => {} });
  mocks.pages = [[first(4), first(5), first(6)]];
  mocks.first.mockResolvedValueOnce({ state: 'skipped', reason: 'provider_circuit_open' }).mockResolvedValue({ applied: true, state: 'succeeded' });
  expect(await runFirstReviewConsumer({ owner, once: true, circuits })).toEqual({ attempted: 3, recorded: 2, skipped: 1, deferred: 0 });
  expect(mocks.first.mock.calls.map(call => call[0].candidateId)).toEqual([4, 5, 6]);
  expect(mocks.first.mock.calls.every(call => call[0].reviewerCircuits === circuits)).toBe(true);
  // 예전 단일 회로의 결과 콜백은 넘기지 않는다
  expect(mocks.first.mock.calls.some(call => 'onProviderResult' in call[0])).toBe(false);
});

it('a consumer without ranks rests without claiming — no default reviewer or voter is called', async () => {
  pinReviewRanks({});
  mocks.pages = [[first(4)]];
  expect(await runFirstReviewConsumer({ owner, once: true })).toEqual({ attempted: 0, recorded: 0, skipped: 0, deferred: 1 });
  expect(mocks.first).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledWith('pipeline_consumer.degraded', expect.objectContaining({ stage: 'ai1', code: 'no_task_models' }));
  mocks.pages = [[{ id: 9, fallback: false, provider: 'abcllm' }]];
  expect(await runSecondReviewConsumer({ owner, once: true })).toEqual({ attempted: 0, recorded: 0, skipped: 0, deferred: 1 });
  expect(mocks.second).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledWith('pipeline_consumer.degraded', expect.objectContaining({ stage: 'ai2', code: 'no_task_models' }));
});

it('AI2 holds only the failing provider and keeps claiming the healthy provider', async () => {
  const logs: string[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 1, openMs: 60_000 }, { log: (event, fields) => logs.push(`${event}:${fields.key}`) });
  mocks.pages = [[{ id: 1, fallback: false, provider: 'grok-cli', model: 'grok' }, { id: 2, fallback: false, provider: 'abcllm', model: 'fallback-model' },
    { id: 3, fallback: false, provider: 'grok-cli', model: 'grok' }, { id: 4, fallback: false, provider: 'abcllm', model: 'fallback-model' }]];
  mocks.second.mockImplementation(replies([{ ok: false, error: 'budget' }, { ok: true }, { ok: true }], { state: 'recorded' }));
  expect(await runSecondReviewConsumer({ owner, once: true, circuits })).toEqual({ attempted: 3, recorded: 3, skipped: 0, deferred: 1 });
  expect(mocks.second.mock.calls.map(call => call[0].secondReviewId)).toEqual([1, 2, 4]);
  expect(logs).toEqual(['provider_circuit.opened:ai2:grok-cli:grok']);
});

it.each([false, true])('AI2 isolates a failing direct model from the same provider fallback (reserved=%s)', async reserved => {
  const logs: string[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 1, openMs: 60_000 }, { log: (event, fields) => logs.push(`${event}:${fields.key}`) });
  const direct = { id: 1, fallback: false, provider: 'abcllm', model: 'gpu3090-qwen' };
  mocks.pages = [[...(reserved ? [] : [direct]), { id: 2, fallback: true, provider: 'abcllm', model: 'fallback-model' },
    { ...direct, id: 3 }, { id: 4, fallback: true, provider: 'abcllm', model: 'fallback-model' }]];
  if (reserved) mocks.reservedPages = [[{ ...direct, reserved: true, ordinal: 1 }]];
  mocks.second.mockImplementation(replies([{ ok: false, error: 'gateway_error' }, { ok: true }, { ok: true }], { state: 'recorded' }));
  expect(await runSecondReviewConsumer({ owner, once: true, circuits })).toEqual({ attempted: 3, recorded: 3, skipped: 0, deferred: 1 });
  expect(mocks.second.mock.calls.map(call => call[0].secondReviewId)).toEqual([1, 2, 4]);
  expect(logs).toEqual(['provider_circuit.opened:ai2:abcllm:gpu3090-qwen']);
});

it.each(['ai1', 'ai2'] as const)('%s host admission defers before any claim, logs the reason, and releases an admitted slot even when the item throws', async stage => {
  const run = stage === 'ai1' ? runFirstReviewConsumer : runSecondReviewConsumer, item = stage === 'ai1' ? mocks.first : mocks.second;
  const job = stage === 'ai1' ? 'crawl-agent-review' : 'second-review', hint = stage === 'ai1' ? first(4) : { id: 4, fallback: false, provider: 'abcllm' };
  const admit = vi.fn().mockResolvedValueOnce({ admitted: false, reason: 'host_pressure_rss' });
  mocks.pages = [[hint]];
  expect(await run({ owner, once: true, admit })).toEqual({ attempted: 0, recorded: 0, skipped: 0, deferred: 1 });
  expect(admit).toHaveBeenCalledExactlyOnceWith(job); expect(item).not.toHaveBeenCalled();
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith('pipeline_consumer.deferred', { stage, reason: 'host_pressure_rss' });
  admit.mockRejectedValueOnce(new Error('ledger down')); mocks.pages = [[hint]];
  expect(await run({ owner, once: true, admit })).toMatchObject({ attempted: 0, deferred: 1 });
  expect(mocks.info).toHaveBeenLastCalledWith('pipeline_consumer.deferred', { stage, reason: 'host_budget_unavailable' });
  const events: string[] = [], failure = new Error('SQL failure');
  admit.mockResolvedValueOnce({ admitted: true, release: async () => { events.push('release'); } });
  item.mockImplementationOnce(async () => { events.push('item'); throw failure; });
  mocks.pages = [[hint]];
  await expect(run({ owner, once: true, admit })).rejects.toBe(failure);
  expect(events).toEqual(['item', 'release']);
});

// PR C1: AI1 의 「host 장부 전에 회로」 관문(단일 회로)은 없앴다 — 회로는 고른 모델마다 항목 안에서 본다. host 자리는 항목이 끝나면 돌려준다.
it('AI1 releases its host slot after an item held by its model circuit', async () => {
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 1, openMs: 60_000 }, { log: () => {} });
  const released: number[] = [];
  const admit = vi.fn().mockImplementation(async () => ({ admitted: true, release: async () => { released.push(1); } }));
  mocks.pages = [[first(4), first(5)]];
  mocks.first.mockResolvedValue({ state: 'skipped', reason: 'provider_circuit_open' });
  expect(await runFirstReviewConsumer({ owner, once: true, circuits, admit })).toEqual({ attempted: 2, recorded: 0, skipped: 2, deferred: 0 });
  expect(admit).toHaveBeenCalledTimes(2); expect(released).toEqual([1, 1]);
});
