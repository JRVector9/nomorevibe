import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ModelCapacityDeviceState } from '@/lib/llm/capacity-devices';
import { helperAssignmentSchema, ROLE_DEMAND_BEACONS, SUPERVISOR_PRINCIPAL, type HelperAssignmentRow, type RoleDemandRow } from '@/lib/llm/capacity-helpers';
import { planSupervisorSignals, runCapacitySupervisor, type CapacitySupervisorDeps } from '@/lib/operations/capacity-supervisor/loop';
import { boundedJson, supervisorPrincipalAllowed, type SupervisorLease, type SupervisorWriteResult } from '@/lib/operations/capacity-supervisor/repository';
import { helperHealthCounts, helperOwnRoleBeacon, helperPrimaryDevices, supervisorDeviceDemandInputs, supervisorHelperInputs,
  type HelperLedgerRow, type HelperShadowStats, type SupervisorSnapshot } from '@/lib/operations/capacity-supervisor/snapshot';

// pr2-plan §3.3–3.4: 스냅샷 → 입력(순수)과 순환(가짜 의존성). 실제 SQL·권한은 tests/integration/capacity-supervisor.test.ts.
const T0 = Date.parse('2026-10-31T00:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();
const owner = { instanceId: 'capacity-supervisor-consumer-oracle', bootId: '00000000-0000-4000-8000-000000000001', release: 'a'.repeat(40) };
function row(stage: 'ai1' | 'ai2', changes: Partial<HelperAssignmentRow> = {}): HelperAssignmentRow {
  const defaults = stage === 'ai1' ? { shadowRouteId: 'local-helper-shadow-ai1', liveRouteId: 'local-ai1-helper' }
    : { shadowRouteId: 'local-helper-shadow-ai2', liveRouteId: 'second-review' };
  const input = helperAssignmentSchema.parse({ assignmentId: `m3-deepseek:${stage}`, stage, deviceId: 'm3-deepseek', model: 'deepseek',
    liveProvider: 'local-direct', mode: 'shadow', ...defaults });
  return { ...input, version: 2, evidenceKey: 'b'.repeat(64), promotedAt: null, promotedBy: null, updatedBy: 'admin', createdAt: at(T0 - 3_600_000),
    updatedAt: at(T0 - 3_600_000), ...changes };
}
const device = (deviceId: string, changes: Partial<ModelCapacityDeviceState> = {}): ModelCapacityDeviceState => ({ deviceId, source: 'table',
  limitSlots: 1, secondaryCap: 0, idleMs: 60_000, reserveSlots: 0, active: 1, secondaryActive: 0, secondaryBound: 0, primaryBusy: false, lending: false,
  waiting: 1, waitingPrimary: 1, version: 1, updatedAt: at(T0), ...changes });
const demand = (roleId: string, deviceId: string, changes: Partial<RoleDemandRow> = {}): RoleDemandRow => ({ roleId, deviceId, backlog: 0, oldestAgeMs: null,
  metrics: {}, observedAt: at(T0 - 1_000), validUntil: at(T0 + 30_000), writtenBy: 'nomorevibe', ...changes });
const shadowStats = (assignmentId: string, changes: Partial<HelperShadowStats> = {}): HelperShadowStats => ({ assignmentId, lastHour: 0, n: 0,
  succeeded: 0, failed: 0, unknown: 0, decided: 0, agreed: 0, wrongApproval: 0, wrongRejection: 0, rollingDecided: 0, rollingAgreed: 0, failedRecent: 0,
  recentStates: [], ...changes });
function snapshot(changes: Partial<SupervisorSnapshot> = {}): SupervisorSnapshot {
  const assignments = changes.assignments ?? [row('ai1'), row('ai2')];
  return { nowMs: T0, control: { enabled: true, signalPrincipal: SUPERVISOR_PRINCIPAL, signalTtlMs: 45_000, loopMs: 15_000, ownerInstanceId: owner.instanceId,
    ownerBootId: owner.bootId, epoch: 4, leaseUntil: at(T0 + 45_000), heartbeatAt: at(T0), loopSeq: 9, release: null, updatedBy: 'admin', updatedAt: at(T0) },
  routes: [{ routeId: 'second-review', provider: 'local-direct', model: 'qwen', groupId: 'gpu3090-qwen' },
    { routeId: 'second-review', provider: 'local-direct', model: 'deepseek', groupId: 'm3-deepseek' },
    { routeId: 'second-review', provider: 'abcllm', model: 'x', groupId: 'abcllm-pool' }],
  deviceStates: [device('m3-deepseek', { waiting: 0, active: 0 }), device('gpu3090-qwen'), device('supa')],
  assignments, signals: [], stops: [],
  roleDemand: [demand('human-review', 'm3-deepseek'), demand('ai1', ROLE_DEMAND_BEACONS.ai1.deviceId, { metrics: { devices: ['supa', 'm3-deepseek'] } })],
  ledger: [], ai2Waiting: [{ deviceId: 'gpu3090-qwen', waiting: 1, oldestAgeMs: 20_000 }],
  shadow: assignments.map(value => shadowStats(value.assignmentId)), live: assignments.map(value => ({ assignmentId: value.assignmentId,
    ai2Agreed: 0, ai2Disagreed: 0, humanOverturned: 0 })), ...changes };
}

describe('snapshot builders', () => {
  it('takes AI1 primaries from the fresh AI1 beacon and AI2 primaries from local-direct second-review routes, never the helper device', () => {
    const s = snapshot();
    expect(helperPrimaryDevices(s, row('ai1'))).toEqual([{ deviceId: 'supa', active: 1, limitSlots: 1, waiting: 1, oldestWaitingAgeMs: null }]);
    expect(helperPrimaryDevices(s, row('ai2'))).toEqual([{ deviceId: 'gpu3090-qwen', active: 1, limitSlots: 1, waiting: 1, oldestWaitingAgeMs: 20_000 }]);
    // beacon 이 만료·없음·모양 틀림 ⇒ 모름(null), 나열된 장비 상태가 없음 ⇒ 모름
    for (const roleDemand of [[], [demand('ai1', 'ai1-pool', { metrics: { devices: ['supa'] }, validUntil: at(T0) })],
      [demand('ai1', 'ai1-pool', { metrics: { devices: 'supa' } })], [demand('ai1', 'ai1-pool', { metrics: { devices: ['nowhere'] } })]])
      expect(helperPrimaryDevices({ ...s, roleDemand }, row('ai1'))).toBeNull();
    expect(helperPrimaryDevices({ ...s, routes: [] }, row('ai2'))).toEqual([]);
  });
  it('merges several own-role beacons conservatively (sum backlog, earliest expiry)', () => {
    const rows = [demand('human-review', 'm3-deepseek', { backlog: 2, validUntil: at(T0 + 9_000) }), demand('x', 'm3-deepseek', { backlog: 3 })];
    expect(helperOwnRoleBeacon(rows, 'm3-deepseek')).toMatchObject({ roleId: 'human-review+x', backlog: 5, validUntil: at(T0 + 9_000) });
    expect(helperOwnRoleBeacon(rows, 'supa')).toBeNull();
  });
  it('counts settled, indeterminate and withdrawn-after-dispatch rows; failures come from the shadow window; leading unknowns', () => {
    const ledger: HelperLedgerRow[] = [
      { assignmentId: 'a', kind: 'shadow', state: 'indeterminate', dispatched: true, at: at(T0 - 1_000) },
      { assignmentId: 'a', kind: 'shadow', state: 'indeterminate', dispatched: true, at: at(T0 - 2_000) },
      { assignmentId: 'a', kind: 'live', state: 'withdrawn', dispatched: false, at: at(T0 - 2_500) },
      { assignmentId: 'a', kind: 'shadow', state: 'settled', dispatched: true, at: at(T0 - 3_000) },
      { assignmentId: 'a', kind: 'shadow', state: 'settled', dispatched: true, at: at(T0 - 4_000) },
      { assignmentId: 'a', kind: 'live', state: 'withdrawn', dispatched: true, at: at(T0 - 5_000) },
      { assignmentId: 'b', kind: 'shadow', state: 'indeterminate', dispatched: true, at: at(T0) }];
    const counts = helperHealthCounts('a', ledger, shadowStats('a', { failedRecent: 5, recentStates: ['unknown', 'unknown', 'unknown', 'succeeded'] }), undefined);
    expect(counts.dispatch).toEqual({ n: 5, ok: 0, unknown: 2, failed: 2, notStarted: 1 });
    expect(counts.consecutiveUnknowns).toBe(3);
    expect(helperHealthCounts('a', ledger, undefined, undefined).consecutiveUnknowns).toBe(2);
  });
  it('builds inputs per assignment and marks a missing helper device state incomplete; device demand only for helper devices not off', () => {
    const s = snapshot({ assignments: [row('ai1'), row('ai2', { deviceId: 'm1-qwen', assignmentId: 'm1-qwen:ai2', mode: 'off' })] });
    const built = supervisorHelperInputs(s, 4);
    expect(built.map(value => [value.assignment.assignmentId, value.snapshotComplete, value.ownRole.beaconFresh])).toEqual([
      ['m3-deepseek:ai1', true, true], ['m1-qwen:ai2', false, false]]);
    expect(built[1].ownRole).toMatchObject({ ledgerBusy: true, beacon: null });
    expect(supervisorDeviceDemandInputs(s, 4).map(value => value.deviceId)).toEqual(['m3-deepseek']);
  });
});

describe('planSupervisorSignals', () => {
  it('decides every assignment and every active helper device in one plan', () => {
    const plan = planSupervisorSignals(snapshot(), 4);
    expect(plan.helpers.map(decision => [decision.assignmentId, decision.verdict, decision.reason])).toEqual([
      ['m3-deepseek:ai1', 'shadow_only', 'primary_full'], ['m3-deepseek:ai2', 'shadow_only', 'primary_full']]);
    expect(plan.devices).toEqual([{ deviceId: 'm3-deepseek', supervisorEpoch: 4, primaryDemand: false, backlog: 0,
      metrics: { reason: 'fresh', roles: 1, freshRoles: 1 } }]);
  });
  it('bounds the jsonb payloads', () => {
    expect(boundedJson({ a: 1 })).toBe('{"a":1}');
    expect(JSON.parse(boundedJson({ big: 'x'.repeat(5_000) }))).toEqual({ truncated: true, keys: 1 });
  });
});

function baseFakes() {
  const lease: SupervisorLease = { kind: 'owner', epoch: 4, enabled: true, signalTtlMs: 45_000, loopMs: 15_000, signalPrincipal: SUPERVISOR_PRINCIPAL,
    principalOk: true, leaseUntil: at(T0 + 45_000), loopSeq: 10 };
  const written: SupervisorWriteResult = { kind: 'written', helpers: 2, devices: 1, stops: 0, skipped: 0, signalTtlMs: 45_000 };
  return {
    readPrincipal: vi.fn(async () => ({ currentUser: SUPERVISOR_PRINCIPAL, sessionUser: SUPERVISOR_PRINCIPAL })),
    acquireLease: vi.fn(async () => lease), readSnapshot: vi.fn(async () => snapshot()), writeSignals: vi.fn(async () => written),
    observe: vi.fn(async (key: string, value: Record<string, unknown>) => { void key; void value; }),
    sleep: vi.fn(async (ms: number, signal?: AbortSignal) => { void ms; void signal; }), clock: vi.fn(() => 0),
  } satisfies CapacitySupervisorDeps;
}
type Fakes = ReturnType<typeof baseFakes>;
const fakes = (overrides: Partial<Record<keyof Fakes, Mock>> = {}): Fakes => ({ ...baseFakes(), ...overrides }) as Fakes;

describe('runCapacitySupervisor', () => {
  it.each([['nomorevibe', 'nomorevibe'], ['nomorevibe_oracle_uptime', 'nomorevibe_oracle_uptime'], [SUPERVISOR_PRINCIPAL, 'nomorevibe']])(
    'refuses to run as %s (session %s) before taking any lease or writing anything', async (currentUser, sessionUser) => {
      const deps = fakes({ readPrincipal: vi.fn(async () => ({ currentUser, sessionUser })) });
      await expect(runCapacitySupervisor({ owner, once: true, deps })).rejects.toThrow('supervisor_principal_mismatch');
      expect(deps.acquireLease).not.toHaveBeenCalled(); expect(deps.writeSignals).not.toHaveBeenCalled(); expect(deps.observe).not.toHaveBeenCalled();
    });
  it('allows only the exact supervisor principal on its own session', () => {
    expect(supervisorPrincipalAllowed({ currentUser: SUPERVISOR_PRINCIPAL, sessionUser: SUPERVISOR_PRINCIPAL })).toBe(true);
    expect(supervisorPrincipalAllowed({ currentUser: 'nomorevibe', sessionUser: 'nomorevibe' })).toBe(false);
  });
  it('as owner reads one snapshot, writes the decided plan under the lease epoch and observes the verdicts', async () => {
    const deps = fakes();
    const summary = await runCapacitySupervisor({ owner, once: true, deps });
    expect(summary).toMatchObject({ loops: 1, written: 1, failures: 0 });
    expect(deps.writeSignals).toHaveBeenCalledExactlyOnceWith(owner, 4, planSupervisorSignals(snapshot(), 4));
    const [key, value] = deps.observe.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(key).toBe('capacity-supervisor:capacity-supervisor-consumer-oracle');
    expect(value).toMatchObject({ state: 'running', epoch: 4, bootId: owner.bootId, verdicts: { 'm3-deepseek:ai1': 'shadow_only:primary_full' },
      devices: { 'm3-deepseek': false } });
  });
  it.each([
    ['standby', { kind: 'standby', ownerInstanceId: 'capacity-supervisor-consumer-other', leaseUntil: at(T0 + 9_000), loopMs: 15_000, epoch: 3 }],
    ['disabled', { kind: 'owner', epoch: 4, enabled: false, signalTtlMs: 45_000, loopMs: 15_000, signalPrincipal: SUPERVISOR_PRINCIPAL, principalOk: true,
      leaseUntil: at(T0 + 45_000), loopSeq: 3 }],
    ['fenced', { kind: 'fenced', reason: 'operator_fence' }], ['control_missing', { kind: 'control_missing' }],
  ] as [string, SupervisorLease][])('writes no signal when %s (helpers close within the TTL)', async (state, lease) => {
    const deps = fakes({ acquireLease: vi.fn(async () => lease) });
    await runCapacitySupervisor({ owner, once: true, deps });
    expect(deps.readSnapshot).not.toHaveBeenCalled(); expect(deps.writeSignals).not.toHaveBeenCalled();
    expect((deps.observe.mock.calls[0] as unknown as [string, { state: string }])[1].state).toBe(state);
  });
  it('fails closed on any error: nothing written, the loop continues and records the failure', async () => {
    const deps = fakes({ readSnapshot: vi.fn().mockRejectedValueOnce(new Error('statement timeout')).mockResolvedValue(snapshot()) });
    const controller = new AbortController();
    let rounds = 0;
    deps.sleep.mockImplementation(async () => { if (++rounds >= 2) controller.abort(); });
    const summary = await runCapacitySupervisor({ owner, deps, signal: controller.signal });
    expect(summary).toMatchObject({ failures: 1, written: 1 });
    expect(deps.writeSignals).toHaveBeenCalledOnce();
    const states = deps.observe.mock.calls.map(call => (call as unknown as [string, { state: string; lastError: string | null }])[1]);
    expect(states[0]).toMatchObject({ state: 'error', lastError: 'statement_timeout' });
    expect(states.at(-1)!.state).toBe('stopped');
  });
  it('stops on a principal mismatch reported by the lease or the write', async () => {
    const lease = { kind: 'owner', epoch: 4, enabled: true, signalTtlMs: 45_000, loopMs: 15_000, signalPrincipal: 'someone_else', principalOk: false,
      leaseUntil: at(T0), loopSeq: 1 } as const;
    const first = fakes({ acquireLease: vi.fn(async () => lease) });
    await expect(runCapacitySupervisor({ owner, once: true, deps: first })).rejects.toThrow('supervisor_principal_mismatch');
    expect(first.writeSignals).not.toHaveBeenCalled();
    const second = fakes({ writeSignals: vi.fn(async () => ({ kind: 'principal_mismatch' as const })) });
    await expect(runCapacitySupervisor({ owner, once: true, deps: second })).rejects.toThrow('supervisor_principal_mismatch');
  });
  it('reports lease loss without retrying the write and sleeps in supervisor-friendly slices', async () => {
    const deps = fakes({ writeSignals: vi.fn(async () => ({ kind: 'lease_lost' as const })),
      acquireLease: vi.fn(async () => ({ kind: 'owner', epoch: 4, enabled: true, signalTtlMs: 120_000, loopMs: 60_000,
        signalPrincipal: SUPERVISOR_PRINCIPAL, principalOk: true, leaseUntil: at(T0), loopSeq: 1 }) as SupervisorLease) });
    const controller = new AbortController();
    const report = vi.fn();
    deps.sleep.mockImplementation(async () => { if (deps.sleep.mock.calls.length >= 2) controller.abort(); });
    const summary = await runCapacitySupervisor({ owner, deps, report, signal: controller.signal });
    expect(summary.leaseLost).toBe(1); expect(deps.writeSignals).toHaveBeenCalledOnce();
    expect(deps.sleep.mock.calls.map(call => call[0])).toEqual([30_000, 30_000]);
    expect(report).toHaveBeenCalledWith('idle');
  });
});
