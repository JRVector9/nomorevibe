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

type SchedulerBoot = { record: () => Promise<void>; recorded: () => boolean };
/**
 * host 장부 자리가 없는 틱은 DB 를 쓰지 않고 건너뛴다(비활성이면 항상 ready). Oracle scheduler(boot 있음)는 첫 틱 전에
 * 이 boot 를 후보 행에 기록하고, 기록되기 전에는 요청을 만들지 않는다. M3/mini(boot=null)는 기존 순서 그대로다.
 */
export function gatedSchedulerTick(host: { ready: () => boolean }, boot: SchedulerBoot | null,
  control: Pick<SchedulerDependencies, 'seen' | 'requestDue'>): Pick<SchedulerDependencies, 'seen' | 'requestDue'> {
  return {
    seen: async () => {
      if (!host.ready()) return;
      await boot?.record();
      await control.seen();
    },
    requestDue: () => host.ready() && (!boot || boot.recorded()) ? control.requestDue() : Promise.resolve(0),
  };
}

async function main() {
  const options = parseLoopArgs(process.argv.slice(2), 10);
  assertHostDbEntry(process.env, { kind: 'scheduler-worker', role: 'scheduler' });
  await withRuntimeProcess('scheduler', async (signal, report) => {
    const [{ requestDueJobs, markSchedulerSeen }, { startHostBudget }, { oracleSchedulerBoot }] = await Promise.all([
      import('@/lib/jobs/control'), import('@/lib/operations/host-budget-runtime'), import('@/lib/runtime/oracle-scheduler')]);
    // Oracle 은 재시작마다 새 boot 다 — 저장된 canary 증거와 더는 맞지 않아 다음 기동에는 새 canary 가 필요하다
    const boot = process.env.PHYSICAL_HOST === 'oracle-osaka-smoke' ? oracleSchedulerBoot(process.env) : null;
    const host = startHostBudget(process.env);
    try {
      if (host.enabled) await host.settled;
      const result = await runScheduler({ ...options, signal }, {
        ...gatedSchedulerTick(host, boot, { requestDue: () => requestDueJobs(), seen: markSchedulerSeen }), report, log: runtimeLog,
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
