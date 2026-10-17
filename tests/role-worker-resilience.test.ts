import { afterEach, expect, it, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { BATCH_ADMISSION_RELEASE_MS, roleWorkerRecorder, runRoleCandidate, type RoleRuntimeHealth } from '@/scripts/role-worker';
import { recordedConsumerOwner } from '@/scripts/worker-supervisor';
import { roleCandidateIsHealthy } from '@/scripts/worker-healthcheck';
import { ROLE_STUCK_UNHEALTHY_MS } from '@/scripts/role-health';
import { runWorker } from '@/scripts/worker';
import { processGroupRecordingEnabled } from '@/lib/operations/dr/process-owner-env';
import { dbErrorFields } from '@/lib/db/error-fields';
import { DbPoolWaitTimeoutError } from '@/lib/db/pool';
import type { RoleCandidate, RoleLease } from '@/lib/jobs/role-leader';

// 2026-10-17 M3 장애 경로: DB 가 돌아와도 acquire 가 계속 실패했고 로그(role.acquire_unknown)에 원인이 없었으며 standby 는 영구 healthy 였다.
const T0 = Date.parse('2026-10-17T03:00:00.000Z');
const candidate: RoleCandidate = { role: 'crawler', instanceId: 'm3-crawler', bootId: 'boot-a', release: 'r1', kind: 'standby' };
const pg = (code: string, message: string) => Object.assign(new Error(message), { name: 'PostgresError', code });
const wrapped = (cause: unknown) => new DrizzleQueryError('select owner_instance_id from role_leases where role = $1 for update', ['secret-param'], cause as Error);
type Log = Record<string, unknown> & { event: string };
function captureLogs(): Log[] {
  const logs: Log[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    try { logs.push(JSON.parse(String(line)) as Log); } catch { /* 다른 출력 */ }
  });
  return logs;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('summarizes driver errors without the SQL text or params that drizzle puts into its wrapper message', () => {
  expect(dbErrorFields(wrapped(pg('55P03', 'canceling statement due to lock timeout'))))
    .toEqual({ code: '55P03', name: 'PostgresError', message: 'canceling statement due to lock timeout' });
  expect(dbErrorFields(wrapped(undefined))).toEqual({ code: null, name: 'Error', message: '' });
  expect(dbErrorFields(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6432'), { code: 'ECONNREFUSED' })))
    .toEqual({ code: 'ECONNREFUSED', name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:6432' });
  expect(dbErrorFields(new DbPoolWaitTimeoutError())).toMatchObject({ code: 'DB_POOL_WAIT_TIMEOUT', name: 'DbPoolWaitTimeoutError' });
  const leaked = dbErrorFields(new Error(`bad url postgres://nomorevibe:hunter2@db:6432/x password=hunter2 ${'x'.repeat(400)}`));
  expect(leaked.message).not.toContain('hunter2'); expect(leaked.message.length).toBeLessThanOrEqual(160);
  expect(dbErrorFields('boom')).toEqual({ code: null, name: 'string', message: '' });
});

it('logs the failure code, counts the streak and exits cleanly once election stays broken for the threshold', async () => {
  vi.useFakeTimers(); vi.setSystemTime(T0);
  const logs = captureLogs(), states: RoleRuntimeHealth[] = [];
  const lockBlockers = vi.fn(async () => [{ pid: 7, applicationName: 'nomorevibe:crawler' }]);
  const acquire = vi.fn(async (): Promise<RoleLease | null> => { throw wrapped(pg('55P03', 'canceling statement due to lock timeout')); });
  // 회귀로 끝나지 않으면 100번째 대기에서 멈춘다(무한 반복 대신 단언 실패)
  const guard = new AbortController();
  let sleeps = 0;
  const code = await runRoleCandidate(candidate, guard.signal, { acquire, renew: async () => true, supervise: async () => 0,
    sleep: async () => { vi.setSystemTime(Date.now() + 5_000); if (++sleeps >= 100) guard.abort(); }, health: state => states.push(state), lockBlockers });
  expect(code).toBe(1);
  const failures = logs.filter(log => log.event === 'role.acquire_unknown');
  expect(failures[0]).toMatchObject({ role: 'crawler', instanceId: 'm3-crawler', code: '55P03', errorName: 'PostgresError',
    message: 'canceling statement due to lock timeout', failures: 1, failingForMs: 0 });
  // 5초 간격으로 0~300초: 61번째 실패에서 연속 5분이 된다
  expect(failures).toHaveLength(ROLE_STUCK_UNHEALTHY_MS / 5_000 + 1);
  expect(failures.at(-1)).toMatchObject({ failures: 61, failingForMs: ROLE_STUCK_UNHEALTHY_MS });
  expect(logs.find(log => log.event === 'role.db_unavailable_exit')).toMatchObject({ failures: 61, failingForMs: ROLE_STUCK_UNHEALTHY_MS });
  expect(JSON.stringify(logs)).not.toMatch(/secret-param|role_leases/);
  // lock 오류는 실패 연속마다 한 번만 막는 세션을 읽는다
  expect(lockBlockers).toHaveBeenCalledOnce();
  expect(logs.find(log => log.event === 'role.lock_blockers')).toMatchObject({ holders: [{ pid: 7, applicationName: 'nomorevibe:crawler' }] });
  expect(states.at(-1)).toMatchObject({ dbFailingSince: T0, dbFailures: 61, dbPendingSince: null });
});

it('keeps a normal standby (another owner holds the lease) running indefinitely and resets the streak on any DB answer', async () => {
  vi.useFakeTimers(); vi.setSystemTime(T0);
  const logs = captureLogs(), states: RoleRuntimeHealth[] = [], controller = new AbortController();
  // 3번 실패 → null(DB 응답) → 다시 실패 2번 → 이후 계속 null 로 1시간
  const script: Array<'fail' | 'null'> = ['fail', 'fail', 'fail', 'null', 'fail', 'fail'];
  const lockBlockers = vi.fn(async () => []);
  let calls = 0;
  const code = await runRoleCandidate(candidate, controller.signal, {
    acquire: async () => { calls++; if ((script.shift() ?? 'null') === 'fail') throw wrapped(pg('55P03', 'lock timeout')); return null; },
    renew: async () => true, supervise: async () => 0, health: state => states.push(state), lockBlockers,
    sleep: async () => { vi.setSystemTime(Date.now() + 5_000); if (Date.now() - T0 >= 3_600_000) controller.abort(); },
  });
  expect(code).toBe(0); expect(calls).toBe(720); // 0~3595초, 5초마다
  expect(logs.filter(log => log.event === 'role.acquire_unknown').map(log => log.failures)).toEqual([1, 2, 3, 1, 2]);
  expect(logs.some(log => log.event === 'role.db_unavailable_exit')).toBe(false);
  expect(lockBlockers).toHaveBeenCalledTimes(2);
  expect(states.at(-1)).toEqual({ dbFailingSince: null, dbFailures: 0, dbPendingSince: null, admissionBlockedSince: null, admissionReason: null });
});

it('logs an unknown renewal with its code before stopping the active child', async () => {
  vi.useFakeTimers(); vi.setSystemTime(T0);
  const logs = captureLogs(), controller = new AbortController(), lease: RoleLease = { ...candidate, epoch: 4 };
  let reason: unknown;
  const running = runRoleCandidate(candidate, controller.signal, {
    acquire: vi.fn().mockResolvedValueOnce(lease).mockResolvedValue(null),
    renew: async () => { throw wrapped(Object.assign(new Error('write CONNECTION_CLOSED db:6432'), { code: 'CONNECTION_CLOSED' })); },
    supervise: async (_owned, signal) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); reason = signal.reason; return 0; },
    sleep: async () => { controller.abort(); },
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await running).toBe(0);
  expect(reason).toBe('role_lease_lost');
  expect(logs.find(log => log.event === 'role.renew_unknown')).toMatchObject({ epoch: 4, code: 'CONNECTION_CLOSED', errorName: 'Error', failures: 1 });
});

const batchCandidate: RoleCandidate = { role: 'translation', instanceId: 'osaka-translation', bootId: 'boot-b', release: 'r1', kind: 'primary',
  batchVersion: 1, host: 'oracle-osaka-smoke' };
const batchLease: RoleLease = { ...batchCandidate, epoch: 3, batchEpoch: 2 };

it('reports a versioned lease whose every claim is blocked, then stops its child and releases the lease after the hold', async () => {
  vi.useFakeTimers(); vi.setSystemTime(T0);
  const logs = captureLogs(), states: RoleRuntimeHealth[] = [], controller = new AbortController();
  const release = vi.fn(async () => true), acquire = vi.fn().mockResolvedValueOnce(batchLease).mockResolvedValue(null);
  let reason: unknown;
  const running = runRoleCandidate(batchCandidate, controller.signal, {
    acquire, release, renew: async () => true, health: state => states.push(state),
    checkAdmission: async () => ({ ready: false, reason: 'result_stale' }),
    supervise: async (_owned, signal) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); reason = signal.reason; return 0; },
    sleep: async () => { controller.abort(); },
  });
  await vi.advanceTimersByTimeAsync(15_000 + BATCH_ADMISSION_RELEASE_MS - 15_000);
  expect(release).not.toHaveBeenCalled();
  expect(states.at(-1)).toMatchObject({ admissionBlockedSince: T0 + 15_000, admissionReason: 'result_stale' });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await running).toBe(0);
  expect(reason).toBe('batch_admission_blocked');
  expect(release).toHaveBeenCalledExactlyOnceWith(batchLease);
  expect(acquire).toHaveBeenCalledTimes(2); // 놓은 뒤 standby 로 돌아가 다시 선출에 나선다(이 boot 는 readiness 전에는 선출되지 않는다)
  expect(logs.filter(log => log.event.startsWith('role.batch_admission')).map(log => [log.event, log.reason ?? log.released]))
    .toEqual([['role.batch_admission_blocked', 'result_stale'], ['role.batch_admission_release', 'result_stale'], ['role.batch_admission_released', true]]);
  expect(states.at(-1)).toMatchObject({ admissionBlockedSince: null, admissionReason: null });
});

it('keeps the lease when admission recovers before the hold, and never checks a legacy lease', async () => {
  vi.useFakeTimers(); vi.setSystemTime(T0);
  const logs = captureLogs(), controller = new AbortController(), release = vi.fn(async () => true);
  const answers = [{ ready: false, reason: 'capability_stale' }, null, { ready: true, reason: 'ready' }];
  const checkAdmission = vi.fn(async () => answers.length ? answers.shift()! : { ready: true, reason: 'ready' });
  const running = runRoleCandidate(batchCandidate, controller.signal, {
    acquire: async () => batchLease, release, renew: async () => true, checkAdmission,
    supervise: async (_owned, signal) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return 0; },
  });
  await vi.advanceTimersByTimeAsync(BATCH_ADMISSION_RELEASE_MS * 2);
  controller.abort();
  expect(await running).toBe(0);
  expect(logs.filter(log => log.event.startsWith('role.batch_admission')).map(log => log.event)).toEqual(['role.batch_admission_blocked', 'role.batch_admission_ready']);
  expect(release).toHaveBeenCalledOnce(); // 종료 신호 뒤 정상 drain 의 release 뿐
  const legacyCheck = vi.fn(async () => ({ ready: false, reason: 'x' })), legacy = new AbortController();
  const legacyRun = runRoleCandidate(candidate, legacy.signal, { acquire: async () => ({ ...candidate, epoch: 1 }), renew: async () => true, checkAdmission: legacyCheck,
    supervise: async (_owned, signal) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return 0; } });
  await vi.advanceTimersByTimeAsync(60_000); legacy.abort();
  expect(await legacyRun).toBe(0); expect(legacyCheck).not.toHaveBeenCalled();
});

it('marks the role candidate unhealthy only when failures, an unfinished call or a blocked lease last past the threshold', () => {
  const now = T0, standby = { role: 'crawler', kind: 'standby', instanceId: 'a', bootId: 'b', phase: 'standby', epoch: null, pid: 9, updatedAt: now };
  const worker = { role: 'crawler', status: 'running', updatedAt: now, lastHeartbeatAt: now };
  expect(roleCandidateIsHealthy({ ...standby, dbFailingSince: null, dbPendingSince: null, admissionBlockedSince: null }, null, now)).toBe(true);
  expect(roleCandidateIsHealthy({ ...standby, dbFailingSince: now - ROLE_STUCK_UNHEALTHY_MS + 1, dbFailures: 60 }, null, now)).toBe(true);
  expect(roleCandidateIsHealthy({ ...standby, dbFailingSince: now - ROLE_STUCK_UNHEALTHY_MS, dbFailures: 61 }, null, now)).toBe(false);
  expect(roleCandidateIsHealthy({ ...standby, dbPendingSince: now - ROLE_STUCK_UNHEALTHY_MS }, null, now)).toBe(false);
  expect(roleCandidateIsHealthy({ ...standby, dbFailingSince: Number.NaN }, null, now)).toBe(false); // 모양이 틀린 값은 다른 필드처럼 fail closed
  const active = { ...standby, phase: 'active', epoch: 3 };
  expect(roleCandidateIsHealthy({ ...active, admissionBlockedSince: now - 60_000 }, worker, now)).toBe(true);
  expect(roleCandidateIsHealthy({ ...active, admissionBlockedSince: now - ROLE_STUCK_UNHEALTHY_MS }, worker, now)).toBe(false);
});

it('records D11 process groups only with PROCESS_GROUP_RECORDING=1; off by default spawns without the DB like 8020dca', () => {
  expect(processGroupRecordingEnabled({})).toBe(false); expect(processGroupRecordingEnabled({ PROCESS_GROUP_RECORDING: '0' })).toBe(false);
  expect(processGroupRecordingEnabled({ PROCESS_GROUP_RECORDING: '1' })).toBe(true);
  for (const value of ['true', ' 1', '2', '']) expect(() => processGroupRecordingEnabled({ PROCESS_GROUP_RECORDING: value })).toThrow('invalid_process_group_recording');
  const owner = { instanceId: 'm3-crawler', bootId: '0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21' };
  const attestation = { version: 1 as const, kernelBootId: '1f0c8a52-91c4-4d1e-9a51-6b8f9d3c2e10', pidNamespace: 4026531836 };
  expect(roleWorkerRecorder(owner, {}, () => attestation)).toBeUndefined();
  expect(roleWorkerRecorder(owner, { PROCESS_GROUP_RECORDING: '1' }, () => attestation)).toMatchObject({ owner });
  expect(roleWorkerRecorder(owner, { PROCESS_GROUP_RECORDING: '1' }, () => attestation)?.probePredecessors).toBeUndefined();
  expect(typeof roleWorkerRecorder(owner, { PROCESS_GROUP_RECORDING: '1', PROCESS_GROUP_SUCCESSOR_PROBE: '1' }, () => attestation)?.probePredecessors).toBe('function');
  // 후속 관측은 기록(owner_opened)을 전제한다 — 기록 없이 켜면 설정 오류
  expect(() => roleWorkerRecorder(owner, { PROCESS_GROUP_SUCCESSOR_PROBE: '1' }, () => attestation)).toThrow('process_group_successor_probe_requires_recording');
  const consumer = { PIPELINE_ITEM_CONSUMER_VERSION: '1', PIPELINE_ITEM_CONSUMER_INSTANCE_ID: 'ai1-consumer-m3' };
  expect(recordedConsumerOwner('ai1', consumer)).toBeNull();
  expect(recordedConsumerOwner('ai1', { ...consumer, PROCESS_GROUP_RECORDING: '1' })).toMatchObject({ instanceId: 'ai1-consumer-m3' });
  expect(recordedConsumerOwner(undefined, { ...consumer, PROCESS_GROUP_RECORDING: '1' })).toBeNull();
  expect(() => recordedConsumerOwner('ai2', { ...consumer, PROCESS_GROUP_RECORDING: 'yes' })).toThrow('invalid_process_group_recording');
});

it('adds the error code and the per-lane consecutive count to poll and tick failure logs', async () => {
  const log = vi.fn(), controller = new AbortController();
  let polls = 0;
  await runWorker({ role: 'crawler', signal: controller.signal }, {
    names: ['crawl-fetch'], lanes: [['crawl-fetch']], seen: async () => {}, log,
    pending: async () => {
      polls++;
      if (polls <= 2) throw wrapped(pg('57P01', 'terminating connection due to administrator command'));
      return polls === 3 ? [] : ['crawl-fetch'];
    },
    run: async () => { throw wrapped(Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' })); },
    sleep: async () => { if (polls >= 4) controller.abort(); },
  });
  expect(log.mock.calls.map(([event, fields]) => [event, fields.code ?? null, fields.consecutiveFailures ?? null])).toEqual([
    ['worker.poll_failed', '57P01', 1], ['worker.poll_failed', '57P01', 2], ['worker.job', 'CONNECTION_CLOSED', 1]]);
  expect(log.mock.calls[0][1]).toMatchObject({ role: 'crawler', errorName: 'PostgresError', message: 'terminating connection due to administrator command' });
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret-param');
});
