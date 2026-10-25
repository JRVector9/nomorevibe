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
  expect(value).toEqual({ checkedAt: expect.any(Number), overall: 'ok', providerFailures: keys });
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
