import { expect, it } from 'vitest';
import { runEvidenceWorker } from '@/scripts/evidence-worker';
it('runs both bounded evidence jobs once without sleeping', async () => {
  const jobs: string[] = [];
  const result = await runEvidenceWorker({ once: true }, { run: async name => { jobs.push(name); return { status: 'completed' }; }, sleep: async () => { throw new Error('unexpected sleep'); } });
  expect(jobs).toEqual(['product-evidence-refresh', 'agent-evidence-refresh']);
  expect(result).toEqual({ ticks: 1, failures: 0 });
});
it('stops before the next job after graceful shutdown is requested', async () => {
  const controller = new AbortController();
  const jobs: string[] = [];
  await runEvidenceWorker({ signal: controller.signal }, { run: async name => { jobs.push(name); controller.abort(); return { status: 'completed' }; } });
  expect(jobs).toEqual(['product-evidence-refresh']);
});
it('continues the other job after a failure and bounds sleep', async () => {
  const controller = new AbortController();
  let jobs = 0;
  const result = await runEvidenceWorker({ intervalMs: 300_000, signal: controller.signal }, { run: async () => ({ status: ++jobs === 1 ? 'failed' : 'completed' }), sleep: async ms => { expect(ms).toBe(60_000); controller.abort(); } });
  expect(result.failures).toBe(1);
  expect(jobs).toBe(2);
});
it('queues a legacy explicit request before consuming it with the shared runner contract', async () => {
  const events: string[] = [];
  await runEvidenceWorker({ once: true }, {
    request: async name => { events.push(`request:${name}`); },
    run: async (name, options) => { expect(options.requestedOnly).toBe(true); events.push(`run:${name}`); return { status: 'completed' }; },
  });
  expect(events).toEqual([
    'request:product-evidence-refresh', 'run:product-evidence-refresh',
    'request:agent-evidence-refresh', 'run:agent-evidence-refresh',
  ]);
});
