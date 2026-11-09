import { modelRequestName, scopedModel } from "@/lib/llm/model-registry";
import { currentHumanModelSelection } from '@/lib/operations/human-model-source';
import { and, asc, desc, eq, inArray, isNull, not, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlReviewAttempts, operationsAudit, jobs, secondReviews, type DecisionReason } from '@/lib/db/schema';
import { assertJobLeaseAtWallTime, requestJob, type JobLease } from '@/lib/jobs/control';
import { readItemStage } from '@/lib/jobs/items/repository';
import { candidateRevisionHash, lockedInput } from './admin-review';
import { lockPipelineInputStages } from './pipeline-stage-context';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewEvidenceAgeHours, validateReviewOutcome, type ReviewInput } from './agent-review-contract';
import { judgeRevision } from './rules';
import { getSettings } from './settings';
import { currentReviewSource, reviewApprovalPredicate } from './agent-review-repository';
import type { CrawlSettings } from './settings-schema';
import { DEEPSEEK_MIN_CONFIDENCE, DEEPSEEK_REVIEW_MODEL, DEEPSEEK_REVIEW_PROVIDER, deepseekActor } from './deepseek-review-policy';
import type { DeepSeekReviewResult } from './deepseek-review';
import { heldQwenOwns } from './held-qwen-retry-policy';

export type HumanReviewClaim = {
  attemptId: number; candidateId: number; repo: string; candidateRevision: string; input: ReviewInput; generation: number; lease: JobLease;
};
const JOB = 'human-deepseek-review';

/** 한 틱이 고를 후보 수의 상한 배수 — 후보 고르기가 거른 뒤에도 claim 이 null 인 후보(드묾)가 머리를 막지 않게 조금 넉넉히 읽는다 */
export const HUMAN_REVIEW_SCAN_FACTOR = 4;
/** 같은 원본의 위임 시도 상한 — claim 의 시도 상한(3)과 같다 */
const MAX_DELEGATED_ATTEMPTS = 3;

/**
 * 이번 틱에 맡을 후보 — 사람 큐에 가장 최근에 들어온 것부터(updatedAt 내림차순). 2026-11-09 운영자 결정:
 * "최신 거부터 검토하되, 최신 것의 검토가 끝나면 쌓여 있는 과거의 것도 검토하게". 그래서 이 입력(원본)에서 이 잡이 이미
 * 끝낸 후보는 SQL 에서 뺀다 — 판단 보류·낮은 확신(succeeded), 같은 원본의 시도 상한(3), 실패 뒤 다시 볼 시각 전, 2차 대기.
 * 빼지 않으면 끝낸 후보가 매 틱 머리에 남아 뒤의 것이 굶는다(2026-11-03~09: 오래된 앞 5,061건이 매 틱 claim null 로
 * 110초 예산을 다 써 started=0). 원본이 바뀌면(currentReviewSource 가 어긋나면) 다시 대상이 된다.
 * 정확한 판정(입력 해시·lease·상태)은 claimHumanReview 가 잠근 행으로 다시 한다 — 여기는 줄 세우기다.
 *
 * skipReasons — 보류 Qwen-v2 재심사가 맡은 사유(heldQwenOwnedReasons). 같은 후보를 두 모델이 따로 가르지 않는다.
 */
export async function humanReviewRepos(ids: number[], skipReasons: readonly string[] = [],
  options: { settings?: CrawlSettings; limit?: number } = {}): Promise<string[]> {
  if (!ids.length) return [];
  const settings = options.settings ?? await getSettings();
  const actor = deepseekActor(settings.humanReview.generation);
  const delegated = sql`${crawlReviewAttempts.candidateId} = ${crawlCandidates.id} AND ${crawlReviewAttempts.kind} = 'delegated'
    AND ${crawlReviewAttempts.provider} = ${DEEPSEEK_REVIEW_PROVIDER} AND ${crawlReviewAttempts.actor} = ${actor}
    AND ${currentReviewSource(settings)}`;
  const rows = await db.select({ repo: crawlCandidates.repo }).from(crawlCandidates).where(and(
    inArray(crawlCandidates.id, ids), eq(crawlCandidates.state, 'needs_review'), eq(crawlCandidates.decidedBy, 'auto'),
    isNull(crawlCandidates.publishedSlug),
    skipReasons.length ? or(isNull(crawlCandidates.reason), notInArray(crawlCandidates.reason, [...skipReasons] as DecisionReason[])) : undefined,
    sql`NOT EXISTS (SELECT 1 FROM ${secondReviews} WHERE ${secondReviews.candidateId} = ${crawlCandidates.id} AND ${secondReviews.status} = 'pending')`,
    // 이 원본에서 모델의 판단(보류 포함)은 끝이다 — claim 의 attempts.some(succeeded) 와 같은 규칙
    sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${delegated} AND ${crawlReviewAttempts.state} = 'succeeded')`,
    sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${delegated} AND ${crawlReviewAttempts.retryAfter} > clock_timestamp())`,
    sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${delegated}
      AND NOT (${crawlReviewAttempts.state} = 'superseded' AND ${crawlReviewAttempts.errorCode} IS NOT DISTINCT FROM 'model_capacity_deferred')) < ${MAX_DELEGATED_ATTEMPTS}`,
  )).orderBy(desc(crawlCandidates.updatedAt), desc(crawlCandidates.id)).limit(Math.max(1, options.limit ?? 50));
  return rows.map(row => row.repo);
}

/** Claim the same candidate slot used by AI1; no DB transaction spans inference. */
export async function claimHumanReview(repo: string, lease: JobLease): Promise<HumanReviewClaim | null> {
  if (lease.name !== JOB) throw new Error('human_review_job_required');
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    if (ai1.mode === 'draining' || ai2.mode === 'draining') return null;
    // 근거 나이를 자르지 않는다(any_age, 2026-11-09 운영자 결정) — 24시간 지난 원본도 같은 원본이면 본다. 기한은 시도 행 validUntil 에 그대로 남는다
    const current = await lockedInput(tx, repo, 'any_age');
    await assertJobLeaseAtWallTime(tx, lease);
    if (!current || !current.settings.enabled || !current.settings.humanReview.enabled
      || current.candidate.state !== 'needs_review' || current.candidate.decidedBy !== 'auto'
      || current.candidate.publishedSlug || current.document.productUrl !== current.candidate.productUrl
      // 보류 Qwen-v2 재심사가 맡은 사유는 그쪽만 가른다 — 같은 잠긴 설정 행으로 재므로 두 claim 이 한 후보에 겹치지 않는다
      || heldQwenOwns(current.settings, current.candidate.reason)) return null;
    const { candidate, input } = current;
    if (input.snapshot.adminFirstReviewRerunId) {
      const [rerun] = await tx.select({ id: crawlReviewAttempts.id }).from(crawlReviewAttempts).where(and(
        eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.kind, 'automatic'),
        eq(crawlReviewAttempts.state, 'succeeded'), eq(crawlReviewAttempts.inputHash, input.inputHash),
        eq(crawlReviewAttempts.policyHash, input.policyHash), eq(crawlReviewAttempts.sourceRevisionHash, input.sourceRevisionHash),
        eq(crawlReviewAttempts.promptVersion, REVIEW_PROMPT_VERSION),
        eq(crawlReviewAttempts.rulesVersion, REVIEW_RULES_VERSION),
      )).limit(1);
      if (!rerun) return null;
    }
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
      sql`not (${crawlReviewAttempts.state} = 'superseded' and ${crawlReviewAttempts.errorCode} is not distinct from 'model_capacity_deferred')`,
    )).orderBy(desc(crawlReviewAttempts.id));
    // A model's abstention is final for this input. Failures have bounded retries.
    if (attempts.some(row => row.state === 'succeeded') || attempts.length >= MAX_DELEGATED_ATTEMPTS
      || attempts[0]?.retryAfter && attempts[0].retryAfter > new Date()) return null;
    const [attempt] = await tx.insert(crawlReviewAttempts).values({
      candidateId: candidate.id, kind: 'delegated', state: 'running', inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, source: input.source, snapshot: input.snapshot,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: DEEPSEEK_REVIEW_PROVIDER,
      model: scopedModel("human-review", DEEPSEEK_REVIEW_MODEL), actor: deepseekActor(generation), attemptNumber: attempts.length + 1,
      leaseToken: lease.token, validUntil: input.validUntil,
    }).returning({ id: crawlReviewAttempts.id });
    await assertJobLeaseAtWallTime(tx, lease);
    return { attemptId: attempt.id, candidateId: candidate.id, repo, candidateRevision: candidateRevisionHash(candidate), input, generation, lease };
  });
}

/** 슬롯 미발급은 생성·제품 실패가 아니다. 원격 점유 장부는 여기서 해제하지 않는다. */
export async function deferHumanReviewForModelCapacity(claim: HumanReviewClaim): Promise<void> {
  await db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    await tx.update(crawlReviewAttempts).set({ state: 'superseded', errorCode: 'model_capacity_deferred', completedAt: new Date(), retryAfter: null })
      .where(and(eq(crawlReviewAttempts.id, claim.attemptId), eq(crawlReviewAttempts.candidateId, claim.candidateId),
        eq(crawlReviewAttempts.kind, 'delegated'), eq(crawlReviewAttempts.state, 'running'), eq(crawlReviewAttempts.leaseToken, claim.lease.token)));
    await assertJobLeaseAtWallTime(tx, claim.lease);
  });
}

/** Recheck switch generation, human decisions, all evidence and lease at the final write. */
export async function recordHumanReview(claim: HumanReviewClaim, result: DeepSeekReviewResult): Promise<'applied' | 'held' | 'failed' | 'superseded'> {
  if (claim.lease.name !== JOB) throw new Error('human_review_job_required');
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    const current = await lockedInput(tx, claim.repo, 'any_age');
    const [attempt] = await tx.select().from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.id, claim.attemptId),
      eq(crawlReviewAttempts.kind, 'delegated'), eq(crawlReviewAttempts.leaseToken, claim.lease.token))).for('update');
    await assertJobLeaseAtWallTime(tx, claim.lease);
    if (!attempt || attempt.state !== 'running') return 'superseded';
    const now = new Date();
    if (ai1.mode === 'draining' || ai2.mode === 'draining' || !current || !current.settings.enabled || !current.settings.humanReview.enabled
      || current.settings.humanReview.generation !== claim.generation || current.candidate.state !== 'needs_review'
      || current.candidate.decidedBy !== 'auto' || candidateRevisionHash(current.candidate) !== claim.candidateRevision
      || current.input.inputHash !== attempt.inputHash || current.input.sourceRevisionHash !== attempt.sourceRevisionHash
      || current.input.policyHash !== attempt.policyHash) {
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
    // 근거 나이 — 24시간이 지난 근거로 내린 결정인지 운영자가 감사에서 가려 볼 수 있게(evidenceExpired). 시도 행의 validUntil·source 로도 다시 잴 수 있다
    const evidenceAgeHours = reviewEvidenceAgeHours(current.input, attempt.startedAt);
    await tx.insert(operationsAudit).values({
      actor: DEEPSEEK_REVIEW_PROVIDER, actorKind: 'model', ok: true,
      action: 'candidate-deepseek-decision', target: claim.repo,
      detail: { attemptId: attempt.id, generation: claim.generation, model: scopedModel("human-review", DEEPSEEK_REVIEW_MODEL), outcome,
        evidenceAgeHours, evidenceExpired: attempt.validUntil <= attempt.startedAt, validUntil: attempt.validUntil.toISOString() },
    });
    if (outcome.decision === 'approve') await requestJob('crawl-publish', tx);
    await assertJobLeaseAtWallTime(tx, claim.lease);
    return 'applied';
  });
}

/**
 * Revoked approvals return to the human queue; never strand them behind a gate.
 * 근거 나이만으로는 되돌리지 않는다(2026-11-09 운영자 결정) — 같은 원본·입력 해시·정책·스위치 세대·지금 모델이면 발행을 기다린다.
 */
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
      const current = await lockedInput(tx, repo, 'any_age');
      await assertJobLeaseAtWallTime(tx, lease);
      if (!current || current.candidate.state !== 'approved' || current.candidate.decidedBy !== 'deepseek') return 0;
      const id = current.candidate.signals?.delegatedReviewAttemptId;
      const [attempt] = await tx.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, typeof id === 'number' ? id : -1)).for('share');
      const selection = currentHumanModelSelection(current.settings.stageModelPools?.["human-review"] ?? []);
      if (current.settings.humanReview.enabled && attempt?.kind === 'delegated' && attempt.state === 'succeeded'
        && attempt.actor === deepseekActor(current.settings.humanReview.generation) && attempt.outcome?.decision === 'approve'
        && attempt.provider === DEEPSEEK_REVIEW_PROVIDER && attempt.model !== null
        && (selection.source === 'unknown' || selection.effectiveModels.map(modelRequestName).includes(attempt.model))
        && attempt.policyHash === current.input.policyHash
        && attempt.inputHash === current.input.inputHash && attempt.sourceRevisionHash === current.input.sourceRevisionHash) return 0;
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
