import { assertHostDbEntry } from '@/lib/db/host-budget';
/** Primary/standby candidate. Only the elected process starts the existing supervisor. */
import { BATCH_ROLES, BATCH_HOSTS, type BatchHost } from '@/lib/jobs/batches';
import { randomUUID } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { interruptibleSleep, runtimeLog } from './worker';
import { superviseWorker } from './worker-supervisor';
import { releaseRole, renewRole, tryAcquireRole, type RoleCandidate, type RoleLease } from '@/lib/jobs/role-leader';
import { observe } from '@/lib/operations/observations';
import { serviceInstanceId } from '@/lib/operations/instance';
import { readWorkerProgress } from '@/lib/operations/worker-progress-query';
import { maintenanceUptimeStalled, readMaintenanceUptimeProgress } from '@/lib/operations/maintenance-progress';
import { readTextProgress, textProgressStalled } from '@/lib/operations/text-progress';
import { hasActiveRoleJob } from '@/lib/jobs/control';
import { laneForJob } from '@/lib/operations/worker-progress';
import { DEFAULT_ROLE_HEALTH_PATH } from './role-health';
import { startHostBudget } from '@/lib/operations/host-budget-runtime';
import { emergencyTakeoverGate } from '@/lib/operations/emergency-admission-runtime';
import { processGroupRecorder, type ProcessGroupRecorder, type ProcessOwner } from '@/lib/operations/dr/repository';
import { readProcessAttestation, successorProbeEnabled, type ProcessAttestation } from '@/lib/operations/dr/process-attestation';

type Dependencies = {
  acquire: typeof tryAcquireRole;
  renew: typeof renewRole;
  release?: typeof releaseRole;
  supervise: (lease: RoleLease, signal: AbortSignal) => Promise<number>;
  sleep?: typeof interruptibleSleep;
  checkProgress?: (role: RoleCandidate['role']) => Promise<boolean>;
  report?: (phase: 'standby' | 'active' | 'stopping', epoch: number | null) => void;
};

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
  while (!signal.aborted) {
    let lease: RoleLease | null = null;
    try { lease = await deps.acquire(candidate); }
    catch { runtimeLog('role.acquire_unknown', { role: candidate.role, instanceId: candidate.instanceId }); }
    if (!lease) {
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
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      void deps.renew(lease).then(ok => {
        if (!ok) { lost = true; active.abort('role_lease_lost'); }
      }).catch(() => { lost = true; active.abort('role_lease_lost'); })
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
    let exitCode = 1;
    try { exitCode = await deps.supervise(lease, active.signal); }
    finally {
      clearInterval(timer);
      if (progressTimer) clearInterval(progressTimer);
      signal.removeEventListener('abort', onStop);
    }
    runtimeLog('role.supervisor_stopped', { role: candidate.role, epoch: lease.epoch, exitCode, lost, progressRestart });
    deps.report?.(signal.aborted ? 'stopping' : 'standby', null);
    if (signal.aborted) {
      if (exitCode === 0) await deps.release?.(lease).catch(() => false);
      return exitCode;
    }
    if (lost) continue;
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

async function main() {
  const candidate = parseRoleWorkerArgs(process.argv.slice(2));
  assertHostDbEntry(process.env, { kind: 'role-parent', role: candidate.role });
  // host 장부 자리가 없으면 선출에 나서지 않고 standby 로 남는다(자식·일감을 띄우지 않음)
  const host = startHostBudget(process.env);
  // 비상 admission 이 켜진 Oracle 은 recovering 동안 새 인계 역할을 가져가지 않는다(비활성이면 hook 없음)
  const takeover = emergencyTakeoverGate(process.env);
  // D11: 이 boot(=모델 장부 owner)의 child 그룹마다 spawn 전 의도와 ESRCH 종료를 남긴다. 기록 실패 시 spawn 하지 않는다.
  const processGroup = roleWorkerProcessGroup({ instanceId: candidate.instanceId, bootId: candidate.bootId }, process.env).recorder;
  // PR15f: 켜져 있으면 boot 직후 한 번 옛 boot 그룹을 관측한다. 선출·spawn 과 독립이고 실패해도 기존 동작 그대로다(그 행은 근거 없이 남는다).
  if (processGroup.probePredecessors) void processGroup.probePredecessors()
    .then(result => runtimeLog('role.process_group_successor_probe', { role: candidate.role, recorded: result.recorded.length, alive: result.alive }),
      () => runtimeLog('role.process_group_successor_probe_failed', { role: candidate.role }));
  const controller = new AbortController();
  let phase: 'standby' | 'active' | 'stopping' = 'standby';
  let epoch: number | null = null;
  const healthPath = process.env.ROLE_HEALTH_PATH ?? DEFAULT_ROLE_HEALTH_PATH;
  const writeLocal = () => {
    const path = `${healthPath}.${process.pid}.tmp`;
    writeFileSync(path, JSON.stringify({ role: candidate.role, kind: candidate.kind,
      instanceId: candidate.instanceId, bootId: candidate.bootId, phase, epoch,
      pid: process.pid, updatedAt: Date.now() }), { mode: 0o600 });
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
        return superviseWorker(lease.role, { signal, closeDbOnExit: false, processGroup });
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
