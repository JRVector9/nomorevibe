import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), replay: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: mocks.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: mocks.replay }));
import { CAPACITY_MONITOR_DEFAULTS, capacityMonitorThresholds, capacityReviewOnlyAlarm, capacityUnknownReportSchema,
  readModelCapacityUnknowns, summarizeCapacityReview } from '@/lib/operations/model-capacity-unknowns';
import { combineMonitorStatus, exitCodeFor } from '@/lib/operations/failover-monitor';
import { monitorPushMessage, recordMonitorHeartbeat, runMonitorCycle } from '@/scripts/watch-failover-readiness';
beforeEach(() => { vi.clearAllMocks(); mocks.replay.mockReturnValue(undefined);
  mocks.transaction.mockImplementation((load: (tx: unknown) => unknown) => load({ execute: mocks.execute })); });
const row = () => ({ request_id: randomUUID(), route_id: 'product-translate', group_id: 'm1-mlx', old_policy: true, local_end_recorded: true });
const summary = (review_count: number, oldest_age_seconds: number | null = review_count ? 120 : null, stuck_dispatched = 0) =>
  ({ review_count, oldest_age_seconds, stuck_dispatched });
function reply(rows: ReturnType<typeof row>[], totals = summary(rows.length), control: unknown[] = [{ id: 1 }]) {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce(rows).mockResolvedValueOnce([totals]).mockResolvedValueOnce(control);
}
const ready = { measuredAt: '2026-10-31T00:00:00.000Z', overall: 'ok' as const,
  roles: [], scheduler: { reason: 'ready' as const, alarm: false, freshReplicas: 3, miniFreshReplicas: 1 } };
const progress = { measuredAt: ready.measuredAt, overall: 'ok' as const, stages: [],
  scheduler: { role: 'scheduler' as const, reason: 'scheduled' as const, alarm: false, overdueJobs: [] }, liveness: [] };
const request = (requestId = randomUUID()) => ({ requestId, routeId: 'product-translate', groupId: 'm1-mlx', oldPolicy: false, localEndRecorded: false });

it('reports unknown-outcome calls as a non-alarm human-review queue and carries exact safe IDs to the Oracle heartbeat', async () => {
  const record = row(); reply([record], summary(1, 7_200));
  const capacity = await readModelCapacityUnknowns();
  expect(capacity).toEqual({ status: 'review', truncated: false, count: 1, oldestAgeSeconds: 7_200, stuckDispatched: 0, alarmReasons: [],
    requests: [{ requestId: record.request_id, routeId: 'product-translate', groupId: 'm1-mlx', oldPolicy: true, localEndRecorded: true }] });
  // 2026-10-30 owner decision: review rows never stop work, so they neither page nor turn the monitor DOWN.
  const status = combineMonitorStatus(ready, progress, capacity);
  expect(status.overall).toBe('ok');
  expect(exitCodeFor(status.overall)).toBe(0);
  expect(monitorPushMessage(status)).toBe('worker failover ok; capacity review 1 (oldest 2h)');
  const push = vi.fn().mockResolvedValue(undefined);
  await runMonitorCycle({ badSamples: 0 }, status, { push, record: vi.fn() });
  expect(push).toHaveBeenCalledWith('up', 'worker failover ok; capacity review 1 (oldest 2h)');
  const dir = mkdtempSync(join(tmpdir(), 'capacity-heartbeat-'));
  try {
    recordMonitorHeartbeat(status, join(dir, 'health.json'));
    expect(JSON.parse(readFileSync(join(dir, 'health.json'), 'utf8')).capacityUnknowns).toEqual(capacity);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const dialect = new PgDialect();
  const list = dialect.sqlToQuery(mocks.execute.mock.calls[1][0]).sql;
  expect(list).toContain("r.state = 'indeterminate'");
  expect(list).toContain('r.owner_boot_id::text'); expect(list).toContain('r.dispatch_binding_hash');
  const totals = dialect.sqlToQuery(mocks.execute.mock.calls[2][0]);
  expect(totals.sql).toContain("r.state = 'dispatched'"); expect(totals.sql).toContain('make_interval(secs =>');
  expect(totals.params).toEqual([CAPACITY_MONITOR_DEFAULTS.dispatchStuckSeconds]);
  for (const query of [list, totals.sql]) {
    expect(query).not.toMatch(/FOR UPDATE|FOR SHARE|\bINSERT\b|\bDELETE\b|\bUPDATE\b/);
    expect(query).not.toMatch(/r\.token|dispatch_binding AS/);
  }
  expect(mocks.transaction.mock.calls[0][1]).toEqual({ accessMode: 'read only', isolationLevel: 'repeatable read' });
});

it('reports truncation with the exact total instead of claiming a complete list', async () => {
  reply(Array.from({ length: 65 }, row), summary(70, 600));
  const capacity = await readModelCapacityUnknowns();
  expect(capacity).toMatchObject({ status: 'alarm', truncated: true, count: 70, alarmReasons: ['review_backlog'] });
  expect(capacity.requests).toHaveLength(64);
});

it('requires an observed empty queue and a present control for a clear', async () => {
  reply([]);
  expect(await readModelCapacityUnknowns()).toEqual({ status: 'ok', truncated: false, requests: [], count: 0, oldestAgeSeconds: null,
    stuckDispatched: 0, alarmReasons: [] });
  reply([], summary(0), []); expect(await readModelCapacityUnknowns()).toEqual({ status: 'unknown', truncated: false, requests: [] });
});

it('fails closed on read permission errors, malformed or inconsistent rows and replay without exposing errors or querying replay', async () => {
  mocks.execute.mockRejectedValueOnce(new Error('private DB credential text'));
  expect(await readModelCapacityUnknowns()).toEqual({ status: 'unknown', truncated: false, requests: [] });
  reply([{ ...row(), route_id: 'invalid\nlabel' }]);
  expect((await readModelCapacityUnknowns()).status).toBe('unknown');
  reply([row()], summary(0));
  expect((await readModelCapacityUnknowns()).status).toBe('unknown');
  mocks.execute.mockClear(); mocks.replay.mockReturnValue({});
  expect((await readModelCapacityUnknowns()).status).toBe('unknown'); expect(mocks.execute).not.toHaveBeenCalled();
});

describe('alarm only when work is actually stopped or the review queue is neglected', () => {
  const review = (count: number, oldestAgeSeconds: number | null, stuckDispatched = 0) => summarizeCapacityReview({
    requests: Array.from({ length: Math.min(count, 64) }, () => request()), count, oldestAgeSeconds, stuckDispatched });
  // 2026-11-10: 검토 문턱(review_*)만 넘은 장부는 overall 에 넣지 않는다(보고는 alarm 그대로). 문턱 값은 그대로다.
  it.each([
    [50, 3_600, 0, 'review', [], 'ok'],
    [51, 3_600, 0, 'alarm', ['review_backlog'], 'ok'],
    [3, 86_400, 0, 'review', [], 'ok'],
    [3, 86_401, 0, 'alarm', ['review_stale'], 'ok'],
    [80, 90_000, 0, 'alarm', ['review_backlog', 'review_stale'], 'ok'],
    [0, null, 1, 'alarm', ['dispatch_stuck'], 'alarm'],
    [3, 86_401, 1, 'alarm', ['dispatch_stuck', 'review_stale'], 'alarm'],
    [80, 90_000, 2, 'alarm', ['dispatch_stuck', 'review_backlog', 'review_stale'], 'alarm'],
  ] as const)('count %i, oldest %s s, stuck %i => %s %j, overall %s', (count, age, stuck, status, reasons, overall) => {
    const capacity = review(count, age, stuck);
    expect(capacity).toMatchObject({ status, alarmReasons: reasons, count, stuckDispatched: stuck });
    expect(combineMonitorStatus(ready, progress, capacity).overall).toBe(overall);
  });
  it('names the alarm and the review queue in the Kuma message without exposing request IDs', () => {
    const capacity = review(51, 90_000);
    const message = monitorPushMessage(combineMonitorStatus(ready, progress, capacity));
    expect(message).toBe('worker failover ok; 검토 대기 51건(가장 오래된 25시간) — 사람 검토 필요 (review_backlog+review_stale)');
    expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(monitorPushMessage(combineMonitorStatus(ready, progress, review(51, 90_000, 1))))
      .toBe('worker failover alarm; capacity alarm dispatch_stuck+review_backlog+review_stale; capacity review 51 (oldest 1d)');
    expect(monitorPushMessage(combineMonitorStatus(ready, progress, review(0, null, 1)))).toBe('worker failover alarm; capacity alarm dispatch_stuck');
    expect(monitorPushMessage(combineMonitorStatus(ready, progress, review(0, null)))).toBe('worker failover ok');
  });
  it('an unreadable ledger stays unknown, never ok', () => {
    expect(combineMonitorStatus(ready, progress, { status: 'unknown', truncated: false, requests: [] }).overall).toBe('unknown');
  });
  it('reads positive integer thresholds from the monitor env and keeps the documented defaults otherwise', () => {
    expect(capacityMonitorThresholds({})).toEqual({ reviewMaxRows: 50, reviewMaxAgeSeconds: 86_400, dispatchStuckSeconds: 1_800 });
    expect(capacityMonitorThresholds({ MONITOR_CAPACITY_REVIEW_MAX_ROWS: '200', MONITOR_CAPACITY_REVIEW_MAX_AGE_SECONDS: ' 3600 ',
      MONITOR_CAPACITY_DISPATCH_STUCK_SECONDS: '900' })).toEqual({ reviewMaxRows: 200, reviewMaxAgeSeconds: 3_600, dispatchStuckSeconds: 900 });
    for (const raw of ['0', '-1', '1.5', '1e3', 'abc', '99999999999']) {
      expect(capacityMonitorThresholds({ MONITOR_CAPACITY_REVIEW_MAX_ROWS: raw, MONITOR_CAPACITY_DISPATCH_STUCK_SECONDS: raw }))
        .toEqual(CAPACITY_MONITOR_DEFAULTS);
    }
    expect(summarizeCapacityReview({ requests: [request()], count: 1, oldestAgeSeconds: 7_200, stuckDispatched: 0 },
      { ...CAPACITY_MONITOR_DEFAULTS, reviewMaxAgeSeconds: 3_600 })).toMatchObject({ status: 'alarm', alarmReasons: ['review_stale'] });
  });
});

describe('2026-11-10 owner decision: a review-only ledger alarm pushes UP with a message, everything else keeps DOWN', () => {
  const review = (count: number, oldestAgeSeconds: number | null, stuckDispatched = 0) => summarizeCapacityReview({
    requests: Array.from({ length: Math.min(count, 64) }, () => request()), count, oldestAgeSeconds, stuckDispatched });
  // 11-09 배포 창: indeterminate 35건, 가장 오래된 41시간 → review_stale 하나.
  const staleOnly = () => review(35, 147_600);
  const reviewMessage = '검토 대기 35건(가장 오래된 41시간) — 사람 검토 필요 (review_stale)';
  const cycleTwice = async (status: ReturnType<typeof combineMonitorStatus>) => {
    const push = vi.fn().mockResolvedValue(undefined), record = vi.fn();
    const first = await runMonitorCycle({ badSamples: 0 }, status, { push, record });
    const second = await runMonitorCycle(first, status, { push, record });
    return { push, first, second };
  };

  it('classifies only review_* reasons with no stuck dispatched row as review-only', () => {
    expect(capacityReviewOnlyAlarm(staleOnly())).toBe(true);
    expect(capacityReviewOnlyAlarm(review(51, 3_600))).toBe(true);
    expect(capacityReviewOnlyAlarm(review(80, 90_000))).toBe(true);
    expect(capacityReviewOnlyAlarm(review(35, 147_600, 1))).toBe(false);
    expect(capacityReviewOnlyAlarm(review(0, null, 1))).toBe(false);
    expect(capacityReviewOnlyAlarm(review(3, 3_600))).toBe(false);
    expect(capacityReviewOnlyAlarm(review(0, null))).toBe(false);
    expect(capacityReviewOnlyAlarm({ status: 'unknown', truncated: false, requests: [] })).toBe(false);
    expect(capacityReviewOnlyAlarm(undefined)).toBe(false);
  });

  it('review-only: overall ok, UP at once with the review message, and the review condition stays in the output', async () => {
    const capacity = staleOnly();
    expect(capacity).toMatchObject({ status: 'alarm', alarmReasons: ['review_stale'], count: 35, oldestAgeSeconds: 147_600, stuckDispatched: 0 });
    const status = combineMonitorStatus(ready, progress, capacity);
    expect(status).toMatchObject({ overall: 'ok', warnings: ['capacity_review'], capacityUnknowns: capacity });
    expect(exitCodeFor(status.overall)).toBe(0);
    expect(monitorPushMessage(status)).toBe(`worker failover ok; ${reviewMessage}`);
    const push = vi.fn().mockResolvedValue(undefined);
    // A previous bad sample does not delay the UP: the review-only sample is a good sample.
    expect(await runMonitorCycle({ badSamples: 1 }, status, { push, record: vi.fn() })).toEqual({ badSamples: 0 });
    expect(push).toHaveBeenCalledWith('up', `worker failover ok; ${reviewMessage}`);
    const dir = mkdtempSync(join(tmpdir(), 'capacity-review-only-'));
    try {
      recordMonitorHeartbeat(status, join(dir, 'health.json'));
      const heartbeat = JSON.parse(readFileSync(join(dir, 'health.json'), 'utf8'));
      expect(heartbeat.overall).toBe('ok');
      expect(heartbeat.capacityUnknowns).toEqual(capacity);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('review + stuck dispatched row: alarm and DOWN after two samples, as before', async () => {
    const status = combineMonitorStatus(ready, progress, review(35, 147_600, 1));
    expect(status.overall).toBe('alarm');
    expect(status.warnings).toBeUndefined();
    expect(exitCodeFor(status.overall)).toBe(2);
    const { push, first, second } = await cycleTwice(status);
    expect([first.badSamples, second.badSamples]).toEqual([1, 2]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('down', 'worker failover alarm; capacity alarm dispatch_stuck+review_stale; capacity review 35 (oldest 1d)');
  });

  it('review + another alarm or an unreadable state: DOWN after two samples, the review stays a warning', async () => {
    for (const [status, overall] of [
      [combineMonitorStatus({ ...ready, overall: 'alarm' }, progress, staleOnly()), 'alarm'],
      [combineMonitorStatus(ready, { ...progress, overall: 'alarm' }, staleOnly()), 'alarm'],
      [combineMonitorStatus(ready, { ...progress, overall: 'unknown' }, staleOnly()), 'unknown'],
      [combineMonitorStatus(null, progress, staleOnly()), 'unknown'],
      [combineMonitorStatus(ready, null, staleOnly()), 'unknown'],
    ] as const) {
      expect(status).toMatchObject({ overall, warnings: ['capacity_review'] });
      expect(exitCodeFor(status.overall)).toBe(overall === 'alarm' ? 2 : 1);
      const { push, second } = await cycleTwice(status);
      expect(second.badSamples).toBe(2);
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith('down', `worker failover ${overall}; ${reviewMessage}`);
    }
  });

  it('no review-only alarm: unchanged', async () => {
    for (const [capacity, message] of [
      [review(0, null), 'worker failover ok'],
      [review(3, 3_600), 'worker failover ok; capacity review 3 (oldest 1h)'],
      [undefined, 'worker failover ok'],
    ] as const) {
      const status = combineMonitorStatus(ready, progress, capacity);
      expect(status.overall).toBe('ok');
      expect(status.warnings).toBeUndefined();
      expect(monitorPushMessage(status)).toBe(message);
      const push = vi.fn().mockResolvedValue(undefined);
      await runMonitorCycle({ badSamples: 0 }, status, { push, record: vi.fn() });
      expect(push).toHaveBeenCalledWith('up', message);
    }
    const unread = combineMonitorStatus(ready, progress, { status: 'unknown', truncated: false, requests: [] });
    expect(unread).toMatchObject({ overall: 'unknown' });
    expect(unread.warnings).toBeUndefined();
    expect(monitorPushMessage(unread)).toBe('worker failover unknown');
  });
});

it.each([
  { status: 'ok', truncated: false, requests: [request()], count: 1, oldestAgeSeconds: 1, stuckDispatched: 0, alarmReasons: [] },
  { status: 'review', truncated: false, requests: [], count: 0, oldestAgeSeconds: null, stuckDispatched: 0, alarmReasons: [] },
  { status: 'alarm', truncated: false, requests: [request()], count: 1, oldestAgeSeconds: 1, stuckDispatched: 0, alarmReasons: [] },
  { status: 'alarm', truncated: false, requests: [], count: 0, oldestAgeSeconds: null, stuckDispatched: 0, alarmReasons: ['dispatch_stuck'] },
  { status: 'alarm', truncated: false, requests: [], count: 0, oldestAgeSeconds: null, stuckDispatched: 0, alarmReasons: ['review_backlog'] },
  { status: 'review', truncated: true, requests: [request()], count: 1, oldestAgeSeconds: 1, stuckDispatched: 0, alarmReasons: [] },
  { status: 'unknown', truncated: false, requests: [], count: 0, oldestAgeSeconds: null, stuckDispatched: 0, alarmReasons: [] },
  // A summary-less 'alarm' is the pre-2026-10-31 "review pending" shape; this producer never emits it.
  { status: 'alarm', truncated: false, requests: [request()] },
])('rejects inconsistent summary %j', value => {
  expect(capacityUnknownReportSchema.safeParse(value).success).toBe(false);
});
