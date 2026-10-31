import { DEFAULT_SUPERVISOR_LOOP_MS, SUPERVISOR_LOOP_MS_MAX, SUPERVISOR_LOOP_MS_MIN, type HelperDecision } from "@/lib/llm/capacity-helpers";
import { logger } from "@/lib/observability/logger";
import { observe } from "@/lib/operations/observations";
import { interruptibleSleep, type RuntimeReport } from "@/scripts/worker";
import { decideDeviceDemand, decideHelper } from "./decide";
import {
  acquireSupervisorLease, readSessionPrincipal, supervisorPrincipalAllowed, writeSupervisorSignals,
  type SupervisorLease, type SupervisorOwner, type SupervisorWritePlan, type SupervisorWriteResult,
} from "./repository";
import { readSupervisorSnapshot, supervisorDeviceDemandInputs, supervisorHelperInputs, type SupervisorSnapshot } from "./snapshot";

/**
 * Oracle 감시자 순환(pr2-plan §3.3). control.loop_ms(기본 15 초)마다:
 * 1 TX-A lease(fence SHARE → singleton lease·epoch). 다른 owner 가 살아 있으면 standby — 신호를 쓰지 않는다.
 * 2 꺼져 있으면(enabled=false) 신호를 쓰지 않는다 → 남은 신호는 TTL(기본 45 초) 안에 만료되고 도우미는 닫힌다. 관측만 'disabled'.
 * 3 스냅샷(REPEATABLE READ READ ONLY 한 TX) → 4 decideHelper·decideDeviceDemand(순수) → 5 TX-B(fence → lease 재확인 → upsert·정지).
 * 6 관측 `capacity-supervisor:<instance>`(lease·epoch·지연·배정별 판정). 실패해도 순환은 멈추지 않는다.
 *
 * fail-closed: 어느 단계든 오류면 그 순환에는 아무것도 쓰지 않는다 → TTL 이 도우미를 닫는다. 감시자가 죽거나 Oracle 이 끊겨도 우선 역할은
 * 막히지 않는다(D1) — 신호는 선택적 도우미 경로를 열 뿐이다.
 * 계정이 감시자 계정(nomorevibe_oracle_capacity_supervisor)이 아니면(main 역할 `nomorevibe` 포함) DB 에 아무것도 쓰기 전에 끝난다
 * (`supervisor_principal_mismatch`). 관리자가 signal_principal 을 바꿔 이 계정과 달라져도 같다.
 */

export const CAPACITY_SUPERVISOR_JOB = "capacity-supervisor";
/** 긴 기다림은 이 단위로 끊어 감독 진행 기한(90 초) 안에 report('idle') 한다. */
const SLICE_MS = 30_000;
/** 오류 뒤 다음 시도까지(연속 오류마다 늘리되 loop_ms 상한). */
const ERROR_BACKOFF_MS = 5_000;

export type CapacitySupervisorState = "starting" | "running" | "standby" | "disabled" | "fenced" | "control_missing" | "lease_lost" | "error" | "stopped";

export type CapacitySupervisorDeps = Readonly<{
  readPrincipal: () => Promise<{ currentUser: string; sessionUser: string }>;
  acquireLease: (owner: SupervisorOwner) => Promise<SupervisorLease>;
  readSnapshot: () => Promise<SupervisorSnapshot>;
  writeSignals: (owner: SupervisorOwner, epoch: number, plan: SupervisorWritePlan) => Promise<SupervisorWriteResult>;
  observe: (key: string, value: Record<string, unknown>) => Promise<void>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 지연 측정용 단조 시계. */
  clock: () => number;
}>;

const defaultDeps: CapacitySupervisorDeps = {
  readPrincipal: readSessionPrincipal, acquireLease: acquireSupervisorLease, readSnapshot: readSupervisorSnapshot,
  writeSignals: writeSupervisorSignals, observe, sleep: interruptibleSleep, clock: () => performance.now(),
};

export type CapacitySupervisorSummary = { loops: number; written: number; standby: number; disabled: number; fenced: number; leaseLost: number;
  failures: number; stops: number };

/** 판정 계획(순수): 배정마다 decideHelper, mode 가 꺼지지 않은 도우미 장비마다 decideDeviceDemand. */
export function planSupervisorSignals(snapshot: SupervisorSnapshot, epoch: number): SupervisorWritePlan {
  return Object.freeze({
    helpers: supervisorHelperInputs(snapshot, epoch).map(decideHelper),
    devices: supervisorDeviceDemandInputs(snapshot, epoch).map(decideDeviceDemand),
  });
}

const clampLoop = (value: number) => Number.isInteger(value) ? Math.min(SUPERVISOR_LOOP_MS_MAX, Math.max(SUPERVISOR_LOOP_MS_MIN, value)) : DEFAULT_SUPERVISOR_LOOP_MS;
const errorCode = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[^A-Za-z0-9_:.-]+/g, "_").slice(0, 120);
const verdictOf = (decision: HelperDecision) => `${decision.verdict}:${decision.reason}`;

/** 감시자 프로세스 본체. 계정이 감시자 계정이 아니면 던진다. 그 밖의 오류는 기록하고 다음 순환을 기다린다. */
export async function runCapacitySupervisor(input: {
  owner: SupervisorOwner; signal?: AbortSignal; report?: RuntimeReport; once?: boolean; deps?: Partial<CapacitySupervisorDeps>;
}): Promise<CapacitySupervisorSummary> {
  const deps: CapacitySupervisorDeps = { ...defaultDeps, ...input.deps };
  const { owner, signal, report, once } = input;
  const summary: CapacitySupervisorSummary = { loops: 0, written: 0, standby: 0, disabled: 0, fenced: 0, leaseLost: 0, failures: 0, stops: 0 };
  const key = `capacity-supervisor:${owner.instanceId}`;
  const view = {
    state: "starting" as CapacitySupervisorState, reason: null as string | null, epoch: null as number | null, leaseUntil: null as string | null,
    loopSeq: null as number | null, loopMs: DEFAULT_SUPERVISOR_LOOP_MS, signalTtlMs: null as number | null, latencyMs: null as number | null,
    lastWrittenAt: null as number | null, verdicts: {} as Record<string, string>, devices: {} as Record<string, boolean>,
    consecutiveFailures: 0, lastError: null as string | null,
  };
  // 관측이 실패해도 순환은 멈추지 않는다(0107 키 범위 밖이면 42501 — 신호와 무관)
  const publish = () => deps.observe(key, { ...view, bootId: owner.bootId, release: owner.release, ...summary, at: Date.now() }).catch(() => {});
  const setState = (state: CapacitySupervisorState, reason: string | null = null) => {
    if (view.state !== state || view.reason !== reason) logger.info("capacity_supervisor.state", { state, reason, epoch: view.epoch });
    view.state = state; view.reason = reason;
  };
  const rest = async (ms: number) => {
    for (let left = ms; left > 0 && !signal?.aborted; left -= SLICE_MS) {
      report?.("idle");
      await deps.sleep(Math.min(left, SLICE_MS), signal);
    }
  };

  const principal = await deps.readPrincipal();
  if (!supervisorPrincipalAllowed(principal)) {
    logger.error("capacity_supervisor.principal_refused", { principal: principal.currentUser });
    throw new Error("supervisor_principal_mismatch");
  }

  /** 한 순환. 기다릴 시간(ms)을 돌려준다. */
  const round = async (): Promise<number> => {
    report?.("polling");
    const started = deps.clock();
    const lease = await deps.acquireLease(owner);
    if (lease.kind === "fenced") { summary.fenced++; setState("fenced", lease.reason); return view.loopMs; }
    if (lease.kind === "control_missing") { setState("control_missing"); return view.loopMs; }
    if (lease.kind === "standby") {
      summary.standby++; view.loopMs = clampLoop(lease.loopMs); view.epoch = lease.epoch; view.leaseUntil = lease.leaseUntil;
      setState("standby", lease.ownerInstanceId); return view.loopMs;
    }
    view.loopMs = clampLoop(lease.loopMs); view.signalTtlMs = lease.signalTtlMs; view.leaseUntil = lease.leaseUntil; view.loopSeq = lease.loopSeq;
    if (view.epoch !== lease.epoch) logger.info("capacity_supervisor.epoch", { epoch: lease.epoch, previous: view.epoch });
    view.epoch = lease.epoch;
    if (!lease.principalOk) throw new SupervisorPrincipalError();
    if (!lease.enabled) { summary.disabled++; view.verdicts = {}; view.devices = {}; setState("disabled"); return view.loopMs; }
    report?.("running", CAPACITY_SUPERVISOR_JOB, Date.now());
    const snapshot = await deps.readSnapshot();
    const plan = planSupervisorSignals(snapshot, lease.epoch);
    const result = await deps.writeSignals(owner, lease.epoch, plan);
    view.latencyMs = Math.max(0, Math.round(deps.clock() - started));
    if (result.kind === "principal_mismatch") throw new SupervisorPrincipalError();
    if (result.kind === "fenced") { summary.fenced++; setState("fenced", result.reason); return view.loopMs; }
    if (result.kind === "lease_lost") { summary.leaseLost++; setState("lease_lost"); return view.loopMs; }
    if (result.kind === "disabled") { summary.disabled++; setState("disabled"); return view.loopMs; }
    summary.written++; summary.stops += result.stops; view.signalTtlMs = result.signalTtlMs; view.lastWrittenAt = Date.now();
    view.verdicts = Object.fromEntries(plan.helpers.map(decision => [decision.assignmentId, verdictOf(decision)]));
    view.devices = Object.fromEntries(plan.devices.map(decision => [decision.deviceId, decision.primaryDemand]));
    if (result.stops) logger.warn("capacity_supervisor.auto_stop", { epoch: lease.epoch,
      stops: plan.helpers.filter(decision => decision.stop).map(decision => `${decision.assignmentId}:${decision.stop!.effect}:${decision.stop!.reason}`) });
    setState("running");
    return Math.max(0, view.loopMs - view.latencyMs);
  };

  try {
    while (!signal?.aborted) {
      let wait: number;
      try {
        wait = await round();
        view.consecutiveFailures = 0; view.lastError = null;
      } catch (error) {
        if (error instanceof SupervisorPrincipalError) throw new Error("supervisor_principal_mismatch");
        summary.failures++; view.consecutiveFailures++; view.lastError = errorCode(error);
        setState("error", view.lastError);
        logger.warn("capacity_supervisor.round_failed", { error: view.lastError, consecutive: view.consecutiveFailures });
        wait = Math.min(view.loopMs, ERROR_BACKOFF_MS * view.consecutiveFailures);
      }
      summary.loops++;
      await publish();
      if (once) break;
      await rest(wait);
    }
  } finally {
    view.state = "stopped";
    await publish();
  }
  return summary;
}

class SupervisorPrincipalError extends Error {
  constructor() { super("supervisor_principal_mismatch"); }
}
