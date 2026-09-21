import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, productEvidenceAudit, products, secondReviews } from '@/lib/db/schema';
import { resolvePublishedSecondReview } from '@/app/admin/review/actions';
import { ensureSchema, resetTables } from './setup';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(secondReviews);
  await db.delete(crawlCandidates);
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'reviewer' });
});

async function product(slug: string) {
  const [row] = await db.insert(products).values({ slug, url: `https://${slug}.test`, name: slug,
    tagline: '사용할 수 있는 제품', description: '제품 소개', category: 'Dev', status: 'seeded', source: 'crawler',
    verifyToken: `verify-${slug}`, editTokenHash: 'h'.repeat(64) }).returning();
  return row;
}

async function finding(slug: string, status: 'needs_human' | 'resolved' = 'needs_human') {
  const [candidate] = await db.insert(crawlCandidates).values({ repo: `owner/${slug}`, productUrl: `https://${slug}.test`,
    publishedSlug: slug, state: 'published', reason: 'passed', decidedBy: 'auto' }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo: candidate.repo,
    publishedSlug: slug, trigger: 'risk', firstDecision: 'approve', inputHash: 'a'.repeat(64), model: 'reviewer',
    secondDecision: 'reject', status, resolution: status === 'resolved' ? 'kept' : null }).returning();
  return { ...row, candidate };
}

function decide(id: number, slug: string, decision: 'ban' | 'keep') {
  const form = new FormData();
  form.set('id', String(id)); form.set('slug', slug); form.set('decision', decision);
  return resolvePublishedSecondReview(null, form);
}

it('rejects another product slug without banning it or resolving the finding', async () => {
  await product('reviewed'); await product('other');
  const row = await finding('reviewed');
  expect(await decide(row.id, 'other', 'ban')).toMatchObject({ error: expect.any(String) });
  expect((await db.select().from(products)).every((item) => item.status === 'seeded')).toBe(true);
  expect((await db.select().from(secondReviews))[0].status).toBe('needs_human');
  expect(await db.select().from(productEvidenceAudit)).toHaveLength(0);
});

it('rejects a stale resolved finding before banning the product', async () => {
  await product('already-kept');
  const row = await finding('already-kept', 'resolved');
  expect(await decide(row.id, 'already-kept', 'ban')).toMatchObject({ error: expect.any(String) });
  expect((await db.select().from(products))[0].status).toBe('seeded');
  expect(await db.select().from(productEvidenceAudit)).toHaveLength(0);
});

it('rejects a keep decision for a different product', async () => {
  await product('reviewed'); await product('other');
  const row = await finding('reviewed');
  expect(await decide(row.id, 'other', 'keep')).toMatchObject({ error: expect.any(String) });
  expect((await db.select().from(secondReviews))[0].status).toBe('needs_human');
});

it('does not apply an old finding after its published candidate was detached', async () => {
  await product('reused');
  const row = await finding('reused');
  // Product deletion clears this link before the same slug can be registered again.
  await db.update(crawlCandidates).set({ publishedSlug: null }).where(eq(crawlCandidates.id, row.candidateId));
  expect(await decide(row.id, 'reused', 'ban')).toMatchObject({ error: expect.any(String) });
  expect((await db.select().from(products))[0].status).toBe('seeded');
});

it('bans the reviewed product and records the authenticated resolution', async () => {
  await product('reviewed');
  const row = await finding('reviewed');
  expect(await decide(row.id, 'reviewed', 'ban')).toEqual({ message: '내렸습니다.' });
  expect((await db.select().from(products))[0].status).toBe('banned');
  expect((await db.select().from(secondReviews))[0]).toMatchObject({ status: 'resolved', resolution: 'banned', resolvedBy: 'reviewer' });
  expect(await db.select().from(productEvidenceAudit)).toMatchObject([{ slug: 'reviewed', action: 'admin.product.ban' }]);
});

it('lets only one concurrent decision change a finding', async () => {
  await product('contended');
  const row = await finding('contended');
  const results = await Promise.all([decide(row.id, 'contended', 'keep'), decide(row.id, 'contended', 'ban')]);
  expect(results.filter((result) => result?.message)).toHaveLength(1);
  const [settled] = await db.select().from(secondReviews);
  const [item] = await db.select().from(products);
  expect(item.status).toBe(settled.resolution === 'kept' ? 'seeded' : 'banned');
});

it('denies unauthenticated decisions before mutating anything', async () => {
  await product('reviewed');
  const row = await finding('reviewed');
  mocks.admin.mockResolvedValue(null);
  expect(await decide(row.id, 'reviewed', 'ban')).toMatchObject({ error: expect.any(String) });
  expect((await db.select().from(products))[0].status).toBe('seeded');
  expect((await db.select().from(secondReviews))[0].status).toBe('needs_human');
});
