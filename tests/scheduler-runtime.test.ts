import { expect, it, vi } from 'vitest';
import { gatedSchedulerTick, runScheduler } from '@/scripts/scheduler';

it('records due requests once without executing handlers or sleeping', async () => {
  const events: string[] = [];
  const result = await runScheduler({ once: true }, {
    seen: async () => { events.push('seen'); },
    requestDue: async () => { events.push('request'); return 4; },
    sleep: async () => { throw new Error('once must not sleep'); },
  });
  expect(result).toEqual({ ticks: 1, failures: 0, requested: 4 });
  expect(events).toEqual(['seen', 'request']);
});

it('retries failed scheduler polls on the default ten-second interval', async () => {
  const controller = new AbortController();
  let requests = 0;
  const result = await runScheduler({ signal: controller.signal }, {
    seen: async () => {},
    requestDue: async () => { if (++requests === 1) throw new Error('db'); return 0; },
    sleep: async ms => { expect(ms).toBe(10_000); if (requests === 2) controller.abort(); },
  });
  expect(result).toEqual({ ticks: 2, failures: 1, requested: 0 });
});

it('does not request work after shutdown during a scheduler observation query', async () => {
  const controller = new AbortController();
  const requestDue = vi.fn();
  await runScheduler({ signal: controller.signal }, {
    seen: async () => { controller.abort(); }, requestDue,
  });
  expect(requestDue).not.toHaveBeenCalled();
});

it('stops after the in-flight request transaction finishes', async () => {
  const controller = new AbortController();
  const result = await runScheduler({ signal: controller.signal }, {
    seen: async () => {},
    requestDue: async () => { controller.abort(); await Promise.resolve(); return 2; },
    sleep: async () => { throw new Error('shutdown must not sleep'); },
  });
  expect(result).toEqual({ ticks: 1, failures: 0, requested: 2 });
});

it('lets an Oracle scheduler request nothing before this boot is recorded and retries the record on the next tick', async () => {
  const events: string[] = [], controller = new AbortController();
  let recorded = false, attempts = 0;
  const boot = { recorded: () => recorded,
    record: async () => { if (recorded) return; events.push('record'); if (++attempts === 1) throw new Error('db'); recorded = true; } };
  const tick = gatedSchedulerTick({ ready: () => true }, boot, {
    seen: async () => { events.push('seen'); }, requestDue: async () => { events.push('request'); return 3; } });
  const result = await runScheduler({ signal: controller.signal }, { ...tick, sleep: async () => { if (recorded) controller.abort(); } });
  expect(result).toEqual({ ticks: 2, failures: 1, requested: 3 });
  expect(events).toEqual(['record', 'record', 'seen', 'request']);
});

it('never requests for an unrecorded boot when the host slot appears between the two tick steps', async () => {
  let reads = 0;
  const control = { seen: vi.fn(async () => {}), requestDue: vi.fn(async () => 1) };
  const record = vi.fn(async () => {});
  const tick = gatedSchedulerTick({ ready: () => reads++ > 0 }, { record, recorded: () => false }, control);
  expect(await runScheduler({ once: true }, tick)).toEqual({ ticks: 1, failures: 0, requested: 0 });
  expect([record.mock.calls.length, control.seen.mock.calls.length, control.requestDue.mock.calls.length]).toEqual([0, 0, 0]);
});

it('keeps the M3/mini scheduler path without a boot record unchanged', async () => {
  const events: string[] = [];
  const tick = gatedSchedulerTick({ ready: () => true }, null, {
    seen: async () => { events.push('seen'); }, requestDue: async () => { events.push('request'); return 2; } });
  expect(await runScheduler({ once: true }, tick)).toEqual({ ticks: 1, failures: 0, requested: 2 });
  expect(events).toEqual(['seen', 'request']);
});
