import { expect, it } from 'vitest';
import { isRuntimeHeartbeat, stalledReason, supervisorLimits, type WorkerHealth } from '@/scripts/worker-supervisor';
import { workerIsHealthy } from '@/scripts/worker-healthcheck';
import { parseCapacityArgs } from '@/scripts/measure-worker-capacity';

const limits = supervisorLimits('crawler', {});
const health: WorkerHealth = {
  role: 'crawler', pid: 1, childPid: 2, updatedAt: 1_000, lastHeartbeatAt: 1_000, lastProgressAt: 1_000,
  state: 'idle', currentJob: null, jobStartedAt: null, status: 'running',
};
it('distinguishes idle observation, event-loop failure, and a stalled running job', () => {
  expect(stalledReason(health, 6_000, limits)).toBeNull();
  expect(stalledReason(health, 32_000, limits)).toBe('heartbeat_timeout');
  expect(stalledReason({ ...health, lastHeartbeatAt: 100_000 }, 100_000, limits)).toBe('progress_timeout');
  expect(stalledReason({ ...health, lastHeartbeatAt: 200_000, state: 'running', currentJob: 'crawl-fetch', jobStartedAt: 1_000 }, 200_000, limits)).toBe('job_timeout');
});
it('does not treat the cooperative 25-second budget as a hard timeout', () => {
  expect(stalledReason({ ...health, state: 'running', currentJob: 'crawl-fetch', jobStartedAt: 1_000, lastHeartbeatAt: 40_000 }, 40_000, limits)).toBeNull();
  expect(supervisorLimits('maintenance', {}).jobMs).toBe(600_000);
});
it('uses a separate drain path once stopping has started', () => {
  expect(stalledReason({ ...health, status: 'stopping' }, 1_000_000, limits)).toBeNull();
});
it('accepts only structurally valid IPC from the expected child and role', () => {
  const message = { type: 'runtime.heartbeat', role: 'crawler', pid: 2, at: 1_000, state: 'running', currentJob: 'crawl-fetch', startedAt: 1_000, lastProgressAt: 1_000 };
  expect(isRuntimeHeartbeat(message, 'crawler', 2)).toBe(true);
  expect(isRuntimeHeartbeat(message, 'reviewer', 2)).toBe(false);
  expect(isRuntimeHeartbeat({ ...message, pid: 3 }, 'crawler', 2)).toBe(false);
  expect(isRuntimeHeartbeat({ ...message, startedAt: null }, 'crawler', 2)).toBe(false);
});
it('rejects stale, stopped and different-role health without any network probe', () => {
  expect(workerIsHealthy(health, 5_000, 'crawler')).toBe(true);
  expect(workerIsHealthy(health, 40_000, 'crawler')).toBe(false);
  expect(workerIsHealthy({ ...health, status: 'failed' }, 5_000)).toBe(false);
  expect(workerIsHealthy(health, 5_000, 'reviewer')).toBe(false);
});
it('validates bounded supervisor settings', () => {
  expect(() => supervisorLimits('crawler', { WORKER_HEARTBEAT_TIMEOUT_SECONDS: '0' })).toThrow();
  expect(() => supervisorLimits('crawler', { WORKER_DRAIN_SECONDS: 'Infinity' })).toThrow();
});
it('requires an explicit local origin and bounds read-only measurement load', () => {
  expect(parseCapacityArgs(['--origin=http://127.0.0.1:3200'])).toEqual({ origin: 'http://127.0.0.1:3200', paths: ['/'], rps: 1, durationSeconds: 30, maxInflight: 2 });
  for (const args of [[], ['--origin=https://github.com'], ['--origin=http://localhost', '--paths=//github.com'], ['--origin=http://localhost', '--paths=/api/register'], ['--origin=http://localhost', '--paths=/a/../api/register'], ['--origin=http://localhost', '--paths=/go/product'], ['--origin=http://localhost', '--rps=21']]) {
    expect(() => parseCapacityArgs(args)).toThrow();
  }
});
