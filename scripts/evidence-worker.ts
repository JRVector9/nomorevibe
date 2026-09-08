/** Legacy standalone evidence scheduler/consumer. Do not deploy alongside the crawler role. */
import { basename } from 'node:path';
import { interruptibleSleep, runtimeLog, withRuntimeProcess, type RequestedRunOptions, type RuntimeReport } from './worker';

const EVIDENCE_JOBS = ['product-evidence-refresh', 'agent-evidence-refresh'] as const;
type WorkerOptions = { once?: boolean; intervalMs?: number; signal?: AbortSignal };
type WorkerDependencies = {
  run: (name: typeof EVIDENCE_JOBS[number], options: RequestedRunOptions) => Promise<{ status: string }>;
  request?: (name: typeof EVIDENCE_JOBS[number]) => Promise<unknown>;
  seen?: (names: string[]) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
  report?: RuntimeReport;
};
export async function runEvidenceWorker(options: WorkerOptions, dependencies: WorkerDependencies) {
  const intervalMs = Math.max(5_000, Math.min(options.intervalMs ?? 60_000, 60_000));
  let ticks = 0, failures = 0;
  while (!options.signal?.aborted) {
    ticks++;
    dependencies.report?.('polling');
    try { await dependencies.seen?.([...EVIDENCE_JOBS]); }
    catch { failures++; dependencies.log?.('evidence_worker.poll_failed', {}); }
    for (const name of EVIDENCE_JOBS) {
      if (options.signal?.aborted) break;
      dependencies.report?.('running', name);
      try {
        await dependencies.request?.(name);
        // A signal after requesting leaves the durable request for the next compatible consumer.
        if (options.signal?.aborted) break;
        const result = await dependencies.run(name, { requestedOnly: true, signal: options.signal });
        if (result.status === 'failed') failures++;
        dependencies.log?.('evidence_worker.job', { name, status: result.status });
      } catch {
        failures++;
        dependencies.log?.('evidence_worker.job', { name, status: 'failed' });
      } finally {
        dependencies.report?.('polling');
      }
    }
    dependencies.report?.('idle');
    if (options.once || options.signal?.aborted) break;
    await (dependencies.sleep ?? interruptibleSleep)(intervalMs, options.signal);
  }
  return { ticks, failures };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--once' && !/^--interval-seconds=\d+$/.test(arg))) throw new Error('Usage: evidence-worker.ts [--once] [--interval-seconds=5..60]');
  const interval = args.find(arg => arg.startsWith('--interval-seconds='));
  const intervalSeconds = interval ? Number(interval.split('=')[1]) : 60;
  if (intervalSeconds < 5 || intervalSeconds > 60) throw new Error('interval-seconds must be between 5 and 60');
  await withRuntimeProcess('evidence', async (signal, report) => {
    const [{ JOBS }, { runJob }, { requestJob, markWorkerSeen }] = await Promise.all([
      import('@/lib/jobs/registry'), import('@/lib/jobs/runner'), import('@/lib/jobs/control'),
    ]);
    const result = await runEvidenceWorker({ once: args.includes('--once'), intervalMs: intervalSeconds * 1000, signal }, {
      request: name => requestJob(name), seen: markWorkerSeen,
      run: (name, runOptions) => runJob(name, JOBS[name], { ...runOptions, budgetMs: 25_000 }),
      report, log: runtimeLog,
    });
    runtimeLog('evidence_worker.stopped', result);
    if (args.includes('--once') && result.failures) process.exitCode = 1;
  });
}
if (process.argv[1] && /^evidence-worker\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => { console.error('evidence_worker failed; check database/environment configuration'); process.exitCode = 1; });
}
