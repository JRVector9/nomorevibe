import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { combineMonitorStatus, exitCodeFor, parseCapacityModeObservation } from '@/lib/operations/failover-monitor';
import { pushKumaStatus, runMonitorCycle, type MonitorCycleState } from '@/scripts/watch-failover-readiness';
import { monitorHeartbeatIsFresh } from '@/scripts/monitor-healthcheck';

const ready = { measuredAt: '2026-09-29T00:00:00.000Z', overall: 'ok' as const,
  roles: [], scheduler: { reason: 'ready' as const, alarm: false, freshReplicas: 3, miniFreshReplicas: 1 } };
const progress = { measuredAt: ready.measuredAt, overall: 'ok' as const,
  stages: [], scheduler: { role: 'scheduler' as const, reason: 'scheduled' as const,
    alarm: false, overdueJobs: [] }, liveness: [] };

it('combines readiness and progress without downgrading alarms or unknowns', () => {
  expect(combineMonitorStatus(ready, progress)).toMatchObject({ overall: 'ok' });
  expect(combineMonitorStatus({ ...ready, overall: 'alarm' }, progress)).toMatchObject({ overall: 'alarm' });
  expect(combineMonitorStatus(ready, { ...progress, overall: 'unknown' })).toMatchObject({ overall: 'unknown' });
  expect(combineMonitorStatus(null, progress)).toMatchObject({ overall: 'unknown' });
  expect(exitCodeFor('ok')).toBe(0);
  expect(exitCodeFor('unknown')).toBe(1);
  expect(exitCodeFor('alarm')).toBe(2);
});

it('carries read-failure causes as a record only: they never change overall, and an unread stage is listed once', () => {
  const failures = [{ piece: 'capacity-mode', code: '57014' }];
  expect(combineMonitorStatus(ready, progress, undefined, undefined, failures)).toMatchObject({ overall: 'ok', readFailures: failures });
  expect(combineMonitorStatus(ready, progress)).not.toHaveProperty('readFailures');
  const unread = { piece: 'text-reason', code: '57014' };
  const partial = { ...progress, overall: 'unknown' as const, stages: [
    { role: 'text' as const, stage: 'reason-translate' as const, reason: 'unknown_age' as const, alarm: false, unread },
    { role: 'text' as const, stage: 'keywords' as const, reason: 'no_work' as const, alarm: false, waiting: 0 }] };
  expect(combineMonitorStatus(ready, partial, undefined, undefined, [unread])).toMatchObject({ overall: 'unknown', readFailures: [unread] });
  expect(combineMonitorStatus(ready, { ...partial, overall: 'alarm' })).toMatchObject({ overall: 'alarm', readFailures: [unread] });
});

it('carries the model admission mode as an observation only: DRAINING never changes overall', () => {
  const draining = { mode: 'draining' as const, changedAt: 1_000 };
  expect(combineMonitorStatus(ready, progress, undefined, draining)).toMatchObject({ overall: 'ok', capacityMode: draining });
  expect(combineMonitorStatus(ready, { ...progress, overall: 'alarm' }, undefined, draining)).toMatchObject({ overall: 'alarm', capacityMode: draining });
  expect(combineMonitorStatus(null, progress, undefined, draining).overall).toBe('unknown');
  expect(combineMonitorStatus(ready, progress)).not.toHaveProperty('capacityMode');
});

it('moves the database-measured mode age onto this process clock and rejects malformed rows', () => {
  expect(parseCapacityModeObservation({ mode: 'draining', age_ms: 95_500.7 }, 1_000_000)).toEqual({ mode: 'draining', changedAt: 904_499 });
  expect(parseCapacityModeObservation({ mode: 'open', age_ms: '0' }, 1_000_000)).toEqual({ mode: 'open', changedAt: 1_000_000 });
  expect(parseCapacityModeObservation({ mode: 'disabled', age_ms: 5_000 }, 1_000)).toEqual({ mode: 'disabled', changedAt: 0 });
  for (const row of [undefined, { mode: 'paused', age_ms: 1 }, { mode: 'open', age_ms: -1 }, { mode: 'open', age_ms: Number.NaN },
    { mode: 'open', age_ms: '' }, { mode: 'open', age_ms: 'x' }, { mode: 'open', age_ms: null }, { mode: 'open' }, { age_ms: 1 },
    { mode: 'open', age_ms: Number.POSITIVE_INFINITY }]) {
    expect(() => parseCapacityModeObservation(row, 1_000_000)).toThrow('capacity_mode_invalid');
  }
  expect(() => parseCapacityModeObservation({ mode: 'open', age_ms: 1 }, 1.5)).toThrow('capacity_mode_invalid');
});

it('pushes down after two bad samples and immediately pushes recovery', async () => {
  let state: MonitorCycleState = { badSamples: 0 };
  const push = vi.fn().mockResolvedValue(undefined);
  const record = vi.fn();
  const alarm = { ...combineMonitorStatus(ready, progress), overall: 'alarm' as const };
  state = await runMonitorCycle(state, alarm, { push, record });
  expect(push).not.toHaveBeenCalled();
  state = await runMonitorCycle(state, alarm, { push, record });
  expect(push).toHaveBeenLastCalledWith('down', 'worker failover alarm');
  expect(state.badSamples).toBe(2);
  state = await runMonitorCycle(state, combineMonitorStatus(ready, progress), { push, record });
  expect(push).toHaveBeenLastCalledWith('up', 'worker failover ok');
  expect(state.badSamples).toBe(0);
  expect(record).toHaveBeenCalledTimes(3);
});

it('keeps unknown distinct and does not expose a push error body', async () => {
  const push = vi.fn().mockRejectedValue(new Error('secret token in response'));
  const status = combineMonitorStatus(null, progress);
  await expect(runMonitorCycle({ badSamples: 1 }, status, { push, record: vi.fn() }))
    .rejects.toThrow('monitor_push_failed');
  expect(push).toHaveBeenCalledWith('down', 'worker failover unknown');
});

it('checks the independent monitor heartbeat age', () => {
  expect(monitorHeartbeatIsFresh({ checkedAt: 1_000 }, 70_000)).toBe(true);
  expect(monitorHeartbeatIsFresh({ checkedAt: 1_000 }, 92_000)).toBe(false);
  expect(monitorHeartbeatIsFresh({ checkedAt: 110_000 }, 100_000)).toBe(false);
});

it('uses the Kuma Push protocol and hides a failed endpoint response', async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: requests.length === 1 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing_address');
    const url = `http://127.0.0.1:${address.port}/api/push/private-token`;
    await pushKumaStatus(url, 'up', 'worker failover ok');
    await expect(pushKumaStatus(url, 'down', 'worker failover alarm'))
      .rejects.toThrow('monitor_push_failed');
    expect(requests).toEqual([
      '/api/push/private-token?status=up&msg=worker+failover+ok',
      '/api/push/private-token?status=down&msg=worker+failover+alarm',
    ]);
  } finally { server.close(); }
});
