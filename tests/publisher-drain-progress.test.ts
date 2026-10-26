import { expect, it } from 'vitest';
import { modelCapacityPolicyHash } from '@/lib/llm/capacity';
import { publisherClassificationDrainHeld } from '@/lib/operations/publisher-drain-progress';
import { buildWorkerProgress } from '@/lib/operations/worker-progress-query';
import { roleHasUnexplainedStall } from '@/scripts/role-worker';

const policy = { version: 1 as const, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { group: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 10,
  queueTtlMs: 60_000, reservationTtlMs: 15_000,
  routes: [{ routeId: 'crawl-publish-classify', provider: 'codex-cli', model: 'offline', providerBudgetId: 'account', groupId: 'group' }] };
function snapshot() {
  const capacity = { epoch: 1, revision: 3, policyHash: modelCapacityPolicyHash(policy), updatedAt: '2026-10-26T09:58:19.240000Z' };
  const role = { instanceId: 'm3-publisher', bootId: '11111111-1111-4111-8111-111111111111', release: 'd'.repeat(40), epoch: 250, kind: 'primary' as const };
  const job = { requestedVersion: 12, processedVersion: 7, runs: 8, lastRunAt: '2026-10-26T10:06:25.123456Z' };
  return { value: { version: 1 as const, reason: 'classification_draining' as const, capacity: { ...capacity }, role: { ...role },
    job: { ...job, name: 'crawl-publish' as const, token: '22222222-2222-4222-8222-222222222222' } },
    capacity, policy, role, job: { ...job, token: null as string | null, lastError: null as string | null, claimLive: false, released: true },
    mode: 'draining', writerActive: true, batchMode: 'legacy', roleLive: true, at: 60_000, observedAt: 59_000 };
}
it('accepts the same fresh exact execution after its deferred lease is released', () => {
  const row = snapshot();
  expect(publisherClassificationDrainHeld(row)).toBe(true);
  row.job.token = row.value.job.token;
  row.job.released = false; row.job.claimLive = true;
  expect(publisherClassificationDrainHeld(row)).toBe(true);
});
const invalid: Array<[string, (row: ReturnType<typeof snapshot>) => void]> = [
  ['generic capacity', row => { row.value.reason = 'model_capacity' as never; }],
  ['provider refusal', row => { row.value.reason = 'provider_contract_unavailable' as never; }],
  ['OPEN', row => { row.mode = 'open'; }], ['DISABLED', row => { row.mode = 'disabled'; }],
  ['expired', row => { row.observedAt = -1; }], ['future', row => { row.observedAt = row.at + 1; }],
  ['policy revision', row => { row.capacity.revision++; }], ['drain ABA', row => { row.capacity.updatedAt = '2026-10-26T10:00:00.000000Z'; }],
  ['policy contents', row => { row.policy = { ...row.policy, globalLimit: 2 }; }],
  ['fenced', row => { row.writerActive = false; }], ['versioned', row => { row.batchMode = 'versioned'; }],
  ['owner', row => { row.role.instanceId = 'foreign'; }], ['boot', row => { row.role.bootId = '33333333-3333-4333-8333-333333333333'; }],
  ['release', row => { row.role.release = 'a'.repeat(40); }], ['role epoch', row => { row.role.epoch++; }],
  ['role expired', row => { row.roleLive = false; }], ['next execution', row => { row.job.runs++; }],
  ['same-request rerun', row => { row.job.lastRunAt = '2026-10-26T10:06:26.123456Z'; }],
  ['new request', row => { row.job.requestedVersion++; }], ['acknowledged', row => { row.job.processedVersion++; }],
  ['foreign claim', row => { row.job.token = '33333333-3333-4333-8333-333333333333'; }],
  ['stale claim', row => { row.job.token = row.value.job.token; row.job.released = false; }],
  ['partially released claim', row => { row.job.released = false; }],
  ['job failure', row => { row.job.lastError = 'database_unavailable'; }],
];
it.each(invalid)('rejects %s evidence', (_, change) => {
  const row = snapshot(); change(row); expect(publisherClassificationDrainHeld(row)).toBe(false);
});
it.each([undefined, null, {}, { value: {} }])('keeps missing and malformed evidence fail closed (%j)', row => {
  expect(publisherClassificationDrainHeld(row)).toBe(false);
});

const now = new Date('2026-10-26T10:06:40Z');
const observations = ['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text'].map(role => ({
  key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: now }));
const stage = { key: 'publish' as const, label: 'publish', unit: '건' as const, enabled: true, waiting: 7, oldestMinutes: 10.73,
  completed1m: 0, completed5m: 0, progress5m: 0, errors5m: null, queueNote: '', detail: '', status: 'stalled' as const };
function report(mode: 'draining' | 'open' | 'disabled', held: boolean, extra = {}, lastError: string | null = null, samples = observations) {
  return buildWorkerProgress({ measuredAt: now.toISOString(), stages: [{ ...stage, ...extra }] },
    [{ name: 'crawl-publish', nextScheduledAt: new Date(now.getTime() + 60_000), notBefore: null, lastError }], samples,
    now, { mode: 'legacy', writerContractVersion: 0 }, [], null, [], mode, held);
}
it('explains only observed classification draining, preserving normal publication stalls', () => {
  const held = report('draining', true);
  expect(held.stages[0]).toMatchObject({ reason: 'backoff', held: true, alarm: false, restartEligible: false });
  expect(roleHasUnexplainedStall(held, 'publisher')).toBe(false);
  for (const mode of ['draining', 'open', 'disabled'] as const) {
    const stalled = report(mode, mode !== 'draining');
    expect(stalled.stages[0]).toMatchObject({ reason: 'no_progress', alarm: true, restartEligible: true });
    expect(roleHasUnexplainedStall(stalled, 'publisher')).toBe(true);
  }
});
it('preserves provider, job errors, progress, explicit pause and unknown-age classification', () => {
  for (const [extra, error, reason] of [
    [{ errors5m: 1 }, null, 'upstream_or_job_error'], [{ providerErrors: 2, providerErrorMinutes: 45 }, null, 'upstream_stalled'],
    [{}, 'database_unavailable', 'upstream_or_job_error'], [{ completed5m: 1, progress5m: 1 }, null, 'progressing'],
    [{ enabled: false }, null, 'paused'], [{ oldestMinutes: null }, null, 'unknown_age'],
  ] as const) expect(report('draining', true, extra, error).stages[0].reason).toBe(reason);
  const missing = report('draining', true, {}, null, observations.filter(row => row.key !== 'service:publisher:fixture'));
  expect(missing.liveness.find(row => row.role === 'publisher')).toMatchObject({ alarm: true });
  expect(missing.overall).toBe('alarm');
});

it.each(['lane_poll_timeout', 'job_timeout'] as const)('retains publisher %s recovery during a proven drain', fault => {
  const samples = observations.map(row => row.key !== 'service:publisher:fixture' ? row : {
    ...row, value: { ...row.value, lanes: [{ name: 'crawl-publish', jobs: ['crawl-publish'],
      state: fault === 'job_timeout' ? 'running' : 'polling', currentJob: fault === 'job_timeout' ? 'crawl-publish' : null,
      startedAt: fault === 'job_timeout' ? now.getTime() - 200_000 : null,
      pollStartedAt: fault === 'lane_poll_timeout' ? now.getTime() - 100_000 : null, lastProgressAt: now.getTime() - 200_000 }] },
  });
  const result = report('draining', true, {}, null, samples);
  expect(result.stages[0].reason).toBe('backoff');
  expect(result.lanes).toContainEqual(expect.objectContaining({ role: 'publisher', reason: fault, alarm: true, restartEligible: true }));
  expect(result.overall).toBe('alarm');
  expect(roleHasUnexplainedStall(result, 'publisher')).toBe(true);
});

it('retains a missed scheduler alarm during proven publication draining', () => {
  const result = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [stage] },
    [{ name: 'crawl-publish', nextScheduledAt: new Date(now.getTime() - 11 * 60_000), notBefore: null }], observations,
    now, { mode: 'legacy', writerContractVersion: 0 }, [], null, [], 'draining', true);
  expect(result.stages[0].reason).toBe('backoff');
  expect(result.scheduler).toMatchObject({ reason: 'scheduler_missed', alarm: true });
  expect(result.overall).toBe('alarm');
});
