import { expect, it, vi } from 'vitest';
import { interruptibleSleep, jobRunOptions, parseWorkerArgs, runWorker } from '@/scripts/worker';
import { batchJobsForRole, batchLanesForRole } from '@/lib/jobs/batches';

function runtimeGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it.each(['legacy', 'versioned'] as const)('keeps the production %s crawler fetch lane progressing while evidence is held', async mode => {
  const controller = new AbortController();
  const entered = runtimeGate();
  const release = runtimeGate();
  let fetchFinished = false;
  let evidenceFinished = false;
  const work = runWorker({ role: 'crawler', once: true, signal: controller.signal }, {
    names: batchJobsForRole('crawler', mode), lanes: batchLanesForRole('crawler', mode),
    seen: async () => {}, pending: async () => ['crawl-fetch', 'ai-level-refresh'],
    run: async name => {
      if (name === 'ai-level-refresh') {
        entered.release();
        await release.promise;
        evidenceFinished = true;
      } else if (name === 'crawl-fetch') {
        await entered.promise;
        fetchFinished = true;
      }
      return { status: 'completed' };
    },
  });
  try {
    await vi.waitFor(() => expect(fetchFinished).toBe(true));
    expect(evidenceFinished).toBe(false);
  } finally {
    controller.abort();
    entered.release();
    release.release();
    await work;
  }
});

it('keeps the production translation batch serial while its first call is held', async () => {
  const controller = new AbortController();
  const entered = runtimeGate();
  const release = runtimeGate();
  const started: string[] = [];
  const names = batchJobsForRole('translation', 'versioned');
  const work = runWorker({ role: 'translation', once: true, signal: controller.signal }, {
    names, lanes: batchLanesForRole('translation', 'versioned'),
    seen: async () => {}, pending: async () => names,
    run: async name => {
      started.push(name);
      if (name === 'reason-translate') { entered.release(); await release.promise; }
      return { status: 'completed' };
    },
  });
  try {
    await entered.promise;
    await Promise.resolve();
    expect(started).toEqual(['reason-translate']);
    release.release();
    await work;
    expect(started).toEqual(['reason-translate', 'product-tagline-ko', 'product-translate']);
  } finally {
    controller.abort();
    release.release();
    await work;
  }
});

it('re-polls the production versioned crawler source lane before sleeping after a verified continuation', async () => {
  const controller = new AbortController();
  const sleeping = runtimeGate();
  let sourcePolls = 0;
  let ran = false;
  const work = runWorker({ role: 'crawler', signal: controller.signal }, {
    names: batchJobsForRole('crawler', 'versioned'), lanes: batchLanesForRole('crawler', 'versioned'),
    seen: async names => { if (names.includes('product-evidence-refresh')) sourcePolls += 1; },
    pending: async () => ran ? [] : ['product-evidence-refresh'],
    run: async () => { ran = true; return { status: 'completed', done: false, sourceContinuation: true }; },
    sleep: async () => { await sleeping.promise; },
  });
  try {
    await vi.waitFor(() => expect(sourcePolls).toBe(2));
    expect(ran).toBe(true);
  } finally {
    controller.abort();
    sleeping.release();
    await work;
  }
});

it('gives product audit a finite budget for its sixty-second call and keeps cancellation', () => {
  const signal = new AbortController().signal;
  expect(jobRunOptions('product-audit', { requestedOnly: true, signal }))
    .toEqual({ requestedOnly: true, signal, budgetMs: 70_000 });
});

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
  expect(jobRunOptions('reason-translate', base)).toEqual({ ...base, budgetMs: 55_000 });
  expect(jobRunOptions('crawl-fetch', base)).toBe(base);
});

it('re-polls only the crawler source lane without sleeping when the runner verified a continuation', async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  let polls = 0;
  const jobs: string[] = [];
  await runWorker({ role: 'crawler', signal: controller.signal }, {
    names: ['product-evidence-refresh'], lanes: [['product-evidence-refresh']],
    seen: async () => {},
    pending: async () => {
      polls += 1;
      return polls === 1 ? ['product-evidence-refresh'] : [];
    },
    run: async (name) => {
      jobs.push(name);
      return { status: 'completed', done: false, sourceContinuation: true };
    },
    sleep: async (ms) => { sleeps.push(ms); controller.abort(); },
  });
  expect(jobs).toEqual(['product-evidence-refresh']);
  expect(polls).toBe(2);
  expect(sleeps).toEqual([5_000]);
});

it('keeps the normal poll when continuation is missing, the lane is mixed, or the role is different', async () => {
  const cases = [
    { role: 'crawler' as const, names: ['product-evidence-refresh'], result: { status: 'completed', done: false } },
    { role: 'crawler' as const, names: ['product-evidence-refresh'], result: { status: 'completed', done: false, sourceContinuation: false } },
    { role: 'crawler' as const, names: ['product-evidence-refresh', 'crawl-fetch'], result: { status: 'completed', done: false, sourceContinuation: true } },
    { role: 'reviewer' as const, names: ['product-evidence-refresh'], result: { status: 'completed', done: false, sourceContinuation: true } },
    { role: 'crawler' as const, names: ['product-evidence-refresh'], result: { status: 'skipped', reason: 'locked' } },
    { role: 'crawler' as const, names: ['product-evidence-refresh'], result: { status: 'skipped', reason: 'not_requested' } },
    { role: 'crawler' as const, names: ['product-evidence-refresh'], result: { status: 'skipped', reason: 'backoff' } },
    { role: 'crawler' as const, names: ['product-evidence-refresh'], result: { status: 'completed', done: true, sourceContinuation: true } },
    { role: 'crawler' as const, names: ['product-evidence-refresh'], result: { status: 'failed', done: false, sourceContinuation: true } },
  ];
  for (const item of cases) {
    const controller = new AbortController();
    let polls = 0;
    await runWorker({ role: item.role, signal: controller.signal }, {
      names: item.names, lanes: [item.names], seen: async () => {},
      pending: async () => { polls += 1; return ['product-evidence-refresh']; },
      run: async () => item.result,
      sleep: async (ms) => { expect(ms).toBe(5_000); controller.abort(); },
    });
    expect(polls).toBe(1);
  }
});

it('does not take another poll when once or abort already ends a marked source tick', async () => {
  const onceSleep = vi.fn(async () => { throw new Error('once must not sleep'); });
  const once = await runWorker({ role: 'crawler', once: true }, {
    names: ['product-evidence-refresh'], lanes: [['product-evidence-refresh']],
    seen: async () => {}, pending: async () => ['product-evidence-refresh'],
    run: async () => ({ status: 'completed', done: false, sourceContinuation: true }),
    sleep: onceSleep,
  });
  expect(once).toEqual({ ticks: 1, failures: 0 });
  expect(onceSleep).not.toHaveBeenCalled();

  const controller = new AbortController();
  let polls = 0;
  await runWorker({ role: 'crawler', signal: controller.signal }, {
    names: ['product-evidence-refresh'], lanes: [['product-evidence-refresh']],
    seen: async () => {},
    pending: async () => { polls += 1; return ['product-evidence-refresh']; },
    run: async () => { controller.abort(); return { status: 'completed', done: false, sourceContinuation: true }; },
    sleep: async () => { throw new Error('abort must not sleep'); },
  });
  expect(polls).toBe(1);
});

it('visits every pending job on a mixed lane and sleeps even if one result carries a marker', async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  let polls = 0;
  await runWorker({ role: 'crawler', signal: controller.signal }, {
    names: ['crawl-fetch', 'product-evidence-refresh'],
    lanes: [['crawl-fetch', 'product-evidence-refresh']],
    seen: async () => {},
    pending: async () => { polls += 1; return ['crawl-fetch', 'product-evidence-refresh']; },
    run: async (name) => {
      seen.push(name);
      return { status: 'completed', done: false, sourceContinuation: true };
    },
    sleep: async (ms) => { expect(ms).toBe(5_000); controller.abort(); },
  });
  expect(seen).toEqual(['crawl-fetch', 'product-evidence-refresh']);
  expect(polls).toBe(1);
});

it('gives product evidence one 55-second cooperative budget in the existing crawler', () => {
  const options = { requestedOnly: true as const, signal: new AbortController().signal };
  expect(jobRunOptions('product-evidence-refresh', options)).toEqual({ ...options, budgetMs: 55_000 });
});

it('lets a configured Grok first review start within the same 110-second second-review budget', () => {
  const base = { requestedOnly: true as const };
  expect(jobRunOptions('crawl-agent-review', base).budgetMs).toBe(110_000);
  expect(jobRunOptions('second-review', base).budgetMs).toBe(110_000);
});

it('preserves a lane polling age while another lane starts and completes jobs', async () => {
  let unblockPoll!: () => void;
  let finishJob!: () => void;
  const poll = new Promise<void>(resolve => { unblockPoll = resolve; });
  const job = new Promise<void>(resolve => { finishJob = resolve; });
  const snapshots: Array<Array<{ name: string; state: string; pollStartedAt: number | null; lastProgressAt: number }>> = [];
  const work = runWorker({ role: 'crawler', once: true }, {
    names: ['crawl-fetch', 'product-evidence-refresh'], lanes: [['crawl-fetch'], ['product-evidence-refresh']],
    seen: names => names.includes('crawl-fetch') ? poll : Promise.resolve(),
    pending: async () => ['product-evidence-refresh'],
    report: (_state, _job, _at, lanes) => { if (lanes) snapshots.push(lanes); },
    run: async () => { await job; return { status: 'completed' }; },
  });
  try {
    await vi.waitFor(() => expect(snapshots.at(-1)?.find(lane => lane.name === 'product-evidence-refresh')?.state).toBe('running'));
    const waiting = snapshots.at(-1)!.find(lane => lane.name === 'crawl-fetch')!;
    expect(waiting.pollStartedAt).toEqual(expect.any(Number));
    finishJob();
    await vi.waitFor(() => expect(snapshots.at(-1)?.find(lane => lane.name === 'product-evidence-refresh')?.state).toBe('idle'));
    expect(snapshots.at(-1)!.find(lane => lane.name === 'crawl-fetch')).toMatchObject(waiting);
  } finally { finishJob(); unblockPoll(); await work; }
});

it('runs lanes at the same time — a slow evidence job does not hold up the main lane', async () => {
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const order: string[] = [];
  const result = await runWorker({ role: 'crawler', once: true }, {
    names: ['crawl-fetch', 'ai-level-refresh'], lanes: [['crawl-fetch'], ['ai-level-refresh']],
    seen: async () => {}, pending: async () => ['crawl-fetch', 'ai-level-refresh'],
    run: async (name) => {
      order.push(`start:${name}`);
      // 느린 잡은 기본 줄의 잡이 끝나야 풀린다 — 한 줄로 돌면 여기서 멈춘다
      if (name === 'ai-level-refresh') await slowGate;
      else releaseSlow();
      order.push(`end:${name}`);
      return { status: 'completed' };
    },
  });
  expect(order).toHaveLength(4);
  expect(order.indexOf('end:crawl-fetch')).toBeLessThan(order.indexOf('end:ai-level-refresh'));
  expect(result).toEqual({ ticks: 2, failures: 0 });
});

it('reports the longest-running job across lanes with its own start time — the supervisor times jobs from it', async () => {
  const resolvers = new Map<string, () => void>();
  const reports: [string, string | null | undefined, number | null | undefined][] = [];
  const work = runWorker({ role: 'crawler', once: true }, {
    names: ['crawl-fetch', 'ai-level-refresh'], lanes: [['crawl-fetch'], ['ai-level-refresh']],
    // 기본 줄은 조금 늦게 시작한다 — 근거 줄의 잡이 먼저 돈다
    seen: (names) => names.includes('crawl-fetch') ? new Promise((resolve) => setTimeout(resolve, 20)) : Promise.resolve(),
    pending: async () => ['crawl-fetch', 'ai-level-refresh'],
    report: (state, job, startedAt) => { reports.push([state, job, startedAt]); },
    run: (name) => new Promise((resolve) => { resolvers.set(name, () => resolve({ status: 'completed' })); }),
  });
  await vi.waitFor(() => expect(resolvers.size).toBe(2));
  const first = reports.find(([state, job]) => state === 'running' && job === 'ai-level-refresh')!;
  // 둘 다 도는 동안은 먼저 시작한 잡과 그 시작 시각
  expect(reports.at(-1)).toEqual(['running', 'ai-level-refresh', first[2]]);
  resolvers.get('crawl-fetch')!();
  await vi.waitFor(() => expect(reports.at(-1)?.[0]).toBe('running'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 기본 줄이 끝나도 남은 잡의 시작 시각은 그대로 — 다시 알릴 때 지금 시각으로 바뀌면 감독이 오래 걸린 잡을 놓친다
  expect(reports.at(-1)).toEqual(['running', 'ai-level-refresh', first[2]]);
  resolvers.get('ai-level-refresh')!();
  await work;
  expect(reports.at(-1)?.[0]).toBe('idle');
});
