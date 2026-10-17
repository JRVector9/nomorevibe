import { assertHostDbEntry, hostDbChildEnvironment } from '@/lib/db/host-budget';
import { currentHostBudget, startHostBudget, waitForHostBudget } from '@/lib/operations/host-budget-runtime';
/** Container PID 1's child supervisor: a healthy event loop is not proof of job progress. */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { observeService } from '../lib/operations/observations';
import { networkRoutesField } from '../lib/db/network-route';
import { consumerHealthPath, supervisorHealthPath } from './consumer-health';
export { consumerHealthPath, supervisorHealthPath, DEFAULT_HEALTH_PATH } from './consumer-health';
import type { RuntimeHeartbeat } from './worker';
import { parseRuntimeLanes, runtimeLaneStall, type RuntimeLane } from '../lib/operations/worker-progress';

import type { BatchRole } from '../lib/jobs/batches';
import type { ProcessGroupRecorder, ProcessOwner } from '../lib/operations/dr/repository';
import { processGroupOwnerEnvironment } from '../lib/operations/dr/process-owner-env';
export type RuntimeRole = 'scheduler' | BatchRole;
export type SupervisorLimits = { heartbeatMs: number; progressMs: number; jobMs: number; drainMs: number };
export type WorkerHealth = {
  role: RuntimeRole; pid: number; childPid: number | null;
  updatedAt: number; lastHeartbeatAt: number; lastProgressAt: number;
  state: RuntimeHeartbeat['state']; currentJob: string | null; jobStartedAt: number | null;
  status: 'starting' | 'running' | 'stopping' | 'failed'; reason?: string;
  /** 일하는 프로세스가 마지막으로 읽은 크롤 설정 판·시각 — 관측(service:<역할>)에 실려 설정 화면이 견준다 */
  settingsVersion?: string | null; settingsReadAt?: number | null;
  lanes?: RuntimeLane[];
  laneLimits?: Pick<SupervisorLimits, 'progressMs' | 'jobMs'>;
};
const JOB_LIMIT_MS: Record<RuntimeRole, number> = {
  translation:180_000, 'product-health':600_000, 'site-evidence':180_000, 'official-news':600_000,
  scheduler: 120_000, crawler: 180_000, reviewer: 180_000, publisher: 180_000, text: 180_000, maintenance: 600_000,
};

export function supervisorLimits(role: RuntimeRole, env: Readonly<Record<string, string | undefined>> = process.env): SupervisorLimits {
  const seconds = (name: string, fallback: number, minimum: number) => {
    const value = env[name] ? Number(env[name]) : fallback / 1_000;
    if (!Number.isSafeInteger(value) || value < minimum || value > 3_600) throw new Error(`Invalid ${name}`);
    return value * 1_000;
  };
  return {
    heartbeatMs: seconds('WORKER_HEARTBEAT_TIMEOUT_SECONDS', 30_000, 15),
    progressMs: seconds('WORKER_PROGRESS_TIMEOUT_SECONDS', 90_000, 65),
    jobMs: seconds('WORKER_JOB_TIMEOUT_SECONDS', JOB_LIMIT_MS[role], 60),
    drainMs: seconds('WORKER_DRAIN_SECONDS', 45_000, 5),
  };
}

export function stalledReason(health: WorkerHealth, now: number, limits: SupervisorLimits): string | null {
  if (health.status === 'stopping' || health.status === 'failed') return null;
  if (now - health.lastHeartbeatAt > limits.heartbeatMs) return 'heartbeat_timeout';
  if (health.lanes?.length) {
    for (const lane of health.lanes) {
      const reason = runtimeLaneStall(lane, now, limits);
      if (reason) return reason;
    }
    return null;
  }
  if (health.currentJob !== null && health.jobStartedAt !== null) {
    if (now - health.jobStartedAt > limits.jobMs) return 'job_timeout';
  } else if (now - health.lastProgressAt > limits.progressMs) return 'progress_timeout';
  return null;
}

export function isRuntimeHeartbeat(value: unknown, role: RuntimeRole, pid: number): value is RuntimeHeartbeat {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<RuntimeHeartbeat>;
  return v.type === 'runtime.heartbeat' && v.role === role && v.pid === pid &&
    ['idle', 'polling', 'running', 'stopping'].includes(v.state ?? '') &&
    Number.isFinite(v.at) && Number.isFinite(v.lastProgressAt) &&
    (v.currentJob === null || typeof v.currentJob === 'string') &&
    (v.startedAt === null || Number.isFinite(v.startedAt)) &&
    (v.state !== 'running' || (typeof v.currentJob === 'string' && typeof v.startedAt === 'number')) &&
    (v.lanes === undefined || parseRuntimeLanes(v.lanes, role) !== null);
}

/** heartbeat 의 설정 판을 건강 기록으로. 옛 워커(싣지 않음)나 모양이 틀린 값은 건너뛴다 — 지난 판을 지우지 않는다 */
export function settingsFromHeartbeat(value: RuntimeHeartbeat): Pick<WorkerHealth, 'settingsVersion' | 'settingsReadAt'> {
  const settings = value.settings;
  if (typeof settings?.version !== 'string' || !Number.isFinite(settings.at)) return {};
  return { settingsVersion: settings.version.slice(0, 64), settingsReadAt: settings.at };
}

function writeHealth(path: string, health: WorkerHealth) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(health), { mode: 0o600 });
  renameSync(temporary, path);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
/** D11 기록이 DB 대기로 슈퍼바이저 종료·spawn 판단을 붙잡지 않게 한다. 늦게 commit 된 기록도 사실(의도·관측한 종료)만 담는다. */
const PROCESS_GROUP_RECORD_MS = 10_000;
function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('process_group_record_timeout')), PROCESS_GROUP_RECORD_MS); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}
function groupExists(child: ChildProcess) {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function childExitCode(current: number, code: number | null, state: {
  stopping: boolean; requested: boolean; everHeartbeat: boolean; once: boolean;
}): number {
  if (!state.stopping) return state.once && code === 0 ? 0 : 1;
  if (current !== 0) return current;
  if (code === 0 || (state.requested && !state.everHeartbeat)) return 0;
  return 1;
}

/** No internal respawn: exiting lets the container restart policy recreate the whole process tree. */
export function supervisorCommand(role: RuntimeRole, options: { once?: boolean; consumer?: 'ai1' | 'ai2' } = {}): string[] {
  if (options.consumer !== undefined && (!['ai1', 'ai2'].includes(options.consumer) || role !== 'reviewer')) throw new Error('invalid_item_consumer_role');
  const command = options.consumer === 'ai1' ? ['scripts/pipeline-first-consumer.ts'] : options.consumer === 'ai2' ? ['scripts/pipeline-consumer.ts', '--stage=ai2']
    : role === 'scheduler' ? ['scripts/scheduler.ts'] : ['scripts/worker.ts', `--role=${role}`];
  if (options.once) command.push('--once');
  return command;
}

export async function superviseWorker(role: RuntimeRole, options: {
  once?: boolean; healthPath?: string; limits?: SupervisorLimits;
  signal?: AbortSignal; closeDbOnExit?: boolean; consumer?: 'ai1' | 'ai2';
  /** D11: role-worker boot 의 프로세스 그룹 근거 기록기. 없으면(직접 실행·scheduler·consumer) 기존 순서 그대로다. */
  processGroup?: ProcessGroupRecorder;
} = {}): Promise<number> {
  assertHostDbEntry(process.env, { kind: role === 'scheduler' ? 'scheduler-parent' : 'role-parent', role,
    ...(options.consumer !== undefined ? { consumer: options.consumer } : {}) });
  const limits = options.limits ?? supervisorLimits(role);
  const healthPath = supervisorHealthPath(options);
  const consumerPath = options.consumer !== undefined ? consumerHealthPath() : null;
  if (consumerPath && resolve(healthPath) !== resolve(consumerPath)) throw new Error('invalid_item_consumer_health_path');
  const command = supervisorCommand(role, options);
  // AI1/AI2 consumer 감독도 같은 장부 자리(role-parent:reviewer:<consumer>)를 얻는다 — 자식 consumer 는 자기 worker 자리로 item 마다 admit 한다(PR06e)
  const sharedHost = currentHostBudget(), host = sharedHost ?? startHostBudget(process.env);
  // host 장부 자리를 얻기 전에는 자식(DB pool·일감)을 띄우지 않는다. 비활성은 기다림 없이 기존 순서 그대로다
  if (host.enabled && !host.ready()) {
    console.log(JSON.stringify({ event: 'supervisor.host_budget_wait', role, at: new Date().toISOString() }));
    const waiting = new AbortController(), cancel = () => waiting.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (!await waitForHostBudget(host, waiting.signal)) { if (!sharedHost) await host.stop(); return 0; }
    } finally {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  // D11: spawn 전에 의도를 commit 한다. 기록하지 못하면 spawn 하지 않는다(fail closed) — 의도 없는 child 가 장부 행을 dispatch 하면
  // 그 행이 '가능한 모든 child 가 끝났다'는 근거로 잘못 회수될 수 있기 때문이다. 그룹 종료 증명은 kill(-pgid) 가 있는 플랫폼에서만 쓴다.
  const group = process.platform === 'win32' ? undefined : options.processGroup;
  const spawnRecord = group ? await bounded(group.intent()).catch(() => null) : undefined;
  if (group && !spawnRecord) {
    console.log(JSON.stringify({ event: 'supervisor.spawn_intent_failed', role, at: new Date().toISOString() }));
    if (!sharedHost) await host.stop();
    return 1;
  }
  const child = spawn(process.execPath, ['--import', 'tsx', ...command], {
    // D11: 기록한 owner 를 child env 로만 넘긴다 — child 의 장부 행·HTTP hop 이 이 그룹 근거와 같은 owner 가 된다.
    cwd: resolve('.'), env: { ...hostDbChildEnvironment(process.env, role, options.consumer), ...(group?.owner ? processGroupOwnerEnvironment(group.owner) : {}) },
    detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  // spawned 기록 실패는 child 를 멈추지 않는다(가용성). 그 경우 이 child 의 종료는 기록하지 않으므로 이후 행은 D11 로 회수되지 않는다.
  const spawned = group && spawnRecord && child.pid ? bounded(group.spawned(spawnRecord, child.pid)).then(() => true, () => {
    console.log(JSON.stringify({ event: 'supervisor.process_group_spawn_unrecorded', role, at: new Date().toISOString() })); return false; })
    : Promise.resolve(false);
  const started = Date.now();
  const bootId = randomUUID();
  let lastObserved = 0, observationPending = false;
  let health: WorkerHealth = {
    role, pid: process.pid, childPid: child.pid ?? null, updatedAt: started,
    lastHeartbeatAt: started, lastProgressAt: started, state: 'idle', currentJob: null,
    jobStartedAt: null, status: 'starting',
    laneLimits: { progressMs: limits.progressMs, jobMs: limits.jobMs },
  };
  return await new Promise<number>(resolveResult => {
    let exitCode = 1, stopping = false, finishing = false, requestedStop = false, everHeartbeat = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const log = (event: string, fields: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event, role, at: new Date().toISOString(), ...fields }));
    const publish = () => {
      if (!observationPending && Date.now() - lastObserved >= 15_000) {
        lastObserved = Date.now(); observationPending = true;
        void observeService(role, { ...health, bootId, bootedAt: started, release: process.env.RELEASE_TAG ?? "unknown", supervisorRssBytes: process.memoryUsage().rss, ...networkRoutesField() })
          .catch(() => {}).finally(() => { observationPending = false; });
      }
      health.updatedAt = Date.now();
      try { writeHealth(healthPath, health); }
      catch { stop('health_write_failed', false); }
    };
    const stop = (reason: string, requested: boolean) => {
      if (stopping || finishing) return;
      stopping = true;
      requestedStop = requested;
      exitCode = requested ? 0 : 1;
      health = { ...health, status: 'stopping', reason };
      log('supervisor.stopping', { reason });
      // Let the worker abort and drain first. Signalling its whole group here also kills
      // tsx/esbuild during startup and turns a requested graceful shutdown into a failure.
      // The deadline and final cleanup still SIGKILL the entire group, including CLI children.
      child.kill('SIGTERM');
      drainTimer = setTimeout(() => {
        log('supervisor.force_stop', { reason });
        exitCode = 1;
        signalGroup(child, 'SIGKILL');
      }, limits.drainMs);
    };
    const onSignal = () => stop('shutdown_requested', true);
    const onAbort = () => stop(options.signal?.reason === 'shutdown_requested'
      ? 'shutdown_requested' : options.signal?.reason === 'progress_stalled'
        ? 'progress_stalled' : 'role_lease_lost', true);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const monitor = setInterval(() => {
      const reason = stalledReason(health, Date.now(), limits);
      if (reason) stop(reason, false);
      publish();
    }, 5_000);
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      clearInterval(monitor);
      if (drainTimer) clearTimeout(drainTimer);
      // A worker can exit while a CLI grandchild remains. Kill and observe its entire group.
      signalGroup(child, 'SIGKILL');
      const deadline = Date.now() + 5_000;
      while (groupExists(child) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (groupExists(child)) { exitCode = 1; log('supervisor.group_cleanup_incomplete'); }
      // D11: 그룹 SIGKILL 뒤 ESRCH 를 직접 본 경우에만 종료를 기록한다. 기록기도 같은 TX 안에서 다시 ESRCH 를 확인한다.
      else if (group && spawnRecord && child.pid && await spawned) {
        await bounded(group.exited(spawnRecord, child.pid)).catch(() => log('supervisor.process_group_exit_unrecorded'));
      }
      health = { ...health, status: exitCode === 0 ? 'stopping' : 'failed', updatedAt: Date.now() };
      try { writeHealth(healthPath, health); } catch { exitCode = 1; }
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      options.signal?.removeEventListener('abort', onAbort);
      log('supervisor.stopped', { exitCode });
      if (!sharedHost) await host.stop();
      const client=(globalThis as unknown as {pgClient?:{end:(options:{timeout:number})=>Promise<void>}}).pgClient;
      if(options.closeDbOnExit !== false && client)await client.end({timeout:1}).catch(()=>{});
      resolveResult(exitCode);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    child.on('message', value => {
      if (!child.pid || !isRuntimeHeartbeat(value, role, child.pid)) return;
      everHeartbeat = true;
      health = {
        ...health, lastHeartbeatAt: Date.now(), lastProgressAt: value.lastProgressAt,
        state: value.state, currentJob: value.currentJob, jobStartedAt: value.startedAt,
        status: stopping ? 'stopping' : 'running',
        ...settingsFromHeartbeat(value),
        ...(value.lanes ? { lanes: parseRuntimeLanes(value.lanes, role)! } : {}),
      };
      publish();
    });
    child.once('error', () => { exitCode = 1; health.reason = 'child_spawn_failed'; void finish(); });
    child.once('exit', code => {
      exitCode = childExitCode(exitCode, code, {
        stopping, requested: requestedStop, everHeartbeat, once: options.once ?? false,
      });
      void finish();
    });
    publish();
  });
}

/** D11(PR15d): 켜진 AI1/AI2 consumer child 는 item owner(consumer instance, 이 boot)로 장부 행을 만든다. 그 owner 로 spawn 의도·종료를 남긴다.
 * 기본 비활성 consumer·scheduler·직접 실행은 기록하지 않는다(DB 를 건드리지 않고 기존 순서 그대로). */
export function consumerProcessOwner(consumer: 'ai1' | 'ai2' | undefined, env: Readonly<Record<string, string | undefined>>): ProcessOwner | null {
  if (consumer === undefined || env.PIPELINE_ITEM_CONSUMER_VERSION !== '1') return null;
  const owner = { instanceId: env.PIPELINE_ITEM_CONSUMER_INSTANCE_ID ?? '', bootId: randomUUID() };
  processGroupOwnerEnvironment(owner); // 모양이 틀린 instance 는 기록 전에 거절한다(child 도 같은 값으로는 시작하지 못한다)
  return owner;
}

async function main() {
  const args = process.argv.slice(2);
  const role = args.find(arg => arg.startsWith('--role='))?.slice(7) as RuntimeRole;
  const consumer = args.includes('--consumer=ai1') ? 'ai1' : args.includes('--consumer=ai2') ? 'ai2' : undefined;
  if (!Object.hasOwn(JOB_LIMIT_MS, role) ||
      args.filter(arg => arg.startsWith('--role=')).length !== 1 ||
      args.filter(arg => arg.startsWith('--consumer=')).length > 1 || consumer && role !== 'reviewer' ||
      args.some(arg => arg !== '--once' && arg !== `--role=${role}` && arg !== '--consumer=ai2' && arg !== '--consumer=ai1')) {
    throw new Error('Usage: worker-supervisor.ts --role=scheduler|crawler|reviewer|publisher|text|maintenance [--once]');
  }
  const owner = consumerProcessOwner(consumer, process.env);
  const processGroup = owner ? (await import('../lib/operations/dr/repository')).processGroupRecorder(owner) : undefined;
  process.exitCode = await superviseWorker(role, { once: args.includes('--once'), consumer, ...(processGroup ? { processGroup } : {}) });
}
if (process.argv[1] && /^worker-supervisor\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => { console.error('worker supervisor failed; check role/environment configuration'); process.exitCode = 1; });
}
