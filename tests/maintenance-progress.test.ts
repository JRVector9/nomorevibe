import { expect, it } from 'vitest';
import { maintenanceUptimeStalled } from '@/lib/operations/maintenance-progress';

const ready = { schedulerScheduled: true, waiting: true, oldestMinutes: 8,
  persistedWithin5m: false, inBackoff: false, jobError: false };

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
