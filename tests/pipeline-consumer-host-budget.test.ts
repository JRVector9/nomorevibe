import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runPipelineFirstConsumer } from '@/scripts/pipeline-first-consumer';
import { runPipelineConsumer } from '@/scripts/pipeline-consumer';
import { superviseWorker } from '@/scripts/worker-supervisor';

/*
 * PR06e AI1/AI2 consumer 의 host 장부 참여 — 켜진 HOST_BUDGET_ENFORCEMENT 에서 거절하지 않고 role-worker·worker 와 같은 장부 규칙으로
 * 자리를 얻고(감독 부모·consumer 자식) item 마다 admit/release 하며 끝날 때 놓는다. 꺼져 있으면 loop 인자가 지금과 같다.
 * 실제 장부 행·갱신·해제는 tests/integration/consumer-host-budget.test.ts.
 */
const boundary = vi.hoisted(() => ({ runtime: vi.fn(), first: vi.fn(), second: vi.fn(), spawn: vi.fn(), observe: vi.fn(),
  start: vi.fn(), current: vi.fn(), wait: vi.fn() }));
vi.mock('@/scripts/worker', () => ({ withRuntimeProcess: boundary.runtime }));
vi.mock('@/lib/crawl/consumers/first', () => ({ runFirstReviewConsumer: boundary.first }));
vi.mock('@/lib/crawl/consumers/second', () => ({ runSecondReviewConsumer: boundary.second }));
vi.mock('@/lib/operations/observations', () => ({ observeService: boundary.observe }));
vi.mock('@/lib/operations/host-budget-runtime', () => ({ startHostBudget: boundary.start, currentHostBudget: boundary.current,
  waitForHostBudget: boundary.wait }));
vi.mock('node:child_process', async load => ({ ...await load<typeof import('node:child_process')>(), spawn: boundary.spawn }));

const policy = { version: 1, host: 'm3', release: 'pr06e-test', roles: ['reviewer'], reviewerConsumers: ['ai1', 'ai2'], schedulerReplicas: 0,
  webReplicas: 0, webReadReplica: false, monitor: false, connectAgent: false, preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 };
const pressure = { maxLoadPerCpu: 4, maxHostRssBytes: 8_000_000_000, maxEventLoopDelayMs: 500, maxHeartbeatGapMs: 30_000 };
function environment(consumer: 'ai1' | 'ai2', kind: 'role-parent' | 'worker', enforcement = true): Record<string, string> {
  return { WORKER_ROLE: 'reviewer', PHYSICAL_HOST: 'm3', RELEASE_TAG: 'pr06e-test', SERVICE_INSTANCE_ID: `${consumer}-consumer-m3`,
    HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy, process: { kind, role: 'reviewer', consumer, host: 'm3', release: 'pr06e-test', replica: 1, copy: 1 } }),
    ...(enforcement ? { HOST_BUDGET_ENFORCEMENT: JSON.stringify({ mode: 'enabled', pressure }), HTTP_ORIGIN_PERMITS: '1' } : {}) };
}
function cliEnvironment(consumer: 'ai1' | 'ai2', enforcement = true) {
  return { ...environment(consumer, 'worker', enforcement), PIPELINE_ITEM_CONSUMER_VERSION: '1', PIPELINE_ITEM_CONSUMER_INSTANCE_ID: `${consumer}-consumer-m3` };
}
const cli = (consumer: 'ai1' | 'ai2', env: Record<string, string>) =>
  consumer === 'ai1' ? runPipelineFirstConsumer(['--once'], env) : runPipelineConsumer(['--stage=ai2', '--once'], env);
const empty = { attempted: 0, recorded: 0, skipped: 0, deferred: 0 };
beforeEach(() => {
  vi.resetAllMocks();
  boundary.first.mockResolvedValue(empty); boundary.second.mockResolvedValue(empty);
  boundary.runtime.mockImplementation(async (_role, load) => load(new AbortController().signal, () => {}));
});
afterEach(() => vi.unstubAllEnvs());

it.each(['ai1', 'ai2'] as const)('the %s consumer joins the host ledger with the worker hold, admits per item through the loop and leaves at the end', async consumer => {
  const events: string[] = [], admit = vi.fn();
  boundary.start.mockImplementation(() => ({ enabled: true, settled: Promise.resolve().then(() => { events.push('settled'); }), ready: () => true,
    admit, stop: async () => { events.push('stop'); } }));
  const loop = consumer === 'ai1' ? boundary.first : boundary.second;
  loop.mockImplementation(async () => { events.push('loop'); return empty; });
  const env = cliEnvironment(consumer);
  expect(await cli(consumer, env)).toEqual({ state: 'stopped', ...empty });
  // 감독이 이 item 을 끊는 한도(reviewer job 180초 + drain 45초)까지 비상 slot 을 지킨다 — worker 와 같은 값
  expect(boundary.start).toHaveBeenCalledExactlyOnceWith(env, { holdMs: 225_000 });
  expect(loop).toHaveBeenCalledExactlyOnceWith({ owner: { instanceId: `${consumer}-consumer-m3`, bootId: expect.any(String) },
    signal: expect.any(AbortSignal), report: expect.any(Function), once: true, admit });
  expect(events).toEqual(['settled', 'loop', 'stop']);
  const failure = new Error('loop failed');
  loop.mockRejectedValueOnce(failure); events.length = 0;
  await expect(cli(consumer, env)).rejects.toBe(failure);
  expect(events).toEqual(['settled', 'stop']);
});

it.each(['ai1', 'ai2'] as const)('the %s consumer passes exactly the previous loop arguments when the host ledger and circuit are off', async consumer => {
  boundary.start.mockReturnValue({ enabled: false, settled: Promise.resolve(), ready: () => true, admit: vi.fn(), stop: async () => {} });
  const loop = consumer === 'ai1' ? boundary.first : boundary.second;
  await cli(consumer, cliEnvironment(consumer, false));
  expect(loop).toHaveBeenCalledExactlyOnceWith({ owner: { instanceId: `${consumer}-consumer-m3`, bootId: expect.any(String) },
    signal: expect.any(AbortSignal), report: expect.any(Function), once: true });
  expect(Object.keys(loop.mock.calls[0][0]).sort()).toEqual(['once', 'owner', 'report', 'signal']);
});

it.each(['ai1', 'ai2'] as const)('the %s consumer validates its provider circuit before runtime work and passes it to the loop', async consumer => {
  boundary.start.mockReturnValue({ enabled: false, settled: Promise.resolve(), ready: () => true, admit: vi.fn(), stop: async () => {} });
  const env = cliEnvironment(consumer, false);
  await expect(cli(consumer, { ...env, PROVIDER_CIRCUIT_BREAKER: '{"mode":"enabled","failures":3}' })).rejects.toThrow('provider_circuit_breaker_invalid');
  expect(boundary.runtime).not.toHaveBeenCalled();
  await cli(consumer, { ...env, PROVIDER_CIRCUIT_BREAKER: '{"mode":"enabled","failures":3,"openMs":60000}' });
  const loop = consumer === 'ai1' ? boundary.first : boundary.second;
  expect(loop.mock.calls[0][0]).toMatchObject({ circuits: { admit: expect.any(Function) } });
  expect(loop.mock.calls[0][0]).not.toHaveProperty('admit');
});

it.each(['ai1', 'ai2'] as const)('the %s supervisor takes its role-parent ledger seat instead of refusing enforcement, then spawns its fixed child', async consumer => {
  const env = environment(consumer, 'role-parent');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const host = { enabled: true, settled: Promise.resolve(), ready: () => true, admit: vi.fn(), stop: vi.fn() };
  boundary.start.mockReturnValue(host);
  const stop = new Error('stop_at_spawn'); boundary.spawn.mockImplementation(() => { throw stop; });
  await expect(superviseWorker('reviewer', { consumer, once: true })).rejects.toBe(stop);
  expect(boundary.start).toHaveBeenCalledExactlyOnceWith(process.env);
  expect(boundary.spawn).toHaveBeenCalledOnce();
  expect(JSON.parse(boundary.spawn.mock.calls[0][2].env.HOST_DB_BUDGET).process).toMatchObject({ kind: 'worker', consumer });
});
