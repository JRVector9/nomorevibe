import { expect, it } from 'vitest';
import { textProgressStalled } from '@/lib/operations/text-progress';

const ready = { schedulerScheduled: true, oldestReadyMinutes: 12, persistedWithin10m: false,
  inBackoff: false, providerError: false, admissionHeld: false };

it('requires old eligible text work and no saved result before restarting', () => {
  expect(textProgressStalled(ready)).toBe(true);
  expect(textProgressStalled({ ...ready, oldestReadyMinutes: null })).toBe(false);
  expect(textProgressStalled({ ...ready, oldestReadyMinutes: 8 })).toBe(false);
  expect(textProgressStalled({ ...ready, persistedWithin10m: true })).toBe(false);
});

it('suppresses failover when the scheduler or shared provider is the cause', () => {
  expect(textProgressStalled({ ...ready, schedulerScheduled: false })).toBe(false);
  expect(textProgressStalled({ ...ready, inBackoff: true })).toBe(false);
  expect(textProgressStalled({ ...ready, providerError: true })).toBe(false);
});

it('does not restart for intentionally held model admission, and resumes stall detection when it opens', () => {
  expect(textProgressStalled({ ...ready, admissionHeld: true })).toBe(false);
  expect(textProgressStalled(ready)).toBe(true);
});
