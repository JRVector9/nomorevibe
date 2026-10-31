import { describe, expect, it } from 'vitest';
import { HELPER_DECISION_LIMITS, helperAssignmentSchema, type HelperAssignmentRow, type HelperDecision, type HelperHealthCounts, type HelperInputs,
  type HelperPrimaryDeviceSample, type HelperSignalRow, type HelperStopRow, type RoleDemandRow } from '@/lib/llm/capacity-helpers';
import { decideDeviceDemand, decideHelper, helperHealthBreach, helperPrimaryFull, helperShadowAllowed } from '@/lib/operations/capacity-supervisor/decide';

// pr2-plan §3.5: 순수 판정. 시각은 모두 DB 시계 ms(nowMs). 기본 배정: enter 2 · exit 4 · min_help 120 s · 재진입 대기 60 s.
const T0 = Date.parse('2026-10-31T00:00:00.000Z'), LOOP = 15_000, EPOCH = 7;
const at = (ms: number) => new Date(ms).toISOString();
function assignment(changes: Partial<HelperAssignmentRow> = {}): HelperAssignmentRow {
  const input = helperAssignmentSchema.parse({ assignmentId: 'm3-deepseek:ai1', stage: 'ai1', deviceId: 'm3-deepseek', model: 'deepseek',
    shadowRouteId: 'local-helper-shadow-ai1', liveRouteId: 'local-ai1-helper', liveProvider: 'local-direct', mode: 'live' });
  return { ...input, version: 3, evidenceKey: 'a'.repeat(64), promotedAt: at(T0 - 86_400_000), promotedBy: 'admin', updatedBy: 'admin',
    createdAt: at(T0 - 86_400_000), updatedAt: at(T0 - 86_400_000), ...changes };
}
const full: HelperPrimaryDeviceSample[] = [{ deviceId: 'gpu3090-qwen', active: 2, limitSlots: 2, waiting: 3, oldestWaitingAgeMs: null },
  { deviceId: 'supa', active: 1, limitSlots: 1, waiting: 1, oldestWaitingAgeMs: null }];
const notFull: HelperPrimaryDeviceSample[] = [{ ...full[0], active: 1 }, full[1]];
const beacon = (nowMs: number, backlog = 0, changes: Partial<RoleDemandRow> = {}): RoleDemandRow => ({ roleId: 'human-review', deviceId: 'm3-deepseek',
  backlog, oldestAgeMs: null, metrics: {}, observedAt: at(nowMs - 1_000), validUntil: at(nowMs + 149_000), writtenBy: 'nomorevibe', ...changes });
const healthy: HelperHealthCounts = { dispatch: { n: 0, ok: 0, unknown: 0, failed: 0, notStarted: 0 },
  shadow: { n: 0, succeeded: 0, failed: 0, unknown: 0, decided: 0, agreed: 0, wrongApproval: 0, wrongRejection: 0 },
  rollingShadow: { decided: 0, agreed: 0 }, live: { ai2Agreed: 0, ai2Disagreed: 0, humanOverturned: 0 }, consecutiveUnknowns: 0 };
function inputs(changes: Partial<HelperInputs> = {}): HelperInputs {
  const nowMs = changes.nowMs ?? T0;
  return { nowMs, epoch: EPOCH, assignment: assignment(), previous: null, stops: [], snapshotComplete: true, primaryDevices: full,
    ownRole: { ledgerBusy: false, beacon: beacon(nowMs), beaconFresh: true }, health: healthy, shadowRunsLastHour: 0, ...changes };
}
/** 결정을 다음 순환의 이전 신호로 바꾼다(TX-B 가 쓴 것과 같은 모양, valid_until = now + 45 s). */
function signalOf(decision: HelperDecision, nowMs: number, epoch = EPOCH): HelperSignalRow {
  return { assignmentId: decision.assignmentId, assignmentVersion: decision.assignmentVersion, supervisorEpoch: epoch, verdict: decision.verdict,
    reason: decision.reason, streak: decision.streak, stateSince: decision.stateSince, lastExitAt: decision.lastExitAt, metrics: decision.metrics,
    observedAt: at(nowMs), validUntil: at(nowMs + 45_000), writtenBy: 'nomorevibe_oracle_capacity_supervisor' };
}
/** 순환을 이어 돌린다. samples[i] 가 i 번째 순환의 입력 변경. */
function run(samples: Partial<HelperInputs>[], start: { previous?: HelperSignalRow | null; nowMs?: number } = {}): HelperDecision[] {
  let previous = start.previous ?? null, nowMs = start.nowMs ?? T0;
  const out: HelperDecision[] = [];
  for (const sample of samples) {
    const decision = decideHelper(inputs({ ...sample, nowMs, previous, ownRole: sample.ownRole ?? { ledgerBusy: false, beacon: beacon(nowMs), beaconFresh: true } }));
    out.push(decision); previous = signalOf(decision, nowMs); nowMs += LOOP;
  }
  return out;
}
const stop = (effect: HelperStopRow['effect'], version = 3): HelperStopRow => ({ id: 1, assignmentId: 'm3-deepseek:ai1', assignmentVersion: version,
  effect, reason: effect === 'stop' ? 'unknown_rate' : 'quality_regression', evidence: {}, createdAt: at(T0 - 1_000), writtenBy: 'nomorevibe_oracle_capacity_supervisor' });
const verdicts = (decisions: HelperDecision[]) => decisions.map(decision => decision.verdict);

describe('decideHelper precedence', () => {
  it('1 mode off holds even with every other condition favourable', () => {
    expect(decideHelper(inputs({ assignment: assignment({ mode: 'off' }) }))).toMatchObject({ verdict: 'hold', reason: 'mode_off', stop: null });
  });
  it('2 an active stop of the current version holds; an older version stop does not', () => {
    expect(decideHelper(inputs({ stops: [stop('stop')] }))).toMatchObject({ verdict: 'hold', reason: 'auto_stopped' });
    expect(decideHelper(inputs({ stops: [stop('stop', 2)] })).reason).not.toBe('auto_stopped');
  });
  it('3 stale inputs hold: incomplete snapshot, unknown primaries, missing or stale own-role beacon', () => {
    for (const change of [{ snapshotComplete: false }, { primaryDevices: null },
      { ownRole: { ledgerBusy: false, beacon: null, beaconFresh: false } },
      { ownRole: { ledgerBusy: false, beacon: beacon(T0, 0, { validUntil: at(T0 - 1) }), beaconFresh: false } }] as Partial<HelperInputs>[])
      expect(decideHelper(inputs(change))).toMatchObject({ verdict: 'hold', reason: 'stale_inputs', stop: null });
  });
  it('4 health breaches hold and propose a stop; stop beats demote; demote only in live', () => {
    const unknowns = { ...healthy, dispatch: { n: 10, ok: 9, unknown: 1, failed: 0, notStarted: 0 } };
    expect(decideHelper(inputs({ health: unknowns }))).toMatchObject({ verdict: 'hold', reason: 'unknown_rate', stop: { effect: 'stop', reason: 'unknown_rate' } });
    const failures = { ...healthy, dispatch: { n: 10, ok: 8, unknown: 0, failed: 1, notStarted: 1 } };
    expect(decideHelper(inputs({ health: failures }))).toMatchObject({ verdict: 'hold', reason: 'failure_rate', stop: { effect: 'stop' } });
    const disagree = { ...healthy, live: { ai2Agreed: 17, ai2Disagreed: 3, humanOverturned: 0 } };
    expect(decideHelper(inputs({ health: disagree }))).toMatchObject({ verdict: 'hold', reason: 'quality_regression', stop: { effect: 'demote_to_shadow' } });
    expect(decideHelper(inputs({ health: disagree, assignment: assignment({ mode: 'shadow', promotedAt: null }) })).stop).toBeNull();
    expect(decideHelper(inputs({ health: { ...disagree, consecutiveUnknowns: 3 } })).stop).toMatchObject({ effect: 'stop', reason: 'unknown_rate' });
  });
  it('4 an existing demote stop counts as handled: shadow keeps sampling and live help never opens', () => {
    const disagree = { ...healthy, live: { ai2Agreed: 10, ai2Disagreed: 10, humanOverturned: 0 } };
    const decisions = run(Array.from({ length: 6 }, () => ({ health: disagree, stops: [stop('demote_to_shadow')] })));
    expect(new Set(verdicts(decisions))).toEqual(new Set(['shadow_only']));
    expect(decisions.every(decision => decision.stop === null)).toBe(true);
  });
  it('5 own-role work holds at once and overrides the help dwell', () => {
    const helping = run([{}, {}, {}]);
    expect(helping.at(-1)!.verdict).toBe('help');
    const previous = signalOf(helping.at(-1)!, T0 + 2 * LOOP);
    for (const ownRole of [{ ledgerBusy: true, beacon: beacon(T0 + 3 * LOOP), beaconFresh: true },
      { ledgerBusy: false, beacon: beacon(T0 + 3 * LOOP, 4), beaconFresh: true }]) {
      const decision = decideHelper(inputs({ nowMs: T0 + 3 * LOOP, previous, ownRole }));
      expect(decision).toMatchObject({ verdict: 'hold', reason: 'helper_own_work', streak: 0, lastExitAt: at(T0 + 3 * LOOP) });
    }
  });
});

describe('hysteresis', () => {
  it('enters help only after enter_samples full samples', () => {
    const decisions = run([{}, {}, {}]);
    expect(decisions.map(decision => [decision.verdict, decision.reason, decision.streak])).toEqual([
      ['shadow_only', 'primary_full', 1], ['help', 'primary_full', 0], ['help', 'primary_full', 0]]);
    expect(decisions[2].stateSince).toBe(decisions[1].stateSince);
    expect(run([{}, { primaryDevices: notFull }, {}, {}]).map(decision => decision.verdict)).toEqual(['shadow_only', 'shadow_only', 'shadow_only', 'help']);
  });
  it('leaves help only after exit_samples not-full samples and min_help_ms in help', () => {
    // 2 순환으로 들어가고, 바로 여유가 생겨도 120 s(8 순환) 머문다
    const decisions = run([{}, {}, ...Array.from({ length: 10 }, () => ({ primaryDevices: notFull }))]);
    const exit = decisions.findIndex((decision, index) => index > 1 && decision.verdict !== 'help');
    expect(exit).toBeGreaterThan(1);
    expect(T0 + exit * LOOP - Date.parse(decisions[1].stateSince)).toBeGreaterThanOrEqual(120_000);
    expect(decisions[exit]).toMatchObject({ verdict: 'shadow_only', reason: 'primary_not_full', streak: 0, lastExitAt: at(T0 + exit * LOOP) });
    expect(decisions.slice(2, exit).every(decision => decision.verdict === 'help' && decision.reason === 'primary_not_full')).toBe(true);
    // 머무름을 채운 뒤에는 exit_samples(4) 만큼만 더 기다린다
    const dwelled = run([{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, ...Array.from({ length: 6 }, () => ({ primaryDevices: notFull }))]);
    expect(verdicts(dwelled).slice(10)).toEqual(['help', 'help', 'help', 'shadow_only', 'shadow_only', 'shadow_only']);
    // 가득으로 돌아오면 나가기 streak 를 0 으로 되돌린다
    const reset = run([...Array.from({ length: 10 }, () => ({})), { primaryDevices: notFull }, { primaryDevices: notFull }, {},
      { primaryDevices: notFull }, { primaryDevices: notFull }, { primaryDevices: notFull }]);
    expect(reset.slice(10).map(decision => decision.streak)).toEqual([1, 2, 0, 1, 2, 3]);
    expect(verdicts(reset).slice(10).every(verdict => verdict === 'help')).toBe(true);
  });
  it('waits the re-entry cooldown after an exit', () => {
    const previous = signalOf({ ...decideHelper(inputs()), verdict: 'shadow_only', reason: 'primary_not_full', streak: 1, lastExitAt: at(T0 - 30_000) }, T0 - LOOP);
    const decisions = run([{}, {}, {}, {}], { previous });
    // 들어가기 streak 는 이미 2 이지만 마지막 나감 뒤 60 s 전에는 들어가지 않는다
    expect(verdicts(decisions)).toEqual(['shadow_only', 'shadow_only', 'help', 'help']);
    expect(T0 + 2 * LOOP - (T0 - 30_000)).toBeGreaterThanOrEqual(60_000);
  });
  it('a new epoch, a new assignment version or an expired previous signal starts streaks again from zero', () => {
    const helping = run([{}, {}, {}]).at(-1)!;
    const nowMs = T0 + 3 * LOOP;
    for (const previous of [signalOf(helping, nowMs - LOOP, EPOCH - 1), { ...signalOf(helping, nowMs - LOOP), assignmentVersion: 2 },
      { ...signalOf(helping, nowMs - LOOP), validUntil: at(nowMs - 1) }]) {
      const decision = decideHelper(inputs({ nowMs, previous, ownRole: { ledgerBusy: false, beacon: beacon(nowMs), beaconFresh: true } }));
      expect(decision).toMatchObject({ verdict: 'shadow_only', reason: 'primary_full', streak: 1, stateSince: at(nowMs) });
      // 'help' 에서 벗어난 것으로 보고 재진입 대기를 지킨다
      expect(decision.lastExitAt).toBe(at(nowMs));
    }
  });
  it('does not flap: alternating full/not-full over 50 samples yields at most 2 transitions', () => {
    for (const enterSamples of [1, 2]) {
      const decisions = run(Array.from({ length: 50 }, (_, index) => ({ primaryDevices: index % 2 ? notFull : full,
        assignment: assignment({ enterSamples }) })));
      const transitions = decisions.slice(1).filter((decision, index) => decision.verdict !== decisions[index].verdict).length;
      expect(transitions, `enter ${enterSamples}`).toBeLessThanOrEqual(2);
    }
  });
  it('helps only in live mode without a demote stop; shadow mode samples shadow within its hourly quota', () => {
    const shadowMode = assignment({ mode: 'shadow', promotedAt: null });
    expect(verdicts(run(Array.from({ length: 5 }, () => ({ assignment: shadowMode }))))).toEqual(Array(5).fill('shadow_only'));
    expect(decideHelper(inputs({ assignment: shadowMode, shadowRunsLastHour: 30 }))).toMatchObject({ verdict: 'hold', reason: 'primary_full' });
    expect(decideHelper(inputs({ assignment: assignment({ shadowPerHour: 0 }), primaryDevices: notFull })))
      .toMatchObject({ verdict: 'hold', reason: 'primary_not_full' });
  });
});

describe('helpers of the decision', () => {
  it('needs every primary device full with a waiting row; none or unknown is never full; AI2 needs a 15 s old wait', () => {
    expect(helperPrimaryFull('ai1', full)).toBe(true);
    expect(helperPrimaryFull('ai1', notFull)).toBe(false);
    expect(helperPrimaryFull('ai1', [{ ...full[0], waiting: 0 }])).toBe(false);
    expect(helperPrimaryFull('ai1', [])).toBe(false);
    expect(helperPrimaryFull('ai1', null)).toBe(false);
    expect(helperPrimaryFull('ai1', [{ ...full[0], limitSlots: 0, active: 0 }])).toBe(false);
    const aged = { ...full[0], oldestWaitingAgeMs: HELPER_DECISION_LIMITS.ai2PrimaryWaitMinMs };
    expect(helperPrimaryFull('ai2', [aged])).toBe(true);
    expect(helperPrimaryFull('ai2', [{ ...aged, oldestWaitingAgeMs: 14_999 }])).toBe(false);
    expect(helperPrimaryFull('ai2', [{ ...aged, oldestWaitingAgeMs: null }])).toBe(false);
  });
  it('applies minimum samples to the rate stops but not to consecutive unknowns', () => {
    const a = assignment();
    expect(helperHealthBreach(a, { ...healthy, dispatch: { n: 9, ok: 0, unknown: 9, failed: 0, notStarted: 0 } })).toBeNull();
    expect(helperHealthBreach(a, { ...healthy, consecutiveUnknowns: 2 })).toBeNull();
    expect(helperHealthBreach(a, { ...healthy, consecutiveUnknowns: 3 })).toMatchObject({ effect: 'stop', evidence: { rule: 'consecutive_unknowns' } });
    expect(helperHealthBreach(a, { ...healthy, dispatch: { n: 50, ok: 49, unknown: 1, failed: 0, notStarted: 0 } })).toBeNull();
    expect(helperHealthBreach(a, { ...healthy, dispatch: { n: 9, ok: 0, unknown: 0, failed: 9, notStarted: 0 } })).toBeNull();
    expect(helperHealthBreach(a, { ...healthy, dispatch: { n: 10, ok: 9, unknown: 0, failed: 1, notStarted: 0 } })).toBeNull();
    expect(helperHealthBreach(a, { ...healthy, live: { ai2Agreed: 10, ai2Disagreed: 9, humanOverturned: 0 } })).toBeNull();
    expect(helperHealthBreach(a, { ...healthy, rollingShadow: { decided: 19, agreed: 0 } })).toBeNull();
    expect(helperHealthBreach(a, { ...healthy, rollingShadow: { decided: 100, agreed: 90 } })).toBeNull();
    expect(helperHealthBreach(a, { ...healthy, rollingShadow: { decided: 100, agreed: 89 } }))
      .toMatchObject({ effect: 'demote_to_shadow', reason: 'quality_regression', evidence: { rule: 'rolling_shadow_agreement' } });
  });
  it('allows shadow only for shadow/live modes with quota left', () => {
    expect(helperShadowAllowed({ mode: 'off', shadowPerHour: 30 }, 0)).toBe(false);
    expect(helperShadowAllowed({ mode: 'shadow', shadowPerHour: 30 }, 29)).toBe(true);
    expect(helperShadowAllowed({ mode: 'live', shadowPerHour: 30 }, 30)).toBe(false);
  });
  it('writes the flat metric keys the admin helper table reads (WP-2a-C HELPER_METRIC_KEYS); shadow ratios only with samples', () => {
    const empty = decideHelper(inputs()).metrics;
    expect(empty).toMatchObject({ primaryFull: true, primaryActive: 3, primaryLimit: 3, primaryWaiting: 4, primaryDevices: 2, ownBacklog: 0, shadowSamples: 0 });
    for (const key of ['shadowAgreement', 'shadowWrongApproval', 'shadowWrongRejection', 'shadowUnknownRate', 'shadowFailureRate']) expect(empty).not.toHaveProperty(key);
    const shadow = { n: 200, succeeded: 190, failed: 4, unknown: 6, decided: 180, agreed: 171, wrongApproval: 2, wrongRejection: 7 };
    expect(decideHelper(inputs({ health: { ...healthy, shadow } })).metrics).toMatchObject({ shadowSamples: 200, shadowAgreement: 0.95,
      shadowWrongApproval: 0.0111, shadowWrongRejection: 0.0389, shadowUnknownRate: 0.03, shadowFailureRate: 0.02 });
  });
  it('keeps metrics within the signal size and only scalar values', () => {
    const decision = decideHelper(inputs());
    expect(Buffer.byteLength(JSON.stringify(decision.metrics))).toBeLessThan(2048);
    expect(Object.values(decision.metrics).every(value => ['number', 'string', 'boolean'].includes(typeof value))).toBe(true);
  });
});

describe('decideDeviceDemand', () => {
  const device = (changes: Partial<RoleDemandRow> = {}) => beacon(T0, 0, changes);
  it('raises primary demand only from a fresh beacon with backlog', () => {
    expect(decideDeviceDemand({ nowMs: T0, epoch: EPOCH, deviceId: 'm3-deepseek', beacons: [device({ backlog: 5 })] }))
      .toEqual({ deviceId: 'm3-deepseek', supervisorEpoch: EPOCH, primaryDemand: true, backlog: 5, metrics: { reason: 'fresh', roles: 1, freshRoles: 1 } });
    expect(decideDeviceDemand({ nowMs: T0, epoch: EPOCH, deviceId: 'm3-deepseek', beacons: [device()] }))
      .toMatchObject({ primaryDemand: false, backlog: 0, metrics: { reason: 'fresh' } });
  });
  it('writes false with stale or missing so Layer A falls back to the ledger rule', () => {
    expect(decideDeviceDemand({ nowMs: T0, epoch: EPOCH, deviceId: 'm3-deepseek', beacons: [device({ backlog: 5, validUntil: at(T0) })] }))
      .toMatchObject({ primaryDemand: false, backlog: 0, metrics: { reason: 'stale', roles: 1, freshRoles: 0 } });
    expect(decideDeviceDemand({ nowMs: T0, epoch: EPOCH, deviceId: 'm3-deepseek', beacons: [device({ deviceId: 'ai1-pool', backlog: 9 })] }))
      .toMatchObject({ primaryDemand: false, metrics: { reason: 'missing', roles: 0 } });
  });
});
