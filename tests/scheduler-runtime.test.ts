import { expect, it, vi } from 'vitest';
import { runScheduler } from '@/scripts/scheduler';

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
