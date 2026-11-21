import { beforeEach, expect, it, vi } from 'vitest';

// 2026-11-21: 감시는 DB 연결이 1개다. 무거운 사유 번역 집계는 다른 읽기보다 먼저 혼자 돌고, 읽지 못한 조각은 이름·코드로 남는다.
const mocks = vi.hoisted(() => ({ events: [] as string[], execute: vi.fn(), readiness: vi.fn(), progress: vi.fn(), capacity: vi.fn(), warm: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: () => undefined }));
vi.mock('@/lib/operations/failover-readiness', () => ({ readFailoverReadiness: mocks.readiness }));
vi.mock('@/lib/operations/worker-progress-query', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/operations/worker-progress-query')>(), readWorkerProgress: mocks.progress }));
vi.mock('@/lib/operations/model-capacity-unknowns', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/operations/model-capacity-unknowns')>(), readModelCapacityUnknowns: mocks.capacity }));
vi.mock('@/lib/operations/text-stage-progress', () => ({ warmTextReasonProgress: mocks.warm }));
import { readMonitorStatus } from '@/lib/operations/failover-monitor';

const ready = { measuredAt: '2026-11-21T00:00:00.000Z', overall: 'ok' as const,
  roles: [], scheduler: { reason: 'ready' as const, alarm: false, freshReplicas: 3, miniFreshReplicas: 1 } };
const progress = { measuredAt: ready.measuredAt, overall: 'ok' as const, stages: [] as unknown[],
  scheduler: { role: 'scheduler' as const, reason: 'scheduled' as const, alarm: false, overdueJobs: [] }, liveness: [] };
const capacity = { status: 'ok' as const, truncated: false, requests: [], count: 0, oldestAgeSeconds: null, stuckDispatched: 0, alarmReasons: [] };
const pg = (code: string) => Object.assign(new Error('Failed query: select secret_body\nparams: hunter2'),
  { cause: Object.assign(new Error('canceling statement'), { name: 'PostgresError', code }) });

beforeEach(() => {
  vi.clearAllMocks(); mocks.events.length = 0;
  mocks.warm.mockImplementation(async () => { mocks.events.push('warm:start'); await new Promise(resolve => setTimeout(resolve, 5)); mocks.events.push('warm:end'); });
  mocks.readiness.mockImplementation(async () => { mocks.events.push('readiness'); return ready; });
  mocks.progress.mockImplementation(async () => { mocks.events.push('progress'); return progress; });
  mocks.capacity.mockImplementation(async () => { mocks.events.push('capacity'); return capacity; });
  mocks.execute.mockImplementation(async () => { mocks.events.push('mode'); return [{ mode: 'open', age_ms: 1_000 }]; });
});

it('counts the reason group alone before every other read and lets the progress read only reuse it', async () => {
  const status = await readMonitorStatus();
  expect(mocks.events.slice(0, 2)).toEqual(['warm:start', 'warm:end']);
  expect([...mocks.events.slice(2)].sort()).toEqual(['capacity', 'mode', 'progress', 'readiness']);
  expect(mocks.progress).toHaveBeenCalledExactlyOnceWith(undefined, { reuseTextReasonOnly: true });
  expect(status).toMatchObject({ overall: 'ok', capacityMode: { mode: 'open' } });
  expect(status).not.toHaveProperty('readFailures');
});

it('records which read failed with its SQLSTATE or error name only, and keeps the verdict unknown', async () => {
  mocks.readiness.mockRejectedValueOnce(pg('57014'));
  mocks.progress.mockRejectedValueOnce(Object.assign(new Error('Database connection pool wait exceeded its deadline'),
    { name: 'DbPoolWaitTimeoutError', code: 'DB_POOL_WAIT_TIMEOUT' }));
  mocks.capacity.mockRejectedValueOnce(pg('42501'));
  mocks.execute.mockRejectedValueOnce(new Error('connection lost'));
  const status = await readMonitorStatus();
  expect(status.overall).toBe('unknown');
  expect(status.readiness).toBeNull();
  expect(status.progress).toBeNull();
  expect(status.capacityUnknowns?.status).toBe('unknown');
  expect(status).not.toHaveProperty('capacityMode');
  expect(status.readFailures).toEqual([{ piece: 'readiness', code: '57014' }, { piece: 'progress', code: 'DB_POOL_WAIT_TIMEOUT' },
    { piece: 'capacity-unknowns', code: '42501' }, { piece: 'capacity-mode', code: 'Error' }]);
  expect(JSON.stringify(status)).not.toMatch(/secret_body|hunter2|connection lost|pool wait exceeded/);
});

it('lists a stage-level unread piece once while the rest of the progress report stays usable', async () => {
  const unread = { piece: 'text-other', code: '57014' };
  mocks.progress.mockResolvedValueOnce({ ...progress, overall: 'unknown', stages: [
    { role: 'text', stage: 'keywords', reason: 'unknown_age', alarm: false, unread },
    { role: 'text', stage: 'tagline-ko', reason: 'unknown_age', alarm: false, unread },
    { role: 'text', stage: 'reason-translate', reason: 'no_work', alarm: false, waiting: 0, measuredAgeSeconds: 12 }] });
  const status = await readMonitorStatus();
  expect(status.overall).toBe('unknown');
  expect(status.progress?.stages).toHaveLength(3);
  expect(status.readFailures).toEqual([unread]);
});
