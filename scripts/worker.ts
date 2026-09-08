/** Role-specific consumer. Scheduling belongs to scheduler.ts, never this poll loop. */
import { basename } from 'node:path';
import type { JobRole } from '@/lib/jobs/catalog';

export type RuntimeState = 'idle' | 'polling' | 'running' | 'stopping';
export type RuntimeHeartbeat = {
  type: 'runtime.heartbeat';
  role: string;
  pid: number;
  at: number;
  state: RuntimeState;
  currentJob: string | null;
  startedAt: number | null;
  lastProgressAt: number;
};
export type RuntimeReport = (state: RuntimeState, currentJob?: string | null) => void;
export type RequestedRunOptions = { requestedOnly: true; signal?: AbortSignal };
type WorkerOptions = { role: JobRole; once?: boolean; intervalMs?: number; signal?: AbortSignal };
type WorkerDependencies = {
  names: readonly string[];
  pending: () => Promise<string[]>;
  seen: (names: string[]) => Promise<void>;
  run: (name: string, options: RequestedRunOptions) => Promise<{ status: string }>;
  sleep?: typeof interruptibleSleep;
  report?: RuntimeReport;
  log?: typeof runtimeLog;
};

export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function runtimeLog(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

/** A once run processes one pending snapshot, not the entire queue or future requests. */
export async function runWorker(options: WorkerOptions, dependencies: WorkerDependencies) {
  const intervalMs = Math.max(1_000, Math.min(options.intervalMs ?? 5_000, 60_000));
  const names = [...new Set(dependencies.names)];
  let ticks = 0, failures = 0, nextIndex = 0;
  while (!options.signal?.aborted) {
    ticks++;
    dependencies.report?.('polling');
    try {
      await dependencies.seen(names);
      const pending = new Set(await dependencies.pending());
      // Visit each role-owned job at most once per poll. Never run names from another role.
      const ordered = [...names.slice(nextIndex), ...names.slice(0, nextIndex)];
      for (const name of ordered) {
        if (options.signal?.aborted) break;
        if (!pending.has(name)) continue;
        dependencies.report?.('running', name);
        try {
          const result = await dependencies.run(name, { requestedOnly: true, signal: options.signal });
          if (result.status === 'failed') failures++;
          dependencies.log?.('worker.job', { role: options.role, name, status: result.status });
        } catch {
          failures++;
          dependencies.log?.('worker.job', { role: options.role, name, status: 'failed' });
        } finally {
          nextIndex = (names.indexOf(name) + 1) % names.length;
          dependencies.report?.('polling');
        }
      }
    } catch {
      failures++;
      dependencies.log?.('worker.poll_failed', { role: options.role });
    }
    dependencies.report?.('idle');
    if (options.once || options.signal?.aborted) break;
    await (dependencies.sleep ?? interruptibleSleep)(intervalMs, options.signal);
  }
  return { ticks, failures };
}

/** Shared CLI lifecycle. A supervisor can distinguish event-loop liveness from job progress. */
export async function withRuntimeProcess<T>(
  role: string,
  execute: (signal: AbortSignal, report: RuntimeReport) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let current: Omit<RuntimeHeartbeat, 'at'> = {
    type: 'runtime.heartbeat', role, pid: process.pid, state: 'idle',
    currentJob: null, startedAt: null, lastProgressAt: Date.now(),
  };
  const heartbeat = () => {
    if (process.connected && process.send) {
      // The parent can disconnect during shutdown. IPC failure must not interrupt a DB write.
      try { process.send({ ...current, at: Date.now() }, () => {}); } catch { /* disconnected */ }
    }
  };
  const report: RuntimeReport = (state, currentJob = null) => {
    const now = Date.now();
    current = {
      ...current, state: controller.signal.aborted ? 'stopping' : state,
      currentJob, startedAt: state === 'running' ? now : null, lastProgressAt: now,
    };
    heartbeat();
  };
  const shutdown = () => {
    controller.abort();
    current = { ...current, state: 'stopping' };
    heartbeat();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const timer = setInterval(heartbeat, 5_000);
  timer.unref();
  heartbeat();
  try {
    return await execute(controller.signal, report);
  } finally {
    // Keep heartbeat reporting while the pool drains; stop accepting another tick immediately.
    shutdown();
    try {
      const client = (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient;
      await client?.end({ timeout: 5 });
    } finally {
      clearInterval(timer);
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      if (process.connected) process.disconnect?.();
    }
  }
}

export function parseWorkerArgs(args: string[]) {
  const roleArg = args.find(arg => arg.startsWith('--role='));
  const role = roleArg?.slice('--role='.length);
  const roles: readonly string[] = ['crawler', 'reviewer', 'publisher', 'maintenance'];
  if (!role || !roles.includes(role) || args.filter(arg => arg.startsWith('--role=')).length !== 1) {
    throw new Error('Usage: worker.ts --role=crawler|reviewer|publisher|maintenance [--once] [--interval-seconds=1..60]');
  }
  return { ...parseLoopArgs(args.filter(arg => arg !== roleArg), 5), role: role as JobRole };
}

export function parseLoopArgs(args: string[], defaultSeconds: number) {
  if (args.some(arg => arg !== '--once' && !/^--interval-seconds=\d+$/.test(arg)) ||
      args.filter(arg => arg.startsWith('--interval-seconds=')).length > 1) {
    throw new Error('Expected [--once] [--interval-seconds=1..60]');
  }
  const intervalArg = args.find(arg => arg.startsWith('--interval-seconds='));
  const seconds = intervalArg ? Number(intervalArg.split('=')[1]) : defaultSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) {
    throw new Error('interval-seconds must be between 1 and 60');
  }
  return { once: args.includes('--once'), intervalMs: seconds * 1_000 };
}

async function main() {
  const options = parseWorkerArgs(process.argv.slice(2));
  await withRuntimeProcess(options.role, async (signal, report) => {
    const [{ jobsForRole }, { pendingJobNames, markWorkerSeen }, { JOBS }, { runJob }] = await Promise.all([
      import('@/lib/jobs/catalog'), import('@/lib/jobs/control'), import('@/lib/jobs/registry'), import('@/lib/jobs/runner'),
    ]);
    const result = await runWorker({ ...options, signal }, {
      names: jobsForRole(options.role),
      pending: () => pendingJobNames(options.role),
      seen: markWorkerSeen,
      run: (name, runOptions) => runJob(name, JOBS[name], runOptions),
      report, log: runtimeLog,
    });
    runtimeLog('worker.stopped', { role: options.role, ...result });
    if (options.once && result.failures) process.exitCode = 1;
  });
}

if (process.argv[1] && /^worker\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(error => {
    console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'worker failed; check role/database/environment configuration');
    process.exitCode = 1;
  });
}
