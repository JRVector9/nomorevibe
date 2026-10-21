import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, operationsAudit, products, secondReviews, type SecondReview, type SecondReviewAutoOpinion } from '@/lib/db/schema';
import { lockProductGeneration, type ProductTransaction } from '@/lib/domain/products/generation';
import { setStatusWithAudit } from '@/lib/domain/products/repository';
import { withJobLeaseWrite, type JobLease } from '@/lib/jobs/control';
import { lockPipelineInputStages } from './pipeline-stage-context';
import { classifyAuditReason } from './audit-reason-category';
import { QWEN_V2_AUTO_SOURCE } from './qwen-direct-review';
import { qwenConfident } from './second-opinion-rules';
import { lockedQwenAuto } from './settings';

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

/** 잠근 행을 사람의 결정(내리기·유지)으로 닫는다 — 사람의 결정과 Qwen-v2 자동 유지가 같은 이 길을 지난다 */
async function decideLocked(tx: ProductTransaction, locked: { productId: number; finding: SecondReview }, input: {
  slug: string; decision: 'ban' | 'keep'; actor: string; autoOpinion?: SecondReviewAutoOpinion;
}): Promise<boolean> {
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
}

/** The finding, product transition, and human decision must succeed together. */
export async function decidePublishedSecondReview(input: { id: number; slug: string; decision: 'ban' | 'keep'; actor: string }): Promise<boolean> {
  return transact(undefined, async (tx) => {
    await lockPipelineInputStages(tx);
    const locked = await lockPublishedFinding(tx, input);
    return locked ? decideLocked(tx, locked, input) : false;
  });
}

export type PublishedAutoResult = 'kept' | 'noted' | 'not_open' | 'switched_off';

/**
 * Qwen-v2 공개분 2차 거르기(audit-second-opinion-auto.ts)의 쓰기 — 사람의 결정과 같은 잠금(stage → 제품 세대 → 후보 → 행)으로 잡고,
 * 쓰는 순간 그 단계의 스위치(qwenAuto.publishedFilter)를 다시 본다(꺼졌으면 아무것도 쓰지 않는다).
 * 승인이고 확신이 0.90 이상이면 사람의 '유지'와 같은 길(decideLocked — resolution kept, 누가 qwen-v2-auto)로 닫고 작업 로그에 남긴다.
 * 그 밖(거절·판단 보류·낮은 확신)은 행을 사람에게 둔 채 판단만 적는다(화면이 앞에 세우고 배지를 붙인다). 이 길로는 내리지 않는다.
 * 그 사이 사람이 정했거나 내려갔으면 not_open
 */
export async function applyPublishedAutoOpinion(input: { id: number; slug: string; autoOpinion: SecondReviewAutoOpinion; lease: JobLease }):
  Promise<PublishedAutoResult> {
  return transact(input.lease, async (tx) => {
    await lockPipelineInputStages(tx);
    const locked = await lockPublishedFinding(tx, input);
    if (!locked) return 'not_open';
    if (!(await lockedQwenAuto(tx)).publishedFilter.enabled) return 'switched_off';
    const { autoOpinion } = input;
    if (autoOpinion.decision === 'approve' && qwenConfident(autoOpinion.confidence)) {
      if (!(await decideLocked(tx, locked, { slug: input.slug, decision: 'keep', actor: QWEN_V2_AUTO_SOURCE, autoOpinion }))) return 'not_open';
      await tx.insert(operationsAudit).values({ actor: QWEN_V2_AUTO_SOURCE, actorKind: 'model', ok: true, action: 'published-second-auto-keep',
        target: input.slug.slice(0, 200), detail: { secondReviewId: locked.finding.id, model: autoOpinion.model, promptVersion: autoOpinion.promptVersion,
          confidence: autoOpinion.confidence } });
      return 'kept';
    }
    await tx.update(secondReviews).set({ autoOpinion }).where(eq(secondReviews.id, locked.finding.id));
    return 'noted';
  });
}
