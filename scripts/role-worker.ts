import { assertHostDbEntry } from '@/lib/db/host-budget';
/** Primary/standby candidate. Only the elected process starts the existing supervisor. */
import { BATCH_ROLES, BATCH_HOSTS, type BatchHost } from '@/lib/jobs/batches';
import { randomUUID } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { interruptibleSleep, runtimeLog } from './worker';
import { superviseWorker, supervisorLimits } from './worker-supervisor';
import { readRoleLockHolders, readWaitingPrimary, releaseRole, renewRole, tryAcquireRole, yieldRoleToPrimary,
  type RoleCandidate, type RoleLease, type WaitingPrimary } from '@/lib/jobs/role-leader';
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
  /** true/false 는 기존 호출·시험 그대로다. 객체는 그 한 번 읽은 보고서의 트리거이며 다시 조회하지 않는다. */
  checkProgress?: (role: RoleCandidate['role']) => Promise<boolean | ProgressStallTrigger>;
  /** 이 boot 의 종료 기록. 없으면 DB 를 부르지 않는다. */
  recordStop?: (record: WorkerExitRecord) => Promise<void>;
  report?: (phase: 'standby' | 'active' | 'stopping', epoch: number | null) => void;
  /** versioned lease 의 claim 관문 readiness. null 이면 판정 대상 아님(draining·epoch 바뀜 — 갱신이 따로 본다) */
  checkAdmission?: (lease: RoleLease) => Promise<{ ready: boolean; reason: string } | null>;
  /** DB 실패 연속·끝나지 않은 호출·claim 막힘 — role health 파일이 싣고 healthcheck 가 한도를 본다 */
  health?: (state: RoleRuntimeHealth) => void;
  /** lock 오류(55P03·40P01) 뒤 실패 연속마다 한 번 읽는 진단 */
  lockBlockers?: () => Promise<unknown>;
  /** 예비 넘겨주기: 예비가 쥔 legacy lease 에서 같은 릴리스의 건강한 주가 기다리는지(readWaitingPrimary) */
  waitingPrimary?: (lease: RoleLease) => Promise<WaitingPrimary | null>;
  /** 예비 넘겨주기: drain 을 마친 뒤 lease 를 주에게 넘긴다(yieldRoleToPrimary) */
  yieldRole?: (lease: RoleLease) => Promise<boolean>;
  /** 같은 주 boot 가 이만큼 이어서 기다려야 넘긴다. null·없음이면 넘겨주기를 하지 않는다(ROLE_HANDOFF_STABLE_SECONDS=0) */
  handoffStableMs?: number | null;
  handoffPollMs?: number;
};
export type RoleRuntimeHealth = { dbFailingSince: number | null; dbFailures: number; dbPendingSince: number | null;
  admissionBlockedSince: number | null; admissionReason: string | null };
/** 선출된 versioned 역할의 claim 관문이 이만큼 계속 막히면 child 를 멈추고 lease 를 놓아 다른 host 가 선출될 수 있게 한다.
 * stale 결과(24시간)·만료 capability(15분)는 운영자 recanary/refresh 전에는 스스로 풀리지 않는다. 2분은 15초 표본 여러 번이라 attest 가 증거를 바꾸는 순간 같은 일시 상태로는 놓지 않는다. */
export const BATCH_ADMISSION_RELEASE_MS = 2 * 60_000;
export const ROLE_RENEW_DEADLINE_MS = 10_000;
export const ROLE_LEASE_WINDOW_MS = 45_000;
const LOCK_ERRORS = new Set(['55P03', '40P01']);

/**
 * 예비 넘겨주기(2026-10-22 #597). 같은 릴리스의 예비는 주가 정상 반납하거나 만료(+20초 유예)되면 역할을 맡지만, 예전에는 스스로 놓는 길이
 * 없어 주가 다시 떠도 예비가 계속 일했다(standby_active — 배포 관문이 멈추고 운영자가 예비를 scale 0 으로 내려야 했다).
 * 이제 예비가 쥔 legacy lease 는 15초마다 같은 릴리스·격리 아님·선출 가능(electable)인 주 후보의 최근 관측을 읽고, **같은 주 boot** 가
 * ROLE_HANDOFF_STABLE_SECONDS(기본 60초) 이상 이어서 기다리면 자식을 drain(그 동안도 lease 갱신)한 뒤 lease 를 만료시켜 넘긴다.
 * 주가 넘겨받지 못해 15분 안에 예비가 다시 선출되면 다음 넘겨주기는 두 배 더 기다린다(최대 1시간) — 반복 재시작하는 주와 주고받지 않는다.
 */
export const ROLE_HANDOFF_STABLE_MS = 60_000;
export const ROLE_HANDOFF_POLL_MS = 15_000;
export const ROLE_HANDOFF_RETRY_WINDOW_MS = 15 * 60_000;
export const ROLE_HANDOFF_MAX_STABLE_MS = 60 * 60_000;

/** ROLE_HANDOFF_STABLE_SECONDS: 없으면 60초, 0 이면 넘겨주기 끔, 1–3600 초. 그 밖의 값은 시작 전에 거절한다 */
export function roleHandoffStableMs(env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  const raw = env.ROLE_HANDOFF_STABLE_SECONDS;
  if (raw === undefined || raw === '') return ROLE_HANDOFF_STABLE_MS;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seconds) || seconds > 3_600) throw new Error('Invalid ROLE_HANDOFF_STABLE_SECONDS');
  return seconds === 0 ? null : seconds * 1_000;
}
/** ROLE_HANDOFF_POLL_SECONDS: 없으면 15초, 1–60 초(시험이 짧게 줄인다) */
export function roleHandoffPollMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.ROLE_HANDOFF_POLL_SECONDS;
  if (raw === undefined || raw === '') return ROLE_HANDOFF_POLL_MS;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || seconds < 1 || seconds > 60) throw new Error('Invalid ROLE_HANDOFF_POLL_SECONDS');
  return seconds * 1_000;
}

/** 넘겨주기 판단 상태. 기다리는 주의 boot 가 바뀌거나 보이지 않으면 처음부터 다시 잰다 */
export class PrimaryHandoff {
  private seen: { bootId: string; since: number } | null = null;
  private failures = 0;
  private yieldedAt: number | null = null;
  constructor(private readonly stableMs: number, private readonly now: () => number = Date.now) {}
  requiredMs(): number { return Math.min(this.stableMs * 2 ** this.failures, ROLE_HANDOFF_MAX_STABLE_MS); }
  /** 이번 표본. 같은 주 boot 가 requiredMs 이상 이어서 보였으면 true */
  observe(primary: WaitingPrimary | null): boolean {
    if (!primary) { this.seen = null; return false; }
    const at = this.now();
    if (this.seen?.bootId !== primary.bootId) this.seen = { bootId: primary.bootId, since: at };
    return at - this.seen.since >= this.requiredMs();
  }
  yielded(): void { this.yieldedAt = this.now(); this.seen = null; }
  /** 이 예비가 다시 선출됐다. 넘겨준 지 얼마 안 됐으면 주가 받지 못한 것이다 */
  acquired(): void {
    if (this.yieldedAt !== null) this.failures = this.now() - this.yieldedAt < ROLE_HANDOFF_RETRY_WINDOW_MS ? this.failures + 1 : 0;
    this.yieldedAt = null;
    this.seen = null;
  }
}

/** 재시작 로그에 남기는 정체 트리거. 프롬프트·본문·환경·토큰은 넣지 않는다. */
export type ProgressStallTrigger = {
  kind: 'stage' | 'lane';
  reason: string;
  job: string | null;
  lane: string | null;
  /** stage 는 최장 대기 분, lane 은 마지막 진행 이후 ms */
  age: number | null;
  /** stage 는 대기 건수, lane 은 poll 연령 ms */
  wait: number | null;
  /** stage 는 최근 진행 건수. lane 에는 같은 카운터가 없다 */
  progress: number | null;
  restartEligible: boolean;
};

const EXPLAINED_STAGE_REASONS: readonly string[] = ['progressing', 'running', 'upstream_or_job_error', 'upstream_stalled', 'backoff', 'paused'];
type LeaseCause = 'role_renew_deadline' | 'role_lease_expired' | 'renew_rejected' | 'renew_failed';
type StallStage = {
  role: string; reason: string; lane?: string; job?: string; restartEligible?: boolean;
  waiting?: number; oldestMinutes?: number | null; progress5m?: number | null; completed5m?: number | null;
};
type StallLane = {
  role: string; reason: string | null; restartEligible: boolean;
  name?: string; currentJob?: string | null; progressAgeMs?: number; pollAgeMs?: number | null;
};
type StallReport = { scheduler: { reason: string }; stages: StallStage[]; lanes?: StallLane[]; activeJobs?: string[] };

function boundLabel(value: unknown, max = 80): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return /^[A-Za-z0-9_.:@+/-]+$/.test(value) ? value : null;
}
function boundMetric(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) return null;
  return Math.round(value * 1_000) / 1_000;
}
function boundReason(value: unknown): string {
  return boundLabel(value, 64) ?? 'unspecified';
}
function knownStopSignal(reason: unknown): 'SIGINT' | 'SIGTERM' | null {
  return reason === 'SIGINT' || reason === 'SIGTERM' ? reason : null;
}
function candidateLog(candidate: RoleCandidate, epoch: number | null, fields: Record<string, unknown> = {}) {
  return {
    role: candidate.role, instanceId: boundLabel(candidate.instanceId, 48), bootId: boundLabel(candidate.bootId, 80),
    release: boundLabel(candidate.release, 120), epoch, ...fields,
  };
}
function stallFields(trigger: ProgressStallTrigger | null) {
  return {
    kind: trigger?.kind ?? null, reason: trigger?.reason ?? null, job: trigger?.job ?? null, lane: trigger?.lane ?? null,
    age: trigger?.age ?? null, wait: trigger?.wait ?? null, progress: trigger?.progress ?? null,
    restartEligible: trigger?.restartEligible ?? null,
  };
}
/** boolean true 는 기존 호출이다. 객체는 restartEligible 이 정확히 true 일 때만 정체다. */
function progressSample(result: boolean | ProgressStallTrigger): { stalled: boolean; trigger: ProgressStallTrigger | null } {
  if (result === true) return { stalled: true, trigger: null };
  if (typeof result !== 'object' || result === null) return { stalled: false, trigger: null };
  if ((result.kind !== 'stage' && result.kind !== 'lane') || result.restartEligible !== true) return { stalled: false, trigger: null };
  return { stalled: true, trigger: {
    kind: result.kind, reason: boundReason(result.reason), job: boundLabel(result.job), lane: boundLabel(result.lane),
    age: boundMetric(result.age), wait: boundMetric(result.wait), progress: boundMetric(result.progress),
    restartEligible: true,
  } };
}
function stageWouldRestart(stage: StallStage, stages: StallStage[], activeJobs: string[], role: RoleCandidate['role']): boolean {
  if (stage.reason !== 'no_progress' || stage.restartEligible === false) return false;
  const siblings = stages.filter(other => other.lane === stage.lane);
  const activeInLane = activeJobs.some(job => siblings.some(other => other.job === job) ||
    (stage.lane !== undefined && laneForJob(role, job) === stage.lane));
  return !activeInLane && !siblings.some(other => EXPLAINED_STAGE_REASONS.includes(other.reason));
}
function stageTriggerOf(stage: StallStage): ProgressStallTrigger {
  return {
    kind: 'stage', reason: boundReason(stage.reason), job: boundLabel(stage.job), lane: boundLabel(stage.lane),
    age: boundMetric(stage.oldestMinutes), wait: boundMetric(stage.waiting),
    progress: boundMetric(stage.progress5m ?? stage.completed5m), restartEligible: stage.restartEligible !== false,
  };
}
function laneTriggerOf(lane: StallLane): ProgressStallTrigger {
  return {
    kind: 'lane', reason: boundReason(lane.reason), job: boundLabel(lane.currentJob), lane: boundLabel(lane.name),
    age: boundMetric(lane.progressAgeMs), wait: boundMetric(lane.pollAgeMs), progress: null, restartEligible: true,
  };
}

/**
 * 재시작 판정과 같은 첫 후보. lane 이 우선이고, scheduler 가 scheduled 일 때만 stage 를 본다.
 * 배열에서 먼저 걸리는 FIRST 가 원인이면 그 stage 가 로그에 남는다. 이미 읽은 report 만 사용한다.
 */
export function selectUnexplainedStall(report: StallReport, role: RoleCandidate['role'], activeJobs: string[] = report.activeJobs ?? []): ProgressStallTrigger | null {
  const lane = report.lanes?.find(item => item.role === role && item.restartEligible);
  if (lane) return laneTriggerOf(lane);
  if (report.scheduler.reason !== 'scheduled') return null;
  const stages = report.stages.filter(stage => stage.role === role);
  const stage = stages.find(item => stageWouldRestart(item, stages, activeJobs, role));
  return stage ? stageTriggerOf(stage) : null;
}

export function roleHasUnexplainedStall(report: StallReport, role: RoleCandidate['role'], activeJobs: string[] = report.activeJobs ?? []): boolean {
  return selectUnexplainedStall(report, role, activeJobs) !== null;
}

function maintenanceStallTrigger(state: { oldestMinutes: number | null; waiting: boolean; persistedWithin5m: boolean }): ProgressStallTrigger {
  return {
    kind: 'stage', reason: 'no_progress', job: 'uptime-ping', lane: laneForJob('maintenance', 'uptime-ping'),
    age: boundMetric(state.oldestMinutes), wait: state.waiting ? 1 : 0, progress: state.persistedWithin5m ? 1 : 0,
    restartEligible: true,
  };
}
function textStallTrigger(oldestReadyMinutes: number | null): ProgressStallTrigger {
  return {
    kind: 'stage', reason: 'no_progress', job: null, lane: null, age: boundMetric(oldestReadyMinutes),
    wait: null, progress: 0, restartEligible: true,
  };
}

export type WorkerExitRecord = {
  why: string;
  stopReason: string | null;
  trigger: ReturnType<typeof stallFields>;
  previous: ReturnType<typeof stallFields>;
  instanceId: string | null;
  bootId: string | null;
  release: string | null;
  epoch: number | null;
  exitCode: number;
  drainTimedOut: boolean;
  signal: 'SIGINT' | 'SIGTERM' | null;
  leaseCause: LeaseCause | null;
};

const EXIT_RECORD_MS = 2_000;
const BOOT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 한 boot 하나의 키. 다음 boot 가 같은 역할을 덮어쓰지 않는다. 80자 미만. */
export function workerExitObservationKey(role: string, bootId: string): string | null {
  if (!/^[a-z0-9-]{1,32}$/.test(role) || !BOOT_UUID.test(bootId)) return null;
  const key = `worker-exit:${role}:${bootId}`;
  return key.length < 80 ? key : null;
}

async function writeExitRecord(candidate: RoleCandidate, record: WorkerExitRecord, write: Dependencies['recordStop']): Promise<void> {
  if (!write) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = Promise.resolve().then(() => write(record)).then(
    () => ({ ok: true as const }),
    () => ({ ok: false as const, code: 'exit_record_failed' }),
  );
  const result = await Promise.race([
    attempt,
    new Promise<{ ok: false; code: string }>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, code: 'exit_record_timeout' }), EXIT_RECORD_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!result.ok) {
    runtimeLog('role.exit_record_failed', candidateLog(candidate, record.epoch, { code: result.code }));
  }
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
  // 예비 넘겨주기는 예비 후보·legacy lease 에서만(versioned 는 host 순서·readiness 로 따로 선출한다)
  const handoff = candidate.kind === 'standby' && deps.waitingPrimary && deps.yieldRole && deps.handoffStableMs
    ? new PrimaryHandoff(deps.handoffStableMs) : null;
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
  let decisionTrigger: ProgressStallTrigger | null = null;
  let decisionPrevious: ProgressStallTrigger | null = null;
  const receivedSignal = () => knownStopSignal(signal.reason);
  const controlledExit = (code: number, why: string, detail: {
    epoch?: number | null; drainTimedOut?: boolean; stopReason?: string | null; leaseCause?: LeaseCause | null;
  } = {}) => {
    const exitCode = Number.isSafeInteger(code) ? code : 1;
    const record: WorkerExitRecord = {
      why: boundLabel(why, 64) ?? 'unspecified',
      stopReason: boundLabel(detail.stopReason, 64),
      trigger: stallFields(decisionTrigger),
      previous: stallFields(decisionPrevious),
      instanceId: boundLabel(candidate.instanceId, 48),
      bootId: boundLabel(candidate.bootId, 80),
      release: boundLabel(candidate.release, 120),
      epoch: typeof detail.epoch === 'number' && Number.isSafeInteger(detail.epoch) ? detail.epoch : null,
      exitCode, drainTimedOut: detail.drainTimedOut === true, signal: receivedSignal(), leaseCause: detail.leaseCause ?? null,
    };
    return writeExitRecord(candidate, record, deps.recordStop).then(() => exitCode);
  };
  while (!signal.aborted) {
    let lease: RoleLease | null = null;
    const acquiredAt = Date.now();
    pending();
    let acquireTimer: ReturnType<typeof setTimeout> | undefined, acquireTimedOut = false;
    try {
      // A half-open DB connection may never return even after the server's statement timeout.
      // End this boot instead of retrying an election whose commit is still uncertain.
      lease = await Promise.race([deps.acquire(candidate), new Promise<never>((_resolve, reject) => {
        acquireTimer = setTimeout(() => { acquireTimedOut = true; reject(new Error('role_acquire_deadline')); }, ROLE_STUCK_UNHEALTHY_MS);
        acquireTimer.unref?.();
      })]);
      succeeded();
    } catch (error) {
      if (acquireTimedOut) health.dbFailingSince ??= acquiredAt;
      failed('role.acquire_unknown', error);
    } finally { clearTimeout(acquireTimer); }
    if (signal.aborted) {
      // An election already in flight may still commit after SIGTERM. Never start its child.
      if (lease) await deps.release?.(lease).catch(() => false);
      deps.report?.('stopping', null);
      runtimeLog('role.shutdown_requested', candidateLog(candidate, lease?.epoch ?? null, { signal: receivedSignal(), phase: lease ? 'acquired' : 'election' }));
      return controlledExit(0, 'shutdown_requested', { epoch: lease?.epoch ?? null });
    }
    if (!lease) {
      // 스스로 회복하지 못한 boot 는 깨끗이 끝낸다 — 재시작 정책이 새 프로세스·새 DB pool 로 다시 띄운다.
      if (health.dbFailingSince !== null && Date.now() - health.dbFailingSince >= ROLE_STUCK_UNHEALTHY_MS) {
        runtimeLog('role.db_unavailable_exit', { role: candidate.role, instanceId: candidate.instanceId,
          failures: health.dbFailures, failingForMs: Date.now() - health.dbFailingSince });
        return controlledExit(1, 'db_unavailable');
      }
      deps.report?.('standby', null);
      await sleep(5_000, signal);
      continue;
    }
    runtimeLog('role.acquired', { role: candidate.role, kind: candidate.kind,
      instanceId: candidate.instanceId, epoch: lease.epoch });
    handoff?.acquired();
    deps.report?.('active', lease.epoch);
    const active = new AbortController();
    let abortReason: string | null = null;
    let leaseCause: LeaseCause | null = null;
    const abortActive = (reason: string) => {
      if (active.signal.aborted) return;
      abortReason = reason;
      active.abort(reason);
    };
    const onStop = () => abortActive('shutdown_requested');
    signal.addEventListener('abort', onStop, { once: true });
    if (signal.aborted) onStop();
    let renewing = false, lost = false, checkingProgress = false, progressRestart = false;
    let stallSamples: Array<ProgressStallTrigger | null> = [];
    let checkingAdmission = false, admissionRelease = false, ended = false, checkingHandoff = false, handoffRelease = false;
    // 갱신은 drain 이 시작되면 멈춘다. 넘겨주기 drain 만은 자식이 끝날 때까지 갱신해 주가 그 전에 선출되지 않게 한다(두 자식이 겹치지 않는다).
    const renewalsStopped = () => active.signal.aborted && !(handoffRelease && !signal.aborted);
    let leaseDeadline = acquiredAt + ROLE_LEASE_WINDOW_MS, renewDeadline: number | null = null;
    const lose = (reason: string) => {
      if (lost || ended) return;
      lost = true;
      const cause: LeaseCause = reason === 'role_renew_deadline' || reason === 'role_lease_expired' ? reason : 'renew_failed';
      leaseCause = cause;
      failed('role.renew_unknown', new Error(reason), { epoch: lease.epoch, cause });
      abortActive('role_lease_lost');
    };
    // Independent of the renew promise: a wedged DB call cannot keep a child alive.
    const watchdog = setInterval(() => {
      if (Date.now() >= leaseDeadline) lose('role_lease_expired');
      else if (renewDeadline !== null && Date.now() >= renewDeadline) lose('role_renew_deadline');
    }, 250);
    watchdog.unref();
    const timer = setInterval(() => {
      if (renewing || lost || ended || renewalsStopped()) return;
      if (Date.now() >= leaseDeadline) { lose('role_lease_expired'); return; }
      renewing = true;
      const startedAt = Date.now();
      renewDeadline = Math.min(leaseDeadline, startedAt + ROLE_RENEW_DEADLINE_MS);
      pending();
      void Promise.resolve().then(() => deps.renew(lease)).then(ok => {
        if (ended || lost || renewalsStopped()) return;
        if (Date.now() >= renewDeadline!) { lose('role_renew_deadline'); return; }
        succeeded();
        if (!ok) {
          lost = true; leaseCause = 'renew_rejected';
          runtimeLog('role.lease_lost', candidateLog(candidate, lease.epoch, { cause: 'renew_rejected' }));
          abortActive('role_lease_lost');
        } else leaseDeadline = startedAt + ROLE_LEASE_WINDOW_MS;
      }).catch(error => {
        if (ended || lost || renewalsStopped()) return;
        leaseCause = 'renew_failed';
        failed('role.renew_unknown', error, { epoch: lease.epoch, cause: 'renew_failed' }); lost = true; abortActive('role_lease_lost');
      }).finally(() => { renewing = false; renewDeadline = null; });
    }, 10_000);
    timer.unref();
    const progressTimer = candidate.kind === 'primary' && deps.checkProgress ? setInterval(() => {
      if (checkingProgress || lost || progressRestart || signal.aborted || active.signal.aborted) return;
      checkingProgress = true;
      void deps.checkProgress!(candidate.role).then(result => {
        if (lost || ended || progressRestart || signal.aborted || active.signal.aborted) return;
        const sample = progressSample(result);
        if (!sample.stalled) { stallSamples = []; return; }
        stallSamples = [...stallSamples, sample.trigger].slice(-2);
        if (stallSamples.length < 2) return;
        progressRestart = true;
        decisionPrevious = stallSamples[0] ?? null;
        decisionTrigger = stallSamples[1] ?? null;
        runtimeLog('role.progress_stalled', candidateLog(candidate, lease.epoch, {
          samples: 2, trigger: stallFields(decisionTrigger), previous: stallFields(decisionPrevious),
        }));
        abortActive('progress_stalled');
      }).catch(() => {
        if (lost || ended || signal.aborted || active.signal.aborted) return;
        stallSamples = [];
        runtimeLog('role.progress_unknown', candidateLog(candidate, lease.epoch));
      }).finally(() => { checkingProgress = false; });
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
        abortActive('batch_admission_blocked');
      }).catch(error => {
        const detail = dbErrorFields(error);
        runtimeLog('role.batch_admission_unknown', { role: candidate.role, code: detail.code, errorName: detail.name, message: detail.message });
      }).finally(() => { checkingAdmission = false; });
    }, 15_000) : null;
    admissionTimer?.unref();
    // 예비 넘겨주기: 같은 릴리스의 건강한 주 boot 가 충분히 오래 기다리면 자식을 drain 하고 넘긴다
    const handoffTimer = handoff && lease.batchVersion !== 1 ? setInterval(() => {
      if (checkingHandoff || lost || handoffRelease || active.signal.aborted) return;
      checkingHandoff = true;
      void deps.waitingPrimary!(lease).then(primary => {
        if (ended || lost || handoffRelease || active.signal.aborted || !handoff.observe(primary)) return;
        handoffRelease = true;
        runtimeLog('role.primary_handoff', { role: candidate.role, instanceId: candidate.instanceId, epoch: lease.epoch,
          primaryInstanceId: primary!.instanceId, primaryBootId: primary!.bootId, waitedMs: handoff.requiredMs() });
        abortActive('primary_handoff');
      }).catch(error => {
        handoff.observe(null);
        const detail = dbErrorFields(error);
        runtimeLog('role.primary_handoff_unknown', { role: candidate.role, code: detail.code, errorName: detail.name, message: detail.message });
      }).finally(() => { checkingHandoff = false; });
    }, deps.handoffPollMs ?? ROLE_HANDOFF_POLL_MS) : null;
    handoffTimer?.unref();
    let exitCode = 1, drainTimedOut = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let startDrain: () => void;
    const drainLimitMs = supervisorLimits(candidate.role).drainMs + 5_000;
    const drainExpired = new Promise<number>(resolve => {
      startDrain = () => {
        drainTimer = setTimeout(() => {
          drainTimedOut = true;
          runtimeLog('role.supervisor_drain_timeout', candidateLog(candidate, lease.epoch, {
            abortReason, signal: receivedSignal(), leaseCause, drainTimeout: true, drainMs: drainLimitMs,
          }));
          resolve(1);
        }, drainLimitMs);
      };
      active.signal.addEventListener('abort', startDrain, { once: true });
      if (active.signal.aborted) startDrain();
    });
    try { exitCode = await Promise.race([deps.supervise(lease, active.signal), drainExpired]); }
    finally {
      ended = true;
      active.signal.removeEventListener('abort', startDrain!);
      if (drainTimer) clearTimeout(drainTimer);
      clearInterval(watchdog);
      clearInterval(timer);
      if (progressTimer) clearInterval(progressTimer);
      if (admissionTimer) clearInterval(admissionTimer);
      if (handoffTimer) clearInterval(handoffTimer);
      signal.removeEventListener('abort', onStop);
    }
    runtimeLog('role.supervisor_stopped', candidateLog(candidate, lease.epoch, {
      exitCode, lost, progressRestart, admissionRelease, handoffRelease,
      abortReason, signal: receivedSignal(), leaseCause, drainTimedOut,
    }));
    deps.report?.(signal.aborted ? 'stopping' : 'standby', null);
    if (drainTimedOut) return controlledExit(1, 'drain_timeout', { epoch: lease.epoch, drainTimedOut: true, stopReason: abortReason, leaseCause });
    if (signal.aborted) {
      if (exitCode === 0) await deps.release?.(lease).catch(() => false);
      return controlledExit(exitCode, 'shutdown_requested', { epoch: lease.epoch, drainTimedOut, stopReason: abortReason, leaseCause });
    }
    if (lost) continue;
    if (admissionRelease) {
      // 놓기가 거절돼도(일감 token 이 남음 등) 갱신을 멈췄으므로 lease 는 45초 안에 만료된다. 이 boot 는 readiness 가 돌아올 때까지 선출되지 않는다.
      const released = await (deps.release?.(lease) ?? Promise.resolve(false)).catch(() => false);
      runtimeLog('role.batch_admission_released', { role: candidate.role, epoch: lease.epoch, released });
      health.admissionBlockedSince = null; health.admissionReason = null; publish();
      continue;
    }
    if (handoffRelease && exitCode === 0) {
      // 자식이 깨끗이 끝난 뒤에만 넘긴다. 결과를 모르면(DB 오류) 이 boot 를 끝내 재시작에 맡긴다 — 갱신이 멈춘 lease 는 45초 안에 만료되고
      // 주는 유예 없이, 새 예비 boot 는 20초 유예 뒤에야 선출에 나선다.
      let yielded: boolean;
      try { yielded = await deps.yieldRole!(lease); }
      catch (error) { failed('role.primary_handoff_unknown', error, { epoch: lease.epoch });
        return controlledExit(1, 'primary_handoff_failed', { epoch: lease.epoch, stopReason: 'primary_handoff', leaseCause }); }
      runtimeLog('role.primary_handoff_yielded', { role: candidate.role, instanceId: candidate.instanceId, epoch: lease.epoch, yielded });
      // false 는 이미 이 epoch 의 lease 가 아니라는 뜻이다(다른 후보가 맡았거나 batch·fence 상태) — 다음 선출이 DB 로 다시 정한다
      if (yielded) handoff!.yielded();
      continue;
    }
    // An unexpected supervisor exit gets the container's existing restart policy.
    return controlledExit(1, progressRestart ? 'progress_stalled' : 'supervisor_exit', {
      epoch: lease.epoch, drainTimedOut, stopReason: abortReason, leaseCause,
    });
  }
  runtimeLog('role.shutdown_requested', candidateLog(candidate, null, { signal: receivedSignal(), phase: 'standby' }));
  return controlledExit(0, 'shutdown_requested');
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
  // 잘못된 넘겨주기 설정은 선출 전에 거절한다
  const handoffStableMs = roleHandoffStableMs(process.env), handoffPollMs = roleHandoffPollMs(process.env);
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
  const stop = (received: 'SIGINT' | 'SIGTERM') => {
    phase = 'stopping'; writeLocal();
    if (!controller.signal.aborted) controller.abort(received);
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  // electable: 선출에 나설 수 있는 boot(host 장부 준비·DB 실패 연속 없음). 같은 릴리스 예비는 이 값이 true 인 주에게만 넘긴다
  const record = () => { writeLocal(); void observe(roleCandidateObservationKey(candidate), {
    role: candidate.role, kind: candidate.kind, instanceId: candidate.instanceId,
    bootId: candidate.bootId, release: candidate.release, phase, epoch,
    electable: host.ready() && runtime.dbFailingSince === null,
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
        // These roles retain their specialized main-work progress policy; the supervisor observes each runtime lane.
        if ((role === 'maintenance' || role === 'text') && await hasActiveRoleJob(role)) return false;
        const report = await readWorkerProgress(undefined, { includeText: false });
        if (role === 'maintenance') {
          const uptime = { ...await readMaintenanceUptimeProgress(), schedulerScheduled: report.scheduler.reason === 'scheduled' };
          return maintenanceUptimeStalled(uptime) ? maintenanceStallTrigger(uptime) : false;
        }
        if (role === 'text') {
          const text = { ...await readTextProgress(), schedulerScheduled: report.scheduler.reason === 'scheduled' };
          return textProgressStalled(text) ? textStallTrigger(text.oldestReadyMinutes) : false;
        }
        return selectUnexplainedStall(report, role) ?? false;
      },
      recordStop: async record => {
        const key = workerExitObservationKey(candidate.role, candidate.bootId);
        if (!key) throw Object.assign(new Error('exit_record_key'), { code: 'exit_record_key' });
        await observe(key, {
          why: record.why, stopReason: record.stopReason, trigger: record.trigger, previous: record.previous,
          instanceId: record.instanceId, bootId: record.bootId, release: record.release, epoch: record.epoch,
          exitCode: record.exitCode, drainTimedOut: record.drainTimedOut, signal: record.signal, leaseCause: record.leaseCause,
        });
      },
      report: (next, currentEpoch) => { phase = next; epoch = currentEpoch; record(); },
      checkAdmission: batchLeaseAdmission, health: state => { runtime = state; }, lockBlockers: readRoleLockHolders,
      waitingPrimary: readWaitingPrimary, yieldRole: yieldRoleToPrimary, handoffStableMs, handoffPollMs,
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
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    await host.stop();
    const client = (globalThis as {pgClient?: {end: (options: {timeout:number}) => Promise<void>}}).pgClient;
    await client?.end({timeout: 5});
  }
}

if (process.argv[1] && /^role-worker\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => { console.error('role worker failed; check role/database/environment configuration'); process.exitCode = 1; });
}
