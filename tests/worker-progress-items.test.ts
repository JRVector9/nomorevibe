import { expect, it } from 'vitest';
import { buildWorkerProgress } from '@/lib/operations/worker-progress-query';
import type { ThroughputStage } from '@/lib/operations/throughput-model';
import { selectUnexplainedStall, roleHasUnexplainedStall } from '@/scripts/role-worker';

const now = new Date('2026-10-25T06:01:00Z');
const batch = { mode: 'legacy', writerContractVersion: 0 };
const observations = ['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text']
  .map(role => ({ key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: now }));
const stage = (key: 'first' | 'second', enabled = true): ThroughputStage => ({ key, label: key, unit: '표', enabled,
  waiting: 3, oldestMinutes: 468, completed1m: 0, completed5m: 0, progress5m: 0, errors5m: 0,
  queueNote: '', detail: '', status: 'stalled' });
const jobs = [{ name: 'crawl-agent-review', nextScheduledAt: new Date(now.getTime() + 60_000), notBefore: null },
  { name: 'second-review', nextScheduledAt: new Date(now.getTime() + 60_000), notBefore: null }];

it.each([['first', 'ai1'], ['second', 'ai2']] as const)(
  'keeps stalled %s item-consumer work out of the unrelated reviewer restart decision', (key, itemStage) => {
    const consumer = { key: `service:reviewer:${itemStage}-consumer-m3`, value: { status: 'running' }, observedAt: now };
    const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage(key)] }, jobs,
      [...observations, consumer], now, batch, [], null, [{ stage: itemStage, mode: 'items', drainingFrom: null }]);
    expect(report.stages[0]).toMatchObject({ reason: 'no_progress', alarm: true, restartEligible: false });
    expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
  });

it.each(['absent', 'stale', 'stopped'] as const)('alerts on an %s AI2 consumer without restarting reviewer', state => {
  const consumer = { key: 'service:reviewer:ai2-consumer-m3', value: { status: state === 'stopped' ? 'stopped' : 'running' },
    observedAt: new Date(now.getTime() - (state === 'stale' ? 121_000 : 0)) };
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('second')] }, jobs,
    state === 'absent' ? observations : [...observations, consumer], now, batch, [], null,
    [{ stage: 'ai2', mode: 'items', drainingFrom: null }]);
  expect(report.stages[0]).toMatchObject({ reason: 'consumer_missing', alarm: true, restartEligible: false });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
});

it('preserves a deliberate AI2 pause when no consumer is deployed', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('second', false)] }, jobs,
    observations, now, batch, [], null, [{ stage: 'ai2', mode: 'items', drainingFrom: null }]);
  expect(report.stages[0]).toMatchObject({ reason: 'paused', alarm: false, restartEligible: false });
});

it.each(['legacy', 'items'] as const)('treats an intentional drain from %s as backoff', drainingFrom => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('second')] }, jobs,
    observations, now, batch, [], null, [{ stage: 'ai2', mode: 'draining', drainingFrom }]);
  expect(report.stages[0]).toMatchObject({ reason: 'backoff', alarm: false, restartEligible: false });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
});

it('retains legacy first-review recovery independently of an item-owned second stage', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('first'), stage('second')] }, jobs,
    observations, now, batch, [], null, [{ stage: 'ai1', mode: 'legacy', drainingFrom: null },
      { stage: 'ai2', mode: 'items', drainingFrom: null }]);
  expect(report.stages[0]).toMatchObject({ reason: 'no_progress', restartEligible: true });
  expect(report.stages[1]).toMatchObject({ reason: 'consumer_missing', restartEligible: false });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(true);
});

it('does not use an active legacy orchestration job to hide a stalled AI2 consumer', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('second')] },
    jobs.map(job => job.name === 'second-review' ? { ...job, lockedAt: now, leaseToken: 'legacy-lock' } : job),
    [...observations.filter(row => row.key !== 'service:reviewer:fixture'),
      { key: 'service:reviewer:fixture', value: { status: 'running', currentJob: 'second-review', state: 'running', jobStartedAt: now.getTime() }, observedAt: now },
      { key: 'service:reviewer:ai2-consumer-m3', value: { status: 'running' }, observedAt: now }],
    now, batch, [], null, [{ stage: 'ai2', mode: 'items', drainingFrom: null }]);
  expect(report.stages[0]).toMatchObject({ reason: 'no_progress', alarm: true, restartEligible: false });
});

it('does not let healthy independent AI2 output hide a stalled legacy first-review lane', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('first'), { ...stage('second'), completed5m: 2, progress5m: 2 }] },
    jobs, [...observations, { key: 'service:reviewer:ai2-consumer-m3', value: { status: 'running' }, observedAt: now }],
    now, batch, [], null, [{ stage: 'ai1', mode: 'legacy', drainingFrom: null }, { stage: 'ai2', mode: 'items', drainingFrom: null }]);
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(true);
});

it.each([true, false])('holds model-dependent stages during global capacity drain (consumer present: %s)', consumerPresent => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('first'), stage('second')] }, jobs,
    [...observations, ...(consumerPresent ? [{ key: 'service:reviewer:ai2-consumer-m3', value: { status: 'running' }, observedAt: now }] : [])],
    now, batch, [], null, [{ stage: 'ai1', mode: 'legacy', drainingFrom: null }, { stage: 'ai2', mode: 'items', drainingFrom: null }], 'draining');
  expect(report.stages).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'first', held: true, reason: 'backoff', alarm: false, restartEligible: false }),
    expect.objectContaining({ stage: 'second', held: true, reason: 'backoff', alarm: false, restartEligible: false }),
  ]));
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
});

it.each(['open', 'disabled'] as const)('preserves actual legacy first-review recovery when capacity is %s', capacityMode => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('first')] }, jobs, observations,
    now, batch, [], null, [{ stage: 'ai1', mode: 'legacy', drainingFrom: null }], capacityMode);
  expect(report.stages[0]).toMatchObject({ reason: 'no_progress', alarm: true, restartEligible: true });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(true);
});

it('keeps provider failure and deliberate review pause visible during global capacity drain', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [
    { ...stage('first'), errors5m: 1 }, stage('second', false),
  ] }, jobs, observations, now, batch, [], null,
  [{ stage: 'ai1', mode: 'legacy', drainingFrom: null }, { stage: 'ai2', mode: 'items', drainingFrom: null }], 'draining');
  expect(report.stages[0]).toMatchObject({ reason: 'upstream_stalled', alarm: true, restartEligible: false });
  expect(report.stages[1]).toMatchObject({ reason: 'paused', alarm: false, restartEligible: false });
});

it('does not hide a stalled non-model publication stage during global capacity drain', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [{ ...stage('first'), key: 'publish' }] },
    jobs, observations, now, batch, [], null, [], 'draining');
  expect(report.stages[0]).toMatchObject({ stage: 'publish', reason: 'no_progress', alarm: true, restartEligible: true });
});


it('keeps unleased FIRST capacity waiting alarmed without restarting reviewer', () => {
  const blocked = [{ job: 'crawl-agent-review', routeId: 'crawl-agent-review', groupId: 'm3-mlx', scope: 'device' as const }];
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('first')] }, jobs,
    observations, now, batch, [], null, [], 'open', false, blocked);
  expect(report.activeJobs).toEqual([]);
  expect(report.stages[0]).toMatchObject({ reason: 'no_progress', alarm: true, waiting: 3, progress5m: 0,
    restartEligible: false, admissionBlock: { reason: 'capacity', groupId: 'm3-mlx', scope: 'device' } });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
  expect(selectUnexplainedStall(report, 'reviewer')).toBeNull();
});

it('still diagnoses a hung reviewer lane while FIRST is capacity blocked', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('first')] }, jobs,
    observations, now, batch, [], null, [], 'open', false,
    [{ job: 'crawl-agent-review', routeId: 'crawl-agent-review', groupId: 'm3-mlx', scope: 'device' }]);
  report.lanes = [{ role: 'reviewer', name: 'audit-screen-review', jobs: ['crawl-agent-review'], state: 'polling',
    currentJob: null, startedAt: null, pollStartedAt: now.getTime() - 100_000, lastProgressAt: now.getTime() - 100_000,
    pollAgeMs: 100_000, progressAgeMs: 100_000, reason: 'lane_poll_timeout', alarm: true, restartEligible: true }];
  expect(selectUnexplainedStall(report, 'reviewer')).toMatchObject({ kind: 'lane', reason: 'lane_poll_timeout',
    lane: 'audit-screen-review', age: 100_000, wait: 100_000, restartEligible: true });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(true);
});

it('does not apply another job capacity block to FIRST recovery', () => {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage('first')] }, jobs,
    observations, now, batch, [], null, [], 'open', false,
    [{ job: 'second-review', routeId: 'second-review', groupId: 'gpu3090', scope: 'device' }]);
  expect(selectUnexplainedStall(report, 'reviewer')).toMatchObject({ kind: 'stage', reason: 'no_progress',
    job: 'crawl-agent-review', age: 468, wait: 3, progress: 0, restartEligible: true });
});
