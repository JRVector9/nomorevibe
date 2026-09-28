import { expect, it, vi } from 'vitest';
import { parseRoleWorkerArgs, roleCandidateObservationKey, runRoleCandidate } from '@/scripts/role-worker';
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
