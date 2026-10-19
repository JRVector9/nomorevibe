import { and, asc, desc, eq, inArray, not, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlReviewAttempts, operationsAudit, jobs, secondReviews } from '@/lib/db/schema';
import { assertJobLeaseAtWallTime, requestJob, type JobLease } from '@/lib/jobs/control';
import { readItemStage } from '@/lib/jobs/items/repository';
import { candidateRevisionHash, lockedInput } from './admin-review';
import { lockPipelineInputStages } from './pipeline-stage-context';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, validateReviewOutcome, type ReviewInput } from './agent-review-contract';
import { judgeRevision } from './rules';
import { getSettings } from './settings';
import { reviewApprovalPredicate } from './agent-review-repository';
import { DEEPSEEK_MIN_CONFIDENCE, DEEPSEEK_REVIEW_MODEL, DEEPSEEK_REVIEW_PROVIDER, deepseekActor } from './deepseek-review-policy';
import type { DeepSeekReviewResult } from './deepseek-review';

export type HumanReviewClaim = {
  attemptId: number; repo: string; candidateRevision: string; input: ReviewInput; generation: number; lease: JobLease;
};
const JOB = 'human-deepseek-review';

export async function humanReviewRepos(ids: number[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.select({ repo: crawlCandidates.repo }).from(crawlCandidates).where(and(
    inArray(crawlCandidates.id, ids), eq(crawlCandidates.state, 'needs_review'), eq(crawlCandidates.decidedBy, 'auto'),
  )).orderBy(asc(crawlCandidates.updatedAt), asc(crawlCandidates.id));
  return rows.map(row => row.repo);
}

/** Claim the same candidate slot used by AI1; no DB transaction spans inference. */
export async function claimHumanReview(repo: string, lease: JobLease): Promise<HumanReviewClaim | null> {
  if (lease.name !== JOB) throw new Error('human_review_job_required');
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    if (ai1.mode === 'draining' || ai2.mode === 'draining') return null;
    const current = await lockedInput(tx, repo);
    await assertJobLeaseAtWallTime(tx, lease);
    if (!current || !current.settings.enabled || !current.settings.humanReview.enabled
      || current.candidate.state !== 'needs_review' || current.candidate.decidedBy !== 'auto'
      || current.candidate.publishedSlug || current.document.productUrl !== current.candidate.productUrl
      || current.input.validUntil <= new Date()) return null;
    const { candidate, input } = current;
    const pending = await tx.select({ id: secondReviews.id }).from(secondReviews).where(and(
      eq(secondReviews.candidateId, candidate.id), eq(secondReviews.status, 'pending'),
    )).for('share');
    if (pending.length) return null;
    // Never interrupt another reviewer or an external operation whose owner is alive.
    const [active] = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.state, 'running'),
    )).for('update');
    if (active) {
      if (active.kind !== 'delegated' || active.startedAt.getTime() + 120_000 > Date.now()) return null;
      const [owner] = await tx.select({ name: jobs.name }).from(jobs).where(and(eq(jobs.name, JOB),
        eq(jobs.leaseToken, active.leaseToken ?? ''), sql`${jobs.lockedAt} > now() - interval '120 seconds'`));
      if (owner) return null;
      await tx.update(crawlReviewAttempts).set({ state: 'failed', errorCode: 'owner_lost', completedAt: new Date(), retryAfter: new Date() })
        .where(eq(crawlReviewAttempts.id, active.id));
    }
    const generation = current.settings.humanReview.generation;
    const attempts = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.kind, 'delegated'),
      eq(crawlReviewAttempts.inputHash, input.inputHash), eq(crawlReviewAttempts.sourceRevisionHash, input.sourceRevisionHash),
      eq(crawlReviewAttempts.actor, deepseekActor(generation)),
    )).orderBy(desc(crawlReviewAttempts.id));
    // A model's abstention is final for this input. Failures have bounded retries.
    if (attempts.some(row => row.state === 'succeeded') || attempts.length >= 3
      || attempts[0]?.retryAfter && attempts[0].retryAfter > new Date()) return null;
    const [attempt] = await tx.insert(crawlReviewAttempts).values({
      candidateId: candidate.id, kind: 'delegated', state: 'running', inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, source: input.source, snapshot: input.snapshot,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: DEEPSEEK_REVIEW_PROVIDER,
      model: DEEPSEEK_REVIEW_MODEL, actor: deepseekActor(generation), attemptNumber: attempts.length + 1,
      leaseToken: lease.token, validUntil: input.validUntil,
    }).returning({ id: crawlReviewAttempts.id });
    await assertJobLeaseAtWallTime(tx, lease);
    return { attemptId: attempt.id, repo, candidateRevision: candidateRevisionHash(candidate), input, generation, lease };
  });
}

/** Recheck switch generation, human decisions, all evidence and lease at the final write. */
export async function recordHumanReview(claim: HumanReviewClaim, result: DeepSeekReviewResult): Promise<'applied' | 'held' | 'failed' | 'superseded'> {
  if (claim.lease.name !== JOB) throw new Error('human_review_job_required');
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    const current = await lockedInput(tx, claim.repo);
    const [attempt] = await tx.select().from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.id, claim.attemptId),
      eq(crawlReviewAttempts.kind, 'delegated'), eq(crawlReviewAttempts.leaseToken, claim.lease.token))).for('update');
    await assertJobLeaseAtWallTime(tx, claim.lease);
    if (!attempt || attempt.state !== 'running') return 'superseded';
    const now = new Date();
    if (ai1.mode === 'draining' || ai2.mode === 'draining' || !current || !current.settings.enabled || !current.settings.humanReview.enabled
      || current.settings.humanReview.generation !== claim.generation || current.candidate.state !== 'needs_review'
      || current.candidate.decidedBy !== 'auto' || candidateRevisionHash(current.candidate) !== claim.candidateRevision
      || current.input.inputHash !== attempt.inputHash || current.input.sourceRevisionHash !== attempt.sourceRevisionHash
      || current.input.policyHash !== attempt.policyHash || current.input.validUntil <= now) {
      await tx.update(crawlReviewAttempts).set({ state: 'superseded', errorCode: 'input_or_switch_changed', completedAt: now })
        .where(eq(crawlReviewAttempts.id, attempt.id));
      return 'superseded';
    }
    if (!result.ok) {
      await tx.update(crawlReviewAttempts).set({ state: 'failed', errorCode: result.error, completedAt: now,
        retryAfter: new Date(now.getTime() + 15 * 60_000) }).where(eq(crawlReviewAttempts.id, attempt.id));
      await assertJobLeaseAtWallTime(tx, claim.lease);
      return 'failed';
    }
    const outcome = validateReviewOutcome(current.input, result.outcome);
    // These approvals still need fresh source/safety facts or an actual human.
    const cannotApprove = ['suspected_spam', 'repo_deleted', 'source_refresh_failed'].includes(current.candidate.reason ?? '');
    if ((outcome.confidence ?? 0) < DEEPSEEK_MIN_CONFIDENCE || outcome.decision === 'approve' && cannotApprove) outcome.decision = 'needs_review';
    await tx.update(crawlReviewAttempts).set({ state: 'succeeded', outcome, reason: outcome.reason, completedAt: now })
      .where(eq(crawlReviewAttempts.id, attempt.id));
    if (outcome.decision === 'needs_review') return 'held';
    await tx.update(crawlCandidates).set({ state: outcome.decision === 'approve' ? 'approved' : 'rejected',
      reason: outcome.decision === 'approve' ? 'passed' : 'not_a_product', decidedBy: 'deepseek', decidedAt: now, updatedAt: now,
      // judgedAt remains the source bound into this review's hashes.
      signals: { ...current.candidate.signals, delegatedReviewAttemptId: attempt.id, judgedRevision: judgeRevision(current.document) },
    }).where(eq(crawlCandidates.id, current.candidate.id));
    await tx.insert(operationsAudit).values({
      actor: DEEPSEEK_REVIEW_PROVIDER, actorKind: 'model', ok: true,
      action: 'candidate-deepseek-decision', target: claim.repo,
      detail: { attemptId: attempt.id, generation: claim.generation, model: DEEPSEEK_REVIEW_MODEL, outcome },
    });
    if (outcome.decision === 'approve') await requestJob('crawl-publish', tx);
    await assertJobLeaseAtWallTime(tx, claim.lease);
    return 'applied';
  });
}

/** Expired/revoked approvals return to the human queue; never strand them behind a gate. */
export async function requeueInvalidHumanApprovals(lease: JobLease, limit = 50): Promise<number> {
  if (lease.name !== JOB) throw new Error('human_review_job_required');
  const settings = await getSettings();
  const rows = await db.select({ repo: crawlCandidates.repo }).from(crawlCandidates).where(and(
    eq(crawlCandidates.state, 'approved'), eq(crawlCandidates.decidedBy, 'deepseek'), not(reviewApprovalPredicate(settings)),
  )).orderBy(asc(crawlCandidates.updatedAt)).limit(limit);
  let count = 0;
  for (const { repo } of rows) {
    count += await db.transaction(async tx => {
      await lockPipelineInputStages(tx);
      const current = await lockedInput(tx, repo);
      await assertJobLeaseAtWallTime(tx, lease);
      if (!current || current.candidate.state !== 'approved' || current.candidate.decidedBy !== 'deepseek') return 0;
      const id = current.candidate.signals?.delegatedReviewAttemptId;
      const [attempt] = await tx.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, typeof id === 'number' ? id : -1)).for('share');
      if (current.settings.humanReview.enabled && attempt?.kind === 'delegated' && attempt.state === 'succeeded'
        && attempt.actor === deepseekActor(current.settings.humanReview.generation) && attempt.outcome?.decision === 'approve'
        && attempt.provider === DEEPSEEK_REVIEW_PROVIDER && attempt.model === DEEPSEEK_REVIEW_MODEL
        && attempt.policyHash === current.input.policyHash
        && attempt.inputHash === current.input.inputHash && attempt.sourceRevisionHash === current.input.sourceRevisionHash
        && attempt.validUntil > new Date() && current.input.validUntil > new Date()) return 0;
      const signals = { ...current.candidate.signals };
      delete signals.delegatedReviewAttemptId;
      await tx.update(crawlCandidates).set({ state: 'needs_review', reason: 'second_review_split', decidedBy: 'auto',
        decidedAt: null, updatedAt: new Date(), signals }).where(eq(crawlCandidates.id, current.candidate.id));
      await assertJobLeaseAtWallTime(tx, lease);
      return 1;
    });
  }
  return count;
}
