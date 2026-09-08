/** Container PID 1's child supervisor: a healthy event loop is not proof of job progress. */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { RuntimeHeartbeat } from './worker';

export type RuntimeRole = 'scheduler' | 'crawler' | 'reviewer' | 'publisher' | 'maintenance';
export type SupervisorLimits = { heartbeatMs: number; progressMs: number; jobMs: number; drainMs: number };
export type WorkerHealth = {
  role: RuntimeRole; pid: number; childPid: number | null;
  updatedAt: number; lastHeartbeatAt: number; lastProgressAt: number;
  state: RuntimeHeartbeat['state']; currentJob: string | null; jobStartedAt: number | null;
  status: 'starting' | 'running' | 'stopping' | 'failed'; reason?: string;
};
export const DEFAULT_HEALTH_PATH = '/tmp/nomorevibe-worker-health.json';
const JOB_LIMIT_MS: Record<RuntimeRole, number> = {
  scheduler: 120_000, crawler: 180_000, reviewer: 180_000, publisher: 180_000, maintenance: 600_000,
};

export function supervisorLimits(role: RuntimeRole, env: NodeJS.ProcessEnv = process.env): SupervisorLimits {
  const seconds = (name: string, fallback: number, minimum: number) => {
    const value = env[name] ? Number(env[name]) : fallback / 1_000;
    if (!Number.isSafeInteger(value) || value < minimum || value > 3_600) throw new Error(`Invalid ${name}`);
    return value * 1_000;
  };
  return {
    heartbeatMs: seconds('WORKER_HEARTBEAT_TIMEOUT_SECONDS', 30_000, 15),
    progressMs: seconds('WORKER_PROGRESS_TIMEOUT_SECONDS', 90_000, 65),
    jobMs: seconds('WORKER_JOB_TIMEOUT_SECONDS', JOB_LIMIT_MS[role], 60),
    drainMs: seconds('WORKER_DRAIN_SECONDS', 45_000, 5),
  };
}

export function stalledReason(health: WorkerHealth, now: number, limits: SupervisorLimits): string | null {
  if (health.status === 'stopping' || health.status === 'failed') return null;
  if (now - health.lastHeartbeatAt > limits.heartbeatMs) return 'heartbeat_timeout';
  if (health.currentJob !== null && health.jobStartedAt !== null) {
    if (now - health.jobStartedAt > limits.jobMs) return 'job_timeout';
  } else if (now - health.lastProgressAt > limits.progressMs) return 'progress_timeout';
  return null;
}

export function isRuntimeHeartbeat(value: unknown, role: RuntimeRole, pid: number): value is RuntimeHeartbeat {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<RuntimeHeartbeat>;
  return v.type === 'runtime.heartbeat' && v.role === role && v.pid === pid &&
    ['idle', 'polling', 'running', 'stopping'].includes(v.state ?? '') &&
    Number.isFinite(v.at) && Number.isFinite(v.lastProgressAt) &&
    (v.currentJob === null || typeof v.currentJob === 'string') &&
    (v.startedAt === null || Number.isFinite(v.startedAt)) &&
    (v.state !== 'running' || (typeof v.currentJob === 'string' && typeof v.startedAt === 'number'));
}

function writeHealth(path: string, health: WorkerHealth) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(health), { mode: 0o600 });
  renameSync(temporary, path);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
function groupExists(child: ChildProcess) {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** No internal respawn: exiting lets the container restart policy recreate the whole process tree. */
export async function superviseWorker(role: RuntimeRole, options: {
  once?: boolean; healthPath?: string; limits?: SupervisorLimits;
} = {}): Promise<number> {
  const limits = options.limits ?? supervisorLimits(role);
  const healthPath = options.healthPath ?? process.env.WORKER_HEALTH_PATH ?? DEFAULT_HEALTH_PATH;
  const command = role === 'scheduler' ? ['scripts/scheduler.ts'] : ['scripts/worker.ts', `--role=${role}`];
  if (options.once) command.push('--once');
  const child = spawn(process.execPath, ['--import', 'tsx', ...command], {
    cwd: resolve('.'), env: { ...process.env, WORKER_ROLE: role },
    detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const started = Date.now();
  let health: WorkerHealth = {
    role, pid: process.pid, childPid: child.pid ?? null, updatedAt: started,
    lastHeartbeatAt: started, lastProgressAt: started, state: 'idle', currentJob: null,
    jobStartedAt: null, status: 'starting',
  };
  return await new Promise<number>(resolveResult => {
    let exitCode = 1, stopping = false, finishing = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const log = (event: string, fields: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event, role, at: new Date().toISOString(), ...fields }));
    const publish = () => {
      health.updatedAt = Date.now();
      try { writeHealth(healthPath, health); }
      catch { stop('health_write_failed', false); }
    };
    const stop = (reason: string, requested: boolean) => {
      if (stopping || finishing) return;
      stopping = true;
      exitCode = requested ? 0 : 1;
      health = { ...health, status: 'stopping', reason };
      log('supervisor.stopping', { reason });
      signalGroup(child, 'SIGTERM');
      drainTimer = setTimeout(() => {
        log('supervisor.force_stop', { reason });
        exitCode = 1;
        signalGroup(child, 'SIGKILL');
      }, limits.drainMs);
    };
    const onSignal = () => stop('shutdown_requested', true);
    const monitor = setInterval(() => {
      const reason = stalledReason(health, Date.now(), limits);
      if (reason) stop(reason, false);
      publish();
    }, 5_000);
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      clearInterval(monitor);
      if (drainTimer) clearTimeout(drainTimer);
      // A worker can exit while a CLI grandchild remains. Kill and observe its entire group.
      signalGroup(child, 'SIGKILL');
      const deadline = Date.now() + 5_000;
      while (groupExists(child) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (groupExists(child)) { exitCode = 1; log('supervisor.group_cleanup_incomplete'); }
      health = { ...health, status: exitCode === 0 ? 'stopping' : 'failed', updatedAt: Date.now() };
      try { writeHealth(healthPath, health); } catch { exitCode = 1; }
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      log('supervisor.stopped', { exitCode });
      resolveResult(exitCode);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    child.on('message', value => {
      if (!child.pid || !isRuntimeHeartbeat(value, role, child.pid)) return;
      health = {
        ...health, lastHeartbeatAt: Date.now(), lastProgressAt: value.lastProgressAt,
        state: value.state, currentJob: value.currentJob, jobStartedAt: value.startedAt,
        status: stopping ? 'stopping' : 'running',
      };
      publish();
    });
    child.once('error', () => { exitCode = 1; health.reason = 'child_spawn_failed'; void finish(); });
    child.once('exit', code => {
      if (!stopping) exitCode = options.once && code === 0 ? 0 : 1;
      else if (code !== 0) exitCode = 1;
      void finish();
    });
    publish();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const role = args.find(arg => arg.startsWith('--role='))?.slice(7) as RuntimeRole;
  if (!Object.hasOwn(JOB_LIMIT_MS, role) ||
      args.filter(arg => arg.startsWith('--role=')).length !== 1 ||
      args.some(arg => arg !== '--once' && arg !== `--role=${role}`)) {
    throw new Error('Usage: worker-supervisor.ts --role=scheduler|crawler|reviewer|publisher|maintenance [--once]');
  }
  process.exitCode = await superviseWorker(role, { once: args.includes('--once') });
}
if (process.argv[1] && /^worker-supervisor\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => { console.error('worker supervisor failed; check role/environment configuration'); process.exitCode = 1; });
}
