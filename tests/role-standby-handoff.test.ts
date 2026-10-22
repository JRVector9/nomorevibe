import { afterEach, expect, it, vi } from 'vitest';
import { PrimaryHandoff, ROLE_HANDOFF_MAX_STABLE_MS, ROLE_HANDOFF_POLL_MS, ROLE_HANDOFF_RETRY_WINDOW_MS, ROLE_HANDOFF_STABLE_MS,
  roleHandoffPollMs, roleHandoffStableMs, runRoleCandidate } from '@/scripts/role-worker';
import type { RoleCandidate, RoleLease } from '@/lib/jobs/role-leader';

// 2026-10-22 #597: 같은 릴리스의 예비가 역할을 쥐면 주가 다시 떠도 돌려주지 않았다. 예비가 기다리는 건강한 주에게 drain 뒤 넘긴다.
const standby: RoleCandidate = { role: 'crawler', instanceId: 'mini-crawler-standby', bootId: 'standby-boot', release: 'r1', kind: 'standby' };
const standbyLease: RoleLease = { ...standby, epoch: 147 };
const waiting = { instanceId: 'm3-crawler', bootId: 'primary-boot' };

afterEach(() => { vi.useRealTimers(); });

function untilAborted(signal: AbortSignal) {
  return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

it('hands a same-release role back to a primary boot that keeps waiting, draining first while still renewing', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const events: string[] = [];
  const renew = vi.fn(async () => { events.push(`renew@${Date.now()}`); return true; });
  let reason: unknown;
  const supervise = vi.fn(async (_lease: RoleLease, signal: AbortSignal) => {
    await untilAborted(signal);
    reason = signal.reason;
    events.push(`abort@${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 20_000)); // 자식 drain
    events.push(`drained@${Date.now()}`);
    return 0;
  });
  const yieldRole = vi.fn(async () => { events.push(`yield@${Date.now()}`); controller.abort(); return true; });
  const waitingPrimary = vi.fn(async () => waiting);
  const started = Date.now();
  const running = runRoleCandidate(standby, controller.signal, {
    acquire: vi.fn().mockResolvedValueOnce(standbyLease).mockResolvedValue(null), renew, supervise, sleep: async () => {},
    waitingPrimary, yieldRole, handoffStableMs: 60_000, handoffPollMs: 15_000,
  });
  await vi.advanceTimersByTimeAsync(200_000);
  expect(await running).toBe(0);
  expect(reason).toBe('primary_handoff');
  // 첫 표본(15초)부터 같은 boot 가 60초 이어진 75초에 drain 을 시작한다
  const abortAt = Number(events.find(event => event.startsWith('abort@'))!.split('@')[1]);
  expect(abortAt - started).toBe(75_000);
  const yieldAt = Number(events.find(event => event.startsWith('yield@'))!.split('@')[1]);
  const drainedAt = Number(events.find(event => event.startsWith('drained@'))!.split('@')[1]);
  expect(yieldAt).toBeGreaterThanOrEqual(drainedAt);
  // drain 동안에도 갱신했다 — 주는 예비 자식이 끝나기 전에는 선출되지 않는다
  expect(events.filter(event => event.startsWith('renew@')).some(event => {
    const at = Number(event.split('@')[1]);
    return at > abortAt && at < drainedAt;
  })).toBe(true);
  expect(yieldRole).toHaveBeenCalledExactlyOnceWith(standbyLease);
  expect(waitingPrimary).toHaveBeenCalledWith(standbyLease);
});

it('waits the stable window from the first sample of one boot and starts over when the boot changes or disappears', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const samples = [waiting, waiting, { ...waiting, bootId: 'restarted' }, null, waiting, waiting, waiting, waiting, waiting];
  let calls = 0;
  const waitingPrimary = vi.fn(async () => samples[Math.min(calls++, samples.length - 1)]);
  const supervise = vi.fn(async (_lease: RoleLease, signal: AbortSignal) => { await untilAborted(signal); return 0; });
  const yieldRole = vi.fn(async () => { controller.abort(); return true; });
  const started = Date.now();
  let abortedAt = 0;
  const running = runRoleCandidate(standby, controller.signal, {
    acquire: vi.fn().mockResolvedValueOnce(standbyLease).mockResolvedValue(null), renew: async () => true,
    supervise: async (lease, signal) => { const code = await supervise(lease, signal); abortedAt = Date.now(); return code; },
    sleep: async () => {}, waitingPrimary, yieldRole, handoffStableMs: 60_000, handoffPollMs: 15_000,
  });
  await vi.advanceTimersByTimeAsync(300_000);
  await running;
  // 5번째 표본(75초)에 다시 처음 보고, 그 뒤 60초(9번째 표본, 135초)에 넘긴다
  expect(abortedAt - started).toBe(135_000);
  expect(yieldRole).toHaveBeenCalledOnce();
});

it('never hands off while the primary keeps restarting (a new boot every sample)', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let boot = 0;
  const waitingPrimary = vi.fn(async () => ({ ...waiting, bootId: `boot-${boot++}` }));
  const release = vi.fn(async () => true);
  const yieldRole = vi.fn(async () => true);
  let reason: unknown;
  const running = runRoleCandidate(standby, controller.signal, {
    acquire: async () => standbyLease, renew: async () => true, release, sleep: async () => {},
    supervise: async (_lease, signal) => { await untilAborted(signal); reason = signal.reason; return 0; },
    waitingPrimary, yieldRole, handoffStableMs: 60_000, handoffPollMs: 15_000,
  });
  await vi.advanceTimersByTimeAsync(600_000);
  controller.abort();
  await vi.advanceTimersByTimeAsync(1);
  expect(await running).toBe(0);
  expect(waitingPrimary.mock.calls.length).toBeGreaterThan(30);
  expect(yieldRole).not.toHaveBeenCalled();
  expect(reason).toBe('shutdown_requested');
  expect(release).toHaveBeenCalledOnce(); // 정상 종료는 예전처럼 반납한다
});

it('only a standby holding a legacy lease looks for a waiting primary, and only when enabled', async () => {
  vi.useFakeTimers();
  for (const [candidate, lease, stable] of [
    [{ ...standby, kind: 'primary' as const }, { ...standbyLease, kind: 'primary' as const }, 60_000],
    [standby, { ...standbyLease, batchVersion: 1 as const, host: 'mini' as const, batchEpoch: 3 }, 60_000],
    [standby, standbyLease, null],
  ] as const) {
    const controller = new AbortController();
    const waitingPrimary = vi.fn(async () => waiting);
    const running = runRoleCandidate(candidate, controller.signal, {
      acquire: async () => lease, renew: async () => true, release: async () => true, sleep: async () => {},
      supervise: async (_lease, signal) => { await untilAborted(signal); return 0; },
      waitingPrimary, yieldRole: async () => true, handoffStableMs: stable, handoffPollMs: 15_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toBe(0);
    expect(waitingPrimary).not.toHaveBeenCalled();
  }
});

it('does not yield after an unclean drain or an unknown yield result and leaves the restart policy to recover', async () => {
  vi.useFakeTimers();
  for (const [exitCode, yieldRole, expectedYields] of [
    [1, vi.fn(async () => true), 0],
    [0, vi.fn(async () => { throw new Error('db_unreachable'); }), 1],
  ] as const) {
    const running = runRoleCandidate(standby, new AbortController().signal, {
      acquire: async () => standbyLease, renew: async () => true, sleep: async () => {},
      supervise: async (_lease, signal) => { await untilAborted(signal); return exitCode; },
      waitingPrimary: async () => waiting, yieldRole, handoffStableMs: 30_000, handoffPollMs: 15_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await running).toBe(1);
    expect(yieldRole).toHaveBeenCalledTimes(expectedYields);
  }
});

it('a lease lost during the handoff drain is not yielded and the next election decides again', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const yieldRole = vi.fn(async () => true);
  let renewals = 0, reason: unknown;
  const acquire = vi.fn().mockResolvedValueOnce(standbyLease).mockImplementation(async () => { controller.abort(); return null; });
  const running = runRoleCandidate(standby, controller.signal, {
    // 10·20·30초 갱신은 되고, 넘겨주기 drain(30초부터) 중인 40초 갱신에서 lease 를 잃는다
    acquire, renew: async () => ++renewals < 4, sleep: async () => {},
    supervise: async (_lease, signal) => {
      await untilAborted(signal); reason = signal.reason; await new Promise(resolve => setTimeout(resolve, 30_000)); return 0;
    },
    waitingPrimary: async () => waiting, yieldRole, handoffStableMs: 15_000, handoffPollMs: 15_000,
  });
  await vi.advanceTimersByTimeAsync(200_000);
  expect(await running).toBe(0);
  expect(reason).toBe('primary_handoff');
  expect(renewals).toBe(4);
  expect(yieldRole).not.toHaveBeenCalled();
  expect(acquire).toHaveBeenCalledTimes(2);
});

it('backs off after a handoff the primary did not take, and forgets it after a real failover window', () => {
  let now = 0;
  const handoff = new PrimaryHandoff(60_000, () => now);
  expect(handoff.observe(waiting)).toBe(false);
  now = 60_000;
  expect(handoff.observe(waiting)).toBe(true);
  handoff.yielded();
  now += 25_000; // 주가 받지 못해 20초 유예 뒤 예비가 다시 선출됐다
  handoff.acquired();
  expect(handoff.requiredMs()).toBe(120_000);
  handoff.observe(waiting);
  now += 119_000;
  expect(handoff.observe(waiting)).toBe(false);
  now += 1_000;
  expect(handoff.observe(waiting)).toBe(true);
  for (let i = 0; i < 10; i++) { handoff.yielded(); now += 1_000; handoff.acquired(); }
  expect(handoff.requiredMs()).toBe(ROLE_HANDOFF_MAX_STABLE_MS);
  handoff.yielded();
  now += ROLE_HANDOFF_RETRY_WINDOW_MS; // 주가 오래 쥐었다가 정말 죽은 failover 는 실패한 넘겨주기가 아니다
  handoff.acquired();
  expect(handoff.requiredMs()).toBe(60_000);
});

it('reads the handoff settings strictly before election', () => {
  expect(roleHandoffStableMs({})).toBe(ROLE_HANDOFF_STABLE_MS);
  expect(roleHandoffStableMs({ ROLE_HANDOFF_STABLE_SECONDS: '0' })).toBeNull();
  expect(roleHandoffStableMs({ ROLE_HANDOFF_STABLE_SECONDS: '90' })).toBe(90_000);
  for (const value of ['-1', '1.5', '3601', 'abc', ' 60']) {
    expect(() => roleHandoffStableMs({ ROLE_HANDOFF_STABLE_SECONDS: value })).toThrow('Invalid ROLE_HANDOFF_STABLE_SECONDS');
  }
  expect(roleHandoffPollMs({})).toBe(ROLE_HANDOFF_POLL_MS);
  expect(roleHandoffPollMs({ ROLE_HANDOFF_POLL_SECONDS: '1' })).toBe(1_000);
  for (const value of ['0', '61', 'x']) expect(() => roleHandoffPollMs({ ROLE_HANDOFF_POLL_SECONDS: value })).toThrow();
});
