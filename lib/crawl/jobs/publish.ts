import { findOwnPendingPublicationApiBatches, cancelOwnPendingPublicationApiBatch, readModelCapacityControlObservation } from '@/lib/llm/capacity-repository';
import { roleLeaseFromEnv } from '@/lib/jobs/role-leader';
import { readAiTaskExecutionConfig } from '@/lib/llm/ai-task-execution-snapshot';
import { ensureReviewTaskRanks } from '@/lib/crawl/review-task-ranks';
import { classifyPublicationPool } from '@/lib/crawl/publication-classify-pool';
import { jobKnob } from '@/lib/operations/runtime-settings-schema';
import { runtimeSettings } from '@/lib/operations/runtime-settings-store';
import { emitPipelineEvent } from "@/lib/observability/review-pipeline";
import { and, inArray, notInArray, or } from 'drizzle-orm';
import { crawlCandidates } from '@/lib/db/schema';
import { agentRequest } from '@/lib/operations/agent-client';
import { classificationReadyPredicate, decisionFor, holdClassification } from '@/lib/operations/categories';
import type { Category } from '@/lib/domain/products/schema';
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import * as crawl from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { prepareCandidateClassification, publishCandidate } from "@/lib/crawl/publish";
import { classifyCategories } from "@/lib/crawl/classify";
import { recordPublicationFailure } from "@/lib/crawl/publication-guard";
import { requeueInvalidStarApprovals, reviewApprovalPredicate, starAutoApprovalPredicate } from "@/lib/crawl/agent-review-repository";
import { requiresProfileCategory } from "@/lib/crawl/rules";
import { requestJob } from "@/lib/jobs/control";
import { publicationClassificationAuthority, publicationClassificationPath } from '@/lib/crawl/publication-classify-capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { recordPublisherClassificationDraining } from '@/lib/operations/publisher-drain-progress';

/**
 * 발행 잡 — 통과한 후보를 목록에 올린다. 파이프라인의 마지막 단계다.
 *
 * 크롤과 색인이 끊겨 있다는 것이 이 구조의 요지다. 수집기가 무엇을 긁어오든 products는
 * 이 단계를 거쳐야만 바뀐다.
 *
 * 커서가 없다. 발행하면 후보가 published로 바뀌어 대기 목록에서 빠진다.
 */

/** 한 번에 발행하는 수. 후보마다 insert와 OG 이미지 복사가 붙으므로 작게 잡는다 */
const BATCH = 10;

/** 발행에서 멈춘 이유 — 거부·보류 기록(signals.stoppedAt)에 사람이 읽을 말로 남긴다. 없는 것은 코드 그대로 */
const PUBLISH_STOPS: Record<string, string> = {
  no_description: "페이지 설명도 레포 설명도 없어 목록에 쓸 소개를 만들 수 없다",
  not_a_product: "설문·연구 문서처럼 제품이 아닌 목적의 페이지",
  already_listed: "같은 저장소 또는 URL의 제품이 이미 목록에 있다",
  no_document: "수집한 원본이 없다",
  no_url: "배포 URL 이 없다",
  installation_review_required: "설치형 제품은 AI 심사 적용 모드 또는 관리자 승인이 필요합니다",
  source_changed: "판정 뒤 배포 URL 이 바뀌었다",
  repository_relationship_conflict: "페이지가 가리키는 저장소가 이 레포가 아니다",
  suspected_spam: "스팸·악성 배포 의심 — 틀에 찍은 README·다운로드 미끼·남의 github.io 첫 화면. 사람이 승인해야 올린다",
};

async function observeClassificationDrain(error: unknown, ctx: JobContext<null>) {
  if (error instanceof ModelCapacityDeferredError && error.reason === 'draining')
    await recordPublisherClassificationDraining(ctx.lease).catch(() => ctx.log('crawl.classification_drain_observation_failed', {}));
}

export async function publishCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("crawl.publish_skipped", { reason: "disabled" });
    return { done: true };
  }

  // Queue predicates and final approval checks use the current reviewers, even
  // though this role does not execute first/second reviews itself.
  await ensureReviewTaskRanks();
  if (ctx.lease) {
    const reopened = await requeueInvalidStarApprovals(settings, ctx.lease);
    if (reopened) ctx.log("crawl.star_approvals_reopened", { count: reopened });
  }

  let execution: ReturnType<typeof readAiTaskExecutionConfig>;
  try { execution = readAiTaskExecutionConfig('publish-classify'); }
  catch (error) {
    if (!(error instanceof ModelCapacityDeferredError)) throw error;
    ctx.log('crawl.classification_deferred', { reason: error.reason });
    return deferredJob<null>('model_capacity');
  }
  const pool = execution.mode === 'workload_pool';
  // Independent classification batches; model admission still enforces each physical device's limit.
  const classifyConcurrency = pool ? jobKnob(runtimeSettings(), 'crawl-publish', 'classifierConcurrency') : 1;
  const classificationWaiting = new Set<number>();
  let classificationDrainObserved = false;
  const role = roleLeaseFromEnv('publisher', process.env);
  const pendingBatches = role ? await findOwnPendingPublicationApiBatches({ instanceId: role.instanceId, bootId: role.bootId }) : [];
  let published = 0;
  let skipped = 0;
  const conflicts = new Set<number>();
  const publicationChanged = (candidate: { id: number; repo: string }, branch: string) => {
    conflicts.add(candidate.id);
    ctx.log("crawl.publication_changed", { repo: candidate.repo, branch, conflicts: 1 });
  };
  const capacityDeferred = () => deferredJob<null>("model_capacity", published + skipped);
  const abandonPending = async (batch: typeof pendingBatches[number]) => {
    if (role) await cancelOwnPendingPublicationApiBatch(batch, { instanceId: role.instanceId, bootId: role.bootId });
  };
  if (pendingBatches.length && (!pool || (await readModelCapacityControlObservation()).mode !== 'open')) {
    // Mode changes abandon only unstarted API work; native admission still enforces the global drain below.
    for (const batch of pendingBatches.splice(0)) await abandonPending(batch);
  }

  const poolCounts: Record<string, number> = { ranks: 0, pool_members: execution.members.length, pool_revision: execution.revision ?? 0 };
  const classifyCtx: JobContext<null> = { ...ctx, log(event, fields) {
    if (event !== 'ai_task.ranks') { ctx.log(event, fields); return; }
    for (const [key, count] of Object.entries(fields ?? {}))
      if (key.startsWith('member_') && typeof count === 'number') poolCounts[key] = (poolCounts[key] ?? 0) + count;
  } };
  try {
  while (ctx.hasBudget()) {
    // Filter before LIMIT so pending reviews cannot starve approved products.
    const eligible = pool || process.env.CONNECT_AGENT_URL
      ? and(reviewApprovalPredicate(settings), or(classificationReadyPredicate(), starAutoApprovalPredicate(settings)))
      : reviewApprovalPredicate(settings);
    // Exclude conflicting snapshots before LIMIT; they remain untouched for the next tick.
    const resume = pendingBatches.shift();
    const candidates = await crawl.listCandidates(["approved"], resume ? BATCH : BATCH * classifyConcurrency,
      and(eligible, resume ? inArray(crawlCandidates.id, [...resume.candidateIds]) : undefined,
        conflicts.size || classificationWaiting.size ? notInArray(crawlCandidates.id, [...conflicts, ...classificationWaiting]) : undefined));
    // Stable input order is part of the payload hash. A new queue head must not split an existing batch.
    if (pool) candidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id);
    if (resume && (candidates.length !== resume.candidateIds.length || candidates.some(candidate => !resume.candidateIds.includes(candidate.id)))) {
      // Abandon the exact unstarted batch; keep unrelated queue work moving.
      await abandonPending(resume);
      for (const id of resume.candidateIds) classificationWaiting.add(id);
      continue;
    }
    if (candidates.length === 0) {
      if (classificationWaiting.size) return capacityDeferred();
      ctx.log("crawl.publish_done", { published, skipped, conflicts: conflicts.size, drained: conflicts.size === 0 });
      return { done: conflicts.size === 0 };
    }

    const prepared = await Promise.all(candidates.map(async candidate => ({
      candidate,
      classification: await prepareCandidateClassification(candidate),
    })));
    const decisions = new Map(await Promise.all(prepared.map(async item => [item.candidate.repo, item.classification && (pool || process.env.CONNECT_AGENT_URL) ? await decisionFor(item.candidate, item.classification.snapshot.document) : null] as const)));
    const inputs = prepared.filter(item => !decisions.get(item.candidate.repo)?.category).flatMap(item => item.classification ? [item.classification.input] : []);
    let classified: (Category | null)[] = [];
    if (resume && inputs.length === 0) await abandonPending(resume);
    if (inputs.length > 0) {
      if (pool) {
        // Complete all started batches before publishing; an unsuccessful batch does not hide another batch's result.
        const batches = Array.from({ length: Math.ceil(inputs.length / BATCH) }, (_, index) => inputs.slice(index * BATCH, (index + 1) * BATCH));
        const outcomes = await Promise.allSettled(batches.map(batch => {
          const selected = prepared.flatMap(item => item.classification && batch.some(input => input.repo === item.candidate.repo)
            ? [{ candidate: item.candidate, classification: item.classification, decision: decisions.get(item.candidate.repo) ?? null }] : []);
          return classifyPublicationPool(selected, { inputs: batch, definitions: settings.classify.definitions }, execution, classifyCtx, resume);
        }));
        // The existing drain witness belongs after all started native calls have completed/settled.
        const draining = outcomes.find(outcome => outcome.status === 'rejected'
          && outcome.reason instanceof ModelCapacityDeferredError && outcome.reason.reason === 'draining');
        if (!classificationDrainObserved && draining?.status === 'rejected') {
          classificationDrainObserved = true;
          await observeClassificationDrain(draining.reason, ctx);
        }
        classified = outcomes.flatMap((outcome, index) => {
          if (outcome.status === 'fulfilled') return outcome.value;
          if (!(outcome.reason instanceof ModelCapacityDeferredError)) throw outcome.reason;
          for (const input of batches[index]) {
            const candidate = candidates.find(candidate => candidate.repo === input.repo);
            if (candidate) classificationWaiting.add(candidate.id);
          }
          ctx.log('crawl.classification_deferred', { count: batches[index].length,
            reason: outcome.reason instanceof ModelCapacityDeferredError ? outcome.reason.reason : 'provider_contract_unavailable' });
          return batches[index].map(() => null);
        });
      } else if (process.env.CONNECT_AGENT_URL) {
        let nativeRequested = false;
        try {
          const payload = { inputs, definitions: settings.classify.definitions };
          const selected = prepared.flatMap(item => item.classification && inputs.some(input => input.repo === item.candidate.repo)
            ? [{ candidate: item.candidate, classification: item.classification, decision: decisions.get(item.candidate.repo) ?? null }] : []);
          const authority = await publicationClassificationAuthority(selected, payload, ctx.lease);
          nativeRequested = authority !== undefined;
          classified = (await agentRequest<{ categories: (Category | null)[] }>('classify', { ...payload, ...(authority ? { authority } : {}) })).categories;
        } catch (error) {
          if (error instanceof ModelCapacityDeferredError || nativeRequested) {
            await observeClassificationDrain(error, ctx);
            // A lost RPC response cannot prove whether the remote native child has ended.
            ctx.log('crawl.classification_deferred', { count: inputs.length,
              reason: error instanceof ModelCapacityDeferredError ? error.reason : 'dispatched' });
            return capacityDeferred();
          }
          classified = inputs.map(() => null); ctx.log('crawl.classification_held', { count: inputs.length });
        }
      } else {
        const path = await publicationClassificationPath().catch(async error => { await observeClassificationDrain(error, ctx); throw error; });
        if (path !== 'legacy') {
          ctx.log('crawl.classification_deferred', { count: inputs.length, reason: 'provider_contract_unavailable' });
          return capacityDeferred();
        }
        classified = await classifyCategories(inputs, undefined, undefined, undefined, settings.classify.definitions);
      }
    }
    const categoryByRepo = new Map(inputs.map((input, index) => [input.repo, classified[index] ?? null]));
    const snapshotByRepo = new Map(prepared.flatMap(item => item.classification
      ? [[item.candidate.repo, item.classification.snapshot] as const]
      : []));

    let rejudge = 0;
    try {
      for (const candidate of candidates) {
        if (classificationWaiting.has(candidate.id)) continue;
        if (!ctx.hasBudget()) return { done: false };
        const manual = decisions.get(candidate.repo);
        const category = manual?.category as Category | null ?? categoryByRepo.get(candidate.repo) ?? null;
        const snapshot = snapshotByRepo.get(candidate.repo);
        if ((pool || process.env.CONNECT_AGENT_URL) && snapshot && category === null && !snapshot.starAutoApproved) {
          await holdClassification(candidate, snapshot.document, ctx.lease); skipped++; continue;
        }
        /**
         * 이름만으로 개인 것인지 못 가르는 패턴은 분류기의 답을 조건으로 쓴다.
         *
         * `*-blog` 로 통과한 것이 Profile 이 아니면 회사·주제 블로그다 — 읽을거리지 제품이
         * 아니므로 판정 때 통과시킨 것을 여기서 되돌린다. 사람이 이미 본 것(admin)과 사람이
         * 직접 고른 카테고리는 건드리지 않는다.
         */
        if (!manual?.category && candidate.decidedBy !== "admin"
          && requiresProfileCategory(candidate.signals, settings) && category !== "Profile") {
          if (!await recordPublicationFailure(candidate, { state: "rejected", reason: "personal_site", stoppedAt: {
            rule: "발행 조건 — 개인 프로필",
            detail: `${String(candidate.signals?.profilePattern)} 패턴으로 통과했지만 분류가 ${category ?? "없음"} — 개인 것이 아니면 읽을거리다`,
          } }, ctx.lease)) {
            publicationChanged(candidate, "profile_failure_cas");
            continue;
          }
          ctx.log("crawl.publish_not_a_personal_profile", { repo: candidate.repo, category });
          skipped++; continue;
        }
        const result = await publishCandidate(candidate, ctx.lease, {
          category,
          decision: pool || process.env.CONNECT_AGENT_URL ? { revision: manual?.revision ?? null, sourceHash: manual?.sourceHash ?? null } : undefined,
          snapshot: snapshotByRepo.get(candidate.repo),
        });

        if (!result.ok) {
          if (result.reason === "publication_state_changed" || result.reason === "review_approval_changed") {
            publicationChanged(candidate, result.reason);
            continue; // Preserve the newer human/source decision, and process other candidates.
          }
          // 승인 뒤 바뀐 원본이 지금 규칙을 통과하지 못했다 — 사람에게 넘기지 않고 판정에 되돌린다
          if (result.reason === "stale_judgement") {
            if (!await recordPublicationFailure(candidate, { state: "new", reason: "source_changed" }, ctx.lease)) {
              publicationChanged(candidate, "rejudge_failure_cas");
              continue;
            }
            ctx.log("crawl.publish_rejudge", { repo: candidate.repo });
            rejudge++;
            skipped++;
            continue;
          }
          /**
           * 발행하지 못한 후보는 어느 쪽으로든 approved에서 빼야 한다. 그대로 두면 다음 틱이
           * 같은 것을 또 집어 큐가 막힌다 — approved 상태가 곧 대기 목록이기 때문이다.
           *
           * 소개가 없어서 못 올린 것만 사람에게 넘긴다. 나머지는 사람이 봐도 할 일이 없다.
           */
          const evidenceHeld = result.reason.startsWith("ai_evidence_") || result.reason === "repository_relationship_conflict" || result.reason === "source_changed";
          const spam = result.reason === "suspected_spam";
          const held = result.reason === "no_description" || evidenceHeld || result.reason === "installation_review_required" || spam;
          const duplicateReason = result.existing?.status === "banned" ? "banned" : "already_listed";
          const recorded = await recordPublicationFailure(candidate, {
            state: held ? "needs_review" : "rejected",
            // 소개 없음은 AI 가 다시 집지 않는 사유로 둔다 — ambiguous 면 enforce 에서 보류·승인·발행 실패가 AI 호출마다 되풀이된다
            reason: result.reason === "installation_review_required" ? "ambiguous" : spam ? "suspected_spam" : evidenceHeld ? result.reason as import("@/lib/db/schema").DecisionReason : held ? "no_description" : result.reason === "already_listed" ? duplicateReason : "not_a_product",
            existing: result.existing,
            ...(result.suspectedSpam ? { signals: { suspectedSpam: result.suspectedSpam } } : {}),
            stoppedAt: { rule: "발행 조건", detail: PUBLISH_STOPS[result.reason] ?? result.reason },
          }, ctx.lease);
          if (!recorded) {
            publicationChanged(candidate, "publication_failure_cas");
            continue;
          }
          ctx.log("crawl.publish_skipped_candidate", { repo: candidate.repo, reason: result.reason });
          skipped++;
          continue;
        }

        emitPipelineEvent("committed", { stage: "publish", candidateId: candidate.id, job: ctx.lease?.name,
          runId: String(ctx.lease?.requestedVersion), state: "published" }, ctx.log);
        published++;
        if (!ctx.hasBudget()) break;
      }
    } finally {
      // 되돌린 것은 곧바로 다시 판정한다. 묶음당 한 번이다 — 후보마다 부르면 잡 행을 두고 경합한다
      if (rejudge > 0) await requestJob("crawl-judge");
    }
  }

  ctx.log("crawl.publish_done", { published, skipped, conflicts: conflicts.size, drained: false });
  return { done: false };
  } finally {
    // One end-of-tick observation retains all member counts even when several independent batches ran.
    if (pool) ctx.log('ai_task.ranks', poolCounts);
  }
}
