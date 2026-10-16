import { expect, it, vi } from 'vitest';
import { jobsForRole } from '@/lib/jobs/catalog';
import { BACKGROUND_CONSUMER_JOBS, backgroundConsumerJobs } from '@/lib/jobs/background-consumer';
import { slotOnlyModelCapacity, withSlotOnlyModelCapacity } from '@/lib/llm/capacity-consumer-scope';
import { runWorker, type BackgroundConsumerLanes } from '@/scripts/worker';
import type { RuntimeLane } from '@/lib/operations/worker-progress';

/*
 * PR06c 배경 consumer 의 순수 경계 — 기본 비활성, 고정 allowlist, 기존 줄에서 빼기, 남은 일 뒤 다음 요청, 빈 큐·닫힌 슬롯·미룸·잠김에서
 * 일감을 잡지 않음, 종료 신호. DB·모델·runJob 은 쓰지 않는다(실제 job lease·control 은 tests/integration/background-consumer.test.ts).
 */
const TEXT = ['product-search-profile', 'product-search-verify', 'reason-translate', 'product-translate', 'product-tagline-ko', 'crawl-tagline'];
const env = (jobs?: string, version: string | null = '1') => ({ PIPELINE_BACKGROUND_CONSUMER_VERSION: version ?? undefined, PIPELINE_BACKGROUND_CONSUMER_JOBS: jobs });

it('is disabled unless the exact version is set, and accepts only the fixed slot-gated background jobs of the role', () => {
  expect(backgroundConsumerJobs('text', {})).toEqual([]);
  // 버전 없이 목록만 있으면 켜지 않는다(기존 legacy 그대로)
  expect(backgroundConsumerJobs('text', env('product-tagline-ko', null))).toEqual([]);
  expect(backgroundConsumerJobs('text', env('product-tagline-ko,product-search-profile'))).toEqual(['product-tagline-ko', 'product-search-profile']);
  expect(backgroundConsumerJobs('reviewer', env('product-intro-check,product-audit'))).toEqual(['product-intro-check', 'product-audit']);
  expect(BACKGROUND_CONSUMER_JOBS).toEqual({ text: TEXT, reviewer: ['product-intro-check', 'product-audit'] });
  for (const [role, names] of Object.entries(BACKGROUND_CONSUMER_JOBS)) for (const name of names)
    expect(jobsForRole(role as 'text' | 'reviewer')).toContain(name);
  for (const [role, value] of [['text', env('product-tagline-ko', '2')], ['text', env('product-tagline-ko', '')], ['text', env(undefined)], ['text', env('')],
    ['text', env('product-tagline-ko,product-tagline-ko')], ['text', env('product-intro-check')], ['text', env('product-embedding')],
    ['text', env('product-repo-review')], ['reviewer', env('grok-session-check')], ['reviewer', env('crawl-agent-review')],
    ['reviewer', env('second-review')], ['text', env(' product-tagline-ko')], ['crawler', env('crawl-fetch')],
    ['translation', env('reason-translate')], ['maintenance', env('uptime-ping')]] as const)
    expect(() => backgroundConsumerJobs(role, value), `${role}:${JSON.stringify(value)}`).toThrow(/invalid_background_consumer/);
});

function lanes(overrides: Partial<BackgroundConsumerLanes> = {}): BackgroundConsumerLanes & { calls: string[] } {
  const calls: string[] = [];
  return { calls, names: ['product-tagline-ko'], open: async () => { calls.push('open'); return true; },
    run: async name => { calls.push(`run:${name}`); return { status: 'completed', done: true }; },
    request: async name => { calls.push(`request:${name}`); }, ...overrides };
}

it('removes consumed jobs from the legacy lanes and gives each its own reported lane', async () => {
  const legacy: string[] = [], snapshots: RuntimeLane[][] = [];
  const consumer = lanes();
  await runWorker({ role: 'text', once: true }, {
    names: jobsForRole('text'), seen: async () => {}, pending: async () => jobsForRole('text'),
    run: async name => { legacy.push(name); return { status: 'completed', done: true }; },
    consumer, report: (_state, _job, _at, value) => { if (value) snapshots.push(value); },
  });
  expect(legacy).toEqual(jobsForRole('text').filter(name => name !== 'product-tagline-ko'));
  expect(consumer.calls).toEqual(['open', 'run:product-tagline-ko']);
  expect(snapshots.at(-1)?.map(lane => [lane.name, lane.jobs])).toEqual([
    ['reason-translate', jobsForRole('text').filter(name => name !== 'product-tagline-ko')], ['product-tagline-ko', ['product-tagline-ko']]]);
});

it('requests the next tick only after a completed tick that reports remaining work, then waits briefly', async () => {
  const controller = new AbortController(), sleeps: number[] = [];
  const results = [{ status: 'completed', done: false }, { status: 'completed', done: false }, { status: 'completed', done: true }];
  const consumer = lanes({ run: async name => { consumer.calls.push(`run:${name}`); return results.shift() ?? { status: 'skipped' }; } });
  let polls = 0;
  await runWorker({ role: 'text', signal: controller.signal }, {
    names: ['product-tagline-ko'], seen: async () => {}, run: async () => ({ status: 'completed' }), consumer,
    // 빈 큐(done) 뒤에는 다음 요청이 없으므로 pending 에서 빠진다
    pending: async () => ++polls <= 3 ? ['product-tagline-ko'] : [],
    sleep: async ms => { sleeps.push(ms); if (sleeps.length === 4) controller.abort(); },
  });
  expect(consumer.calls).toEqual(['open', 'run:product-tagline-ko', 'request:product-tagline-ko', 'open', 'run:product-tagline-ko',
    'request:product-tagline-ko', 'open', 'run:product-tagline-ko']);
  expect(sleeps).toEqual([1_000, 1_000, 5_000, 5_000]);
});

it.each([
  ['an empty or paused or locked queue', { pending: [] as string[], open: true, admitted: true }],
  ['a closed shared model slot', { pending: ['product-tagline-ko'], open: false, admitted: true }],
  ['a host budget deferral', { pending: ['product-tagline-ko'], open: true, admitted: false }],
])('claims nothing for %s', async (_label, state) => {
  const sleeps: number[] = [];
  const consumer = lanes({ open: async () => { consumer.calls.push('open'); return state.open; } });
  const controller = new AbortController();
  await runWorker({ role: 'text', signal: controller.signal }, {
    names: ['product-tagline-ko'], seen: async () => {}, run: async () => ({ status: 'completed' }), consumer,
    pending: async () => state.pending,
    admit: async () => state.admitted ? { admitted: true, release: async () => {} } : { admitted: false, reason: 'host_budget' },
    sleep: async ms => { sleeps.push(ms); controller.abort(); },
  });
  expect(consumer.calls.filter(call => call.startsWith('run') || call.startsWith('request'))).toEqual([]);
  expect(consumer.calls.includes('open')).toBe(state.pending.length > 0);
  expect(sleeps).toEqual([5_000]);
});

it.each([['deferred', { status: 'deferred', reason: 'model_capacity' }], ['failed', { status: 'failed', error: 'x' }],
  ['locked', { status: 'skipped', reason: 'locked' }], ['drained', { status: 'completed', done: true }]] as const)(
  'does not refill after a %s tick', async (_label, result) => {
    const sleeps: number[] = [], controller = new AbortController();
    const consumer = lanes({ run: async () => result });
    await runWorker({ role: 'text', signal: controller.signal }, {
      names: ['product-tagline-ko'], seen: async () => {}, run: async () => ({ status: 'completed' }), consumer,
      pending: async () => ['product-tagline-ko'], sleep: async ms => { sleeps.push(ms); controller.abort(); },
    });
    expect(consumer.calls.filter(call => call.startsWith('request'))).toEqual([]);
    expect(sleeps).toEqual([5_000]);
  });

it('drains the in-flight tick on shutdown without requesting another one', async () => {
  const controller = new AbortController();
  let release!: () => void, runs = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const consumer = lanes({ run: async (_name, options) => {
    runs++; await held;
    expect(options).toEqual({ requestedOnly: true, signal: controller.signal });
    return { status: 'completed', done: false };
  } });
  // 바깥 루프가 멈추지 않으면 세 번째 대기에서 끊는다(무한 루프 대신 실패로 드러나게)
  const sleep = vi.fn(async () => { if (sleep.mock.calls.length >= 3) controller.abort(); });
  const work = runWorker({ role: 'text', signal: controller.signal }, {
    names: ['product-tagline-ko'], seen: async () => {}, run: async () => ({ status: 'completed' }), consumer,
    pending: async () => ['product-tagline-ko'], sleep,
  });
  try { await vi.waitFor(() => expect(runs).toBe(1)); }
  catch (error) { controller.abort(); release(); await work; throw error; }
  controller.abort();
  let finished = false;
  void work.then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  await work;
  expect(runs).toBe(1);
  expect(consumer.calls.filter(call => call.startsWith('request'))).toEqual([]);
  expect(sleep).not.toHaveBeenCalled();
});

it('refuses a consumed job that this worker does not own', async () => {
  await expect(runWorker({ role: 'text', once: true }, {
    names: ['product-search-profile'], seen: async () => {}, pending: async () => [], run: async () => ({ status: 'completed' }),
    consumer: lanes(),
  })).rejects.toThrow('invalid_background_consumer_jobs');
});

it('marks only the consumer scope as slot-only, across awaits and timers', async () => {
  expect(slotOnlyModelCapacity()).toBe(false);
  const seen = await withSlotOnlyModelCapacity(async () => {
    const before = slotOnlyModelCapacity();
    await new Promise(resolve => setTimeout(resolve, 1));
    return [before, slotOnlyModelCapacity()];
  });
  expect(seen).toEqual([true, true]);
  expect(slotOnlyModelCapacity()).toBe(false);
});
