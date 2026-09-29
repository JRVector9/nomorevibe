import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs, ogImages } from '@/lib/db/schema';
import { insert, putOgImage, setOgImage, findByUrl } from '@/lib/domain/products/repository';
import type { JobLease } from '@/lib/jobs/control';
import { ensureSchema, resetTables } from './setup';

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(jobs);
  await resetTables();
  await insert({ slug: 'publisher-og-fence', url: 'https://publisher-og-fence.test',
    name: 'Fence', tagline: 'Fence', description: 'Fence', category: 'Other', status: 'seeded',
    verifyToken: 'verify', editTokenHash: 'x'.repeat(64) });
});

it('does not save an OG image or link after the publisher job loses ownership', async () => {
  const lease: JobLease = { name: 'crawl-publish', token: 'old-token', requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token,
    lockedAt: sql`now()`, requestedVersion: 1 });
  await db.update(jobs).set({ leaseToken: null }).where(eq(jobs.name, lease.name));

  await expect(putOgImage('publisher-og-fence', 'image/png', Buffer.from('image'), lease)).rejects.toThrow('job_lease_lost');
  await expect(setOgImage('publisher-og-fence', '/api/og-cache/publisher-og-fence', lease)).rejects.toThrow('job_lease_lost');
  expect(await db.select().from(ogImages)).toEqual([]);
  expect((await findByUrl('https://publisher-og-fence.test'))?.ogImage).toBeNull();
});
