import { expect, it } from 'vitest';
import { uptimeCapacityConfig } from '@/lib/jobs/products/uptime';

it('keeps the production default and accepts a bounded staged increase', () => {
  expect(uptimeCapacityConfig({})).toEqual({ batch: 15, concurrency: 3 });
  expect(uptimeCapacityConfig({ UPTIME_BATCH_SIZE: '30', UPTIME_CONCURRENCY: '4' }))
    .toEqual({ batch: 30, concurrency: 4 });
  expect(uptimeCapacityConfig({ UPTIME_BATCH_SIZE: '60', UPTIME_CONCURRENCY: '6' }))
    .toEqual({ batch: 60, concurrency: 6 });
  // 2026-10-07 공개 웹사이트 3만6천 개 — 운영은 150건·동시 12
  expect(uptimeCapacityConfig({ UPTIME_BATCH_SIZE: '150', UPTIME_CONCURRENCY: '12' }))
    .toEqual({ batch: 150, concurrency: 12 });
});

it.each([
  { UPTIME_BATCH_SIZE: '0' }, { UPTIME_BATCH_SIZE: '201' }, { UPTIME_BATCH_SIZE: '1.5' },
  { UPTIME_CONCURRENCY: '0' }, { UPTIME_CONCURRENCY: '17' }, { UPTIME_CONCURRENCY: 'abc' },
])('rejects an invalid capacity setting: %j', env => {
  expect(() => uptimeCapacityConfig(env)).toThrow(/Invalid UPTIME_/);
});
