import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { interruptibleSleep, jobRunOptions, parseWorkerArgs, runWorker } from '@/scripts/worker';
import { batchJobsForRole, batchLanesForRole } from '@/lib/jobs/batches';

function runtimeGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it('re-polls the single site-evidence lane only after an actual runner continuation', async () => {
  const controller = new AbortController();
  let polls = 0;
  const sleeps: number[] = [];
  await runWorker({ role: 'site-evidence', signal: controller.signal }, {
    names: ['product-site-evidence-refresh'], lanes: [['product-site-evidence-refresh']],
    seen: async () => {},
    pending: async () => ++polls === 1 ? ['product-site-evidence-refresh'] : [],
    run: async () => ({ status: 'completed', done: false, sourceContinuation: true }),
    sleep: async ms => { sleeps.push(ms); controller.abort(); },
  });
  expect(polls).toBe(2);
  expect(sleeps).toEqual([5_000]);
});

it('gives the site-only source lane the same bounded evidence budget', () => {
  const options = { requestedOnly: true as const, signal: new AbortController().signal };
  expect(jobRunOptions('product-site-evidence-refresh', options)).toEqual({ ...options, budgetMs: 55_000 });
});

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


async function runBudgetEntry(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let heartbeats = 0;
  let stderr = '';
  let closed = false;
  child.stdout?.resume();
  child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
  child.on('message', value => { if ((value as { type?: string })?.type === 'runtime.heartbeat') heartbeats += 1; });
  const settled = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { closed = true; resolve(code); });
  });
  const actualClose = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 4000);
  const killTimeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { return { code: await settled, heartbeats, stderr }; }
  finally {
    if (!closed) child.kill('SIGTERM');
    await actualClose;
    clearTimeout(timeout);
    clearTimeout(killTimeout);
  }
}

it('rejects a wrong declared entry before real CLI heartbeats, role observations or supervisor spawn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'host-db-entry-'));
  const env = { ...process.env, DATABASE_URL: undefined, READ_DATABASE_URL: undefined, NODE_OPTIONS: undefined,
    WORKER_ROLE: 'crawler', PHYSICAL_HOST: 'm3', RELEASE_TAG: 'r1', SERVICE_INSTANCE_ID: 'host-budget-test',
    ROLE_HEALTH_PATH: join(directory, 'role.json'), WORKER_HEALTH_PATH: join(directory, 'worker.json') };
  const policy = { version: 1, host: 'm3', release: 'r1', roles: ['crawler'], schedulerReplicas: 1,
    webReplicas: 1, webReadReplica: false, monitor: false, connectAgent: false,
    preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 };
  try {
    for (const [script, args, role, kind] of [
      ['scripts/worker.ts', ['--role=crawler', '--once'], 'crawler', 'role-parent'],
      ['scripts/scheduler.ts', ['--once'], 'scheduler', 'scheduler-parent'],
      ['scripts/role-worker.ts', ['--role=crawler', '--kind=primary'], 'crawler', 'worker'],
      ['scripts/worker-supervisor.ts', ['--role=crawler', '--once'], 'crawler', 'worker'],
    ] as const) {
      const result = await runBudgetEntry(script, [...args], { ...env, WORKER_ROLE: role,
        HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy,
          process: { kind, role, host: 'm3', release: 'r1', replica: 1, copy: 1 } }) });
      expect(result.code).toBe(1);
      expect(result.heartbeats).toBe(0);
      expect(result.stderr).toMatch(/failed; check/);
      expect(existsSync(env.ROLE_HEALTH_PATH)).toBe(false);
      expect(existsSync(env.WORKER_HEALTH_PATH)).toBe(false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('keeps the disabled real worker entry and its original IPC lifecycle reachable', async () => {
  const result = await runBudgetEntry('scripts/worker.ts', ['--role=crawler', '--once'], {
    ...process.env, DATABASE_URL: undefined, READ_DATABASE_URL: undefined, NODE_OPTIONS: undefined,
    HOST_DB_BUDGET: '{"mode":"disabled"}',
  });
  // No DATABASE_URL is supplied: only the pre-existing IPC lifecycle is exercised, no DB/socket/job.
  expect(result.code).toBe(1);
  expect(result.heartbeats).toBeGreaterThan(0);
});

it('re-ticks the reviewer lane after 1s only when second-review is stage-blocked by AI2 item mode', async () => {
  const sleeps: number[] = [];
  for (const result of [{ status: 'deferred', reason: 'stage_blocked' }, { status: 'deferred', reason: 'model_capacity' }, { status: 'completed' }]) {
    const controller = new AbortController();
    await runWorker({ role: 'reviewer', signal: controller.signal }, {
      names: ['crawl-agent-review', 'second-review'], seen: async () => {}, pending: async () => ['crawl-agent-review', 'second-review'],
      run: async name => name === 'second-review' ? result : { status: 'deferred', reason: 'stage_blocked' },
      sleep: async ms => { sleeps.push(ms); controller.abort(); },
    });
  }
  expect(sleeps).toEqual([1_000, 5_000, 5_000]);
});

it('gives the agent evidence scan the 55-second tick budget', () => {
  const base = { requestedOnly: true as const };
  expect(jobRunOptions('agent-evidence-refresh', base)).toEqual({ ...base, budgetMs: 55_000 });
});

it('re-polls the agent evidence scan lane after 1s only when its tick left work', async () => {
  const sleeps: number[] = [];
  for (const result of [{ status: 'completed', done: false }, { status: 'completed', done: true }, { status: 'deferred', reason: 'source_buffer' },
    { status: 'failed', done: false }, { status: 'skipped', reason: 'locked' }]) {
    const controller = new AbortController();
    await runWorker({ role: 'crawler', signal: controller.signal }, {
      names: ['agent-evidence-refresh'], lanes: [['agent-evidence-refresh']], seen: async () => {}, pending: async () => ['agent-evidence-refresh'],
      run: async () => result,
      sleep: async ms => { sleeps.push(ms); controller.abort(); },
    });
  }
  expect(sleeps).toEqual([1_000, 5_000, 5_000, 5_000, 5_000]);
});

it('keeps other crawler lanes on their own schedule while the scan lane runs long ticks back to back', async () => {
  const controller = new AbortController();
  const scan = runtimeGate();
  const events: string[] = [];
  const work = runWorker({ role: 'crawler', signal: controller.signal }, {
    names: ['crawl-fetch', 'agent-evidence-refresh'], lanes: [['crawl-fetch'], ['agent-evidence-refresh']],
    seen: async () => {}, pending: async () => ['crawl-fetch', 'agent-evidence-refresh'],
    run: async name => {
      events.push(`start:${name}`);
      if (name === 'agent-evidence-refresh') await scan.promise;
      events.push(`end:${name}`);
      return name === 'agent-evidence-refresh' ? { status: 'completed', done: false } : { status: 'completed', done: true };
    },
    sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
  });
  try {
    // 스캔 틱 하나가 끝나지 않은 동안 원본 수집 줄은 계속 돈다
    await vi.waitFor(() => expect(events.filter(event => event === 'end:crawl-fetch').length).toBeGreaterThanOrEqual(3));
    expect(events).not.toContain('end:agent-evidence-refresh');
    scan.release();
    await vi.waitFor(() => expect(events.filter(event => event === 'end:agent-evidence-refresh').length).toBeGreaterThanOrEqual(2));
  } finally {
    controller.abort();
    scan.release();
    await work;
  }
});
