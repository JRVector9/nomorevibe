import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, products, secondReviews } from '@/lib/db/schema';
import { lockProductGeneration } from '@/lib/domain/products/generation';
import { setStatusWithAudit } from '@/lib/domain/products/repository';

/** The finding, product transition, and human decision must succeed together. */
export async function decidePublishedSecondReview(input: {
  id: number; slug: string; decision: 'ban' | 'keep'; actor: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.slug, input.slug));
    if (!product || !(await lockProductGeneration(tx, product.id, input.slug))) return false;

    const [finding] = await tx.select().from(secondReviews).where(eq(secondReviews.id, input.id));
    if (!finding || finding.publishedSlug !== input.slug) return false;

    // Deleting a product detaches its candidate before its slug can be reused.
    // Keep the lifecycle → candidate → review lock order used by other writers.
    const [candidate] = await tx.select({ id: crawlCandidates.id }).from(crawlCandidates).where(and(
      eq(crawlCandidates.id, finding.candidateId), eq(crawlCandidates.repo, finding.repo),
      eq(crawlCandidates.state, 'published'), eq(crawlCandidates.publishedSlug, input.slug),
    )).for('update');
    if (!candidate) return false;
    const [current] = await tx.select({ id: secondReviews.id }).from(secondReviews).where(and(
      eq(secondReviews.id, input.id), eq(secondReviews.candidateId, candidate.id),
      eq(secondReviews.publishedSlug, input.slug), eq(secondReviews.status, 'needs_human'),
    )).for('update');
    if (!current) return false;

    if (input.decision === 'ban' && !(await setStatusWithAudit({ id: product.id, slug: input.slug,
      status: 'banned', action: 'admin.product.ban' }, tx))) return false;
    await tx.update(secondReviews).set({ status: 'resolved', resolution: input.decision === 'ban' ? 'banned' : 'kept',
      resolvedBy: input.actor.slice(0, 120), resolvedAt: new Date() }).where(eq(secondReviews.id, current.id));
    return true;
  });
}
