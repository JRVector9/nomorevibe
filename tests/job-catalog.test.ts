import { expect, it } from 'vitest';
import { JOB_CATALOG, jobsForRole } from '@/lib/jobs/catalog';
import { dbPoolConfig } from '@/lib/db/pool';
import { runWorker } from '@/scripts/worker';

/**
 * 생존 확인은 1분마다 maintenance가 돈다.
 *
 * 워커는 역할 안의 잡을 하나씩 차례로 돌린다. crawler는 이미 명목 수요가 한 프로세스를 넘어서
 * 1분 주기를 얹을 자리가 없다 — 한가한 maintenance로 옮긴다.
 */
it('생존 확인은 maintenance 역할에서 1분마다 돈다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'uptime-ping')).toEqual({
    name: 'uptime-ping', role: 'maintenance', intervalMs: 60_000,
  });
  expect(new Set(jobsForRole('maintenance'))).toEqual(new Set(['uptime-ping', 'click-rollup', 'ranking-refresh']));
  expect(jobsForRole('crawler')).not.toContain('uptime-ping');
});

it('maintenance 워커가 생존 확인 요청을 소비하고 crawler 워커는 건드리지 않는다', async () => {
  const ran: string[] = [];
  const dependencies = {
    pending: async () => ['uptime-ping'],
    seen: async () => {},
    run: async (name: string) => { ran.push(name); return { status: 'completed' }; },
  };

  await runWorker({ role: 'crawler', once: true }, { ...dependencies, names: jobsForRole('crawler') });
  expect(ran).toEqual([]);

  await runWorker({ role: 'maintenance', once: true }, { ...dependencies, names: jobsForRole('maintenance') });
  expect(ran).toEqual(['uptime-ping']);
});

it('maintenance 풀이 생존 확인이 동시에 쥐는 연결을 담는다', () => {
  // HTTP는 3곳을 동시에 열지만 기록은 한 번에 하나다 — 기록 1 + 러너 임대 갱신 1
  expect(dbPoolConfig({ WORKER_ROLE: 'maintenance' }).max).toBeGreaterThanOrEqual(2);
});
