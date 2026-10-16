import { assertHostDbEntry } from '@/lib/db/host-budget';
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
  assertHostDbEntry(process.env, { kind: 'scheduler-worker', role: 'scheduler' });
  await withRuntimeProcess('scheduler', async (signal, report) => {
    const [{ requestDueJobs, markSchedulerSeen }, { startHostBudget }] = await Promise.all([
      import('@/lib/jobs/control'), import('@/lib/operations/host-budget-runtime')]);
    // host 장부 자리가 없는 틱은 DB 를 쓰지 않고 건너뛴다. 비활성이면 항상 ready 다
    const host = startHostBudget(process.env);
    try {
      if (host.enabled) await host.settled;
      const result = await runScheduler({ ...options, signal }, {
        requestDue: () => host.ready() ? requestDueJobs() : Promise.resolve(0),
        seen: () => host.ready() ? markSchedulerSeen() : Promise.resolve(), report, log: runtimeLog,
      });
      runtimeLog('scheduler.stopped', result);
      if (options.once && result.failures) process.exitCode = 1;
    } finally { await host.stop(); }
  });
}

if (process.argv[1] && /^scheduler\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => {
    console.error('scheduler failed; check arguments/database/environment configuration');
    process.exitCode = 1;
  });
}
