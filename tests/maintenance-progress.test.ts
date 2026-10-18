import { expect, it } from 'vitest';
import { maintenanceUptimeStalled } from '@/lib/operations/maintenance-progress';

const ready = { schedulerScheduled: true, waiting: true, oldestMinutes: 8,
  persistedWithin5m: false, inBackoff: false, jobError: false, splitHeld: false };

it('restarts a primary only when overdue uptime work has no persisted result', () => {
  expect(maintenanceUptimeStalled(ready)).toBe(true);
  expect(maintenanceUptimeStalled({ ...ready, waiting: false })).toBe(false);
  expect(maintenanceUptimeStalled({ ...ready, oldestMinutes: 4 })).toBe(false);
  expect(maintenanceUptimeStalled({ ...ready, persistedWithin5m: true })).toBe(false);
});

it('does not turn scheduler, backoff, or job errors into a maintenance failover', () => {
  expect(maintenanceUptimeStalled({ ...ready, schedulerScheduled: false })).toBe(false);
  expect(maintenanceUptimeStalled({ ...ready, inBackoff: true })).toBe(false);
  expect(maintenanceUptimeStalled({ ...ready, jobError: true })).toBe(false);
});

it('does not restart maintenance while a split home breaker deliberately holds checks', () => {
  // 광역 장애로 home 차단기가 열린 동안은 확인을 일부러 쉰다 — 재시작으로 고칠 수 없다
  expect(maintenanceUptimeStalled({ ...ready, splitHeld: true })).toBe(false);
});
