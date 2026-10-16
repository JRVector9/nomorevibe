import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbPoolConfig } from '@/lib/db/pool';
import { expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { childExitCode, isRuntimeHeartbeat, settingsFromHeartbeat, stalledReason, superviseWorker, supervisorCommand, supervisorHealthPath, supervisorLimits, type WorkerHealth } from '@/scripts/worker-supervisor';
import { roleCandidateIsHealthy, workerIsHealthy } from '@/scripts/worker-healthcheck';
import { parseCapacityArgs } from '@/scripts/measure-worker-capacity';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));

const limits = supervisorLimits('crawler', {});
const health: WorkerHealth = {
  role: 'crawler', pid: 1, childPid: 2, updatedAt: 1_000, lastHeartbeatAt: 1_000, lastProgressAt: 1_000,
  state: 'idle', currentJob: null, jobStartedAt: null, status: 'running',
};
it('selects the fixed AI2 consumer only for an explicit reviewer child', () => {
  expect(supervisorCommand('reviewer', { consumer: 'ai2', once: true })).toEqual(['scripts/pipeline-consumer.ts', '--stage=ai2', '--once']);
  expect(supervisorCommand('reviewer')).toEqual(['scripts/worker.ts', '--role=reviewer']);
  expect(supervisorCommand('scheduler', { once: true })).toEqual(['scripts/scheduler.ts', '--once']);
  expect(() => supervisorCommand('crawler', { consumer: 'ai2' })).toThrow();
});
it('requires a dedicated AI2 consumer service identity and protects the legacy health file before spawn', () => {
  const options = { consumer: 'ai2' as const }, env = { SERVICE_INSTANCE_ID: 'ai2-consumer-m3-1' };
  expect(supervisorHealthPath(options, env)).toBe('/tmp/nomorevibe-ai2-consumer-health.json');
  for (const id of [undefined, '', 'reviewer-m3', 'ai2-consumer-', 'ai2-consumer-unsafe/path', 'ai2-consumer-' + 'a'.repeat(49)]) {
    expect(() => supervisorHealthPath(options, { SERVICE_INSTANCE_ID: id })).toThrow();
  }
  expect(() => supervisorHealthPath({ ...options, healthPath: '/tmp/nomorevibe-worker-health.json' }, env)).toThrow();
  expect(() => supervisorHealthPath(options, { ...env, WORKER_HEALTH_PATH: '/tmp/./nomorevibe-worker-health.json' })).toThrow();
  expect(supervisorHealthPath({ ...options, healthPath: '/tmp/ai2-specific.json' }, env)).toBe('/tmp/ai2-specific.json');
  expect(supervisorHealthPath({}, {})).toBe('/tmp/nomorevibe-worker-health.json');
  expect(supervisorHealthPath({}, { WORKER_HEALTH_PATH: '/tmp/legacy-custom.json' })).toBe('/tmp/legacy-custom.json');
});
it('rejects an AI2 consumer options-only health override before spawning any child', async () => {
  vi.stubEnv('SERVICE_INSTANCE_ID', 'ai2-consumer-test');
  vi.stubEnv('WORKER_HEALTH_PATH', '/tmp/ai2-from-env.json');
  const spawned = vi.mocked(childProcess.spawn).mockImplementation(() => { throw new Error('unexpected_child_spawn'); });
  try {
    await expect(superviseWorker('reviewer', { consumer: 'ai2', healthPath: '/tmp/ai2-from-options.json' }))
      .rejects.toThrow('invalid_item_consumer_health_path');
    expect(spawned).not.toHaveBeenCalled();
  } finally { spawned.mockReset(); vi.unstubAllEnvs(); }
});
it('accepts matching AI2 consumer env and option paths through configuration validation', async () => {
  vi.stubEnv('SERVICE_INSTANCE_ID', 'ai2-consumer-test');
  vi.stubEnv('WORKER_HEALTH_PATH', '/tmp/ai2-matching.json');
  const stoppedAtSpawn = new Error('test_spawn_boundary');
  const spawned = vi.mocked(childProcess.spawn).mockImplementation(() => { throw stoppedAtSpawn; });
  try {
    await expect(superviseWorker('reviewer', { consumer: 'ai2', healthPath: '/tmp/./ai2-matching.json' })).rejects.toBe(stoppedAtSpawn);
    expect(spawned).toHaveBeenCalledTimes(1);
  } finally { spawned.mockReset(); vi.unstubAllEnvs(); }
});
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

vi.mock('@/lib/operations/observations', () => ({ observeService: vi.fn(async () => {}) }));

it.each(['crawler', 'scheduler'] as const)('uses the production supervisor spawn to transfer the %s parent identity into its child', async role => {
  const directory = mkdtempSync(join(tmpdir(), 'host-db-supervisor-'));
  const child = Object.assign(new childProcess.ChildProcess(), { pid: undefined, kill: vi.fn() });
  vi.mocked(childProcess.spawn).mockReset().mockReturnValue(child);
  const parent = { kind: role === 'scheduler' ? 'scheduler-parent' : 'role-parent', role,
    host: 'm3', release: 'r1', replica: 1, copy: 2 };
  const budget = { mode: 'enabled', policy: { version: 1, host: 'm3', release: 'r1', roles: ['crawler'],
    schedulerReplicas: 1, webReplicas: 0, webReadReplica: false, monitor: false, connectAgent: false,
    preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 2 }, process: parent };
  vi.stubEnv('HOST_DB_BUDGET', JSON.stringify(budget));
  vi.stubEnv('WORKER_ROLE', role); vi.stubEnv('PHYSICAL_HOST', 'm3'); vi.stubEnv('RELEASE_TAG', 'r1');
  vi.stubEnv('DB_POOL_MAX', undefined);
  let running: Promise<number> | undefined;
  try {
    expect(dbPoolConfig().max).toBe(1);
    running = superviseWorker(role, { once: true, closeDbOnExit: false, healthPath: join(directory, 'health.json') });
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledOnce();
    const [executable, args, options] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(executable).toBe(process.execPath);
    expect(args).toEqual(['--import', 'tsx', ...(role === 'scheduler' ? ['scripts/scheduler.ts'] : ['scripts/worker.ts', '--role=crawler']), '--once']);
    const childEnv = options.env as NodeJS.ProcessEnv;
    expect(JSON.parse(childEnv.HOST_DB_BUDGET!)).toEqual({ ...budget,
      process: { ...parent, kind: role === 'scheduler' ? 'scheduler-worker' : 'worker' } });
    expect(dbPoolConfig(childEnv).max).toBe(role === 'scheduler' ? 2 : 4);
    expect(JSON.parse(process.env.HOST_DB_BUDGET!).process).toEqual(parent);
    child.emit('exit', 0);
    expect(await running).toBe(0);
  } finally {
    child.emit('exit', 1);
    await running?.catch(() => {});
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
