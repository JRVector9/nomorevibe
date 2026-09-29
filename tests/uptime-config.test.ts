import { expect, it } from 'vitest';
import { uptimeCapacityConfig } from '@/lib/jobs/products/uptime';

it('keeps the production default and accepts a bounded staged increase', () => {
  expect(uptimeCapacityConfig({})).toEqual({ batch: 15, concurrency: 3 });
  expect(uptimeCapacityConfig({ UPTIME_BATCH_SIZE: '30', UPTIME_CONCURRENCY: '4' }))
    .toEqual({ batch: 30, concurrency: 4 });
  expect(uptimeCapacityConfig({ UPTIME_BATCH_SIZE: '60', UPTIME_CONCURRENCY: '6' }))
    .toEqual({ batch: 60, concurrency: 6 });
});

it.each([
  { UPTIME_BATCH_SIZE: '0' }, { UPTIME_BATCH_SIZE: '61' }, { UPTIME_BATCH_SIZE: '1.5' },
  { UPTIME_CONCURRENCY: '0' }, { UPTIME_CONCURRENCY: '7' }, { UPTIME_CONCURRENCY: 'abc' },
])('rejects an invalid capacity setting: %j', env => {
  expect(() => uptimeCapacityConfig(env)).toThrow(/Invalid UPTIME_/);
});
