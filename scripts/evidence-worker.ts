/** Continuous local evidence collection. DB job leases also protect overlapping scheduler calls. */
import { basename } from 'node:path';

const EVIDENCE_JOBS = ['product-evidence-refresh', 'agent-evidence-refresh'] as const;
type WorkerOptions = { once?: boolean; intervalMs?: number; signal?: AbortSignal };
type WorkerDependencies = {
  run: (name: typeof EVIDENCE_JOBS[number]) => Promise<{ status: string }>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
};
function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
export async function runEvidenceWorker(options: WorkerOptions, dependencies: WorkerDependencies) {
  const intervalMs = Math.max(5_000, Math.min(options.intervalMs ?? 60_000, 60_000));
  let ticks = 0, failures = 0;
  while (!options.signal?.aborted) {
    ticks++;
    for (const name of EVIDENCE_JOBS) {
      if (options.signal?.aborted) break;
      try {
        const result = await dependencies.run(name);
        if (result.status === 'failed') failures++;
        dependencies.log?.('evidence_worker.job', { name, status: result.status });
      } catch {
        failures++;
        dependencies.log?.('evidence_worker.job', { name, status: 'failed' });
      }
    }
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
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const [{ JOBS }, { runJob }] = await Promise.all([import('@/lib/jobs/registry'), import('@/lib/jobs/runner')]);
    const result = await runEvidenceWorker({ once: args.includes('--once'), intervalMs: intervalSeconds * 1000, signal: controller.signal }, {
      run: name => runJob(name, JOBS[name], { budgetMs: 25_000 }),
      log: (event, fields) => console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields })),
    });
    if (args.includes('--once') && result.failures) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    // The DB module shares its pool via globalThis; close it only in this standalone CLI.
    const client = (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient;
    await client?.end({ timeout: 5 });
  }
}
if (process.argv[1] && /^evidence-worker\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => { console.error('evidence_worker failed; check database/environment configuration'); process.exitCode = 1; });
}
