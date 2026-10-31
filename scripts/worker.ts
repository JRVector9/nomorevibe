import { assertHostDbEntry } from '@/lib/db/host-budget';
/** Role-specific consumer. Scheduling belongs to scheduler.ts, never this poll loop. */
import { basename } from 'node:path';
import { BATCH_ROLES, batchJobsForRole, batchLanesForRole, type BatchRole } from '@/lib/jobs/batches';
import { lastSettingsRead } from '@/lib/crawl/settings-version';
import { probeCliServingContracts } from '@/lib/llm/cli-serving-contract';
import { DEFAULT_JOB_BUDGET_MS, effectiveJobBudgetMs, type RuntimeSettings } from '@/lib/operations/runtime-settings-schema';
import { ensureRuntimeSettings, lastRuntimeSettingsRead, runtimeSettings, withRuntimeSettings,
  type RuntimeSettingsRead, type RuntimeSettingsSnapshot } from '@/lib/operations/runtime-settings-store';
import { DECLARED_BUDGET_MARGIN_MS, DECLARED_BUDGET_MAX_MS, type RuntimeLane } from '@/lib/operations/worker-progress';
import { createProviderCircuits, providerCircuitConfig, withProviderOutcome, type ProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { dbErrorFields } from '@/lib/db/error-fields';
import { installTailnetDns } from '@/lib/net/tailnet-dns';

/** poll·tick 실패 로그 필드: 오류 code(SQLSTATE 등)·이름·잘린 message(SQL·params 제외)와 이 줄의 연속 실패 수 */
function failureFields(error: unknown, consecutiveFailures: number) {
  const detail = dbErrorFields(error);
  return { code: detail.code, errorName: detail.name, message: detail.message, consecutiveFailures };
}

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
  lanes?: RuntimeLane[];
  /** 이 프로세스의 잡이 마지막으로 읽은 크롤 설정 판과 그 시각(epoch ms) — 설정 화면의 적용 확인(ADM-19). 옛 워커는 싣지 않는다 */
  settings?: { version: string; at: number } | null;
  /** 이 프로세스가 틱에 마지막으로 고정한 관리자 실시간 한도(runtime_settings) 판·시각·env 등록부 여부 — 실시간 한도 화면의 '읽은 판'. 옛 워커는 싣지 않는다 */
  runtimeSettings?: RuntimeSettingsRead | null;
};
/** startedAt: 그 잡을 시작한 시각 — 줄이 여럿이면 가장 오래 돈 잡의 시작을 그대로 넘겨야 감독(job_timeout)이 맞게 잰다 */
export type RuntimeReport = (state: RuntimeState, currentJob?: string | null, startedAt?: number | null, lanes?: RuntimeLane[]) => void;
/** 줄 하나의 보고 — running 이면 그 틱에 선언한 예산(ms)을 함께 넘긴다. 예산은 틱이 고정한 스냅샷에서 한 번만 계산한다 */
type LaneReport = (state: RuntimeState, currentJob?: string | null, budgetMs?: number | null) => void;
export type RequestedRunOptions = { requestedOnly: true; signal?: AbortSignal };
export type JobRunOptions = RequestedRunOptions & { budgetMs?: number };
type JobRunResult = { status: string; done?: boolean; sourceContinuation?: boolean; reason?: string };
export type BackgroundConsumerLanes = {
  names: readonly string[];
  open: () => Promise<boolean>;
  /** options 에는 줄이 고정한 스냅샷으로 계산한 budgetMs 가 들어 있다 */
  run: (name: string, options: JobRunOptions) => Promise<JobRunResult>;
  request: (name: string) => Promise<unknown>;
  /** provider 회로(PR06e). 줄(job)마다 센다 — 틱 안 gateway 전송 결과가 쌓인다. 없으면 기존 그대로 */
  circuits?: ProviderCircuits;
};
type WorkerOptions = { role: BatchRole; once?: boolean; intervalMs?: number; signal?: AbortSignal;
  /** Stop new ticks without aborting the bounded tick already in flight. */
  stopClaims?: AbortSignal };
type WorkerDependencies = {
  names: readonly string[];
  /** 한 프로세스 안에서 동시에 도는 줄(catalog lanesForRole) — 없으면 names 한 줄 */
  lanes?: readonly (readonly string[])[];
  pending: () => Promise<string[]>;
  seen: (names: string[]) => Promise<void>;
  /** options 에는 줄이 틱 앞에 고정한 스냅샷으로 계산한 budgetMs 가 들어 있다(jobRunOptions) — heartbeat 에 알린 예산과 같은 값 */
  run: (name: string, options: JobRunOptions) => Promise<JobRunResult>;
  /** 틱(poll) 앞에 읽는 관리자 실시간 한도 스냅샷. 없으면 ensureRuntimeSettings(30초 TTL). 리플레이·시험은 고정 스냅샷을 준다 */
  settings?: () => Promise<RuntimeSettingsSnapshot>;
  /** host 합계 예산(lib/operations/host-budget-runtime.ts). 없으면 기존처럼 바로 실행한다 */
  admit?: (name: string) => Promise<{ admitted: true; release: () => Promise<void> } | { admitted: false; reason: string }>;
  consumer?: BackgroundConsumerLanes;
  sleep?: typeof interruptibleSleep;
  report?: RuntimeReport;
  log?: typeof runtimeLog;
  /** claim 전 admission 미룸(host 예산·provider 회로)을 미룬 이유 관측(defer:<job>)에 알린다. 실패해도 줄은 그대로 돈다 */
  deferred?: (name: string, reason: string) => Promise<void>;
};

/** 미룬 이유 관측은 줄의 성공·실패에 들지 않는다 */
async function noteDeferred(dependencies: WorkerDependencies, name: string, reason: string | null) {
  if (!reason) return;
  try { await dependencies.deferred?.(name, reason); } catch { /* 관측 실패는 poll 실패가 아니다 */ }
}

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
 * 잡의 틱 예산(budgetMs)을 options 에 붙인다. 값의 원천은 관리자 실시간 한도 문서 budgets.<job> 이다
 * (lib/operations/runtime-settings-schema.ts DEFAULT_RUNTIME_SETTINGS.budgets — 오늘의 상수: crawl-agent-review 110초, product-audit 70초,
 * product-translate "auto" = 호출 상한 300초 + 여유 15초 = 315초 …). 문서에 없는 잡은 options 그대로(runner 기본 25초 — crawl-tagline 포함).
 *
 * settings 는 틱이 고정한 스냅샷을 넘긴다(runLane) — heartbeat 에 알린 예산과 잡이 읽는 상한이 한 판이다(D3). 생략하면 지금 판(고정 → 프로세스 → 기본값).
 * 사유 번역은 한 번 부르는 데 15~25초라 기본 25초 틱에는 한 번도 빠듯하다(프로드 첫 4틱이 모두 20초 제한에 걸렸다); 번역은 별도 text 워커에서 돈다.
 */
export function jobRunOptions(name: string, options: RequestedRunOptions, settings: RuntimeSettings = runtimeSettings()): JobRunOptions {
  return settings.budgets[name] === undefined ? options : { ...options, budgetMs: effectiveJobBudgetMs(name, settings) };
}

/** 줄이 heartbeat 에 알리는 예산 — 감독의 job_timeout 이 env 하한과 이 예산 + 여유 중 큰 쪽으로 잰다(worker-progress runtimeLaneStall). 알리는 상한 1시간 */
function declaredBudgetMs(run: JobRunOptions): number {
  return Math.min(run.budgetMs ?? DEFAULT_JOB_BUDGET_MS, DECLARED_BUDGET_MAX_MS);
}

/**
 * 부팅 때 host 장부 자리를 지키는 시간 — 감독이 자식을 끊는 한도(가장 긴 틱 예산 + 여유, env 하한 중 큰 쪽)와 drain 까지.
 * 실시간 예산을 env 하한보다 크게 올려 두면 그만큼 더 지킨다(live-settings-plan §8 Q6). 부팅 뒤 더 올린 저장은 다음 재시작부터 반영된다.
 */
export function hostBudgetHoldMs(limits: { jobMs: number; drainMs: number }, names: readonly string[], settings: RuntimeSettings): number {
  const declared = Math.max(0, ...names.map(name => declaredBudgetMs(jobRunOptions(name, { requestedOnly: true }, settings)) + DECLARED_BUDGET_MARGIN_MS));
  return Math.max(limits.jobMs, declared) + limits.drainMs;
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
  // 배경 consumer(PR06c)가 맡은 job 은 기존 줄에서 빼고 job 마다 따로 도는 줄을 준다. 이 역할이 돌리는 job 이 아니면 시작하지 않는다
  const consumed = [...new Set(dependencies.consumer?.names ?? [])];
  if (consumed.some(name => !dependencies.names.includes(name))) throw new Error('invalid_background_consumer_jobs');
  const lanes = (dependencies.lanes ?? [dependencies.names]).map((names) => [...new Set(names)].filter(name => !consumed.includes(name)))
    .filter((names) => names.length > 0);
  const states = [...lanes, ...consumed.map(name => [name])].map((jobs): RuntimeLane => ({ name: jobs[0], jobs, state: 'idle', currentJob: null,
    startedAt: null, pollStartedAt: null, lastProgressAt: Date.now(), budgetMs: null }));
  const emit = () => {
    const snapshot = states.map(lane => ({ ...lane, jobs: [...lane.jobs] }));
    const running = states.filter((lane) => lane.state === 'running' && lane.currentJob !== null && lane.startedAt !== null)
      .sort((a, b) => a.startedAt! - b.startedAt!)[0];
    if (running) dependencies.report?.('running', running.currentJob, running.startedAt, snapshot);
    else dependencies.report?.(states.some((lane) => lane.state === 'polling') ? 'polling' : 'idle', null, null, snapshot);
  };
  const laneReport = (index: number): LaneReport => (state, currentJob = null, budgetMs = null) => {
    const now = Date.now();
    // 도는 잡의 틱 예산을 감독에게 알린다 — 줄이 틱 앞에 고정한 스냅샷에서 한 번 계산한 값이라 잡이 쓰는 예산과 같다(다시 계산하지 않는다)
    states[index] = { ...states[index], state, currentJob, startedAt: state === 'running' ? now : null,
      pollStartedAt: state === 'polling' ? now : null, lastProgressAt: now, budgetMs: state === 'running' && currentJob ? budgetMs : null };
    emit();
  };
  const results = await Promise.all([...lanes.map((names, index) => runLane(options, dependencies, names, intervalMs, laneReport(index))),
    ...consumed.map((name, index) => runConsumerLane(options, dependencies, dependencies.consumer!, name, intervalMs, laneReport(lanes.length + index)))]);
  return { ticks: results.reduce((sum, result) => sum + result.ticks, 0), failures: results.reduce((sum, result) => sum + result.failures, 0) };
}

/** 남은 일이 있다고 끝난 틱 뒤 다음 틱까지의 짧은 간격 — 일감 없이 done:false 를 내는 틱이 DB 를 쉬지 않고 두드리지 않게 */
const CONSUMER_REFILL_MS = 1_000;

/**
 * 배경 consumer 한 줄(PR06c). 기존 틱처럼 scheduler 의 다음 요청이나 같은 줄의 다른 job 을 기다리지 않고, 남은 일이 있으면 곧 다음 틱을 돈다.
 *
 * - 일감 권한은 기존 runJob 의 job lease 다(requestedOnly). 요청 없음·사람이 멈춤·재시도 유예·살아 있는 다른 주인의 잠금은 pending 이 거른다.
 * - 공통 모델 슬롯이 open 일 때만 잡는다. 틱 안의 공정 배분(first/second/background 가중치)은 DB 장부 하나가 맡는다.
 * - 빈 큐(done)·슬롯 미룸·실패·잠김에는 다시 요청하지 않고 기존 poll 간격으로 기다린다 — 빈 큐에서 모델을 부르지 않는다.
 * - 종료 신호를 받으면 새 틱을 시작하지 않고, 진행 중 틱은 runJob 이 lease 를 놓을 때까지 기다린다(다시 요청하지 않음).
 */
async function runConsumerLane(options: WorkerOptions, dependencies: WorkerDependencies, consumer: BackgroundConsumerLanes,
  name: string, intervalMs: number, report: LaneReport) {
  const halt = options.stopClaims ? AbortSignal.any([options.stopClaims, ...(options.signal ? [options.signal] : [])]) : options.signal;
  const readSettings = dependencies.settings ?? (() => ensureRuntimeSettings());
  let ticks = 0, failures = 0, streak = 0;
  while (!halt?.aborted) {
    ticks++;
    let refill = false, failed = false;
    report('polling');
    try {
      // 틱 앞에 실시간 한도 스냅샷을 한 번 받아 예산 계산과 잡 실행을 같은 판에 고정한다(D3). 던지지 않는다
      const snapshot = await readSettings();
      await dependencies.seen([name]);
      if ((await dependencies.pending()).includes(name) && !halt?.aborted && await consumer.open()) {
        // 회로가 열렸으면 틱(job claim)을 시작하지 않는다 — job 요청·cursor·항목 실패 수는 그대로 남고 다음 poll 에 다시 본다
        const circuit = consumer.circuits?.admit(name);
        const admission = circuit?.admitted === false ? null : dependencies.admit
          ? await dependencies.admit(name).catch(() => ({ admitted: false as const, reason: 'host_budget_unavailable' })) : null;
        if (circuit?.admitted === false || admission && !admission.admitted) {
          if (circuit?.admitted) circuit.done();
          const reason = circuit?.admitted === false ? circuit.reason : admission?.admitted === false ? admission.reason : null;
          dependencies.log?.('worker.job', { role: options.role, name, status: 'deferred', reason, consumer: true });
          await noteDeferred(dependencies, name, reason);
        } else {
          if (halt?.aborted) {
            if (circuit?.admitted) circuit.done();
            if (admission?.admitted) await admission.release().catch(() => {});
            break;
          }
          const run = jobRunOptions(name, { requestedOnly: true, signal: options.signal }, snapshot.settings);
          report('running', name, declaredBudgetMs(run));
          try {
            const tick = () => withRuntimeSettings(snapshot, () => consumer.run(name, run));
            const result = await (circuit ? withProviderOutcome(circuit.record, tick) : tick());
            if (result.status === 'failed') failures++;
            refill = result.status === 'completed' && result.done === false;
            dependencies.log?.('worker.job', { role: options.role, name, status: result.status, consumer: true });
          } catch (error) {
            failures++; failed = true;
            dependencies.log?.('worker.job', { role: options.role, name, status: 'failed', consumer: true, ...failureFields(error, ++streak) });
          } finally {
            circuit?.done();
            report('polling');
            if (admission?.admitted) await admission.release().catch(() => {});
          }
        }
      }
      refill &&= !options.once && !halt?.aborted;
      if (refill) await consumer.request(name);
    } catch (error) {
      refill = false;
      failures++; failed = true;
      dependencies.log?.('worker.poll_failed', { role: options.role, name, consumer: true, ...failureFields(error, ++streak) });
    }
    if (!failed) streak = 0;
    report('idle');
    if (options.once || halt?.aborted) break;
    await (dependencies.sleep ?? interruptibleSleep)(refill ? CONSUMER_REFILL_MS : intervalMs, halt);
  }
  return { ticks, failures };
}

async function runLane(options: WorkerOptions, dependencies: WorkerDependencies, names: string[], intervalMs: number, report: LaneReport) {
  const halt = options.stopClaims ? AbortSignal.any([options.stopClaims, ...(options.signal ? [options.signal] : [])]) : options.signal;
  const readSettings = dependencies.settings ?? (() => ensureRuntimeSettings());
  let ticks = 0, failures = 0, nextIndex = 0, streak = 0;
  const sourceLane = names.length === 1 && ((options.role === "crawler" && names[0] === "product-evidence-refresh")
    || (options.role === "site-evidence" && names[0] === "product-site-evidence-refresh"));
  while (!halt?.aborted) {
    ticks++;
    let sourceContinued = false, stageRefill = false, failed = false;
    report('polling');
    try {
      // 틱 앞에 실시간 한도 스냅샷을 한 번 받는다(30초 TTL, 던지지 않음). 이 poll 의 모든 잡은 이 판으로 예산을 계산하고 그 판에 고정되어 돈다(D3)
      const snapshot = await readSettings();
      await dependencies.seen(names);
      const pending = new Set(await dependencies.pending());
      // Visit each role-owned job at most once per poll. Never run names from another role.
      const ordered = [...names.slice(nextIndex), ...names.slice(0, nextIndex)];
      for (const name of ordered) {
        if (halt?.aborted) break;
        if (!pending.has(name)) continue;
        // 한도를 넘으면 claim 전에 미룬다 — 잡 요청·cursor·attempt 는 그대로 남고 다음 틱에 다시 본다
        const admission = dependencies.admit
          ? await dependencies.admit(name).catch(() => ({ admitted: false as const, reason: 'host_budget_unavailable' })) : null;
        if (admission && !admission.admitted) {
          dependencies.log?.('worker.job', { role: options.role, name, status: 'deferred', reason: admission.reason });
          await noteDeferred(dependencies, name, admission.reason);
          continue;
        }
        if (halt?.aborted) {
          if (admission?.admitted) await admission.release().catch(() => {});
          break;
        }
        // 예산은 여기서 한 번만 계산한다 — heartbeat 에 알리는 값과 runner 가 받는 budgetMs 가 같은 스냅샷에서 나온다
        const run = jobRunOptions(name, { requestedOnly: true, signal: options.signal }, snapshot.settings);
        report('running', name, declaredBudgetMs(run));
        try {
          const result = await withRuntimeSettings(snapshot, () => dependencies.run(name, run));
          if (result.status === 'failed') failures++;
          if (sourceLane && result.status === 'completed' && result.done === false && result.sourceContinuation === true) {
            sourceContinued = true;
          }
          // AI2 가 item 모드면 이 잡은 AI2 행 올리기·닫기만 하고 stage_blocked 로 끝난다(요청은 그대로 남는다).
          // AI1 consumer 가 쓴 승인이 다음 틱을 기다리지 않도록 줄을 짧게 다시 돈다.
          if (name === 'second-review' && result.status === 'deferred' && result.reason === 'stage_blocked') stageRefill = true;
          // 제작 근거 스캔이 남은 일을 알리면 runner 가 다시 요청해 두었다 — 1초 뒤 다시 돈다(요청이 없으면 그 poll 은 그냥 지나간다)
          if (name === 'agent-evidence-refresh' && result.status === 'completed' && result.done === false) stageRefill = true;
          // AI1 전용 줄(ai1): 남은 후보가 있어 runner 가 다시 요청해 두었으면 1초 뒤 다시 돈다 — 기본 5초 쉼이 틱 사이 물리 슬롯을 놀리고,
          // 줄에 남긴 예약이 TTL(30초) 안에 다음 틱을 만나게 한다. 미룬(model_capacity) 틱은 기존 간격 그대로다
          if (name === 'crawl-agent-review' && result.status === 'completed' && result.done === false) stageRefill = true;
          dependencies.log?.('worker.job', { role: options.role, name, status: result.status });
        } catch (error) {
          failures++; failed = true;
          dependencies.log?.('worker.job', { role: options.role, name, status: 'failed', ...failureFields(error, ++streak) });
        } finally {
          nextIndex = (names.indexOf(name) + 1) % names.length;
          report('polling');
          if (admission?.admitted) await admission.release().catch(() => {});
        }
      }
    } catch (error) {
      failures++; failed = true;
      dependencies.log?.('worker.poll_failed', { role: options.role, ...failureFields(error, ++streak) });
    }
    if (!failed) streak = 0;
    report('idle');
    if (options.once || halt?.aborted) break;
    if (sourceContinued) continue;
    await (dependencies.sleep ?? interruptibleSleep)(stageRefill ? CONSUMER_REFILL_MS : intervalMs, halt);
  }
  return { ticks, failures };
}

/** Shared CLI lifecycle. A supervisor can distinguish event-loop liveness from job progress. */
export async function withRuntimeProcess<T>(
  role: string,
  execute: (signal: AbortSignal, report: RuntimeReport, stopClaims: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const claims = new AbortController();
  let current: Omit<RuntimeHeartbeat, 'at'> = {
    type: 'runtime.heartbeat', role, pid: process.pid, state: 'idle',
    currentJob: null, startedAt: null, lastProgressAt: Date.now(),
  };
  const heartbeat = () => {
    if (process.connected && process.send) {
      // The parent can disconnect during shutdown. IPC failure must not interrupt a DB write.
      try { process.send({ ...current, at: Date.now(), settings: lastSettingsRead(), runtimeSettings: lastRuntimeSettingsRead() }, () => {}); } catch { /* disconnected */ }
    }
  };
  const report: RuntimeReport = (state, currentJob = null, startedAt = null, lanes) => {
    const now = Date.now();
    current = {
      ...current, state: controller.signal.aborted || claims.signal.aborted ? 'stopping' : state,
      currentJob, startedAt: state === 'running' ? startedAt ?? now : null, lastProgressAt: now,
      ...(lanes ? { lanes } : {}),
    };
    heartbeat();
  };
  const shutdown = () => {
    claims.abort();
    controller.abort();
    current = { ...current, state: 'stopping' };
    heartbeat();
  };
  const drain = (message: unknown) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        Object.keys(message).length !== 1 || (message as { type?: unknown }).type !== 'runtime.drain') return;
    claims.abort();
    current = { ...current, state: 'stopping' };
    heartbeat();
  };
  process.on('message', drain);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const timer = setInterval(heartbeat, 5_000);
  timer.unref();
  heartbeat();
  try {
    // CLI 계약은 이 probe 를 마친 프로세스에서만 열린다(D7) — reviewer 만 CLI 모델을 부른다
    if (role === 'reviewer') for (const status of await probeCliServingContracts()) runtimeLog('cli_contract.probe', status);
    return await execute(controller.signal, report, claims.signal);
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
      process.removeListener('message', drain);
      if (process.connected) process.disconnect?.();
    }
  }
}

export function parseWorkerArgs(args: string[]) {
  const roleArg = args.find(arg => arg.startsWith('--role='));
  const role = roleArg?.slice('--role='.length);
  const roles: readonly string[] = BATCH_ROLES;
  if (!role || !roles.includes(role) || args.filter(arg => arg.startsWith('--role=')).length !== 1) {
    throw new Error('Usage: worker.ts --role=crawler|reviewer|publisher|text|maintenance [--once] [--interval-seconds=1..60]');
  }
  return { ...parseLoopArgs(args.filter(arg => arg !== roleArg), 5), role: role as BatchRole };
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
  assertHostDbEntry(process.env, { kind: 'worker', role: options.role });
  // Engines addressed by Tailscale names (admin engine connections) resolve inside containers too.
  installTailnetDns();
  await withRuntimeProcess(options.role, async (signal, report, stopClaims) => {
    const [{ jobsForRole }, { pendingJobNames, markWorkerSeen }, { JOBS }, { runJob }, { roleLeaseFromEnv }, { startHostBudget }, { supervisorLimits },
      { backgroundConsumerJobs, backgroundConsumerLanes }, { recordJobDeferral }] = await Promise.all([
      import('@/lib/jobs/catalog'), import('@/lib/jobs/control'), import('@/lib/jobs/registry'),
      import('@/lib/jobs/runner'), import('@/lib/jobs/role-leader'), import('@/lib/operations/host-budget-runtime'), import('./worker-supervisor'),
      import('@/lib/jobs/background-consumer'), import('@/lib/jobs/deferral-observation'),
    ]);
    const roleLease = roleLeaseFromEnv(options.role, process.env);
    // 기본 비활성. 배경 dispatch 는 역할 lease 에 묶이므로 선출된 역할 워커에서만 켠다
    const consumed = backgroundConsumerJobs(options.role, process.env);
    if (consumed.length && !roleLease) throw new Error('background_consumer_role_lease_required');
    // provider 회로는 배경 consumer 줄에만 건다(기존 틱 줄은 그대로). consumer 가 꺼져 있으면 설정을 읽지 않는다
    const circuit = consumed.length ? providerCircuitConfig(process.env) : { mode: 'disabled' as const };
    const names = roleLease?.batchVersion === 1 ? batchJobsForRole(options.role, "versioned") : jobsForRole(options.role as import("@/lib/jobs/catalog").JobRole);
    // 감독이 이 잡을 끊는 한도(가장 긴 틱 예산 + 여유 ↔ env 하한, + drain)까지 번역 slot 을 지킨다 — 부팅 때 읽은 실시간 한도 판으로 잰다(Q6)
    const limits = supervisorLimits(options.role, process.env);
    const host = startHostBudget(process.env, { holdMs: hostBudgetHoldMs(limits, names, (await ensureRuntimeSettings(0)).settings) });
    try {
      if (host.enabled) await host.settled;
      const result = await runWorker({ ...options, signal, stopClaims }, {
        names,
        lanes: batchLanesForRole(options.role, roleLease?.batchVersion === 1 ? 'versioned' : 'legacy'),
        pending: () => pendingJobNames(options.role),
        seen: markWorkerSeen,
        // 미룸(defer:<job>)·수집기 회차 누적(job-tally:<job>) 관측은 워커만 남긴다. budgetMs 는 줄이 고정한 스냅샷으로 넣어 준다(runOptions)
        run: (name, runOptions) => runJob(name, JOBS[name], { ...runOptions, roleLease,
          onDeferred: reason => recordJobDeferral(name, reason), tally: true }),
        ...(consumed.length ? { consumer: { ...backgroundConsumerLanes(consumed,
          (name, runOptions) => runJob(name, JOBS[name], { ...runOptions, roleLease,
            onDeferred: reason => recordJobDeferral(name, reason), tally: true })),
          ...(circuit.mode === 'enabled' ? { circuits: createProviderCircuits(circuit) } : {}) } } : {}),
        ...(host.enabled ? { admit: host.admit } : {}),
        report, log: runtimeLog, deferred: recordJobDeferral,
      });
      runtimeLog('worker.stopped', { role: options.role, ...result });
      if (options.once && result.failures) process.exitCode = 1;
    } finally { await host.stop(); }
  });
}

if (process.argv[1] && /^worker\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(error => {
    console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'worker failed; check role/database/environment configuration');
    process.exitCode = 1;
  });
}
