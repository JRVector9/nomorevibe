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
  expect(await publicationChange24h()).toEqual({ added: 0, removed: 0, net: 0 });
  await db.update(crawlCandidates).set({ state: 'published', publishedSlug: 'product' }).where(eq(crawlCandidates.id, candidate.id));
  await db.update(crawlCandidates).set({ signals: { refreshed: true } }).where(eq(crawlCandidates.id, candidate.id));
  expect(await publicationChange24h()).toEqual({ added: 1, removed: 0, net: 1 });
  await db.update(crawlCandidates).set({ state: 'rejected' }).where(eq(crawlCandidates.id, candidate.id));
  expect(await publicationChange24h()).toEqual({ added: 1, removed: 1, net: 0 });
});
it('uses a rolling 24-hour window, supports negative change, and excludes future events', async () => {
  await db.execute(sql`insert into crawl_publication_changes (repo, delta, occurred_at) values
    ('old', 1, '2026-09-20 07:59:59'), ('boundary', 1, '2026-09-20 08:00:00'),
    ('removed-a', -1, '2026-09-21 06:00:00'), ('removed-b', -1, '2026-09-21 07:00:00'),
    ('future', 1, '2026-09-21 08:00:01')`);
  expect(await publicationChange24h(new Date('2026-09-21T08:00:00Z'))).toEqual({ added: 1, removed: 2, net: -1 });
});
it('tracks insertion and deletion of a published candidate without losing its history', async () => {
  const [candidate] = await db.insert(crawlCandidates).values({ repo: 'changes/direct', state: 'published' }).returning();
  await db.delete(crawlCandidates).where(eq(crawlCandidates.id, candidate.id));
  expect(await publicationChange24h()).toEqual({ added: 1, removed: 1, net: 0 });
});
