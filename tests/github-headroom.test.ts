import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute } }));
import { readGitHubCoreHeadroom } from '@/lib/crawl/github-headroom';

const NOW = Date.parse('2026-10-19T13:00:00Z');
const quota = (remaining: number, resetInMinutes: number, limit = 5_000) =>
  ({ core_quota: { limit, used: limit - remaining, remaining, reset: Math.floor((NOW + resetInMinutes * 60_000) / 1_000) } });
beforeEach(() => mocks.execute.mockReset());

it('does not gate when no enabled collector has an observed quota', async () => {
  mocks.execute.mockResolvedValueOnce([]);
  expect(await readGitHubCoreHeadroom(NOW)).toBeNull();
  mocks.execute.mockResolvedValueOnce([{ core_quota: null }, { core_quota: { limit: 'x' } }]);
  expect(await readGitHubCoreHeadroom(NOW)).toBeNull();
});

it('sums every credential and gates below a quarter of the total', async () => {
  mocks.execute.mockResolvedValueOnce([quota(500, 30), quota(1_900, 40)]);
  expect(await readGitHubCoreHeadroom(NOW)).toEqual({ remaining: 2_400, limit: 10_000, low: true });
  mocks.execute.mockResolvedValueOnce([quota(500, 30), quota(2_000, 40)]);
  expect(await readGitHubCoreHeadroom(NOW)).toEqual({ remaining: 2_500, limit: 10_000, low: false });
});

it('counts a passed reset as a full window and does not gate when a reset is minutes away', async () => {
  mocks.execute.mockResolvedValueOnce([quota(0, -1), quota(100, 30)]);
  expect(await readGitHubCoreHeadroom(NOW)).toEqual({ remaining: 5_100, limit: 10_000, low: false });
  mocks.execute.mockResolvedValueOnce([quota(100, 4), quota(100, 30)]);
  expect(await readGitHubCoreHeadroom(NOW)).toEqual({ remaining: 200, limit: 10_000, low: false });
  mocks.execute.mockResolvedValueOnce([quota(100, 6), quota(100, 30)]);
  expect(await readGitHubCoreHeadroom(NOW)).toMatchObject({ low: true });
});

it('reads only the credential tables this process uses when a collector scope is given', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const { collectorScope } = await import('@/lib/crawl/github-secret');
  const text = () => new PgDialect().sqlToQuery(mocks.execute.mock.calls.at(-1)![0]);
  mocks.execute.mockResolvedValue([quota(100, 30)]);
  await readGitHubCoreHeadroom(NOW);
  expect(text().sql).toMatch(/github_collector_accounts WHERE enabled UNION ALL SELECT core_quota FROM github_collector_apps WHERE enabled$/);
  // App 전용 Oracle: 개인 토큰 표는 쿼리에 나오지도 않는다(그 계정은 권한이 없다)
  expect(await readGitHubCoreHeadroom(NOW, collectorScope({ GITHUB_COLLECTOR_SOURCES: 'apps', GITHUB_COLLECTOR_APP_INSTALLATIONS: '42,43' })))
    .toEqual({ remaining: 100, limit: 5_000, low: true });
  expect(text()).toMatchObject({ sql: 'SELECT core_quota FROM github_collector_apps WHERE enabled AND installation_id IN ($1, $2)', params: [42, 43] });
  await readGitHubCoreHeadroom(NOW, collectorScope({ GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS: '42' }));
  expect(text().sql).toContain('github_collector_accounts WHERE enabled UNION ALL SELECT core_quota FROM github_collector_apps WHERE enabled AND installation_id NOT IN ($1)');
  mocks.execute.mockClear();
  expect(await readGitHubCoreHeadroom(NOW, collectorScope({ GITHUB_COLLECTOR_SOURCES: 'env' }))).toBeNull();
  expect(mocks.execute).not.toHaveBeenCalled();
});
