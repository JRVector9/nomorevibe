import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { MonitorStatus } from '@/lib/operations/failover-monitor';
import { TEXT_PROGRESS_STAGE_JOBS, type StageProgress } from '@/lib/operations/worker-progress';
import { monitorHeartbeatIsFresh } from '@/scripts/monitor-healthcheck';
import { recordMonitorHeartbeat } from '@/scripts/watch-failover-readiness';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const lane = (extra: Partial<StageProgress> = {}): StageProgress => ({ stage: 'keywords', role: 'text',
  reason: 'upstream_or_job_error', alarm: false, waiting: 1, deferred: 0, providerErrors: 1,
  errors5m: 0, completed5m: 0, progress5m: 0, ...extra });
const status = (stages: StageProgress[] | null): MonitorStatus => ({ measuredAt: new Date().toISOString(),
  overall: 'ok', readiness: null, progress: stages === null ? null : {
    measuredAt: new Date().toISOString(), overall: 'ok', stages, scheduler: { role: 'scheduler', reason: 'scheduled',
      alarm: false, overdueJobs: [] }, liveness: [], lanes: [], activeJobs: [],
  } });

function heartbeat(value: MonitorStatus, path?: string) {
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), 'nomorevibe-monitor-heartbeat-'));
    directories.push(directory);
    path = join(directory, 'health.json');
  }
  recordMonitorHeartbeat(value, path);
  return { path, value: JSON.parse(readFileSync(path, 'utf8')) };
}

it('records only fixed text-stage keys and deduplicates failures without leaking report fields', () => {
  const keys = Object.keys(TEXT_PROGRESS_STAGE_JOBS) as StageProgress['stage'][];
  const extra = { secret: 'private-token', url: 'https://private.test/token' };
  const report = status([...keys.map(stage => ({ ...lane({ stage }), ...extra })), lane(),
    lane({ stage: 'evidence' }), { ...lane(), stage: 'untrusted-secret' } as unknown as StageProgress]);
  const { value, path } = heartbeat(report);
  expect(value).toEqual({ checkedAt: expect.any(Number), overall: 'ok', providerFailures: keys, reviewFailures: [] });
  expect(JSON.stringify(value)).not.toMatch(/private|untrusted|url|secret/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(monitorHeartbeatIsFresh(value)).toBe(true);
});

it('keeps a provider failure through retry backoff and resets its presence after pause, resume and success', () => {
  const first = heartbeat(status([lane({ waiting: 0, deferred: 1, reason: 'backoff' })]));
  expect(first.value.providerFailures).toEqual(['keywords']);
  expect(heartbeat(status([lane({ waiting: 0, deferred: 1, reason: 'backoff', providerErrorMinutes: 0 })]), first.path)
    .value.providerFailures).toEqual(['keywords']);
  expect(heartbeat(status([lane({ reason: 'paused' })]), first.path).value.providerFailures).toEqual([]);
  expect(heartbeat(status([lane()]), first.path).value.providerFailures).toEqual(['keywords']);
  expect(heartbeat(status([lane({ completed5m: 1 })]), first.path).value.providerFailures).toEqual([]);
  expect(heartbeat(status([lane({ progress5m: 1 })]), first.path).value.providerFailures).toEqual([]);
});

it.each([
  { waiting: 0, deferred: 0 }, { providerErrors: 0, errors5m: 0 }, { reason: 'no_work' },
  { reason: 'manual_attention' }, { held: true }, { completed5m: Number.NaN },
  { providerErrors: Number.POSITIVE_INFINITY, errors5m: 0 }, { waiting: Number.POSITIVE_INFINITY },
] satisfies Partial<StageProgress>[])('does not report an inactive, held or invalid lane: %j', extra => {
  expect(heartbeat(status([lane(extra)])).value.providerFailures).toEqual([]);
});

it('accepts recent failure counts and deferred demand without requiring an already-aged provider error', () => {
  expect(heartbeat(status([lane({ waiting: 0, deferred: 2, providerErrors: 0, errors5m: 1,
    providerErrorMinutes: 0 })])).value.providerFailures).toEqual(['keywords']);
});

it('preserves the legacy heartbeat fields and omits unavailable provider observations', () => {
  const { value } = heartbeat(status(null));
  expect(value).toEqual({ checkedAt: expect.any(Number), overall: 'ok' });
  expect(monitorHeartbeatIsFresh(value)).toBe(true);
  expect(heartbeat(status([])).value.providerFailures).toEqual([]);
});

it('reports AI1 capacity blocking and AI2 consumer absence without transmitting model or request data', () => {
  const first = { ...lane({ stage: 'first', role: 'reviewer', reason: 'no_progress', alarm: true,
    restartEligible: false, providerErrors: 0 }), admissionBlock: { reason: 'capacity' as const,
    routeId: 'crawl-agent-review', groupId: 'private-model-group', scope: 'group' as const } };
  const second = lane({ stage: 'second', role: 'reviewer', reason: 'consumer_missing', alarm: true, restartEligible: false });
  const value = heartbeat(status([first, second])).value;
  expect(value.reviewFailures).toEqual([{ stage: 'first', reason: 'capacity_blocked' },
    { stage: 'second', reason: 'consumer_missing' }]);
  expect(JSON.stringify(value)).not.toMatch(/private|routeId|groupId|scope/);
});

it('distinguishes a locally restartable review stall from an independent consumer stall', () => {
  expect(heartbeat(status([lane({ stage: 'first', reason: 'no_progress', alarm: true, restartEligible: true })]))
    .value.reviewFailures).toEqual([{ stage: 'first', reason: 'local_stalled' }]);
  expect(heartbeat(status([lane({ stage: 'first', reason: 'no_progress', alarm: true, restartEligible: false })]))
    .value.reviewFailures).toEqual([{ stage: 'first', reason: 'review_stalled' }]);
});

it.each([
  { reason: 'paused' as const, alarm: false }, { reason: 'backoff' as const, alarm: false },
  { waiting: 0, deferred: 0 }, { completed5m: 1 }, { progress5m: 1 }, { held: true },
  { completed5m: Number.NaN }, { waiting: Number.POSITIVE_INFINITY },
])('does not turn inactive, progressing or unobserved review work into a stall: %j', extra => {
  expect(heartbeat(status([lane({ stage: 'first', reason: 'no_progress', alarm: true, ...extra })]))
    .value.reviewFailures).toEqual([]);
});

it('adds collection, approval, Korean text, scheduler and role faults while aggregate is already down', () => {
  const report = status([
    lane({ stage: 'fetch', role: 'crawler', reason: 'no_progress', alarm: true }),
    lane({ stage: 'evidence', role: 'crawler', reason: 'upstream_stalled', alarm: true }),
    lane({ stage: 'publish', role: 'publisher', reason: 'worker_missing', alarm: true }),
    lane({ stage: 'tagline-ko', reason: 'no_progress', alarm: true }),
    lane({ stage: 'intro-check', role: 'reviewer', reason: 'no_progress', alarm: true }),
  ]);
  report.overall = 'alarm';
  report.progress!.scheduler = { role: 'scheduler', reason: 'scheduler_missed', alarm: true, overdueJobs: ['private-job'] };
  report.progress!.liveness = [{ role: 'crawler', reason: 'restart_loop', alarm: true }];
  expect(heartbeat(report).value.stageFailures).toEqual([
    { stage: 'fetch', reason: 'no_progress' }, { stage: 'evidence', reason: 'upstream_stalled' },
    { stage: 'publish', reason: 'worker_missing' }, { stage: 'tagline-ko', reason: 'no_progress' },
    { stage: 'intro-check', reason: 'no_progress' }, { stage: 'scheduler', reason: 'scheduler_missed' },
    { stage: 'role-crawler', reason: 'restart_loop' },
  ]);
  expect(JSON.stringify(heartbeat(report).value)).not.toContain('private-job');
});

it('keeps existing review and provider timing and omits held, non-alarm or unknown stage faults', () => {
  const report = status([
    lane({ stage: 'first', role: 'reviewer', reason: 'no_progress', alarm: true }),
    lane({ stage: 'second', role: 'reviewer', reason: 'consumer_missing', alarm: true }),
    lane({ reason: 'upstream_stalled', alarm: true }),
    lane({ stage: 'publish', reason: 'no_progress', alarm: true, held: true }),
    lane({ stage: 'fetch', reason: 'no_progress', alarm: false }),
    { ...lane({ reason: 'no_progress', alarm: true }), stage: 'private-token' } as unknown as StageProgress,
  ]);
  const value = heartbeat(report).value;
  expect(value).not.toHaveProperty('stageFailures');
  expect(value.providerFailures).toContain('keywords');
  expect(value.reviewFailures).toHaveLength(2);
  expect(heartbeat(status(report.progress!.stages.slice(0, -1))).value.stageFailures).toEqual([]);
  expect(heartbeat(status([])).value.stageFailures).toEqual([]);
  expect(heartbeat(status(null)).value).not.toHaveProperty('stageFailures');
});

it('still reports upstream text faults when existing provider metadata cannot represent them', () => {
  expect(heartbeat(status([lane({ reason: 'upstream_stalled', alarm: true, providerErrors: 0, errors5m: 0 })]))
    .value.stageFailures).toEqual([{ stage: 'keywords', reason: 'upstream_stalled' }]);
});

it.each([
  { reason: 'unknown_age' as const }, { waiting: Number.NaN }, { progress5m: Number.POSITIVE_INFINITY }, { errors5m: -1 },
])('does not report a clear while one included stage is unmeasured even if another is alarmed: %j', extra => {
  const report = status([lane({ stage: 'fetch', reason: 'no_progress', alarm: true }), lane(extra)]);
  report.overall = 'alarm';
  report.progress!.overall = 'alarm';
  expect(heartbeat(report).value).not.toHaveProperty('stageFailures');
});

it('preserves unknown scheduler and overall observations instead of emitting an empty stage clear', () => {
  const report = status([]);
  report.progress!.scheduler = { role: 'scheduler', reason: 'unknown_schedule', alarm: false, overdueJobs: [] };
  report.progress!.overall = 'alarm';
  expect(heartbeat(report).value).not.toHaveProperty('stageFailures');
  report.progress!.scheduler = { role: 'scheduler', reason: 'scheduled', alarm: false, overdueJobs: [] };
  report.progress!.overall = 'unknown';
  expect(heartbeat(report).value).not.toHaveProperty('stageFailures');
});
