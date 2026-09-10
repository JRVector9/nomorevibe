import { and } from 'drizzle-orm';
import { agentRequest } from '@/lib/operations/agent-client';
import { classificationReadyPredicate, decisionFor, holdClassification } from '@/lib/operations/categories';
import type { Category } from '@/lib/domain/products/schema';
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import * as crawl from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { prepareCandidateClassification, publishCandidate } from "@/lib/crawl/publish";
import { classifyCategories } from "@/lib/crawl/classify";
import { recordPublicationFailure } from "@/lib/crawl/publication-guard";
import { reviewApprovalPredicate } from "@/lib/crawl/agent-review-repository";
import { requestJob } from "@/lib/jobs/control";

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

export async function publishCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("crawl.publish_skipped", { reason: "disabled" });
    return { done: true };
  }

  let published = 0;
  let skipped = 0;

  while (ctx.hasBudget()) {
    // Filter before LIMIT so pending reviews cannot starve approved products.
    const candidates = await crawl.listCandidates(["approved"], BATCH, process.env.CONNECT_AGENT_URL ? and(reviewApprovalPredicate(settings), classificationReadyPredicate()) : reviewApprovalPredicate(settings));
    if (candidates.length === 0) {
      ctx.log("crawl.publish_done", { published, skipped, drained: true });
      return { done: true };
    }

    const prepared = await Promise.all(candidates.map(async candidate => ({
      candidate,
      classification: await prepareCandidateClassification(candidate),
    })));
    const decisions = new Map(await Promise.all(prepared.map(async item => [item.candidate.repo, item.classification && process.env.CONNECT_AGENT_URL ? await decisionFor(item.candidate, item.classification.snapshot.document) : null] as const)));
    const inputs = prepared.filter(item => !decisions.get(item.candidate.repo)?.category).flatMap(item => item.classification ? [item.classification.input] : []);
    let classified: (Category | null)[] = [];
    if (inputs.length > 0) {
      if (process.env.CONNECT_AGENT_URL) {
        try { classified = (await agentRequest<{ categories: (Category | null)[] }>('classify', { inputs, definitions: settings.classify.definitions })).categories; }
        catch { classified = inputs.map(() => null); ctx.log('crawl.classification_held', { count: inputs.length }); }
      } else classified = await classifyCategories(inputs, undefined, undefined, undefined, settings.classify.definitions);
    }
    const categoryByRepo = new Map(inputs.map((input, index) => [input.repo, classified[index] ?? null]));
    const snapshotByRepo = new Map(prepared.flatMap(item => item.classification
      ? [[item.candidate.repo, item.classification.snapshot] as const]
      : []));

    let rejudge = 0;
    try {
      for (const candidate of candidates) {
        if (!ctx.hasBudget()) return { done: false };
        const manual = decisions.get(candidate.repo);
        const category = manual?.category as Category | null ?? categoryByRepo.get(candidate.repo) ?? null;
        const snapshot = snapshotByRepo.get(candidate.repo);
        if (process.env.CONNECT_AGENT_URL && snapshot && category === null) {
          await holdClassification(candidate, snapshot.document); skipped++; continue;
        }
        const result = await publishCandidate(candidate, ctx.lease, {
          category,
          decision: process.env.CONNECT_AGENT_URL ? { revision: manual?.revision ?? null, sourceHash: manual?.sourceHash ?? null } : undefined,
          snapshot: snapshotByRepo.get(candidate.repo),
        });

        if (!result.ok) {
          if (result.reason === "publication_state_changed" || result.reason === "review_approval_changed") {
            ctx.log("crawl.publication_changed", {repo:candidate.repo});
            return {done:false}; // Preserve the newer human/source decision.
          }
          // 승인 뒤 바뀐 원본이 지금 규칙을 통과하지 못했다 — 사람에게 넘기지 않고 판정에 되돌린다
          if (result.reason === "stale_judgement") {
            if (!await recordPublicationFailure(candidate, { state: "new", reason: "source_changed" }, ctx.lease)) {
              ctx.log("crawl.publication_changed", {repo:candidate.repo});
              return {done:false};
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
          const held = result.reason === "no_description" || evidenceHeld;
          const recorded = await recordPublicationFailure(candidate, {
            state: held ? "needs_review" : "rejected",
            reason: evidenceHeld ? result.reason as import("@/lib/db/schema").DecisionReason : held ? "ambiguous" : result.reason === "already_listed" ? "already_listed" : "not_a_product",
          }, ctx.lease);
          if (!recorded) {
            ctx.log("crawl.publication_changed", {repo:candidate.repo});
            return {done:false};
          }
          ctx.log("crawl.publish_skipped_candidate", { repo: candidate.repo, reason: result.reason });
          skipped++;
          continue;
        }

        published++;
        if (!ctx.hasBudget()) break;
      }
    } finally {
      // 되돌린 것은 곧바로 다시 판정한다. 묶음당 한 번이다 — 후보마다 부르면 잡 행을 두고 경합한다
      if (rejudge > 0) await requestJob("crawl-judge");
    }
  }

  ctx.log("crawl.publish_done", { published, skipped, drained: false });
  return { done: false };
}
