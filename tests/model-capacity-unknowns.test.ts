import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), replay: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: mocks.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: mocks.replay }));
import { capacityUnknownReportSchema, readModelCapacityUnknowns } from '@/lib/operations/model-capacity-unknowns';
import { combineMonitorStatus } from '@/lib/operations/failover-monitor';
import { recordMonitorHeartbeat } from '@/scripts/watch-failover-readiness';
beforeEach(() => { vi.clearAllMocks(); mocks.replay.mockReturnValue(undefined);
  mocks.transaction.mockImplementation((load: (tx: unknown) => unknown) => load({ execute: mocks.execute })); });
const row = () => ({ request_id: randomUUID(), route_id: 'product-translate', group_id: 'm1-mlx', old_policy: true, local_end_recorded: true });
function reply(rows: ReturnType<typeof row>[], control: unknown[] = [{ id: 1 }]) {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce(rows).mockResolvedValueOnce(control);
}
it('observes old-policy unknowns independently of progress, retries or pause and transports exact safe IDs to Oracle heartbeat', async () => {
  const record = row(); reply([record]);
  const capacity = await readModelCapacityUnknowns();
  expect(capacity).toEqual({ status: 'alarm', truncated: false, requests: [{ requestId: record.request_id,
    routeId: 'product-translate', groupId: 'm1-mlx', oldPolicy: true, localEndRecorded: true }] });
  const status = combineMonitorStatus(null, null, capacity);
  expect(status.overall).toBe('alarm');
  const dir = mkdtempSync(join(tmpdir(), 'capacity-heartbeat-'));
  try {
    recordMonitorHeartbeat(status, join(dir, 'health.json'));
    expect(JSON.parse(readFileSync(join(dir, 'health.json'), 'utf8')).capacityUnknowns).toEqual(capacity);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1][0]).sql;
  expect(query).toContain("r.state = 'indeterminate'");
  expect(query).toContain('r.owner_boot_id::text'); expect(query).toContain('r.dispatch_binding_hash');
  expect(query).not.toMatch(/FOR UPDATE|FOR SHARE|\bINSERT\b|\bDELETE\b/);
  expect(query).not.toMatch(/r\.token|dispatch_binding AS/);
  expect(mocks.transaction.mock.calls[0][1]).toEqual({ accessMode: 'read only', isolationLevel: 'repeatable read' });
});
it('reports truncation instead of claiming a complete list', async () => {
  reply(Array.from({ length: 65 }, row));
  expect(await readModelCapacityUnknowns()).toMatchObject({ status: 'alarm', truncated: true, requests: expect.any(Array) });
  expect((await mocks.transaction.mock.results[0].value).requests).toHaveLength(64);
});
it('requires an observed empty queue and a present control for a clear', async () => {
  reply([]); expect(await readModelCapacityUnknowns()).toEqual({ status: 'ok', truncated: false, requests: [] });
  reply([], []); expect(await readModelCapacityUnknowns()).toEqual({ status: 'unknown', truncated: false, requests: [] });
});
it('fails closed on read permission errors, malformed rows and replay without exposing errors or querying replay', async () => {
  mocks.execute.mockRejectedValueOnce(new Error('private DB credential text'));
  expect(await readModelCapacityUnknowns()).toEqual({ status: 'unknown', truncated: false, requests: [] });
  reply([{ ...row(), route_id: 'invalid\nlabel' }]);
  expect((await readModelCapacityUnknowns()).status).toBe('unknown');
  mocks.execute.mockClear(); mocks.replay.mockReturnValue({});
  expect((await readModelCapacityUnknowns()).status).toBe('unknown'); expect(mocks.execute).not.toHaveBeenCalled();
});
it.each([{ status: 'ok', truncated: false, requests: [row()] }, { status: 'alarm', truncated: false, requests: [] }])('rejects inconsistent summary %j', value => {
  expect(capacityUnknownReportSchema.safeParse(value).success).toBe(false);
});
