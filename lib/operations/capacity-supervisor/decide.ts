import {
  HELPER_DECISION_LIMITS, roleDemandFresh,
  type DeviceDemandDecision, type DeviceDemandInputs, type HelperDecision, type HelperHealthCounts, type HelperInputs, type HelperMetrics,
  type HelperPrimaryDeviceSample, type HelperReason, type HelperStage, type HelperStopProposal, type HelperStopRow, type HelperVerdict,
} from "@/lib/llm/capacity-helpers";

/**
 * Oracle 감시자의 판정(pr2-plan §3.5) — 순수 함수. 입력은 한 번의 스냅샷(DB 시계 nowMs)이고, 출력은 쓸 신호 한 줄(+ 선택적 정지 제안)이다.
 * 신호는 선택적 도우미 경로를 *열거나*(help·shadow_only) 닫을(hold) 뿐 우선 역할 일을 막지 못한다(D1). 모르는 것은 모두 hold 다.
 *
 * 우선순위(앞에서 맞는 것이 이긴다):
 * 1 mode 'off' → hold/mode_off
 * 2 현재 version 의 정지(effect 'stop') → hold/auto_stopped
 * 3 스냅샷 불완전 · 주 장비 표본 모름(beacon stale·장비 상태 없음) · 자기 역할 beacon stale/없음 → hold/stale_inputs
 * 4 건강 위반 → hold + 정지 제안: 미확인(n≥10 & 비율>max_unknown_rate, 또는 연속 3) → stop/unknown_rate,
 *   실패(n≥10 & (failed+notStarted)/n > max_failure_rate) → stop/failure_rate,
 *   실전(mode live)만: AI2 불일치(n≥20 & > max_live_disagreement) 또는 rolling 섀도 일치율 < min_agreement − 0.05(결정 쌍 ≥ 20)
 *   → demote_to_shadow/quality_regression. 같은 version 에 강등 정지가 이미 있으면 강등 위반은 처리된 것으로 보고 건너뛴다
 *   (안 그러면 hold 가 섀도 표본까지 영원히 닫는다 — 강등은 실전 경로만 닫아야 한다, §4.4).
 * 5 자기 역할 바쁨(장부 primaryBusy 또는 beacon backlog > 0) → hold/helper_own_work — 즉시, 머무름 시간을 무시한다
 * 6 이전 판정이 이어지는 'help' 이고 돕기가 가능(mode live, 강등 정지 없음): 주 장비 가득 → help(streak 0);
 *   아니면 나가기 streak+1, streak ≥ exit_samples 이고 help 에 min_help_ms 이상 머물렀을 때만 나간다 → shadow_only|hold/primary_not_full
 * 7 그 밖: 주 장비 가득이면 들어가기 streak+1; streak ≥ enter_samples, 마지막 나감 뒤 reenter_cooldown_ms 지남, 돕기 가능이면 help.
 *   아니면 shadow_only(mode ∈ {shadow, live} 이고 시간당 섀도 몫이 남음) | hold.
 *
 * "이어지는" 이전 신호 = 같은 epoch · 같은 배정 version · 아직 유효(valid_until > now). 아니면 streak 를 버리고 7단계에서 0 부터 센다(보수적).
 * last_exit_at 은 이전 신호에서 그대로 이어 온다(epoch 이 바뀌어도 — 재진입 대기를 지키는 쪽). 'help' 에서 다른 판정으로 바뀌면 now 다.
 */

const L = HELPER_DECISION_LIMITS;
/** streak 열은 integer(≥ 0). 오래 이어져도 넘치지 않게 자른다. */
const STREAK_MAX = 1_000_000;
const INT_MAX = 2_147_483_647;

const timeMs = (value: string | null | undefined): number => value ? Date.parse(value) : Number.NaN;
const rate = (part: number, whole: number): number => whole > 0 ? part / whole : 0;
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * 주 장비가 가득 찼는가(§3.4): 주 장비가 하나 이상 있고 *모든* 주 장비가 active ≥ limit_slots 이고 대기 ≥ 1.
 * AI2 는 더해서 그 장비에 local-direct second-review 대기 행이 15 초 이상 묵어 있어야 한다(AI2 소비자가 오늘 대체로 넘기는 조건).
 * 주 장비가 없거나 모르면 가득이 아니다 — 돕기는 언제나 증거가 있을 때만 연다.
 */
export function helperPrimaryFull(stage: HelperStage, devices: readonly HelperPrimaryDeviceSample[] | null): boolean {
  if (!devices || devices.length === 0) return false;
  return devices.every(device => device.limitSlots > 0 && device.active >= device.limitSlots && device.waiting >= 1
    && (stage !== "ai2" || (device.oldestWaitingAgeMs !== null && device.oldestWaitingAgeMs >= L.ai2PrimaryWaitMinMs)));
}

/** 시간당 섀도 몫이 남았는가(mode ∈ {shadow, live}, shadow_per_hour > 0, 최근 1시간 실행 수 < 몫). */
export function helperShadowAllowed(assignment: Pick<HelperInputs["assignment"], "mode" | "shadowPerHour">, shadowRunsLastHour: number): boolean {
  return (assignment.mode === "shadow" || assignment.mode === "live") && assignment.shadowPerHour > 0
    && Number.isFinite(shadowRunsLastHour) && shadowRunsLastHour < assignment.shadowPerHour;
}

/**
 * 건강 위반 하나(§3.5 4단계). stop 계열이 강등보다 앞선다. 강등 계열은 mode 'live' 일 때만 본다.
 * 표본이 최소 수에 못 미치면 비율로는 멈추지 않는다(연속 미확인은 예외 — 3번 연속이면 표본 수와 상관없이 멈춘다).
 */
export function helperHealthBreach(assignment: HelperInputs["assignment"], health: HelperHealthCounts): HelperStopProposal | null {
  const { dispatch, live, rollingShadow } = health;
  const unknownRate = rate(dispatch.unknown, dispatch.n);
  if (health.consecutiveUnknowns >= L.consecutiveUnknownStop)
    return { effect: "stop", reason: "unknown_rate", evidence: { rule: "consecutive_unknowns", consecutiveUnknowns: health.consecutiveUnknowns,
      limit: L.consecutiveUnknownStop, n: dispatch.n, unknown: dispatch.unknown } };
  if (dispatch.n >= L.minHealthSamples && unknownRate > assignment.maxUnknownRate)
    return { effect: "stop", reason: "unknown_rate", evidence: { rule: "unknown_rate", n: dispatch.n, unknown: dispatch.unknown,
      rate: round(unknownRate), max: assignment.maxUnknownRate } };
  const failures = dispatch.failed + dispatch.notStarted, failureRate = rate(failures, dispatch.n);
  if (dispatch.n >= L.minHealthSamples && failureRate > assignment.maxFailureRate)
    return { effect: "stop", reason: "failure_rate", evidence: { rule: "failure_rate", n: dispatch.n, failed: dispatch.failed,
      notStarted: dispatch.notStarted, rate: round(failureRate), max: assignment.maxFailureRate } };
  if (assignment.mode !== "live") return null;
  const liveN = live.ai2Agreed + live.ai2Disagreed, disagreement = rate(live.ai2Disagreed, liveN);
  if (liveN >= L.minLiveDisagreementSamples && disagreement > assignment.maxLiveDisagreement)
    return { effect: "demote_to_shadow", reason: "quality_regression", evidence: { rule: "ai2_disagreement", n: liveN,
      disagreed: live.ai2Disagreed, rate: round(disagreement), max: assignment.maxLiveDisagreement } };
  const floor = assignment.minAgreement - L.demoteAgreementMargin, agreement = rate(rollingShadow.agreed, rollingShadow.decided);
  if (rollingShadow.decided >= L.minLiveDisagreementSamples && agreement < floor)
    return { effect: "demote_to_shadow", reason: "quality_regression", evidence: { rule: "rolling_shadow_agreement", decided: rollingShadow.decided,
      agreed: rollingShadow.agreed, rate: round(agreement), min: round(floor) } };
  return null;
}

/** 자기 역할이 바쁜가: 장부 규칙(primaryBusy) 또는 beacon backlog > 0. beacon 이 없으면 바쁨(돕기에 대해 fail-closed). */
export function helperOwnRoleBusy(ownRole: HelperInputs["ownRole"]): boolean {
  return ownRole.ledgerBusy || !ownRole.beacon || !ownRole.beaconFresh || ownRole.beacon.backlog > 0;
}

function activeStops(stops: readonly HelperStopRow[], assignmentId: string, version: number) {
  const current = stops.filter(stop => stop.assignmentId === assignmentId && stop.assignmentVersion === version);
  return { hard: current.some(stop => stop.effect === "stop"), demote: current.some(stop => stop.effect === "demote_to_shadow") };
}

/**
 * 신호 metrics. 관리자 화면(WP-2a-C `HELPER_METRIC_KEYS`)이 읽는 이름: primaryFull·primaryActive·primaryLimit·primaryWaiting·primaryDevices·ownBacklog·
 * shadowSamples·shadowAgreement·shadowWrongApproval·shadowWrongRejection·shadowUnknownRate·shadowFailureRate(비율 0–1, 분모가 0 이면 넣지 않는다 →
 * 화면은 —). 나머지 키는 진단용이다.
 */
function decisionMetrics(i: HelperInputs, full: boolean, ownBusy: boolean, shadowOk: boolean): HelperMetrics {
  const devices = i.primaryDevices ?? [];
  const { dispatch, shadow, rollingShadow, live } = i.health;
  const ratio = (key: string, part: number, whole: number): HelperMetrics => whole > 0 ? { [key]: round(part / whole) } : {};
  return {
    ...ratio("shadowAgreement", shadow.agreed, shadow.decided), ...ratio("shadowWrongApproval", shadow.wrongApproval, shadow.decided),
    ...ratio("shadowWrongRejection", shadow.wrongRejection, shadow.decided), ...ratio("shadowUnknownRate", shadow.unknown, shadow.n),
    ...ratio("shadowFailureRate", shadow.failed, shadow.n),
    mode: i.assignment.mode, primaryFull: full, primaryKnown: i.primaryDevices !== null, primaryDevices: devices.length,
    primaryFullDevices: devices.filter(device => device.limitSlots > 0 && device.active >= device.limitSlots && device.waiting >= 1).length,
    primaryActive: devices.reduce((sum, device) => sum + device.active, 0),
    primaryLimit: devices.reduce((sum, device) => sum + device.limitSlots, 0),
    primaryWaiting: devices.reduce((sum, device) => sum + device.waiting, 0),
    ownBusy, ownLedgerBusy: i.ownRole.ledgerBusy, ownBeaconFresh: i.ownRole.beaconFresh, ownBacklog: Math.min(INT_MAX, i.ownRole.beacon?.backlog ?? 0),
    shadowAllowed: shadowOk, shadowRunsLastHour: i.shadowRunsLastHour,
    dispatchN: dispatch.n, dispatchUnknown: dispatch.unknown, dispatchFailed: dispatch.failed, dispatchNotStarted: dispatch.notStarted,
    consecutiveUnknowns: i.health.consecutiveUnknowns,
    shadowSamples: shadow.n, shadowDecided: shadow.decided, shadowAgreed: shadow.agreed,
    rollingDecided: rollingShadow.decided, rollingAgreed: rollingShadow.agreed,
    liveAgreed: live.ai2Agreed, liveDisagreed: live.ai2Disagreed, liveOverturned: live.humanOverturned,
  };
}

/** 배정 하나의 판정(§3.5). */
export function decideHelper(i: HelperInputs): HelperDecision {
  const a = i.assignment, nowIso = new Date(i.nowMs).toISOString();
  const previous = i.previous && i.previous.assignmentId === a.assignmentId ? i.previous : null;
  const continuing = previous !== null && previous.supervisorEpoch === i.epoch && previous.assignmentVersion === a.version
    && timeMs(previous.validUntil) > i.nowMs;
  const stops = activeStops(i.stops, a.assignmentId, a.version);
  const full = helperPrimaryFull(a.stage, i.primaryDevices);
  const ownBusy = helperOwnRoleBusy(i.ownRole);
  const shadowOk = helperShadowAllowed(a, i.shadowRunsLastHour);
  const metrics = decisionMetrics(i, full, ownBusy, shadowOk);
  const lastExit = previous?.lastExitAt ?? null;
  const out = (verdict: HelperVerdict, reason: HelperReason, streak: number, stop: HelperStopProposal | null = null): HelperDecision => ({
    assignmentId: a.assignmentId, assignmentVersion: a.version, verdict, reason, streak: Math.max(0, Math.min(STREAK_MAX, Math.trunc(streak))),
    stateSince: continuing && previous!.verdict === verdict && Number.isFinite(timeMs(previous!.stateSince)) ? previous!.stateSince : nowIso,
    lastExitAt: previous?.verdict === "help" && verdict !== "help" ? nowIso : lastExit,
    metrics, stop,
  });
  const quiet = (reason: HelperReason, streak: number) => out(shadowOk ? "shadow_only" : "hold", reason, streak);

  if (a.mode === "off") return out("hold", "mode_off", 0);
  if (stops.hard) return out("hold", "auto_stopped", 0);
  if (!i.snapshotComplete || i.primaryDevices === null || !i.ownRole.beacon || !i.ownRole.beaconFresh) return out("hold", "stale_inputs", 0);
  const breach = helperHealthBreach(a, i.health);
  if (breach && !(breach.effect === "demote_to_shadow" && stops.demote)) return out("hold", breach.reason, 0, breach);
  if (ownBusy) return out("hold", "helper_own_work", 0);
  const canHelp = a.mode === "live" && !stops.demote;
  if (continuing && previous!.verdict === "help" && canHelp) {
    if (full) return out("help", "primary_full", 0);
    const exitStreak = previous!.streak + 1;
    const dwelled = i.nowMs - timeMs(previous!.stateSince) >= a.minHelpMs;
    return exitStreak >= a.exitSamples && dwelled ? quiet("primary_not_full", 0) : out("help", "primary_not_full", exitStreak);
  }
  const base = continuing && previous!.verdict !== "help" ? previous!.streak : 0;
  const enterStreak = full ? base + 1 : 0;
  const cooled = lastExit === null || i.nowMs - timeMs(lastExit) >= a.reenterCooldownMs;
  if (full && canHelp && enterStreak >= a.enterSamples && cooled) return out("help", "primary_full", 0);
  return quiet(full ? "primary_full" : "primary_not_full", enterStreak);
}

/**
 * 장비 하나의 빌려주기 제한 신호(§3.5 decideDeviceDemand). 그 장비를 가리키는 beacon 중 신선한 것만 본다:
 * primary_demand = 신선한 beacon 의 backlog > 0. 신선한 것이 없으면 false 와 reason 'stale'(있었으나 만료)·'missing'(없음) —
 * Layer A 는 그때 PR 1b 장부 규칙으로 돌아간다(D1: 제한 신호는 막지 않는다).
 */
export function decideDeviceDemand(i: DeviceDemandInputs): DeviceDemandDecision {
  const beacons = i.beacons.filter(beacon => beacon.deviceId === i.deviceId);
  const fresh = beacons.filter(beacon => roleDemandFresh({ nowMs: i.nowMs, beacon }));
  const reason = beacons.length === 0 ? "missing" as const : fresh.length === 0 ? "stale" as const : "fresh" as const;
  const backlog = Math.min(INT_MAX, fresh.reduce((sum, beacon) => sum + Math.max(0, Math.trunc(beacon.backlog)), 0));
  return {
    deviceId: i.deviceId, supervisorEpoch: i.epoch, primaryDemand: fresh.some(beacon => beacon.backlog > 0), backlog,
    metrics: { reason, roles: beacons.length, freshRoles: fresh.length },
  };
}
