import { beforeEach, expect, it, vi } from 'vitest';
import { runFirstReviewConsumer } from '@/lib/crawl/consumers/first';
import { runSecondReviewConsumer } from '@/lib/crawl/consumers/second';
import { createProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';

/*
 * PR06e AI1/AI2 consumer 의 claim 전 관문 — provider 회로와 host 장부 admission. lifecycle 은 경계만 흉내 낸다(실제 claim 은 integration).
 * 관문이 없으면 lifecycle 인자가 지금과 같고, 관문이 미루면 lifecycle(=claim)을 부르지 않는다.
 */
const mocks = vi.hoisted(() => ({ pages: [] as unknown[][], select: vi.fn(), limit: vi.fn(), sleep: vi.fn(), first: vi.fn(), second: vi.fn(),
  settings: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { select: mocks.select }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: () => null }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings }));
vi.mock('@/lib/crawl/agent-review-repository', () => ({ reviewCandidatePredicate: () => undefined }));
vi.mock('@/lib/crawl/agent-review-item-lifecycle', () => ({ executeFirstReviewConsumerItem: mocks.first }));
vi.mock('@/lib/crawl/second-review-item-lifecycle', () => ({ executeSecondReviewConsumerItem: mocks.second }));
vi.mock('@/scripts/worker', () => ({ interruptibleSleep: mocks.sleep }));
vi.mock('@/lib/observability/logger', () => ({ logger: { info: mocks.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

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
  vi.resetAllMocks(); mocks.pages = [];
  mocks.limit.mockImplementation(async () => mocks.pages.shift() ?? []);
  mocks.select.mockImplementation(() => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: mocks.limit }) }) }) }));
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true });
});

it('without gates passes the exact previous lifecycle arguments', async () => {
  mocks.pages = [[first(4)]]; mocks.first.mockResolvedValue({ applied: true, state: 'succeeded' });
  mocks.second.mockResolvedValue({ state: 'recorded' });
  expect(await runFirstReviewConsumer({ owner, once: true })).toEqual({ attempted: 1, recorded: 1, skipped: 0, deferred: 0 });
  expect(mocks.first).toHaveBeenCalledExactlyOnceWith({ candidateId: 4, owner, signal: undefined });
  mocks.pages = [[{ id: 9, fallback: false, provider: 'abcllm' }]];
  expect(await runSecondReviewConsumer({ owner, once: true })).toEqual({ attempted: 1, recorded: 1, skipped: 0, deferred: 0 });
  expect(mocks.second).toHaveBeenCalledExactlyOnceWith({ secondReviewId: 9, owner, signal: undefined });
  expect(mocks.info).not.toHaveBeenCalled();
});

it('AI1 stops claiming once technical failures open the circuit and resumes the same hint through one half-open trial', async () => {
  const clock = { now: 0 }, logs: string[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 2, openMs: 60_000 }, { now: () => clock.now, log: event => logs.push(event) });
  const page = [first(4), first(5), first(6), first(7)];
  mocks.pages = [page];
  mocks.first.mockImplementation(replies([{ ok: false, error: 'timeout' }, { ok: false, error: 'gateway_error' }], { applied: true, state: 'failed' }));
  expect(await runFirstReviewConsumer({ owner, once: true, circuits })).toEqual({ attempted: 2, recorded: 0, skipped: 2, deferred: 1 });
  expect(mocks.first.mock.calls.map(call => call[0].candidateId)).toEqual([4, 5]);
  expect(logs).toEqual(['provider_circuit.opened']);
  // 열린 동안: 같은 hint 부터 다시 보지만 claim(=lifecycle)은 0
  mocks.pages = [page.slice(2)];
  expect(await runFirstReviewConsumer({ owner, once: true, circuits })).toEqual({ attempted: 0, recorded: 0, skipped: 0, deferred: 1 });
  expect(mocks.first).toHaveBeenCalledTimes(2);
  clock.now = 60_000; mocks.pages = [page.slice(2)];
  mocks.first.mockImplementation(replies([{ ok: true }, { ok: true }], { applied: true, state: 'succeeded' }));
  expect(await runFirstReviewConsumer({ owner, once: true, circuits })).toEqual({ attempted: 2, recorded: 2, skipped: 0, deferred: 0 });
  expect(mocks.first.mock.calls.map(call => call[0].candidateId)).toEqual([4, 5, 6, 7]);
  expect(logs).toEqual(['provider_circuit.opened', 'provider_circuit.half_open', 'provider_circuit.closed']);
});

it('AI1 judgment, input and no-call results never open the circuit', async () => {
  const logs: string[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 1, openMs: 60_000 }, { log: event => logs.push(event) });
  mocks.pages = [[first(1), first(2), first(3), first(4)]];
  mocks.first.mockImplementation(replies([{ ok: false, error: 'invalid_output' }, { ok: false, error: 'input_too_large' }, null,
    { ok: false, error: 'cancelled' }], { applied: true, state: 'failed' }));
  expect(await runFirstReviewConsumer({ owner, once: true, circuits })).toEqual({ attempted: 4, recorded: 0, skipped: 4, deferred: 0 });
  expect(logs).toEqual([]);
});

it('AI2 holds only the failing provider and keeps claiming the healthy provider', async () => {
  const logs: string[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 1, openMs: 60_000 }, { log: (event, fields) => logs.push(`${event}:${fields.key}`) });
  mocks.pages = [[{ id: 1, fallback: false, provider: 'grok-cli' }, { id: 2, fallback: false, provider: 'abcllm' },
    { id: 3, fallback: false, provider: 'grok-cli' }, { id: 4, fallback: false, provider: 'abcllm' }]];
  mocks.second.mockImplementation(replies([{ ok: false, error: 'budget' }, { ok: true }, { ok: true }], { state: 'recorded' }));
  expect(await runSecondReviewConsumer({ owner, once: true, circuits })).toEqual({ attempted: 3, recorded: 3, skipped: 0, deferred: 1 });
  expect(mocks.second.mock.calls.map(call => call[0].secondReviewId)).toEqual([1, 2, 4]);
  expect(logs).toEqual(['provider_circuit.opened:ai2:grok-cli']);
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

it('an open circuit is checked before the host ledger, so no host slot is taken for a held item', async () => {
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 1, openMs: 60_000 }, { log: () => {} });
  const admit = vi.fn().mockResolvedValue({ admitted: true, release: async () => {} });
  mocks.pages = [[first(4), first(5)]];
  mocks.first.mockImplementation(replies([{ ok: false, error: 'rate_limited' }], { applied: true, state: 'failed' }));
  expect(await runFirstReviewConsumer({ owner, once: true, circuits, admit })).toEqual({ attempted: 1, recorded: 0, skipped: 1, deferred: 1 });
  expect(admit).toHaveBeenCalledOnce();
});
