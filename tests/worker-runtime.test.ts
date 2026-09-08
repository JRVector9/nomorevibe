import { expect, it, vi } from 'vitest';
import { interruptibleSleep, jobRunOptions, parseWorkerArgs, runWorker } from '@/scripts/worker';

it('runs only pending role jobs sequentially and consumes requests without scheduling', async () => {
  const jobs: string[] = [];
  let active = 0;
  const seen = vi.fn(async () => {});
  const result = await runWorker({ role: 'crawler', once: true }, {
    names: ['crawl-fetch', 'crawl-seed', 'agent-evidence-refresh'], seen,
    pending: async () => ['crawl-publish', 'crawl-seed', 'crawl-fetch'],
    run: async (name, options) => {
      expect(options.requestedOnly).toBe(true);
      expect(++active).toBe(1);
      await Promise.resolve();
      jobs.push(name);
      active--;
      return { status: 'completed' };
    },
    sleep: async () => { throw new Error('once must not sleep'); },
  });
  expect(jobs).toEqual(['crawl-fetch', 'crawl-seed']);
  expect(seen).toHaveBeenCalledWith(['crawl-fetch', 'crawl-seed', 'agent-evidence-refresh']);
  expect(result).toEqual({ ticks: 1, failures: 0 });
});

it('keeps idle worker observation separate from handler execution', async () => {
  const run = vi.fn();
  const seen = vi.fn(async () => {});
  await runWorker({ role: 'reviewer', once: true }, {
    names: ['crawl-judge'], pending: async () => [], run, seen,
  });
  expect(seen).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
});

it('finishes the active call on shutdown and does not start another job', async () => {
  const controller = new AbortController();
  const jobs: string[] = [];
  const reports: string[] = [];
  const result = await runWorker({ role: 'crawler', signal: controller.signal }, {
    names: ['crawl-fetch', 'crawl-seed'], pending: async () => ['crawl-fetch', 'crawl-seed'],
    seen: async () => {}, report: (state, name) => reports.push(`${state}:${name ?? ''}`),
    run: async (name, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      await Promise.resolve(); // The loop must await this active tick even after abort.
      jobs.push(name);
      return { status: 'completed' };
    },
  });
  expect(result.ticks).toBe(1);
  expect(jobs).toEqual(['crawl-fetch']);
  expect(reports).toContain('running:crawl-fetch');
});

it('continues other jobs after a failure and rotates the next starting position', async () => {
  const controller = new AbortController();
  const jobs: string[] = [];
  let poll = 0;
  const result = await runWorker({ role: 'crawler', signal: controller.signal }, {
    names: ['crawl-fetch', 'crawl-seed', 'agent-evidence-refresh'], seen: async () => {},
    pending: async () => ++poll === 1 ? ['crawl-fetch', 'crawl-seed'] : ['crawl-fetch', 'crawl-seed', 'agent-evidence-refresh'],
    run: async name => { jobs.push(name); if (name === 'crawl-fetch') throw new Error('network'); return { status: 'completed' }; },
    sleep: async () => { if (poll === 2) controller.abort(); },
  });
  expect(jobs).toEqual(['crawl-fetch', 'crawl-seed', 'agent-evidence-refresh', 'crawl-fetch', 'crawl-seed']);
  expect(result.failures).toBe(2);
});

it('backs off after a polling failure without invoking handlers', async () => {
  const controller = new AbortController();
  const run = vi.fn();
  const result = await runWorker({ role: 'publisher', signal: controller.signal }, {
    names: ['crawl-publish'], seen: async () => {}, pending: async () => { throw new Error('db'); }, run,
    sleep: async ms => { expect(ms).toBe(5_000); controller.abort(); },
  });
  expect(result).toEqual({ ticks: 1, failures: 1 });
  expect(run).not.toHaveBeenCalled();
});

it('wakes an idle poll immediately on shutdown', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const sleeping = interruptibleSleep(60_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('validates role and bounded CLI interval before loading database modules', () => {
  expect(parseWorkerArgs(['--role=crawler', '--once'])).toEqual({ role: 'crawler', once: true, intervalMs: 5_000 });
  expect(() => parseWorkerArgs(['--role=web'])).toThrow();
  expect(() => parseWorkerArgs(['--role=crawler', '--role=publisher'])).toThrow();
  expect(() => parseWorkerArgs(['--role=crawler', '--interval-seconds=0'])).toThrow();
  expect(() => parseWorkerArgs(['--role=crawler', '--interval-seconds=61'])).toThrow();
});

it('gives the publisher batch enough cooperative time below the supervisor deadline', () => {
  const base = { requestedOnly: true as const };
  expect(jobRunOptions('crawl-publish', base)).toEqual({ ...base, budgetMs: 120_000 });
  expect(jobRunOptions('crawl-fetch', base)).toBe(base);
});
