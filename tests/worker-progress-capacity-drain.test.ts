import { expect, it } from 'vitest';
import { buildWorkerProgress } from '@/lib/operations/worker-progress-query';
import { TEXT_PROGRESS_STAGE_JOBS, type ProgressStageInput } from '@/lib/operations/worker-progress';

const now = new Date('2026-10-25T07:00:00Z');
const observations = ['scheduler', 'text', 'reviewer'].map(role => ({
  key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: now,
}));
const keys = Object.keys(TEXT_PROGRESS_STAGE_JOBS) as Array<keyof typeof TEXT_PROGRESS_STAGE_JOBS>;
const input = (key: ProgressStageInput['key'], extra: Partial<ProgressStageInput> = {}): ProgressStageInput => ({
  key, enabled: true, waiting: 5, oldestMinutes: 120, completed5m: 0, progress5m: 0, errors5m: 0, ...extra,
});
function classify(stage: ProgressStageInput, capacity: 'draining' | 'open' | 'disabled') {
  return buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] }, [], observations, now,
    { mode: 'legacy', writerContractVersion: 0 }, [stage], null, [], capacity).stages[0];
}

it.each(keys)('holds %s during intentional global drain', key => {
  expect(classify(input(key), 'draining')).toMatchObject({
    stage: key, held: true, reason: 'backoff', alarm: false, restartEligible: false,
  });
});

it.each(keys)('retains %s stalled-demand alarms with open or disabled capacity', key => {
  for (const capacity of ['open', 'disabled'] as const) {
    expect(classify(input(key), capacity)).toMatchObject({
      reason: 'no_progress', alarm: true, restartEligible: false,
    });
  }
});

it.each(keys)('preserves %s provider errors, explicit pause, and completed progress during drain', key => {
  expect(classify(input(key, { errors5m: 1 }), 'draining')).toMatchObject({
    reason: 'upstream_stalled', alarm: true, restartEligible: false,
  });
  expect(classify(input(key, { enabled: false, errors5m: 1 }), 'draining')).toMatchObject({
    reason: 'paused', alarm: false, restartEligible: false,
  });
  expect(classify(input(key, { completed5m: 1, progress5m: 1 }), 'draining')).toMatchObject({
    reason: 'progressing', alarm: false, restartEligible: false,
  });
});

const modelKeys = ['first', 'second', ...keys] as const;
const historical = (key: typeof modelKeys[number]) => input(key, { providerErrors: 13, providerErrorMinutes: 5056 });

it.each(modelKeys)('holds historical %s item errors only during intentional drain, preserving the evidence', key => {
  expect(classify(historical(key), 'draining')).toMatchObject({
    held: true, reason: 'backoff', alarm: false, restartEligible: false,
    providerErrors: 13, providerErrorMinutes: 5056, errors5m: 0, completed5m: 0,
  });
  for (const capacity of ['open', 'disabled'] as const)
    expect(classify(historical(key), capacity)).toMatchObject({
      reason: 'upstream_stalled', alarm: true, restartEligible: false,
      providerErrors: 13, providerErrorMinutes: 5056, errors5m: 0,
    });
});

it.each([1, null])('does not suppress historical failure alarms with fresh or unknown error counts (%s)', errors5m => {
  expect(classify({ ...historical('keywords'), errors5m }, 'draining'))
    .toMatchObject({ held: true, reason: 'upstream_stalled', alarm: true });
});

it('retains durable job failure alarms during drain even with no recent item failures', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] }, [
    { name: 'product-search-profile', nextScheduledAt: null, notBefore: null, lastError: 'authentication_failed' },
  ], observations, now, { mode: 'legacy', writerContractVersion: 0 }, [historical('keywords')], null, [], 'draining');
  expect(report.stages[0]).toMatchObject({ held: true, reason: 'upstream_stalled', alarm: true, restartEligible: false });
});

it.each(['publish', 'evidence', 'uptime'] as const)('does not hold historical failures for the non-model %s stage', key => {
  expect(classify(input(key, { providerErrors: 13, providerErrorMinutes: 5056 }), 'draining'))
    .toMatchObject({ reason: 'upstream_stalled', alarm: true });
});

const healthyObservations = ['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text'].map(role => ({
  key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: now,
}));
const scheduledJob = { name: 'crawl-fetch', nextScheduledAt: new Date(now.getTime() + 60_000), notBefore: null };

it.each(['healthy', 'missing_worker', 'scheduler_missed', 'lane_poll_timeout', 'job_timeout'] as const)(
  'preserves independent global monitoring during a historical admission hold: %s', fault => {
    const samples = healthyObservations.filter(row => fault !== 'missing_worker' || row.key !== 'service:text:fixture')
      .map(row => fault !== 'lane_poll_timeout' && fault !== 'job_timeout' || row.key !== 'service:text:fixture' ? row : {
        ...row, value: { ...row.value, lanes: [{ name: 'product-search-profile', jobs: ['product-search-profile'],
          state: fault === 'job_timeout' ? 'running' : 'polling',
          currentJob: fault === 'job_timeout' ? 'product-search-profile' : null,
          startedAt: fault === 'job_timeout' ? now.getTime() - 200_000 : null,
          pollStartedAt: fault === 'lane_poll_timeout' ? now.getTime() - 100_000 : null,
          lastProgressAt: now.getTime() - 200_000 }] },
      });
    const job = fault === 'scheduler_missed'
      ? { ...scheduledJob, nextScheduledAt: new Date(now.getTime() - 180_000) } : scheduledJob;
    const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] }, [job], samples, now,
      { mode: 'legacy', writerContractVersion: 0 }, [historical('keywords')], null, [], 'draining');
    expect(report.stages[0]).toMatchObject({ held: true, reason: 'backoff', alarm: false });
    expect(report.overall).toBe(fault === 'healthy' ? 'ok' : 'alarm');
    if (fault === 'missing_worker') expect(report.liveness.find(row => row.role === 'text')).toMatchObject({ reason: 'worker_missing', alarm: true });
    if (fault === 'scheduler_missed') expect(report.scheduler).toMatchObject({ reason: 'scheduler_missed', alarm: true });
    if (fault === 'lane_poll_timeout' || fault === 'job_timeout') expect(report.lanes).toContainEqual(expect.objectContaining({ reason: fault, alarm: true }));
  },
);
