import { assertHostDbEntry } from '@/lib/db/host-budget';
/** Primary/standby candidate. Only the elected process starts the existing supervisor. */
import { BATCH_ROLES, BATCH_HOSTS, type BatchHost } from '@/lib/jobs/batches';
import { randomUUID } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { interruptibleSleep, runtimeLog } from './worker';
import { superviseWorker } from './worker-supervisor';
import { readRoleLockHolders, releaseRole, renewRole, tryAcquireRole, type RoleCandidate, type RoleLease } from '@/lib/jobs/role-leader';
import { batchLeaseAdmission } from '@/lib/jobs/batch-repository';
import { dbErrorFields } from '@/lib/db/error-fields';
import { observe } from '@/lib/operations/observations';
import { serviceInstanceId } from '@/lib/operations/instance';
import { readWorkerProgress } from '@/lib/operations/worker-progress-query';
import { maintenanceUptimeStalled, readMaintenanceUptimeProgress } from '@/lib/operations/maintenance-progress';
import { readTextProgress, textProgressStalled } from '@/lib/operations/text-progress';
import { hasActiveRoleJob } from '@/lib/jobs/control';
import { laneForJob } from '@/lib/operations/worker-progress';
import { DEFAULT_ROLE_HEALTH_PATH, ROLE_STUCK_UNHEALTHY_MS } from './role-health';
import { startHostBudget } from '@/lib/operations/host-budget-runtime';
import { emergencyTakeoverGate } from '@/lib/operations/emergency-admission-runtime';
import { processGroupRecorder, type ProcessGroupRecorder, type ProcessOwner } from '@/lib/operations/dr/repository';
import { readProcessAttestation, successorProbeEnabled, type ProcessAttestation } from '@/lib/operations/dr/process-attestation';
import { processGroupRecordingEnabled } from '@/lib/operations/dr/process-owner-env';

type Dependencies = {
  acquire: typeof tryAcquireRole;
  renew: typeof renewRole;
  release?: typeof releaseRole;
  supervise: (lease: RoleLease, signal: AbortSignal) => Promise<number>;
  sleep?: typeof interruptibleSleep;
  checkProgress?: (role: RoleCandidate['role']) => Promise<boolean>;
  report?: (phase: 'standby' | 'active' | 'stopping', epoch: number | null) => void;
  /** versioned lease 의 claim 관문 readiness. null 이면 판정 대상 아님(draining·epoch 바뀜 — 갱신이 따로 본다) */
  checkAdmission?: (lease: RoleLease) => Promise<{ ready: boolean; reason: string } | null>;
  /** DB 실패 연속·끝나지 않은 호출·claim 막힘 — role health 파일이 싣고 healthcheck 가 한도를 본다 */
  health?: (state: RoleRuntimeHealth) => void;
  /** lock 오류(55P03·40P01) 뒤 실패 연속마다 한 번 읽는 진단 */
  lockBlockers?: () => Promise<unknown>;
};
export type RoleRuntimeHealth = { dbFailingSince: number | null; dbFailures: number; dbPendingSince: number | null;
  admissionBlockedSince: number | null; admissionReason: string | null };
/** 선출된 versioned 역할의 claim 관문이 이만큼 계속 막히면 child 를 멈추고 lease 를 놓아 다른 host 가 선출될 수 있게 한다.
 * stale 결과(24시간)·만료 capability(15분)는 운영자 recanary/refresh 전에는 스스로 풀리지 않는다. 2분은 15초 표본 여러 번이라 attest 가 증거를 바꾸는 순간 같은 일시 상태로는 놓지 않는다. */
export const BATCH_ADMISSION_RELEASE_MS = 2 * 60_000;
const LOCK_ERRORS = new Set(['55P03', '40P01']);

export function roleHasUnexplainedStall(report: {
  scheduler: { reason: string };
  stages: Array<{ role: string; reason: string; lane?: string; job?: string; restartEligible?: boolean }>;
  lanes?: Array<{ role: string; reason: string | null; restartEligible: boolean }>;
  activeJobs?: string[];
}, role: RoleCandidate['role'], activeJobs: string[] = report.activeJobs ?? []): boolean {
  if (report.lanes?.some(lane => lane.role === role && lane.restartEligible)) return true;
  if (report.scheduler.reason !== 'scheduled') return false;
  const stages = report.stages.filter(stage => stage.role === role);
  return stages.some(stage => {
    if (stage.reason !== 'no_progress' || stage.restartEligible === false) return false;
    const siblings = stages.filter(other => other.lane === stage.lane);
    const activeInLane = activeJobs.some(job => siblings.some(other => other.job === job) ||
      (stage.lane !== undefined && laneForJob(role, job) === stage.lane));
    return !activeInLane && !siblings.some(other => ['progressing', 'running', 'upstream_or_job_error', 'upstream_stalled', 'backoff', 'paused'].includes(other.reason));
  });
}

export function parseRoleWorkerArgs(args: string[], env: Readonly<Record<string, string | undefined>> = process.env): RoleCandidate {
  const role = args.find(arg => arg.startsWith('--role='))?.slice(7);
  const kind = args.find(arg => arg.startsWith('--kind='))?.slice(7);
  const instanceId = serviceInstanceId(env);
  const batch = env.JOB_BATCH_VERSION;
  const host = env.PHYSICAL_HOST;
  if (!BATCH_ROLES.includes(role as RoleCandidate['role']) || (batch !== undefined && (batch !== '1' || !BATCH_HOSTS.includes(host as BatchHost))) ||
      (!batch && ['translation','product-health','site-evidence','official-news'].includes(role ?? '')) || (kind !== 'primary' && kind !== 'standby') ||
      args.length !== 2 || !instanceId || !env.RELEASE_TAG || env.RELEASE_TAG.length > 120) {
    throw new Error('Usage: role-worker.ts --role=crawler|reviewer|publisher|maintenance|text --kind=primary|standby; SERVICE_INSTANCE_ID and RELEASE_TAG required');
  }
  return { ...(batch ? {batchVersion:1 as const,host:host as BatchHost} : {}), role:role as RoleCandidate['role'], kind, instanceId, release: env.RELEASE_TAG, bootId: randomUUID() };
}

export function roleCandidateObservationKey(candidate: RoleCandidate): string {
  return `candidate:${candidate.role}:${candidate.instanceId}`;
}

/** A failed/uncertain renewal aborts the active child; the next election uses a new DB decision. */
export async function runRoleCandidate(candidate: RoleCandidate, signal: AbortSignal, deps: Dependencies): Promise<number> {
  const sleep = deps.sleep ?? interruptibleSleep;
  // 선출·갱신의 DB 실패(throw) 연속. 다른 owner 가 lease 를 쥐어 받은 null·false 는 성공이다(정상 standby).
  const health: RoleRuntimeHealth = { dbFailingSince: null, dbFailures: 0, dbPendingSince: null, admissionBlockedSince: null, admissionReason: null };
  let blockersLogged = false;
  const publish = () => deps.health?.({ ...health });
  const pending = () => { health.dbPendingSince = Date.now(); publish(); };
  const succeeded = () => { health.dbPendingSince = null; health.dbFailingSince = null; health.dbFailures = 0; blockersLogged = false; publish(); };
  const failed = (event: string, error: unknown, fields: Record<string, unknown> = {}) => {
    const now = Date.now(), detail = dbErrorFields(error);
    health.dbPendingSince = null; health.dbFailingSince ??= now; health.dbFailures++; publish();
    runtimeLog(event, { role: candidate.role, instanceId: candidate.instanceId, ...fields, code: detail.code, errorName: detail.name,
      message: detail.message, failures: health.dbFailures, failingForMs: now - health.dbFailingSince });
    if (!deps.lockBlockers || blockersLogged || !LOCK_ERRORS.has(detail.code ?? '')) return;
    blockersLogged = true;
    void deps.lockBlockers().then(holders => runtimeLog('role.lock_blockers', { role: candidate.role, holders }), blockerError => {
      const blocker = dbErrorFields(blockerError);
      runtimeLog('role.lock_blockers_unknown', { role: candidate.role, code: blocker.code, errorName: blocker.name, message: blocker.message });
    });
  };
  while (!signal.aborted) {
    let lease: RoleLease | null = null;
    pending();
    try { lease = await deps.acquire(candidate); succeeded(); }
    catch (error) { failed('role.acquire_unknown', error); }
    if (!lease) {
      // 스스로 회복하지 못한 boot 는 깨끗이 끝낸다 — 재시작 정책이 새 프로세스·새 DB pool 로 다시 띄운다.
      if (health.dbFailingSince !== null && Date.now() - health.dbFailingSince >= ROLE_STUCK_UNHEALTHY_MS) {
        runtimeLog('role.db_unavailable_exit', { role: candidate.role, instanceId: candidate.instanceId,
          failures: health.dbFailures, failingForMs: Date.now() - health.dbFailingSince });
        return 1;
      }
      deps.report?.('standby', null);
      await sleep(5_000, signal);
      continue;
    }
    runtimeLog('role.acquired', { role: candidate.role, kind: candidate.kind,
      instanceId: candidate.instanceId, epoch: lease.epoch });
    deps.report?.('active', lease.epoch);
    const active = new AbortController();
    const onStop = () => active.abort('shutdown_requested');
    signal.addEventListener('abort', onStop, { once: true });
    let renewing = false, lost = false, checkingProgress = false, stalledSamples = 0, progressRestart = false;
    let checkingAdmission = false, admissionRelease = false;
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      pending();
      void deps.renew(lease).then(ok => {
        succeeded();
        if (!ok) { lost = true; active.abort('role_lease_lost'); }
      }).catch(error => { failed('role.renew_unknown', error, { epoch: lease.epoch }); lost = true; active.abort('role_lease_lost'); })
        .finally(() => { renewing = false; });
    }, 10_000);
    timer.unref();
    const progressTimer = candidate.kind === 'primary' && deps.checkProgress ? setInterval(() => {
      if (checkingProgress || lost || progressRestart || signal.aborted) return;
      checkingProgress = true;
      void deps.checkProgress!(candidate.role).then(stalled => {
        stalledSamples = stalled ? stalledSamples + 1 : 0;
        if (stalledSamples >= 2) {
          progressRestart = true;
          runtimeLog('role.progress_stalled', { role: candidate.role, epoch: lease.epoch });
          active.abort('progress_stalled');
        }
      }).catch(() => { stalledSamples = 0; runtimeLog('role.progress_unknown', { role: candidate.role }); })
        .finally(() => { checkingProgress = false; });
    }, 15_000) : null;
    progressTimer?.unref();
    // versioned 갱신은 readiness 를 보지 않는다. 모든 claim 이 막힌(stale 결과·만료 capability 등) 선출 상태를 찾아 알리고, 계속되면 놓는다.
    const admissionTimer = lease.batchVersion === 1 && deps.checkAdmission ? setInterval(() => {
      if (checkingAdmission || lost || admissionRelease || signal.aborted) return;
      checkingAdmission = true;
      void deps.checkAdmission!(lease).then(result => {
        const now = Date.now();
        if (!result || result.ready) {
          if (health.admissionBlockedSince !== null) runtimeLog('role.batch_admission_ready', { role: candidate.role, epoch: lease.epoch });
          health.admissionBlockedSince = null; health.admissionReason = null; publish();
          return;
        }
        if (health.admissionBlockedSince === null) runtimeLog('role.batch_admission_blocked', { role: candidate.role, instanceId: candidate.instanceId,
          epoch: lease.epoch, batchEpoch: lease.batchEpoch, reason: result.reason });
        health.admissionBlockedSince ??= now; health.admissionReason = result.reason; publish();
        if (now - health.admissionBlockedSince < BATCH_ADMISSION_RELEASE_MS) return;
        admissionRelease = true;
        runtimeLog('role.batch_admission_release', { role: candidate.role, epoch: lease.epoch, reason: result.reason, blockedForMs: now - health.admissionBlockedSince });
        active.abort('batch_admission_blocked');
      }).catch(error => {
        const detail = dbErrorFields(error);
        runtimeLog('role.batch_admission_unknown', { role: candidate.role, code: detail.code, errorName: detail.name, message: detail.message });
      }).finally(() => { checkingAdmission = false; });
    }, 15_000) : null;
    admissionTimer?.unref();
    let exitCode = 1;
    try { exitCode = await deps.supervise(lease, active.signal); }
    finally {
      clearInterval(timer);
      if (progressTimer) clearInterval(progressTimer);
      if (admissionTimer) clearInterval(admissionTimer);
      signal.removeEventListener('abort', onStop);
    }
    runtimeLog('role.supervisor_stopped', { role: candidate.role, epoch: lease.epoch, exitCode, lost, progressRestart, admissionRelease });
    deps.report?.(signal.aborted ? 'stopping' : 'standby', null);
    if (signal.aborted) {
      if (exitCode === 0) await deps.release?.(lease).catch(() => false);
      return exitCode;
    }
    if (lost) continue;
    if (admissionRelease) {
      // 놓기가 거절돼도(일감 token 이 남음 등) 갱신을 멈췄으므로 lease 는 45초 안에 만료된다. 이 boot 는 readiness 가 돌아올 때까지 선출되지 않는다.
      const released = await (deps.release?.(lease) ?? Promise.resolve(false)).catch(() => false);
      runtimeLog('role.batch_admission_released', { role: candidate.role, epoch: lease.epoch, released });
      health.admissionBlockedSince = null; health.admissionReason = null; publish();
      continue;
    }
    // An unexpected supervisor exit gets the container's existing restart policy.
    return 1;
  }
  return 0;
}

/**
 * D11 기록기. PR15f: PROCESS_GROUP_SUCCESSOR_PROBE=1(기본 꺼짐)이고 이 boot 의 커널 boot·PID namespace 를 읽을 수 있을 때만 attestation 을 남기고,
 * supervisor 와 함께 죽은 같은 instance 옛 boot 의 child 그룹 종료(ESRCH)를 직접 관측할 수 있다. 잘못된 flag 값은 읽기 전에 거절한다.
 */
export function roleWorkerProcessGroup(owner: ProcessOwner, env: Readonly<Record<string, string | undefined>>,
  read: () => ProcessAttestation | null = () => readProcessAttestation()): { recorder: ProcessGroupRecorder; attestation: ProcessAttestation | null } {
  const attestation = successorProbeEnabled(env) ? read() : null;
  return { recorder: processGroupRecorder(owner, { attestation }), attestation };
}
/**
 * D11 기본 꺼짐: PROCESS_GROUP_RECORDING=1 일 때만 기록기를 만든다(켜지면 기록 실패 시 spawn 하지 않는다). 꺼져 있으면 undefined —
 * 슈퍼바이저는 DB 를 거치지 않고 spawn 하고(8020dca 와 같다) 이 boot 의 행은 group 근거 없이 남는다. 후속 관측(PR15f)은 기록을 전제한다.
 */
export function roleWorkerRecorder(owner: ProcessOwner, env: Readonly<Record<string, string | undefined>>,
  read: () => ProcessAttestation | null = () => readProcessAttestation()): ProcessGroupRecorder | undefined {
  if (processGroupRecordingEnabled(env)) return roleWorkerProcessGroup(owner, env, read).recorder;
  if (successorProbeEnabled(env)) throw new Error('process_group_successor_probe_requires_recording');
  return undefined;
}

async function main() {
  const candidate = parseRoleWorkerArgs(process.argv.slice(2));
  assertHostDbEntry(process.env, { kind: 'role-parent', role: candidate.role });
  // host 장부 자리가 없으면 선출에 나서지 않고 standby 로 남는다(자식·일감을 띄우지 않음)
  const host = startHostBudget(process.env);
  // 비상 admission 이 켜진 Oracle 은 recovering 동안 새 인계 역할을 가져가지 않는다(비활성이면 hook 없음)
  const takeover = emergencyTakeoverGate(process.env);
  // D11(PROCESS_GROUP_RECORDING=1 일 때만): 이 boot(=모델 장부 owner)의 child 그룹마다 spawn 전 의도와 ESRCH 종료를 남긴다. 켜져 있으면 기록 실패 시 spawn 하지 않는다.
  const processGroup = roleWorkerRecorder({ instanceId: candidate.instanceId, bootId: candidate.bootId }, process.env);
  // PR15f: 켜져 있으면 boot 직후 한 번 옛 boot 그룹을 관측한다. 선출·spawn 과 독립이고 실패해도 기존 동작 그대로다(그 행은 근거 없이 남는다).
  if (processGroup?.probePredecessors) void processGroup.probePredecessors()
    .then(result => runtimeLog('role.process_group_successor_probe', { role: candidate.role, recorded: result.recorded.length, alive: result.alive }),
      () => runtimeLog('role.process_group_successor_probe_failed', { role: candidate.role }));
  const controller = new AbortController();
  let phase: 'standby' | 'active' | 'stopping' = 'standby';
  let epoch: number | null = null;
  let runtime: RoleRuntimeHealth = { dbFailingSince: null, dbFailures: 0, dbPendingSince: null, admissionBlockedSince: null, admissionReason: null };
  const healthPath = process.env.ROLE_HEALTH_PATH ?? DEFAULT_ROLE_HEALTH_PATH;
  const writeLocal = () => {
    const path = `${healthPath}.${process.pid}.tmp`;
    writeFileSync(path, JSON.stringify({ role: candidate.role, kind: candidate.kind,
      instanceId: candidate.instanceId, bootId: candidate.bootId, phase, epoch,
      pid: process.pid, updatedAt: Date.now(), ...runtime }), { mode: 0o600 });
    renameSync(path, healthPath);
  };
  const stop = () => { phase = 'stopping'; writeLocal(); controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const record = () => { writeLocal(); void observe(roleCandidateObservationKey(candidate), {
    role: candidate.role, kind: candidate.kind, instanceId: candidate.instanceId,
    bootId: candidate.bootId, release: candidate.release, phase, epoch,
  }).catch(() => {}); };
  const localTimer = setInterval(writeLocal, 5_000);
  localTimer.unref();
  const observationTimer = setInterval(record, 15_000);
  observationTimer.unref();
  record();
  try {
    process.exitCode = await runRoleCandidate(candidate, controller.signal, {
      acquire: value => host.ready() ? tryAcquireRole(value, takeover) : Promise.resolve(null), renew: renewRole, release: releaseRole,
      checkProgress: async role => {
        if (candidate.batchVersion === 1) return false;
        // These roles have a single lane and retain their existing specialized progress policy.
        if ((role === 'maintenance' || role === 'text') && await hasActiveRoleJob(role)) return false;
        const report = await readWorkerProgress();
        if (role === 'maintenance') return maintenanceUptimeStalled({
          ...await readMaintenanceUptimeProgress(), schedulerScheduled: report.scheduler.reason === 'scheduled',
        });
        if (role === 'text') return textProgressStalled({
          ...await readTextProgress(), schedulerScheduled: report.scheduler.reason === 'scheduled',
        });
        return roleHasUnexplainedStall(report, role);
      },
      report: (next, currentEpoch) => { phase = next; epoch = currentEpoch; record(); },
      checkAdmission: batchLeaseAdmission, health: state => { runtime = state; }, lockBlockers: readRoleLockHolders,
      supervise: (lease, signal) => {
        process.env.ROLE_LEASE_ROLE = lease.role;
        process.env.ROLE_LEASE_INSTANCE_ID = lease.instanceId;
        process.env.ROLE_LEASE_BOOT_ID = lease.bootId;
        process.env.ROLE_LEASE_RELEASE = lease.release;
        process.env.ROLE_LEASE_EPOCH = String(lease.epoch);
        if (lease.batchVersion === 1) {
          process.env.ROLE_LEASE_BATCH_VERSION = '1';
          process.env.ROLE_LEASE_BATCH_EPOCH = String(lease.batchEpoch);
          process.env.ROLE_LEASE_HOST = lease.host;
        }
        return superviseWorker(lease.role, { signal, closeDbOnExit: false, ...(processGroup ? { processGroup } : {}) });
      },
    });
  } finally {
    clearInterval(localTimer);
    clearInterval(observationTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await host.stop();
    const client = (globalThis as {pgClient?: {end: (options: {timeout:number}) => Promise<void>}}).pgClient;
    await client?.end({timeout: 5});
  }
}

if (process.argv[1] && /^role-worker\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => { console.error('role worker failed; check role/database/environment configuration'); process.exitCode = 1; });
}
