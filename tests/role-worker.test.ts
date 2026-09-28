import { expect, it, vi } from 'vitest';
import { parseRoleWorkerArgs, roleCandidateObservationKey, roleHasUnexplainedStall, runRoleCandidate } from '@/scripts/role-worker';
import type { RoleCandidate, RoleLease } from '@/lib/jobs/role-leader';

const candidate: RoleCandidate = {
  role: 'crawler', instanceId: 'crawler-a', bootId: 'boot-a', release: 'r1', kind: 'primary',
};
const lease: RoleLease = { ...candidate, epoch: 1 };

it('keeps a candidate passive until it owns the role', async () => {
  const controller = new AbortController();
  const acquire = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(lease);
  const states: string[] = [];
  const supervise = vi.fn(async (owned: RoleLease, active: AbortSignal) => {
    expect(owned).toEqual(lease);
    expect(active.aborted).toBe(false);
    controller.abort();
    expect(active.reason).toBe('shutdown_requested');
    return 0;
  });
  await runRoleCandidate(candidate, controller.signal, {
    acquire, renew: async () => true, supervise,
    sleep: async () => {},
    report: (phase, epoch) => states.push(`${phase}:${epoch}`),
  });
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(supervise).toHaveBeenCalledOnce();
  expect(supervise.mock.calls[0][0]).toEqual(lease);
  expect(states).toEqual(['standby:null', 'active:1', 'stopping:null']);
});

it('stops the active supervisor when renewal loses ownership', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    let runs = 0;
    const supervise = vi.fn(async (_lease: RoleLease, signal: AbortSignal) => {
      runs++;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      controller.abort();
      return 0;
    });
    const renew = vi.fn(async () => false);
    const running = runRoleCandidate(candidate, controller.signal, {
      acquire: async () => lease, renew, supervise, sleep: async () => {},
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
    expect(runs).toBe(1);
    expect(renew).toHaveBeenCalledOnce();
    expect(supervise.mock.calls[0][1].aborted).toBe(true);
    expect(supervise.mock.calls[0][1].reason).toBe('role_lease_lost');
  } finally { vi.useRealTimers(); }
});

it('stops the active supervisor when the DB renewal result is unknown', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    let reason: unknown;
    const running = runRoleCandidate(candidate, controller.signal, {
      acquire: async () => lease,
      renew: async () => { throw new Error('db_unreachable'); },
      supervise: async (_owned, signal) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        reason = signal.reason;
        controller.abort();
        return 0;
      },
      sleep: async () => {},
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
    expect(reason).toBe('role_lease_lost');
  } finally { vi.useRealTimers(); }
});

it('requires an explicit stable instance, release and role kind', () => {
  expect(parseRoleWorkerArgs(['--role=reviewer', '--kind=standby'], {
    SERVICE_INSTANCE_ID: 'reviewer-b', RELEASE_TAG: 'r1',
  })).toMatchObject({ role: 'reviewer', kind: 'standby', instanceId: 'reviewer-b', release: 'r1' });
  expect(() => parseRoleWorkerArgs(['--role=reviewer', '--kind=standby'], {})).toThrow();
  expect(() => parseRoleWorkerArgs(['--role=publisher', '--kind=standby'], {
    SERVICE_INSTANCE_ID: 'publisher-b', RELEASE_TAG: 'r1',
  })).toThrow();
  expect(roleCandidateObservationKey(candidate)).toBe('candidate:crawler:crawler-a');
});

it('restarts only for unexplained demand with a healthy scheduler', () => {
  const report = { scheduler: { reason: 'scheduled' }, stages: [
    { role: 'crawler', reason: 'no_progress' }, { role: 'reviewer', reason: 'no_work' },
  ] };
  expect(roleHasUnexplainedStall(report, 'crawler')).toBe(true);
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
  expect(roleHasUnexplainedStall({ ...report, scheduler: { reason: 'scheduler_missed' } }, 'crawler')).toBe(false);
  expect(roleHasUnexplainedStall({ ...report, stages: [
    { role: 'crawler', reason: 'no_progress' }, { role: 'crawler', reason: 'progressing' },
  ] }, 'crawler')).toBe(false);
  expect(roleHasUnexplainedStall({ ...report, stages: [
    { role: 'crawler', reason: 'no_progress' }, { role: 'crawler', reason: 'upstream_or_job_error' },
  ] }, 'crawler')).toBe(false);
});

it('exits the primary after two consecutive stalled samples for Swarm restart', async () => {
  vi.useFakeTimers();
  try {
    let reason: unknown;
    const checkProgress = vi.fn(async () => true);
    const running = runRoleCandidate(candidate, new AbortController().signal, {
      acquire: async () => lease, renew: async () => true, checkProgress,
      supervise: async (_owned, signal) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        reason = signal.reason;
        return 0;
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toBe(1);
    expect(checkProgress).toHaveBeenCalledTimes(2);
    expect(reason).toBe('progress_stalled');
  } finally { vi.useRealTimers(); }
});

it('clears a pending stall after progress resumes or the DB observation is unknown', async () => {
  vi.useFakeTimers();
  try {
    let sample = 0;
    let stopped = false;
    const running = runRoleCandidate(candidate, new AbortController().signal, {
      acquire: async () => lease, renew: async () => true,
      checkProgress: async () => {
        sample++;
        if (sample === 2) return false;
        if (sample === 4) throw new Error('db_unreachable');
        return true;
      },
      supervise: async (_owned, signal) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        stopped = true;
        return 0;
      },
    });
    await vi.advanceTimersByTimeAsync(75_000);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await running).toBe(1);
    expect(sample).toBe(6);
  } finally { vi.useRealTimers(); }
});

it('does not restart an active standby from the primary progress policy', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const checkProgress = vi.fn(async () => true);
    const standby = { ...candidate, kind: 'standby' as const, instanceId: 'crawler-b' };
    const running = runRoleCandidate(standby, controller.signal, {
      acquire: async () => ({ ...standby, epoch: 2 }), renew: async () => true,
      checkProgress,
      supervise: async () => {
        await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
        return 0;
      },
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(checkProgress).not.toHaveBeenCalled();
    controller.abort();
    expect(await running).toBe(0);
  } finally { vi.useRealTimers(); }
});
