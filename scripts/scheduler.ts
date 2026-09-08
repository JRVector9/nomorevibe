/** Records due requests in PostgreSQL. No web, job handler, or external crawler calls. */
import { basename } from 'node:path';
import { interruptibleSleep, parseLoopArgs, runtimeLog, withRuntimeProcess, type RuntimeReport } from './worker';

type SchedulerOptions = { once?: boolean; intervalMs?: number; signal?: AbortSignal };
type SchedulerDependencies = {
  requestDue: () => Promise<number>;
  seen: () => Promise<void>;
  sleep?: typeof interruptibleSleep;
  report?: RuntimeReport;
  log?: typeof runtimeLog;
};

export async function runScheduler(options: SchedulerOptions, dependencies: SchedulerDependencies) {
  const intervalMs = Math.max(1_000, Math.min(options.intervalMs ?? 10_000, 60_000));
  let ticks = 0, failures = 0, requested = 0;
  while (!options.signal?.aborted) {
    ticks++;
    dependencies.report?.('polling');
    try {
      await dependencies.seen();
      if (options.signal?.aborted) break;
      const count = await dependencies.requestDue();
      requested += count;
      dependencies.log?.('scheduler.tick', { requested: count });
    } catch {
      failures++;
      dependencies.log?.('scheduler.tick_failed', {});
    }
    dependencies.report?.('idle');
    if (options.once || options.signal?.aborted) break;
    await (dependencies.sleep ?? interruptibleSleep)(intervalMs, options.signal);
  }
  return { ticks, failures, requested };
}

async function main() {
  const options = parseLoopArgs(process.argv.slice(2), 10);
  await withRuntimeProcess('scheduler', async (signal, report) => {
    const { requestDueJobs, markSchedulerSeen } = await import('@/lib/jobs/control');
    const result = await runScheduler({ ...options, signal }, {
      requestDue: requestDueJobs, seen: markSchedulerSeen, report, log: runtimeLog,
    });
    runtimeLog('scheduler.stopped', result);
    if (options.once && result.failures) process.exitCode = 1;
  });
}

if (process.argv[1] && /^scheduler\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => {
    console.error('scheduler failed; check arguments/database/environment configuration');
    process.exitCode = 1;
  });
}
