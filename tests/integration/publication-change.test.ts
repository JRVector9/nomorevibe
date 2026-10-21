import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates } from '@/lib/db/schema';
import { publicationChange24h } from '@/lib/crawl/admin-review';
import { ensureSchema } from './setup';

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.execute(sql`truncate crawl_publication_changes restart identity`);
});
it('counts entry and exit, ignoring metadata edits and approval without publication', async () => {
  const [candidate] = await db.insert(crawlCandidates).values({ repo: 'changes/product', state: 'approved' }).returning();
  expect(await publicationChange24h()).toMatchObject({ added: 0, removed: 0, net: 0 });
  await db.update(crawlCandidates).set({ state: 'published', publishedSlug: 'product' }).where(eq(crawlCandidates.id, candidate.id));
  await db.update(crawlCandidates).set({ signals: { refreshed: true } }).where(eq(crawlCandidates.id, candidate.id));
  expect(await publicationChange24h()).toMatchObject({ added: 1, removed: 0, net: 1 });
  await db.update(crawlCandidates).set({ state: 'rejected' }).where(eq(crawlCandidates.id, candidate.id));
  expect(await publicationChange24h()).toMatchObject({ added: 1, removed: 1, net: 0 });
});
it('uses a rolling 24-hour window, supports negative change, and excludes future events', async () => {
  await db.execute(sql`insert into crawl_publication_changes (repo, delta, occurred_at) values
    ('old', 1, '2026-09-20 07:59:59'), ('boundary', 1, '2026-09-20 08:00:00'),
    ('removed-a', -1, '2026-09-21 06:00:00'), ('removed-b', -1, '2026-09-21 07:00:00'),
    ('future', 1, '2026-09-21 08:00:01')`);
  // 2026-09-21 08:00Z = 17:00 KST — 오늘(한국 0시 = 09-20 15:00Z)에는 06:00·07:00 의 두 이탈만, 최근 1시간에는 07:00 하나만
  expect(await publicationChange24h(new Date('2026-09-21T08:00:00Z'))).toEqual({ added: 1, removed: 2, net: -1, windows: { hour: -1, today: -2 } });
});
it('cuts "today" at Korean midnight, not UTC midnight', async () => {
  // 2026-10-20 15:10Z = 10-21 00:10 KST. 14:55Z 는 최근 1시간이지만 한국 날짜로는 어제다
  await db.execute(sql`insert into crawl_publication_changes (repo, delta, occurred_at) values
    ('after-midnight', 1, '2026-10-20 15:05:00'), ('before-midnight', 1, '2026-10-20 14:55:00'),
    ('hour-ago', -1, '2026-10-20 14:00:00'), ('utc-day', 1, '2026-10-20 00:30:00')`);
  expect(await publicationChange24h(new Date('2026-10-20T15:10:00Z'))).toEqual({ added: 3, removed: 1, net: 2, windows: { hour: 2, today: 1 } });
});
it('tracks insertion and deletion of a published candidate without losing its history', async () => {
  const [candidate] = await db.insert(crawlCandidates).values({ repo: 'changes/direct', state: 'published' }).returning();
  await db.delete(crawlCandidates).where(eq(crawlCandidates.id, candidate.id));
  expect(await publicationChange24h()).toMatchObject({ added: 1, removed: 1, net: 0 });
});
