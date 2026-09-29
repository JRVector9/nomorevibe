import { beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs } from '@/lib/db/schema';
import { hasActiveRoleJob } from '@/lib/jobs/control';
import { ensureSchema } from './setup';

beforeAll(ensureSchema);
beforeEach(async () => { await db.delete(jobs); });

it('holds a progress restart while the role owns a fresh job lease', async () => {
  await db.insert(jobs).values({ name: 'crawl-publish', leaseToken: 'active', lockedAt: sql`now()` });
  expect(await hasActiveRoleJob('publisher')).toBe(true);
  expect(await hasActiveRoleJob('crawler')).toBe(false);
  await db.update(jobs).set({ lockedAt: sql`now() - interval '91 seconds'` });
  expect(await hasActiveRoleJob('publisher')).toBe(false);
});
