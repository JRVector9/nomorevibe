import { expect, it } from 'vitest';
import { childExitCode, isRuntimeHeartbeat, settingsFromHeartbeat, stalledReason, supervisorLimits, type WorkerHealth } from '@/scripts/worker-supervisor';
import { roleCandidateIsHealthy, workerIsHealthy } from '@/scripts/worker-healthcheck';
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

it('detects a stuck poll independently of a healthy running lane', () => {
  const now = 100_000;
  const lanes = [
    { name: 'crawl-fetch', jobs: ['crawl-fetch'], state: 'polling' as const, currentJob: null,
      startedAt: null, pollStartedAt: 1_000, lastProgressAt: 1_000 },
    { name: 'ai-level-refresh', jobs: ['ai-level-refresh'], state: 'running' as const, currentJob: 'ai-level-refresh',
      startedAt: 90_000, pollStartedAt: null, lastProgressAt: 90_000 },
  ];
  expect(stalledReason({ ...health, state: 'running', currentJob: 'ai-level-refresh', jobStartedAt: 90_000,
    lastHeartbeatAt: now, lastProgressAt: 90_000, lanes }, now, limits)).toBe('lane_poll_timeout');
  expect(stalledReason({ ...health, lastHeartbeatAt: now, lanes: lanes.slice(1) }, now, limits)).toBeNull();
});

it('rejects malformed or unbounded optional lane IPC while accepting older heartbeat messages', () => {
  const message = { type: 'runtime.heartbeat', role: 'crawler', pid: 2, at: 100_000,
    state: 'idle', currentJob: null, startedAt: null, lastProgressAt: 100_000 };
  const lane = { name: 'crawl-fetch', jobs: ['crawl-fetch'], state: 'polling', currentJob: null,
    startedAt: null, pollStartedAt: 90_000, lastProgressAt: 90_000 };
  expect(isRuntimeHeartbeat(message, 'crawler', 2)).toBe(true);
  expect(isRuntimeHeartbeat({ ...message, lanes: [lane] }, 'crawler', 2)).toBe(true);
  expect(isRuntimeHeartbeat({ ...message, lanes: [{ ...lane, pollStartedAt: NaN }] }, 'crawler', 2)).toBe(false);
  expect(isRuntimeHeartbeat({ ...message, lanes: [{ ...lane, pollStartedAt: Date.now() + 3_600_000 }] }, 'crawler', 2)).toBe(false);
  expect(isRuntimeHeartbeat({ ...message, lanes: [{ ...lane, jobs: ['secret payload'] }] }, 'crawler', 2)).toBe(false);
  expect(isRuntimeHeartbeat({ ...message, lanes: Array.from({ length: 17 }, () => lane) }, 'crawler', 2)).toBe(false);
});

it('reports a fresh passive role candidate healthy without a supervisor, but requires the active child', () => {
  const standby = { role: 'crawler', kind: 'standby', instanceId: 'crawler-b', bootId: 'boot-b',
    phase: 'standby', epoch: null, pid: 123, updatedAt: 1_000 };
  const worker = { role: 'crawler', status: 'running', updatedAt: 1_000, lastHeartbeatAt: 1_000 };
  expect(roleCandidateIsHealthy(standby, null, 2_000, 'crawler')).toBe(true);
  expect(roleCandidateIsHealthy(standby, null, 22_000, 'crawler')).toBe(false);
  expect(roleCandidateIsHealthy({ ...standby, phase: 'active', epoch: 2 }, null, 2_000, 'crawler')).toBe(false);
  expect(roleCandidateIsHealthy({ ...standby, phase: 'active', epoch: 2 }, worker, 2_000, 'crawler')).toBe(true);
  expect(roleCandidateIsHealthy({ ...standby, phase: 'stopping' }, worker, 2_000, 'crawler')).toBe(false);
  expect(roleCandidateIsHealthy(standby, null, 2_000, 'reviewer')).toBe(false);
});
it('does not treat the cooperative 25-second budget as a hard timeout', () => {
  expect(stalledReason({ ...health, state: 'running', currentJob: 'crawl-fetch', jobStartedAt: 1_000, lastHeartbeatAt: 40_000 }, 40_000, limits)).toBeNull();
  expect(supervisorLimits('maintenance', {}).jobMs).toBe(600_000);
});

it('allows a legitimate 110-second reviewer call without applying the 90-second poll limit', () => {
  const now = 120_000;
  const lane = { name: 'crawl-agent-review', jobs: ['crawl-agent-review'], state: 'running' as const,
    currentJob: 'crawl-agent-review', startedAt: 1_000, pollStartedAt: null, lastProgressAt: 1_000 };
  expect(stalledReason({ ...health, role: 'reviewer', lastHeartbeatAt: now, lanes: [lane] }, now,
    supervisorLimits('reviewer', {}))).toBeNull();
});
it('uses a separate drain path once stopping has started', () => {
  expect(stalledReason({ ...health, status: 'stopping' }, 1_000_000, limits)).toBeNull();
});
it('treats a requested shutdown during child startup as a clean drain', () => {
  expect(childExitCode(0, null, { stopping: true, requested: true, everHeartbeat: false, once: false })).toBe(0);
  expect(childExitCode(0, 1, { stopping: true, requested: true, everHeartbeat: true, once: false })).toBe(1);
  expect(childExitCode(1, null, { stopping: true, requested: true, everHeartbeat: false, once: false })).toBe(1);
  expect(childExitCode(0, null, { stopping: false, requested: false, everHeartbeat: false, once: false })).toBe(1);
});
it('accepts only structurally valid IPC from the expected child and role', () => {
  const message = { type: 'runtime.heartbeat', role: 'crawler', pid: 2, at: 1_000, state: 'running', currentJob: 'crawl-fetch', startedAt: 1_000, lastProgressAt: 1_000 };
  expect(isRuntimeHeartbeat(message, 'crawler', 2)).toBe(true);
  expect(isRuntimeHeartbeat(message, 'reviewer', 2)).toBe(false);
  expect(isRuntimeHeartbeat({ ...message, pid: 3 }, 'crawler', 2)).toBe(false);
  expect(isRuntimeHeartbeat({ ...message, startedAt: null }, 'crawler', 2)).toBe(false);
});
it('carries the crawl settings version the worker last read, and keeps accepting old workers that send none', () => {
  const message = { type: 'runtime.heartbeat' as const, role: 'crawler', pid: 2, at: 1_000, state: 'idle' as const, currentJob: null, startedAt: null, lastProgressAt: 1_000 };
  expect(isRuntimeHeartbeat(message, 'crawler', 2)).toBe(true);
  expect(settingsFromHeartbeat(message)).toEqual({});
  expect(settingsFromHeartbeat({ ...message, settings: null })).toEqual({});
  expect(settingsFromHeartbeat({ ...message, settings: { version: 'abc123', at: 900 } })).toEqual({ settingsVersion: 'abc123', settingsReadAt: 900 });
  expect(settingsFromHeartbeat({ ...message, settings: { version: 42, at: 900 } as never })).toEqual({});
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
