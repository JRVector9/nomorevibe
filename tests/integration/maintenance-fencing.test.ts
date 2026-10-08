import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { clickEvents, jobs, newsItems, productClickDaily,
  productHealth, products, productSearchProfiles, rankingSeasons, rateLimits, searchQueries } from '@/lib/db/schema';
import { recordPing } from '@/lib/domain/products/health';
import { refreshProductSearchDocuments } from '@/lib/jobs/products/search-refresh';
import { insertNewsItems } from '@/lib/news/repository';
import { pruneEvents, rollupDaily } from '@/lib/domain/products/clicks';
import { pruneExpiredRateLimits } from '@/lib/rate-limit';
import { pruneSearchQueries } from '@/lib/domain/products/search-log';
import { refreshRanking } from '@/lib/domain/ranking/refresh';
import type { JobContext } from '@/lib/jobs/runner';
import type { JobLease } from '@/lib/jobs/control';
import { ensureSchema, resetTables } from './setup';
import { readMaintenanceUptimeProgress } from '@/lib/operations/maintenance-progress';
import { readTextProgress } from '@/lib/operations/text-progress';

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(rateLimits).where(eq(rateLimits.key, 'late-cleanup'));
  await db.delete(searchQueries).where(eq(searchQueries.query, 'maintenance-late-cleanup'));
  await db.delete(jobs);
  await db.delete(newsItems);
  await resetTables();
  await db.insert(products).values({ slug: 'maintenance-fence', url: 'https://maintenance-fence.test',
    name: 'Maintenance', tagline: 'Maintenance', description: 'Maintenance', category: 'Other',
    status: 'verified', verifyToken: 'verify', editTokenHash: 'x'.repeat(64) });
});
afterEach(async () => {
  await db.delete(rateLimits).where(eq(rateLimits.key, 'late-cleanup'));
  await db.delete(searchQueries).where(eq(searchQueries.query, 'maintenance-late-cleanup'));
});

async function lost(name: string): Promise<JobLease> {
  const lease = { name, token: `old-${name}`, requestedVersion: 1 };
  await db.insert(jobs).values({ name, leaseToken: lease.token, lockedAt: sql`now()`, requestedVersion: 1 });
  await db.update(jobs).set({ leaseToken: null }).where(eq(jobs.name, name));
  return lease;
}

it('rejects a late uptime result after role takeover', async () => {
  const lease = await lost('uptime-ping');
  await expect(recordPing('maintenance-fence', 200, 12, new Date(), undefined, lease)).rejects.toThrow('job_lease_lost');
  expect(await db.select().from(productHealth)).toEqual([]);
});

it('rejects a late search copy after role takeover', async () => {
  const lease = await lost('product-search-refresh');
  const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: () => {}, lease } as JobContext<null>;
  await expect(refreshProductSearchDocuments(ctx)).rejects.toThrow('job_lease_lost');
  expect((await db.select({ copy: products.searchCategory }).from(products))[0].copy).toBeNull();
});

it('rejects a late news insertion after role takeover', async () => {
  const lease = await lost('news-refresh');
  await expect(insertNewsItems([{ sourceKey: 'openai', url: 'https://openai.com/news/fence',
    title: 'Fence', summary: null, publishedAt: new Date() }], true, lease)).rejects.toThrow('job_lease_lost');
  expect(await db.select().from(newsItems)).toEqual([]);
});

it('rejects a late click rollup after role takeover', async () => {
  const lease = await lost('click-rollup');
  await db.insert(clickEvents).values({ slug: 'maintenance-fence', occurredAt: new Date() });
  await expect(rollupDaily(3, lease)).rejects.toThrow('job_lease_lost');
  expect(await db.select().from(productClickDaily)).toEqual([]);
});

it('keeps click and search history when a late cleanup loses its lease', async () => {
  const lease = await lost('click-rollup');
  await db.insert(clickEvents).values({ slug: 'maintenance-fence',
    occurredAt: new Date(Date.now() - 40 * 86_400_000) });
  await db.insert(rateLimits).values({ key: 'late-cleanup', resetAt: new Date(Date.now() - 3 * 86_400_000) });
  await db.insert(searchQueries).values({ query: 'maintenance-late-cleanup', normalized: 'maintenance-late-cleanup', results: 0,
    searchedAt: new Date(Date.now() - 100 * 86_400_000) });
  await expect(pruneEvents(35, lease)).rejects.toThrow('job_lease_lost');
  await expect(pruneExpiredRateLimits(lease)).rejects.toThrow('job_lease_lost');
  await expect(pruneSearchQueries(90, lease)).rejects.toThrow('job_lease_lost');
  expect(await db.select().from(clickEvents).where(eq(clickEvents.slug, 'maintenance-fence'))).toHaveLength(1);
  expect(await db.select().from(rateLimits).where(eq(rateLimits.key, 'late-cleanup'))).toHaveLength(1);
  expect(await db.select().from(searchQueries).where(eq(searchQueries.query, 'maintenance-late-cleanup'))).toHaveLength(1);
});

it('rejects a late ranking refresh after role takeover', async () => {
  const lease = await lost('ranking-refresh');
  await expect(refreshRanking(new Date(), lease)).rejects.toThrow('job_lease_lost');
  expect(await db.select().from(rankingSeasons)).toEqual([]);
});

it('reads maintenance and text demand without changing production data', async () => {
  const uptime = await readMaintenanceUptimeProgress();
  const text = await readTextProgress();
  expect(uptime.waiting).toBe(true);
  expect(uptime.oldestMinutes).toBeLessThan(5);
  expect(text.oldestReadyMinutes).not.toBeNull();
  expect((await db.select().from(productHealth))).toEqual([]);
});

it('does not suppress a text stall forever because of an old provider error', async () => {
  vi.stubEnv('ABCLLM_API_KEY', 'present');
  try {
    await db.insert(jobs).values({ name: 'product-search-verify', lastError: 'old provider error',
      updatedAt: sql`now() - interval '1 hour'` });
    expect((await readTextProgress()).providerError).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});

it('does not suppress an uptime stall forever because of an old job error', async () => {
  await db.insert(jobs).values({ name: 'uptime-ping', lastError: 'old request failure',
    lastRunAt: sql`now() - interval '1 hour'` });
  expect((await readMaintenanceUptimeProgress()).jobError).toBe(false);
});

/**
 * 감시(role-worker checkProgress)는 "할 일이 몇 분째 기다리나"로 멈춤을 판단한다. 기다림은 할 일이 된 때부터 잰다 —
 * 마지막으로 본 때부터 재면 다시 볼 때가 막 된 일이 몇 시간·며칠 기다린 것으로 보여, 잡이 다음 틱에 집기도 전에
 * 워커를 멈춘 것으로 보고 재시작한다(2026-10-08 발행 단계의 분류 보류와 같은 실수).
 */
it('ages an uptime recheck from when it became due, not from the previous check', async () => {
  await db.insert(productHealth).values({ slug: 'maintenance-fence', status: 200,
    checkedAt: sql`now() - interval '6 hours' - interval '2 minutes'` });
  const uptime = await readMaintenanceUptimeProgress();
  expect(uptime.waiting).toBe(true);
  expect(uptime.oldestMinutes).toBeGreaterThan(1);
  expect(uptime.oldestMinutes).toBeLessThan(5);
});

it('ages text work from when a refresh or retry became due', async () => {
  vi.stubEnv('ABCLLM_API_KEY', 'present');
  try {
    const [product] = await db.select({ id: products.id }).from(products);
    // 30일이 막 지난 키워드 — 다시 지을 차례가 된 지 2분
    await db.insert(productSearchProfiles).values({ productId: product.id, sourceHash: 'h', keywordsEn: ['a'],
      verifiedAt: sql`now()`, updatedAt: sql`now() - interval '30 days' - interval '2 minutes'` });
    expect((await readTextProgress()).oldestReadyMinutes).toBeLessThan(5);

    // 두 시간 전에 실패해 2분 전에 다시 볼 때가 된 짓기
    await db.update(productSearchProfiles).set({ errorCode: 'timeout', attempts: 1,
      retryAt: sql`now() - interval '2 minutes'`, updatedAt: sql`now() - interval '2 hours'` });
    expect((await readTextProgress()).oldestReadyMinutes).toBeLessThan(5);

    // 두 시간 전에 실패해 2분 전에 다시 볼 때가 된 검수
    await db.update(productSearchProfiles).set({ errorCode: null, retryAt: null, verifiedAt: null,
      verifyError: 'timeout', verifyAttempts: 1, verifyRetryAt: sql`now() - interval '2 minutes'`,
      updatedAt: sql`now() - interval '2 hours'` });
    expect((await readTextProgress()).oldestReadyMinutes).toBeLessThan(5);
  } finally { vi.unstubAllEnvs(); }
});
