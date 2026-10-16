import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const active = new Set<number>();

/** Actual read-only CLI. A forced stop remains an error; only close settles it. */
async function healthCli(env: Partial<NodeJS.ProcessEnv>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/worker-healthcheck.ts'], {
    cwd: resolve('.'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid) active.add(child.pid);
  let output = '', diagnostic = '', spawnError: unknown, forced = false;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  child.once('error', error => { spawnError = error; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
    child.once('close', (code, signal) => {
      if (child.pid) active.delete(child.pid);
      done({ code, signal });
    });
  });
  const term = setTimeout(() => { forced = true; child.kill('SIGTERM'); }, 2_000);
  const kill = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 3_000);
  try {
    const result = await closed;
    if (spawnError || forced) throw new AggregateError([...(spawnError ? [spawnError] : []), ...(forced ? [new Error('health_cli_forced_termination')] : [])]);
    expect(result.signal).toBeNull();
    expect(output).toBe(''); expect(diagnostic).toBe('');
    expect(active.size).toBe(0);
    return result.code;
  } finally { clearTimeout(term); clearTimeout(kill); await closed; }
}

async function check(input: { consumer: boolean; worker: 'fresh' | 'stale' | 'missing' | 'wrong-role'; candidate: 'fresh' | 'stale' }) {
  const directory = await mkdtemp(join(tmpdir(), 'nomorevibe-consumer-health-'));
  const workerPath = join(directory, 'worker.json'), rolePath = join(directory, 'role.json'), now = Date.now();
  try {
    if (input.worker !== 'missing') await writeFile(workerPath, JSON.stringify({
      role: input.worker === 'wrong-role' ? 'crawler' : 'reviewer', status: 'running',
      updatedAt: now - (input.worker === 'stale' ? 60_000 : 0),
      lastHeartbeatAt: now - (input.worker === 'stale' ? 60_000 : 0),
    }));
    await writeFile(rolePath, JSON.stringify({ role: 'reviewer', kind: 'standby',
      instanceId: 'legacy-reviewer', bootId: 'legacy-boot', phase: 'standby', epoch: null,
      pid: 123, updatedAt: now - (input.candidate === 'stale' ? 60_000 : 0) }));
    return await healthCli({ SERVICE_INSTANCE_ID: input.consumer ? 'ai2-consumer-test' : 'reviewer-test',
      WORKER_ROLE: 'reviewer', WORKER_HEALTH_PATH: workerPath, ROLE_HEALTH_PATH: rolePath });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it('checks the fresh actual consumer heartbeat even when the legacy candidate is stale', async () => {
  expect(await check({ consumer: true, worker: 'fresh', candidate: 'stale' })).toBe(0);
});
it('does not let a fresh legacy standby mask a missing or stale consumer heartbeat', async () => {
  expect(await check({ consumer: true, worker: 'missing', candidate: 'fresh' })).toBe(1);
  expect(await check({ consumer: true, worker: 'stale', candidate: 'fresh' })).toBe(1);
});
it('keeps the legacy standby health contract without a worker heartbeat', async () => {
  expect(await check({ consumer: false, worker: 'missing', candidate: 'fresh' })).toBe(0);
});
it('requires a reviewer heartbeat for the consumer even when legacy standby is fresh', async () => {
  expect(await check({ consumer: true, worker: 'wrong-role', candidate: 'fresh' })).toBe(1);
});
