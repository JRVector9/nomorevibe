import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, products, secondReviews, type SecondReview, type SecondReviewAutoOpinion } from '@/lib/db/schema';
import { lockProductGeneration, type ProductTransaction } from '@/lib/domain/products/generation';
import { setStatusWithAudit } from '@/lib/domain/products/repository';
import { withJobLeaseWrite, type JobLease } from '@/lib/jobs/control';
import { lockPipelineInputStages } from './pipeline-stage-context';
import { classifyAuditReason } from './audit-reason-category';

/**
 * 사람 확인을 기다리는 공개분 2차 행을 잠근다 — 제품 세대 → 후보 → 행 순서(다른 쓰기와 같다). 그 사이 내려갔거나 닫혔으면 null.
 * 부르는 쪽이 stage 를 먼저 잡는다
 */
async function lockPublishedFinding(tx: ProductTransaction, input: { id: number; slug: string }):
  Promise<{ productId: number; finding: SecondReview } | null> {
  const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.slug, input.slug));
  if (!product || !(await lockProductGeneration(tx, product.id, input.slug))) return null;

  const [finding] = await tx.select().from(secondReviews).where(eq(secondReviews.id, input.id));
  if (!finding || finding.publishedSlug !== input.slug) return null;

  // Deleting a product detaches its candidate before its slug can be reused.
  // Keep the lifecycle → candidate → review lock order used by other writers.
  const [candidate] = await tx.select({ id: crawlCandidates.id }).from(crawlCandidates).where(and(
    eq(crawlCandidates.id, finding.candidateId), eq(crawlCandidates.repo, finding.repo),
    eq(crawlCandidates.state, 'published'), eq(crawlCandidates.publishedSlug, input.slug),
  )).for('update');
  if (!candidate) return null;
  const [current] = await tx.select().from(secondReviews).where(and(
    eq(secondReviews.id, input.id), eq(secondReviews.candidateId, candidate.id),
    eq(secondReviews.publishedSlug, input.slug), eq(secondReviews.status, 'needs_human'),
  )).for('update');
  return current ? { productId: product.id, finding: current } : null;
}

/**
 * 사람이 아닌 쓰기(감사 잡의 Qwen-v2 공개분 거르기)는 작업 lease 안에서 — DR writer fence 가 첫 잠금이고 같은 커밋에서 lease 를 본다.
 * 사람의 결정은 웹 쓰기 관문(webWriteAction)이 fence 를 맡는다
 */
function transact<T>(lease: JobLease | undefined, write: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  return lease ? withJobLeaseWrite(lease, write) : db.transaction(write);
}

/**
 * The finding, product transition, and human decision must succeed together.
 * autoOpinion·lease: Qwen-v2 공개분 거르기(audit-second-opinion-auto.ts)가 승인으로 닫을 때 — 사람의 '유지'와 같은 길·같은 결과(resolution kept)이고,
 * 누가(resolved_by)는 qwen-v2-auto, 그 판단은 auto_opinion 에 함께 적는다. 이 길로는 내리지 않는다(keep 만 받는다).
 */
export async function decidePublishedSecondReview(input: {
  id: number; slug: string; decision: 'ban' | 'keep'; actor: string;
  autoOpinion?: SecondReviewAutoOpinion; lease?: JobLease;
}): Promise<boolean> {
  if (input.autoOpinion && (input.decision !== 'keep' || input.autoOpinion.decision !== 'approve')) throw new Error('published_auto_keep_only');
  return transact(input.lease, async (tx) => {
    await lockPipelineInputStages(tx);
    const locked = await lockPublishedFinding(tx, input);
    if (!locked) return false;
    const { productId, finding } = locked;

    // 누가 왜 내렸는지 남긴다 — 사유는 감사(audit:<갈래>)처럼 2차 의견의 갈래로 적는다
    if (input.decision === 'ban' && !(await setStatusWithAudit({ id: productId, slug: input.slug,
      status: 'banned', action: 'admin.product.ban', actor: input.actor.slice(0, 120),
      reason: `second_review:${classifyAuditReason(finding.secondReason)}`,
      metadata: { source: 'second-review', secondReviewId: finding.id, trigger: finding.trigger, signals: finding.signals,
        model: finding.model, secondConfidence: finding.secondConfidence } }, tx))) return false;
    await tx.update(secondReviews).set({ status: 'resolved', resolution: input.decision === 'ban' ? 'banned' : 'kept',
      resolvedBy: input.actor.slice(0, 120), resolvedAt: new Date(), ...(input.autoOpinion ? { autoOpinion: input.autoOpinion } : {}) })
      .where(eq(secondReviews.id, finding.id));
    return true;
  });
}

/**
 * Qwen-v2 가 승인하지 않은 공개분 사람 확인 행 — 행은 사람을 기다리는 그대로 두고 판단만 적는다(화면이 앞에 세우고 배지를 붙인다).
 * 그 사이 사람이 정했거나 내려갔으면 아무것도 쓰지 않고 false. 승인은 decidePublishedSecondReview 로 닫는다
 */
export async function notePublishedSecondReviewOpinion(input: { id: number; slug: string; autoOpinion: SecondReviewAutoOpinion; lease: JobLease }):
  Promise<boolean> {
  if (input.autoOpinion.decision === 'approve') throw new Error('published_auto_approve_must_keep');
  return transact(input.lease, async (tx) => {
    await lockPipelineInputStages(tx);
    const locked = await lockPublishedFinding(tx, input);
    if (!locked) return false;
    await tx.update(secondReviews).set({ autoOpinion: input.autoOpinion }).where(eq(secondReviews.id, locked.finding.id));
    return true;
  });
}
