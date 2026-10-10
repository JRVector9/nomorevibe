/** Role-specific consumer. Scheduling belongs to scheduler.ts, never this poll loop. */
import { basename } from 'node:path';
import { JOB_ROLES, type JobRole } from '@/lib/jobs/catalog';
import { lastSettingsRead } from '@/lib/crawl/settings-version';

export type RuntimeState = 'idle' | 'polling' | 'running' | 'stopping';
export type RuntimeHeartbeat = {
  type: 'runtime.heartbeat';
  role: string;
  pid: number;
  at: number;
  state: RuntimeState;
  currentJob: string | null;
  startedAt: number | null;
  lastProgressAt: number;
  /** 이 프로세스의 잡이 마지막으로 읽은 크롤 설정 판과 그 시각(epoch ms) — 설정 화면의 적용 확인(ADM-19). 옛 워커는 싣지 않는다 */
  settings?: { version: string; at: number } | null;
};
/** startedAt: 그 잡을 시작한 시각 — 줄이 여럿이면 가장 오래 돈 잡의 시작을 그대로 넘겨야 감독(job_timeout)이 맞게 잰다 */
export type RuntimeReport = (state: RuntimeState, currentJob?: string | null, startedAt?: number | null) => void;
export type RequestedRunOptions = { requestedOnly: true; signal?: AbortSignal };
export type JobRunOptions = RequestedRunOptions & { budgetMs?: number };
type WorkerOptions = { role: JobRole; once?: boolean; intervalMs?: number; signal?: AbortSignal };
type WorkerDependencies = {
  names: readonly string[];
  /** 한 프로세스 안에서 동시에 도는 줄(catalog lanesForRole) — 없으면 names 한 줄 */
  lanes?: readonly (readonly string[])[];
  pending: () => Promise<string[]>;
  seen: (names: string[]) => Promise<void>;
  run: (name: string, options: RequestedRunOptions) => Promise<{ status: string }>;
  sleep?: typeof interruptibleSleep;
  report?: RuntimeReport;
  log?: typeof runtimeLog;
};

export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function runtimeLog(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

/**
 * A classification batch can use 20 seconds before inserts and image copies begin.
 * 사유 번역은 한 번 부르는 데 15~25초라 기본 25초 틱에는 한 번도 빠듯하다(프로드 첫 4틱이 모두 20초 제한에 걸렸다).
 * 번역은 별도 text 워커에서 실행하며 발행 잡의 실행 시간을 차지하지 않는다.
 */
export function jobRunOptions(name: string, options: RequestedRunOptions): JobRunOptions {
  if (name === 'crawl-agent-review') return { ...options, budgetMs: 40_000 };
  if (name === 'crawl-publish') return { ...options, budgetMs: 120_000 };
  if (name === 'reason-translate') return { ...options, budgetMs: 55_000 };
  // 검색 키워드 한 건이 7초 안팎이다 — 기본 틱이면 동시 셋이 두 바퀴도 못 돈다
  if (name === 'product-search-profile') return { ...options, budgetMs: 55_000 };
  if (name === 'product-search-verify') return { ...options, budgetMs: 110_000 };
  // 한 묶음(64건)이 1초 안쪽이라 처음 채울 때 틱 하나에 3천 건 남짓
  if (name === 'product-embedding') return { ...options, budgetMs: 50_000 };
  // 페이지 열기(10초)와 모델 한 번을 셋씩 — 기본 25초면 한 바퀴밖에 못 돈다
  if (name === 'product-repo-review') return { ...options, budgetMs: 55_000 };
  // 소개 8건 묶음 한 번이 15~25초 — 기본 25초면 한 묶음도 빠듯하다(사유 번역과 같은 까닭)
  if (name === 'product-tagline-ko') return { ...options, budgetMs: 55_000 };
  // 저장소 50개 묶음이 3~4초 — 기본 25초면 하루치(공개 저장소 전부)를 다 못 본다(stars-refresh.ts)
  if (name === 'product-stars-refresh') return { ...options, budgetMs: 40_000 };
  // AI 제작 근거 단계 — GraphQL 묶음을 30초 안에서 열고 마지막 묶음·두 번째 질의(각 10초 상한)와 기록까지(ai-level-refresh.ts)
  if (name === 'ai-level-refresh') return { ...options, budgetMs: 55_000 };
  if (name === 'product-intro-check') return { ...options, budgetMs: 110_000 };
  // 게이트웨이가 붐비면 한 건이 45초까지 간다. 틱이 짧으면 그 호출을 아예 시작하지 못한다
  if (name === 'second-review') return { ...options, budgetMs: 110_000 };
  if (name === 'product-thumbnail-refresh') return { ...options, budgetMs: 40_000 };
  return options;
}

/**
 * A once run processes one pending snapshot, not the entire queue or future requests.
 *
 * 줄(lane)마다 아래 차례 실행을 동시에 돌린다 — 역할 lease 는 하나라 워커를 늘려도 한 대만 일하므로, 오래 걸리는 잡은 따로 도는 줄에
 * 둔다(2026-10-10 크롤러: AI 단계 판정이 시간의 3분의 1을 쓰며 crawl-fetch 간격이 60→70초). 줄 안은 지금처럼 한 번에 하나씩.
 * 감독에게는 줄들을 합쳐 알린다 — 도는 잡이 있으면 가장 오래 돈 잡과 그 시작 시각(감독의 job_timeout 이 그것으로 잰다).
 */
export async function runWorker(options: WorkerOptions, dependencies: WorkerDependencies) {
  const intervalMs = Math.max(1_000, Math.min(options.intervalMs ?? 5_000, 60_000));
  const lanes = (dependencies.lanes ?? [dependencies.names]).map((names) => [...new Set(names)]).filter((names) => names.length > 0);
  const states = lanes.map((): { state: RuntimeState; job: string | null; startedAt: number | null } => ({ state: 'idle', job: null, startedAt: null }));
  const emit = () => {
    const running = states.filter((lane) => lane.state === 'running' && lane.job !== null && lane.startedAt !== null)
      .sort((a, b) => a.startedAt! - b.startedAt!)[0];
    if (running) dependencies.report?.('running', running.job, running.startedAt);
    else dependencies.report?.(states.some((lane) => lane.state === 'polling') ? 'polling' : 'idle');
  };
  const laneReport = (index: number): RuntimeReport => (state, currentJob = null) => {
    states[index] = { state, job: currentJob, startedAt: state === 'running' ? Date.now() : null };
    emit();
  };
  const results = await Promise.all(lanes.map((names, index) => runLane(options, dependencies, names, intervalMs, laneReport(index))));
  return { ticks: results.reduce((sum, result) => sum + result.ticks, 0), failures: results.reduce((sum, result) => sum + result.failures, 0) };
}

async function runLane(options: WorkerOptions, dependencies: WorkerDependencies, names: string[], intervalMs: number, report: RuntimeReport) {
  let ticks = 0, failures = 0, nextIndex = 0;
  while (!options.signal?.aborted) {
    ticks++;
    report('polling');
    try {
      await dependencies.seen(names);
      const pending = new Set(await dependencies.pending());
      // Visit each role-owned job at most once per poll. Never run names from another role.
      const ordered = [...names.slice(nextIndex), ...names.slice(0, nextIndex)];
      for (const name of ordered) {
        if (options.signal?.aborted) break;
        if (!pending.has(name)) continue;
        report('running', name);
        try {
          const result = await dependencies.run(name, { requestedOnly: true, signal: options.signal });
          if (result.status === 'failed') failures++;
          dependencies.log?.('worker.job', { role: options.role, name, status: result.status });
        } catch {
          failures++;
          dependencies.log?.('worker.job', { role: options.role, name, status: 'failed' });
        } finally {
          nextIndex = (names.indexOf(name) + 1) % names.length;
          report('polling');
        }
      }
    } catch {
      failures++;
      dependencies.log?.('worker.poll_failed', { role: options.role });
    }
    report('idle');
    if (options.once || options.signal?.aborted) break;
    await (dependencies.sleep ?? interruptibleSleep)(intervalMs, options.signal);
  }
  return { ticks, failures };
}

/** Shared CLI lifecycle. A supervisor can distinguish event-loop liveness from job progress. */
export async function withRuntimeProcess<T>(
  role: string,
  execute: (signal: AbortSignal, report: RuntimeReport) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let current: Omit<RuntimeHeartbeat, 'at'> = {
    type: 'runtime.heartbeat', role, pid: process.pid, state: 'idle',
    currentJob: null, startedAt: null, lastProgressAt: Date.now(),
  };
  const heartbeat = () => {
    if (process.connected && process.send) {
      // The parent can disconnect during shutdown. IPC failure must not interrupt a DB write.
      try { process.send({ ...current, at: Date.now(), settings: lastSettingsRead() }, () => {}); } catch { /* disconnected */ }
    }
  };
  const report: RuntimeReport = (state, currentJob = null, startedAt = null) => {
    const now = Date.now();
    current = {
      ...current, state: controller.signal.aborted ? 'stopping' : state,
      currentJob, startedAt: state === 'running' ? startedAt ?? now : null, lastProgressAt: now,
    };
    heartbeat();
  };
  const shutdown = () => {
    controller.abort();
    current = { ...current, state: 'stopping' };
    heartbeat();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const timer = setInterval(heartbeat, 5_000);
  timer.unref();
  heartbeat();
  try {
    return await execute(controller.signal, report);
  } finally {
    // Keep heartbeat reporting while the pool drains; stop accepting another tick immediately.
    shutdown();
    try {
      const client = (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient;
      await client?.end({ timeout: 5 });
    } finally {
      clearInterval(timer);
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      if (process.connected) process.disconnect?.();
    }
  }
}

export function parseWorkerArgs(args: string[]) {
  const roleArg = args.find(arg => arg.startsWith('--role='));
  const role = roleArg?.slice('--role='.length);
  const roles: readonly string[] = JOB_ROLES;
  if (!role || !roles.includes(role) || args.filter(arg => arg.startsWith('--role=')).length !== 1) {
    throw new Error('Usage: worker.ts --role=crawler|reviewer|publisher|text|maintenance [--once] [--interval-seconds=1..60]');
  }
  return { ...parseLoopArgs(args.filter(arg => arg !== roleArg), 5), role: role as JobRole };
}

export function parseLoopArgs(args: string[], defaultSeconds: number) {
  if (args.some(arg => arg !== '--once' && !/^--interval-seconds=\d+$/.test(arg)) ||
      args.filter(arg => arg.startsWith('--interval-seconds=')).length > 1) {
    throw new Error('Expected [--once] [--interval-seconds=1..60]');
  }
  const intervalArg = args.find(arg => arg.startsWith('--interval-seconds='));
  const seconds = intervalArg ? Number(intervalArg.split('=')[1]) : defaultSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) {
    throw new Error('interval-seconds must be between 1 and 60');
  }
  return { once: args.includes('--once'), intervalMs: seconds * 1_000 };
}

async function main() {
  const options = parseWorkerArgs(process.argv.slice(2));
  await withRuntimeProcess(options.role, async (signal, report) => {
    const [{ jobsForRole, lanesForRole }, { pendingJobNames, markWorkerSeen }, { JOBS }, { runJob }, { roleLeaseFromEnv }] = await Promise.all([
      import('@/lib/jobs/catalog'), import('@/lib/jobs/control'), import('@/lib/jobs/registry'),
      import('@/lib/jobs/runner'), import('@/lib/jobs/role-leader'),
    ]);
    const roleLease = roleLeaseFromEnv(options.role, process.env);
    const result = await runWorker({ ...options, signal }, {
      names: jobsForRole(options.role),
      lanes: lanesForRole(options.role),
      pending: () => pendingJobNames(options.role),
      seen: markWorkerSeen,
      run: (name, runOptions) => runJob(name, JOBS[name], { ...jobRunOptions(name, runOptions), roleLease }),
      report, log: runtimeLog,
    });
    runtimeLog('worker.stopped', { role: options.role, ...result });
    if (options.once && result.failures) process.exitCode = 1;
  });
}

if (process.argv[1] && /^worker\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(error => {
    console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'worker failed; check role/database/environment configuration');
    process.exitCode = 1;
  });
}
