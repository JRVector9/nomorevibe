import { runWorker, withRuntimeProcess } from '../../scripts/worker';

// An isolated child exercises actual IPC and HTTP cancellation, without a DB or model.
void withRuntimeProcess('crawler', async (signal, report, stopClaims) => {
  await runWorker({ role: 'crawler', signal, stopClaims }, {
    names: ['crawl-fetch', 'crawl-seed'], seen: async () => {},
    pending: async () => ['crawl-fetch', 'crawl-seed'], report,
    run: async name => {
      try {
        const response = await fetch(process.argv[2], { signal });
        const result: unknown = await response.json();
        process.send?.({ type: 'fixture.recorded', name, result });
      } catch {
        process.send?.({ type: 'fixture.cancelled', name });
      }
      return { status: 'completed' };
    },
  });
}).catch(() => { process.exitCode = 1; });
