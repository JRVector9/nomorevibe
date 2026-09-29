/** Primary/standby candidate. Only the elected process starts the existing supervisor. */
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
import { DEFAULT_ROLE_HEALTH_PATH } from './role-health';

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
  stages: Array<{ role: string; reason: string }>;
}, role: RoleCandidate['role']): boolean {
  if (report.scheduler.reason !== 'scheduled') return false;
  const stages = report.stages.filter(stage => stage.role === role);
  return stages.some(stage => stage.reason === 'no_progress') &&
    !stages.some(stage => stage.reason === 'progressing' || stage.reason === 'upstream_or_job_error');
}

export function parseRoleWorkerArgs(args: string[], env: Readonly<Record<string, string | undefined>> = process.env): RoleCandidate {
  const role = args.find(arg => arg.startsWith('--role='))?.slice(7);
  const kind = args.find(arg => arg.startsWith('--kind='))?.slice(7);
  const instanceId = serviceInstanceId(env);
  if ((role !== 'crawler' && role !== 'reviewer' && role !== 'publisher' && role !== 'maintenance' && role !== 'text') || (kind !== 'primary' && kind !== 'standby') ||
      args.length !== 2 || !instanceId || !env.RELEASE_TAG || env.RELEASE_TAG.length > 120) {
    throw new Error('Usage: role-worker.ts --role=crawler|reviewer|publisher|maintenance|text --kind=primary|standby; SERVICE_INSTANCE_ID and RELEASE_TAG required');
  }
  return { role, kind, instanceId, release: env.RELEASE_TAG, bootId: randomUUID() };
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

async function main() {
  const candidate = parseRoleWorkerArgs(process.argv.slice(2));
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
      acquire: tryAcquireRole, renew: renewRole, release: releaseRole,
      checkProgress: async role => {
        if (await hasActiveRoleJob(role)) return false;
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
        return superviseWorker(lease.role, { signal, closeDbOnExit: false });
      },
    });
  } finally {
    clearInterval(localTimer);
    clearInterval(observationTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    const client = (globalThis as {pgClient?: {end: (options: {timeout:number}) => Promise<void>}}).pgClient;
    await client?.end({timeout: 5});
  }
}

if (process.argv[1] && /^role-worker\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => { console.error('role worker failed; check role/database/environment configuration'); process.exitCode = 1; });
}
