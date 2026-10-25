import { expect, it } from 'vitest';
import { buildWorkerProgress } from '@/lib/operations/worker-progress-query';
import { TEXT_PROGRESS_STAGE_JOBS, type ProgressStageInput } from '@/lib/operations/worker-progress';

const now = new Date('2026-10-25T07:00:00Z');
const observations = ['scheduler', 'text', 'reviewer'].map(role => ({
  key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: now,
}));
const keys = Object.keys(TEXT_PROGRESS_STAGE_JOBS) as Array<keyof typeof TEXT_PROGRESS_STAGE_JOBS>;
const input = (key: typeof keys[number], extra: Partial<ProgressStageInput> = {}): ProgressStageInput => ({
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
