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
