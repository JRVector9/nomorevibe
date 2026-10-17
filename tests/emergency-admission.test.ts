import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HostDbBudget } from '@/lib/db/host-budget';
import { emergencyAdmissionConfig, emergencyJobDecision, emergencyTakeoverAllowed, type EmergencyJobRow } from '@/lib/operations/emergency-admission';
import { assertHostBudgetEntrySupported, hostBudgetShape, readHostLedger } from '@/lib/operations/host-budget';
import { startHostBudget } from '@/lib/operations/host-budget-runtime';

/**
 * PR16b — 비상 admission 을 host 장부(PR10e)에 잇는다. 설정이 없으면 기존과 같고, 켜면 Oracle host 에서만, 예산·검증 모델 잡을
 * 모두 명시해야 한다. 판정은 claim 전에만 하고 진행 중 작업을 끊지 않는다. recovering 에서는 새 인계 역할을 가져가지 않는다.
 */
const budget = { jobs: 1, modelJobs: 1, httpJobs: 1, agingMs: 600_000 };
const enabled = (patch: Record<string, unknown> = {}) => JSON.stringify({ mode: 'enabled', budget, verifiedModelJobs: ['product-translate'], ...patch });
const oracle = { PHYSICAL_HOST: 'oracle-osaka-smoke' };

describe('비상 admission 설정', () => {
  it('없으면 비활성이고, 켤 때는 Oracle host 에서 예산 네 값과 검증 모델 잡 목록을 모두 적어야 한다', () => {
    expect(emergencyAdmissionConfig({})).toEqual({ mode: 'disabled' });
    expect(emergencyAdmissionConfig({ EMERGENCY_ADMISSION: '{"mode":"disabled"}', PHYSICAL_HOST: 'm3' })).toEqual({ mode: 'disabled' });
    expect(emergencyAdmissionConfig({ ...oracle, EMERGENCY_ADMISSION: enabled() }))
      .toEqual({ mode: 'enabled', budget, verifiedModelJobs: ['product-translate'] });
    expect(emergencyAdmissionConfig({ ...oracle, EMERGENCY_ADMISSION: enabled({ verifiedModelJobs: [] }) })).toMatchObject({ verifiedModelJobs: [] });
    const { agingMs: _omitted, ...partial } = budget;
    for (const raw of ['', 'null', '{"mode":"enabled"}', enabled({ budget: partial }), enabled({ budget: { ...budget, jobs: -1 } }),
      enabled({ budget: { ...budget, httpJobs: 1.5 } }), enabled({ budget: { ...budget, extra: 1 } }), enabled({ verifiedModelJobs: undefined }),
      enabled({ verifiedModelJobs: ['uptime-ping'] }), enabled({ verifiedModelJobs: ['no-such-job'] }),
      enabled({ verifiedModelJobs: ['product-translate', 'product-translate'] }), enabled({ extra: true }), enabled({ pad: 'x'.repeat(5_000) })]) {
      expect(() => emergencyAdmissionConfig({ ...oracle, EMERGENCY_ADMISSION: raw }), raw.slice(0, 60)).toThrow('emergency_admission_invalid');
    }
    expect(_omitted).toBe(600_000);
    for (const host of [undefined, 'm3', 'mini']) {
      expect(() => emergencyAdmissionConfig({ PHYSICAL_HOST: host, EMERGENCY_ADMISSION: enabled() })).toThrow('emergency_admission_invalid');
    }
  });

  it('host 장부 없이 켜진 설정이나 장부에 참여하지 않는 진입점은 조용히 무시하지 않고 거절한다', () => {
    expect(() => startHostBudget({ ...oracle, EMERGENCY_ADMISSION: enabled() })).toThrow('emergency_admission_invalid');
    expect(startHostBudget({ ...oracle, EMERGENCY_ADMISSION: '{"mode":"disabled"}' }).enabled).toBe(false);
    expect(() => assertHostBudgetEntrySupported({ ...oracle, EMERGENCY_ADMISSION: enabled() })).toThrow('host_budget_entry_unsupported');
    expect(() => assertHostBudgetEntrySupported({ ...oracle, EMERGENCY_ADMISSION: '{"mode":"disabled"}' })).not.toThrow();
  });
});

describe('host 장부의 비상 slot', () => {
  const pressure = { maxLoadPerCpu: 4, maxHostRssBytes: 8_000, maxEventLoopDelayMs: 500, maxHeartbeatGapMs: 20_000 };
  const policy: HostDbBudget = { version: 1, host: 'oracle-osaka-smoke', release: 'r1', roles: ['translation', 'text'],
    schedulerReplicas: 0, webReplicas: 0, webReadReplica: false, monitor: false, connectAgent: false,
    preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 };
  const prefix = 'host-slot:oracle-osaka-smoke';

  it('비활성 shape 는 PR10e 와 같고, 켜면 같은 host 의 모든 프로세스가 같은 예산·검증 목록이어야 한다', () => {
    const shape = hostBudgetShape(policy, pressure);
    expect(hostBudgetShape(policy, pressure, undefined)).toBe(shape);
    const config = { budget, verifiedModelJobs: ['product-translate', 'reason-translate'] };
    const withEmergency = hostBudgetShape(policy, pressure, config);
    expect(withEmergency).not.toBe(shape);
    expect(hostBudgetShape(policy, pressure, { budget, verifiedModelJobs: ['reason-translate', 'product-translate'] })).toBe(withEmergency);
    expect(hostBudgetShape(policy, pressure, { ...config, budget: { ...budget, jobs: 2 } })).not.toBe(withEmergency);
    expect(hostBudgetShape(policy, pressure, { ...config, verifiedModelJobs: ['product-translate'] })).not.toBe(withEmergency);
  });

  it('비상 slot 행은 :e:<n> 자리에서만 읽고, 어긋난 행은 장부 전체를 무효로 본다', () => {
    const shape = hostBudgetShape(policy, pressure, { budget, verifiedModelJobs: [] });
    const slot = { type: 'emergency', bootId: randomUUID(), shape, token: randomUUID(), job: 'uptime-ping', owner: 'worker:maintenance:-:1:1', holdMs: 1, leaseUntilMs: 5 };
    expect(readHostLedger('oracle-osaka-smoke', [{ key: `${prefix}:e:1`, value: slot }], 0)).toEqual({ ok: true, live: [{ ...slot, key: `${prefix}:e:1` }], expired: [] });
    expect(readHostLedger('oracle-osaka-smoke', [{ key: `${prefix}:e:2`, value: slot }], 5)).toEqual({ ok: true, live: [], expired: [`${prefix}:e:2`] });
    const translation = { ...slot, type: 'translation' };
    for (const row of [{ key: `${prefix}:e:0`, value: slot }, { key: `${prefix}:e:x`, value: slot }, { key: `${prefix}:t:1`, value: slot },
      { key: `${prefix}:e:1`, value: translation }, { key: `${prefix}:e:1`, value: { ...slot, token: 'x' } }]) {
      expect(readHostLedger('oracle-osaka-smoke', [row], 0), row.key).toEqual({ ok: false });
    }
  });
});

describe('비상 잡 판정(DB 행 → 순수 판정)', () => {
  const config = { mode: 'enabled' as const, budget, verifiedModelJobs: ['product-translate'] };
  const row = (name: string, patch: Partial<EmergencyJobRow> = {}): EmergencyJobRow =>
    ({ name, pending: true, running: false, paused: false, sinceRunMs: 60_000, ...patch });
  // nowMs 는 DB clock_timestamp 의 float8 ms 라 소수가 붙는다
  const base: Omit<Parameters<typeof emergencyJobDecision>[0], 'job' | 'rows'> = { mode: 'full', config, embedding: 'legacy', hostPressure: null, slots: [], nowMs: 1_800_000_000_000.625 };

  it('정상·부분 장애에서는 끼어들지 않는다', () => {
    for (const mode of ['normal', 'partial'] as const) {
      expect(emergencyJobDecision({ ...base, mode, job: 'reason-translate', rows: [row('reason-translate')] })).toEqual({ active: false });
    }
  });

  it('검증되지 않은 모델 잡·정지 분류·사람 pause·writer hold 는 claim 전에 미룬다', () => {
    const decide = (job: string, patch: Partial<typeof base> = {}, rows = [row(job)]) => emergencyJobDecision({ ...base, ...patch, job, rows });
    expect(decide('reason-translate')).toMatchObject({ active: true, slot: false, decision: { admitted: false, reason: 'model_unverified' } });
    expect(decide('product-translate')).toMatchObject({ active: true, slot: true, decision: { admitted: true, reason: 'admitted' } });
    expect(decide('product-repo-review')).toMatchObject({ decision: { admitted: false, reason: 'suspended' } });
    expect(decide('uptime-ping', {}, [row('uptime-ping', { paused: true })])).toMatchObject({ decision: { admitted: false, reason: 'paused_preserved' } });
    expect(decide('uptime-ping', { mode: 'hold' })).toMatchObject({ decision: { admitted: false, reason: 'hold_control_only' } });
    expect(decide('uptime-ping', { mode: 'recovering' })).toMatchObject({ slot: true, decision: { admitted: true } });
    expect(decide('product-embedding', { embedding: 'degraded' })).toMatchObject({ decision: { admitted: false, reason: 'embedding_not_semantic' } });
    expect(decide('uptime-ping', { hostPressure: 'host_pressure_rss' })).toMatchObject({ decision: { admitted: false, reason: 'host_pressure' } });
    // 제어 단계는 예산 밖이라 slot 을 잡지 않는다
    expect(decide('heartbeat', { mode: 'hold' })).toMatchObject({ slot: false, decision: { admitted: true, tier: 'control' } });
  });

  it('실행 중인 잡(장부 slot 이든 jobs 잠금이든)은 남은 몫에서 빼고 due 에서도 뺀다', () => {
    expect(emergencyJobDecision({ ...base, job: 'cdn-purge', slots: ['uptime-ping'], rows: [row('cdn-purge'), row('uptime-ping', { pending: false })] }))
      .toMatchObject({ decision: { admitted: false, reason: 'budget_jobs' } });
    expect(emergencyJobDecision({ ...base, job: 'cdn-purge', rows: [row('cdn-purge'), row('uptime-ping', { pending: false, running: true })] }))
      .toMatchObject({ decision: { admitted: false, reason: 'budget_jobs' } });
    const wide = { ...config, budget: { ...budget, jobs: 2 } };
    expect(emergencyJobDecision({ ...base, config: wide, job: 'cdn-purge', slots: ['uptime-ping'], rows: [row('cdn-purge')] }))
      .toMatchObject({ decision: { admitted: false, reason: 'budget_http' } });
    expect(emergencyJobDecision({ ...base, config: wide, job: 'product-search-refresh', slots: ['uptime-ping'], rows: [row('product-search-refresh')] }))
      .toMatchObject({ slot: true, decision: { admitted: true } });
    // 정지 분류 잡이 비상 전에 시작돼 아직 돌아도 몫은 차지한다(끊지 않는다)
    expect(emergencyJobDecision({ ...base, job: 'product-search-refresh', rows: [row('product-search-refresh'), row('product-audit', { running: true })] }))
      .toMatchObject({ decision: { admitted: false, reason: 'budget_jobs' } });
  });

  it('기다린 시간은 마지막 차례(last_run_at) 뒤 주기를 넘긴 만큼이라 오래 미뤄진 아래 단계가 차례를 얻는다', () => {
    const fresh = row('product-search-refresh', { sinceRunMs: 60_000 });
    // crawl-judge(준비 심사, 5분 주기) 가 주기 뒤 25분 기다렸다 — aging 10분이면 두 단계 당겨져 1순위에서 더 오래 기다린 쪽
    const waited = row('crawl-judge', { sinceRunMs: 5 * 60_000 + 25 * 60_000 });
    expect(emergencyJobDecision({ ...base, job: 'product-search-refresh', rows: [fresh, waited] }))
      .toMatchObject({ decision: { admitted: false, reason: 'budget_jobs' } });
    expect(emergencyJobDecision({ ...base, job: 'crawl-judge', rows: [fresh, waited] })).toMatchObject({ decision: { admitted: true } });
    // 주기를 막 넘긴 정도면 단계 순서 그대로다
    const recent = row('crawl-judge', { sinceRunMs: 6 * 60_000 });
    expect(emergencyJobDecision({ ...base, job: 'crawl-judge', rows: [fresh, recent] })).toMatchObject({ decision: { admitted: false, reason: 'budget_jobs' } });
    expect(emergencyJobDecision({ ...base, job: 'product-search-refresh', rows: [fresh, recent] })).toMatchObject({ decision: { admitted: true } });
    // 한 번도 돈 적 없는 잡은 가장 오래 기다린 것으로 본다 — 굶지 않는다
    expect(emergencyJobDecision({ ...base, job: 'crawl-judge', rows: [fresh, row('crawl-judge', { sinceRunMs: null })] }))
      .toMatchObject({ decision: { admitted: true } });
    // 행이 없는 요청 잡도 판정에 들어간다
    expect(emergencyJobDecision({ ...base, job: 'uptime-ping', rows: [] })).toMatchObject({ decision: { job: 'uptime-ping', admitted: true } });
  });
});

describe('recovering 에서 새 인계 취득 금지', () => {
  it('M3·mini 몫 역할만 막고, Oracle 이 첫 순위인 역할과 다른 상태는 그대로다', () => {
    for (const role of ['crawler', 'reviewer', 'publisher', 'text', 'maintenance'] as const) {
      expect(emergencyTakeoverAllowed(role, 'recovering')).toBe(false);
      for (const mode of ['normal', 'partial', 'full', 'hold'] as const) expect(emergencyTakeoverAllowed(role, mode)).toBe(true);
    }
    for (const role of ['translation', 'product-health', 'site-evidence', 'official-news'] as const) {
      expect(emergencyTakeoverAllowed(role, 'recovering')).toBe(true);
    }
  });
});
