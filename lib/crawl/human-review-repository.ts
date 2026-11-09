import { modelRequestName, scopedModel } from "@/lib/llm/model-registry";
import { currentHumanModelSelection } from '@/lib/operations/human-model-source';
import { and, asc, desc, eq, inArray, isNull, not, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, operationsAudit, jobs, secondReviews, type DecisionReason } from '@/lib/db/schema';
import { isDeepStrictEqual } from 'node:util';
import { assertJobLeaseAtWallTime, requestJob, type JobLease } from '@/lib/jobs/control';
import { readItemStage } from '@/lib/jobs/items/repository';
import { candidateRevisionHash, lockedInput } from './admin-review';
import { lockPipelineInputStages } from './pipeline-stage-context';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewEvidenceAgeHours, validateReviewOutcome, type ReviewInput } from './agent-review-contract';
import { judgeRevision } from './rules';
import { getSettings, mergeWithDefaults } from './settings';
import { currentReviewSource, reviewApprovalPredicate } from './agent-review-repository';
import type { CrawlSettings } from './settings-schema';
import { DEEPSEEK_MIN_CONFIDENCE, DEEPSEEK_REVIEW_MODEL, DEEPSEEK_REVIEW_PROVIDER, deepseekActor } from './deepseek-review-policy';
import type { DeepSeekReviewResult } from './deepseek-review';
import { heldQwenOwns } from './held-qwen-retry-policy';
import type { DelegatedRepoCheckResult } from './delegated-repo-check';
import { EMPTY_DETAIL, GONE_DETAIL, lockFrontierIdentity, SKIP_EMPTY_REPOSITORY, SKIP_NOT_FOUND } from './repository';
import { hasLiveFetchItem } from './fetch-ownership';
import { hasLiveAgentReviewItem } from './agent-review-ownership';

export type HumanReviewClaim = {
  attemptId: number; candidateId: number; repo: string; candidateRevision: string; input: ReviewInput; generation: number; lease: JobLease;
  /** 시도 행의 시작 시각 — 근거 나이(reviewEvidenceAgeHours)를 잡과 기록이 같은 시각으로 잰다 */
  startedAt: Date;
};
const JOB = 'human-deepseek-review';

/**
 * 위임 승인의 근거 나이에 따른 길(2026-11-09 운영자 결정).
 *  ≤24시간 → 그대로 적용(발행). 24~72시간 → 발행 전에 저장소가 아직 있는지 GitHub 에 한 번 묻는다(delegated-repo-check.ts).
 *  >72시간 → 「72시간이 지난 건 공개하기 전에 다시 검수」 — 승인하지 않고 사람 큐에 둔 채 원본을 다시 받게 한다(refreshStaleDelegatedSources).
 *  다시 받은 원본은 새 입력이라 고르기(humanReviewRepos)가 다시 집고, 그때의 승인이 발행된다. 거부는 나이와 상관없이 그대로 닫는다.
 */
export const DELEGATED_REPO_CHECK_AFTER_HOURS = 24;
export const DELEGATED_APPROVE_MAX_EVIDENCE_HOURS = 72;
export type DelegatedApprovalRoute = 'publish' | 'check_repo' | 'refresh';
export function delegatedApprovalRoute(evidenceAgeHours: number): DelegatedApprovalRoute {
  return evidenceAgeHours > DELEGATED_APPROVE_MAX_EVIDENCE_HOURS ? 'refresh'
    : evidenceAgeHours > DELEGATED_REPO_CHECK_AFTER_HOURS ? 'check_repo' : 'publish';
}
/** 72시간 넘은 근거의 승인을 보류로 적은 시도 행의 표지(reason 칸) — 원본 재수집 요청과 재수집 결과 처리가 이 표지로 찾는다 */
export const STALE_EVIDENCE_REFRESH = 'stale_evidence_refresh';
/** 시도로 세지 않는 미룸 — 용량 미룸과 저장소 확인 미룸(GitHub 한도·전송 탈)은 그 입력 탓이 아니다 */
const UNCOUNTED_DEFERRALS = ['model_capacity_deferred', 'repo_check_deferred'] as const;

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
      AND NOT (${crawlReviewAttempts.state} = 'superseded' AND ${inArray(crawlReviewAttempts.errorCode, [...UNCOUNTED_DEFERRALS])})) < ${MAX_DELEGATED_ATTEMPTS}`,
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
      sql`not (${crawlReviewAttempts.state} = 'superseded' and ${inArray(crawlReviewAttempts.errorCode, [...UNCOUNTED_DEFERRALS])})`,
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
    }).returning({ id: crawlReviewAttempts.id, startedAt: crawlReviewAttempts.startedAt });
    await assertJobLeaseAtWallTime(tx, lease);
    return { attemptId: attempt.id, candidateId: candidate.id, repo, candidateRevision: candidateRevisionHash(candidate), input, generation, lease,
      startedAt: attempt.startedAt };
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

export type HumanReviewRecordState = 'applied' | 'held' | 'failed' | 'superseded' | 'stale' | 'repo_gone' | 'deferred';

/**
 * Recheck switch generation, human decisions, all evidence and lease at the final write.
 * repoCheck — 24~72시간 근거의 승인일 때 잡이 트랜잭션 밖에서 물은 저장소 확인(checkDelegatedRepository). 없으면 모르는 것(deferred)으로 본다.
 */
export async function recordHumanReview(claim: HumanReviewClaim, result: DeepSeekReviewResult,
  options: { repoCheck?: DelegatedRepoCheckResult } = {}): Promise<HumanReviewRecordState> {
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
    // 근거 나이 — 24시간이 지난 근거로 내린 결정인지 운영자가 감사에서 가려 볼 수 있게(evidenceExpired). 시도 행의 validUntil·source 로도 다시 잴 수 있다
    const evidenceAgeHours = reviewEvidenceAgeHours(current.input, attempt.startedAt);
    const evidence = { evidenceAgeHours, evidenceExpired: attempt.validUntil <= attempt.startedAt, validUntil: attempt.validUntil.toISOString() };
    const model = scopedModel("human-review", DEEPSEEK_REVIEW_MODEL);
    if (outcome.decision === 'approve') {
      const route = delegatedApprovalRoute(evidenceAgeHours);
      const check = route === 'check_repo' ? options.repoCheck ?? { check: 'deferred' as const, retryAt: null } : null;
      if (check?.check === 'deferred') {
        // 저장소가 있는지 모르면 발행하지 않는다 — 이 시도를 미루고(세지 않는다) 한도가 풀린 뒤 다시 본다
        const retryAfter = check.retryAt && check.retryAt > now ? check.retryAt : new Date(now.getTime() + 15 * 60_000);
        await tx.update(crawlReviewAttempts).set({ state: 'superseded', errorCode: 'repo_check_deferred', completedAt: now, retryAfter })
          .where(eq(crawlReviewAttempts.id, attempt.id));
        await assertJobLeaseAtWallTime(tx, claim.lease);
        return 'deferred';
      }
      if (route === 'refresh' || check?.check === 'changed' || check?.check === 'gone') {
        const gone = check?.check === 'gone';
        // 승인을 적용하지 않는다 — 모델의 답은 감사에 남기고, 시도 행은 이 입력의 판단 보류로 닫는다(같은 입력은 다시 집지 않는다)
        await tx.update(crawlReviewAttempts).set({ state: 'succeeded', outcome: { ...outcome, decision: 'needs_review' },
          reason: gone ? 'repo_deleted' : STALE_EVIDENCE_REFRESH, completedAt: now }).where(eq(crawlReviewAttempts.id, attempt.id));
        if (gone) {
          // 수집이 404 를 만났을 때(handOffFailedSourceRefreshes)와 같은 사유·발자국으로 사람에게 넘긴다
          await tx.update(crawlCandidates).set({ reason: 'repo_deleted', updatedAt: now,
            signals: { ...current.candidate.signals, stoppedAt: { rule: '저장소 확인', detail: GONE_DETAIL } },
          }).where(eq(crawlCandidates.id, current.candidate.id));
        }
        await tx.insert(operationsAudit).values({
          actor: DEEPSEEK_REVIEW_PROVIDER, actorKind: 'model', ok: true,
          action: gone ? 'candidate-deepseek-repo-gone' : 'candidate-deepseek-stale-hold', target: claim.repo,
          detail: { attemptId: attempt.id, generation: claim.generation, model, outcome, ...evidence,
            cause: gone ? 'repo_not_found' : check?.check === 'changed' ? 'repo_changed' : 'evidence_over_72h' },
        });
        await assertJobLeaseAtWallTime(tx, claim.lease);
        return gone ? 'repo_gone' : 'stale';
      }
    }
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
      detail: { attemptId: attempt.id, generation: claim.generation, model, outcome, ...evidence,
        ...(options.repoCheck ? { repoCheck: options.repoCheck.check } : {}) },
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

/**
 * 72시간 넘은 근거라 승인을 보류한(STALE_EVIDENCE_REFRESH) 후보의 원본을 다시 받게 하고, 다시 받기의 끝을 처리한다.
 *
 * 다시 받기는 수집 잡의 프론티어로만 한다(1차·보류 재심사의 원본 재수집과 같은 신호·잠금 순서) — GitHub 한도와 수집 탈 처리는 수집 잡이 맡는다.
 *  - 요청: 보류한 그 시도 뒤로 프론티어가 한 번도 움직이지 않았고 원본이 하루보다 오래됐을 때만 — 보류 한 번에 요청 한 번이다(매 틱 다시 묻지 않는다).
 *    원본이 하루 안이면(늙은 것이 스캔뿐이면) 다시 받지 않는다 — 사람에게 남는다.
 *  - 다시 받음: 원본(수집 시각)이 바뀌어 새 입력이 되므로 고르기가 다시 집는다. 판정 대상이 바뀌었으면 수집이 후보를 판정으로 되돌린다.
 *  - 404: 수집이 건너뛴(skipped·github_not_found) 것을 보면 handOffFailedSourceRefreshes 와 같은 사유(repo_deleted)·발자국으로 사람에게 넘기고 감사를 남긴다.
 *    빈 저장소·재수집 실패(failed)는 source_refresh_failed 로 넘긴다. 이름이 바뀐 저장소(alias_of)는 수집이 따라가므로 건드리지 않는다.
 */
export async function refreshStaleDelegatedSources(lease: JobLease, settings: CrawlSettings, limit = 20):
  Promise<{ requested: number; gone: number; failed: number }> {
  if (lease.name !== JOB) throw new Error('human_review_job_required');
  const none = { requested: 0, gone: 0, failed: 0 };
  if (!settings.enabled) return none;
  return db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    // 지금 원본에서 보류한 시도의 마지막 시각 — currentReviewSource 는 crawl_review_attempts 이름으로 쓰므로 별칭 없이 한 번 더 묶는다
    const staleAt = sql`(SELECT max(${crawlReviewAttempts.completedAt}) FROM ${crawlReviewAttempts}
      WHERE ${crawlReviewAttempts.candidateId} = ${crawlCandidates.id} AND ${crawlReviewAttempts.kind} = 'delegated'
        AND ${crawlReviewAttempts.provider} = ${DEEPSEEK_REVIEW_PROVIDER} AND ${crawlReviewAttempts.state} = 'succeeded'
        AND ${crawlReviewAttempts.reason} = ${STALE_EVIDENCE_REFRESH} AND ${currentReviewSource(settings)})`;
    const rows = await tx.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, productUrl: crawlCandidates.productUrl,
      signals: crawlCandidates.signals, staleMs: sql<number | null>`(extract(epoch FROM ${staleAt}) * 1000)::double precision` })
      .from(crawlCandidates).where(and(
      eq(crawlCandidates.state, 'needs_review'), eq(crawlCandidates.decidedBy, 'auto'), isNull(crawlCandidates.publishedSlug),
      // 이미 넘긴 것(재수집 끝을 처리한 사유)은 다시 보지 않는다 — 매 틱 같은 넘김·감사를 되풀이하지 않게
      or(isNull(crawlCandidates.reason), notInArray(crawlCandidates.reason, ['repo_deleted', 'source_refresh_failed'])),
      sql`${staleAt} IS NOT NULL`,
      or(
        // 요청할 것 — 보류 뒤 프론티어가 움직이지 않았고 원본이 하루보다 오래됐다
        sql`(EXISTS (SELECT 1 FROM crawl_documents d WHERE d.repo = ${crawlCandidates.repo}
            AND d.fetched_at < clock_timestamp() - interval '24 hours')
          AND NOT EXISTS (SELECT 1 FROM crawl_frontier f WHERE lower(f.repo) = lower(${crawlCandidates.repo})
            AND (f.repo <> ${crawlCandidates.repo} OR f.state IN ('pending', 'fetching') OR f.updated_at > ${staleAt})))`,
        // 끝을 볼 것 — 보류 뒤 다시 받기가 404·빈 저장소·실패로 끝났다
        sql`EXISTS (SELECT 1 FROM crawl_frontier f JOIN crawl_documents d ON d.repo = f.repo
          WHERE f.repo = ${crawlCandidates.repo} AND f.alias_of IS NULL AND f.updated_at > ${staleAt} AND f.updated_at > d.fetched_at
            AND (f.state = 'failed' OR (f.state = 'skipped' AND f.last_error IN (${SKIP_NOT_FOUND}, ${SKIP_EMPTY_REPOSITORY}))))`,
      ),
    )).orderBy(desc(crawlCandidates.updatedAt), desc(crawlCandidates.id))
      .limit(Math.max(1, Math.min(50, limit))).for('update', { skipLocked: true });
    const documents = rows.length ? await tx.select().from(crawlDocuments)
      .where(inArray(crawlDocuments.repo, rows.map(row => row.repo))).orderBy(asc(crawlDocuments.id)).for('share') : [];
    const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for('share');
    if (!rows.length || !isDeepStrictEqual(mergeWithDefaults(saved?.values), settings)) {
      await assertJobLeaseAtWallTime(tx, lease);
      return none;
    }
    for (const repo of [...new Set(rows.map(row => row.repo.toLowerCase()))].sort()) await lockFrontierIdentity(tx, repo);
    const frontiers = await tx.select().from(crawlFrontier)
      .where(inArray(sql`lower(${crawlFrontier.repo})`, rows.map(row => row.repo.toLowerCase())))
      .orderBy(asc(crawlFrontier.id)).for('update');
    const [clock] = await tx.execute<{ ms: number }>(sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS ms`);
    const wallNow = Number(clock.ms);
    type Plan = { row: typeof rows[number]; frontier: typeof crawlFrontier.$inferSelect | null; handoff: null | { gone: boolean; detail: string } };
    const plans: Plan[] = [];
    for (const row of rows) {
      const document = documents.find(item => item.repo === row.repo);
      const staleTime = row.staleMs === null ? NaN : Number(row.staleMs);
      const matching = frontiers.filter(item => item.repo.toLowerCase() === row.repo.toLowerCase());
      if (!document || !Number.isFinite(staleTime) || matching.some(item => item.repo !== row.repo)) continue;
      const [frontier] = matching;
      if (frontier && !frontier.aliasOf && frontier.updatedAt.getTime() > staleTime && frontier.updatedAt > document.fetchedAt
        && (frontier.state === 'failed' || frontier.state === 'skipped' && [SKIP_NOT_FOUND, SKIP_EMPTY_REPOSITORY].includes(frontier.lastError ?? ''))) {
        const failed = frontier.state === 'failed', gone = !failed && frontier.lastError === SKIP_NOT_FOUND;
        plans.push({ row, frontier, handoff: { gone,
          detail: failed ? `GitHub 원본 재수집 실패: ${(frontier.lastError ?? '원인 미상').slice(0, 220)}` : gone ? GONE_DETAIL : EMPTY_DETAIL } });
        continue;
      }
      if (document.fetchedAt.getTime() >= wallNow - 24 * 3600_000) continue;
      if (frontier && (frontier.state === 'pending' || frontier.state === 'fetching' || frontier.updatedAt.getTime() > staleTime)) continue;
      plans.push({ row, frontier: frontier ?? null, handoff: null });
    }
    // 도메인 잠금을 다 잡은 뒤 항목을 본다. 살아 있는 수집 claim 은 되돌리지 않는다
    const busy = new Set<number>();
    for (const plan of plans) if (plan.frontier && await hasLiveFetchItem(tx, plan.frontier.id)) busy.add(plan.frontier.id);
    for (const plan of plans) if (!plan.handoff) await hasLiveAgentReviewItem(tx, plan.row.id);
    const counts = { ...none };
    for (const plan of plans) {
      if (plan.frontier && busy.has(plan.frontier.id)) continue;
      if (plan.handoff) {
        await tx.update(crawlCandidates).set({ reason: plan.handoff.gone ? 'repo_deleted' : 'source_refresh_failed', updatedAt: sql`clock_timestamp()`,
          signals: { ...plan.row.signals, stoppedAt: { rule: '원본 재수집', detail: plan.handoff.detail } } })
          .where(eq(crawlCandidates.id, plan.row.id));
        await tx.insert(operationsAudit).values({ actor: 'human-deepseek-review', actorKind: 'system', ok: true,
          action: 'candidate-deepseek-stale-refresh-failed', target: plan.row.repo,
          detail: { candidateId: plan.row.id, reason: plan.handoff.gone ? 'repo_deleted' : 'source_refresh_failed',
            frontierState: plan.frontier?.state ?? null, frontierError: plan.frontier?.lastError ?? null } });
        if (plan.handoff.gone) counts.gone++; else counts.failed++;
        continue;
      }
      if (plan.frontier) await tx.update(crawlFrontier).set({ state: 'pending', attempts: 0, nextAttemptAt: sql`clock_timestamp()`,
        lastError: null, updatedAt: sql`clock_timestamp()` }).where(eq(crawlFrontier.id, plan.frontier.id));
      else await tx.insert(crawlFrontier).values({ repo: plan.row.repo, signal: 'review-source-refresh', priority: 100 });
      counts.requested++;
    }
    if (counts.requested) await requestJob('crawl-fetch', tx);
    await assertJobLeaseAtWallTime(tx, lease);
    return counts;
  });
}
