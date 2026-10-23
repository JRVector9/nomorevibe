import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq } from "drizzle-orm";
import { productAuditCampaigns, productAuditItems, products, secondReviews, crawlReviewAttempts, gateSplitTiebreaks,
  crawlCandidates, crawlDocuments, crawlSettings, agentRepositoryScans, agentRepositoryObservations } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { assertRoleLease, type RoleLease } from "@/lib/jobs/role-leader";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { lockRepositoryAgentEvidence } from "@/lib/domain/evidence/agents/lock";
import { auditSettings, lockAuditDispatchItem } from "@/lib/crawl/product-audit";
import { auditReviewer } from "@/lib/crawl/product-audit-reviewer";
import { isAssistCapacityInput, type LocalModelInput } from "./local-model-input";
import { localModelJob, type LocalModelTarget } from "./local-model-capacity-contract";
import { readItemStage } from "@/lib/jobs/items/repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { deepseekActor } from "@/lib/crawl/deepseek-review-policy";
import { heldQwenActor, heldQwenOwns } from "@/lib/crawl/held-qwen-retry-policy";
import { QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";

/** 관리자 재판정 loader는 발행 후보를 거절한다. direct 감사에는 발행 원본도 잠가야 한다. */
async function lockDirectInput(tx: ProductTransaction, repo: string) {
  const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo)).for("update");
  const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo)).for("share");
  const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
  if (!candidate || !document || candidate.productUrl !== document.productUrl || !saved) return null;
  const settings = mergeWithDefaults(saved.values);
  await lockRepositoryAgentEvidence(tx, repo.toLowerCase());
  const [scan] = await tx.select().from(agentRepositoryScans).where(and(eq(agentRepositoryScans.repositoryKey, repo.toLowerCase()),
    eq(agentRepositoryScans.scope, ""))).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1).for("share");
  if (scan) await tx.select({ id: agentRepositoryObservations.id }).from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).orderBy(asc(agentRepositoryObservations.id)).for("share");
  return { candidate, document, settings, scan, input: await loadReviewInput(candidate, document, settings, tx) };
}

/** 예약을 잠근 같은 TX에서 실제 행·원본·설정·lease를 다시 증명한다. 외부 boolean 검증기를 받지 않는다. */
export async function proveLocalModelDomain(tx: ProductTransaction, target: LocalModelTarget, input: LocalModelInput,
  job: JobLease, role: RoleLease, model: string, requestId?: string): Promise<boolean> {
  if (job.name !== localModelJob(target) || role.role !== "reviewer") return false;
  if (target.kind === "assist") {
    if (!isAssistCapacityInput(input) || !requestId) return false;
    const { proveAssistModelDomain } = await import("@/lib/domain/llm-assist/model-domain");
    return proveAssistModelDomain(tx, target, input, job, role, requestId);
  }
  if (isAssistCapacityInput(input)) return false;
  const stages = await lockPipelineInputStages(tx);
  if (target.kind === "candidate" || target.kind === "split") {
    const ai1 = await readItemStage(tx, stages.ai1), ai2 = await readItemStage(tx, stages.ai2);
    if (ai1.mode === "draining" || ai2.mode === "draining") return false;
  }
  const current = await lockDirectInput(tx, input.snapshot.product.repo);
  if (!current || !current.settings.enabled || current.input.validUntil <= new Date()
    || current.input.sourceRevisionHash !== input.sourceRevisionHash) return false;
  let expected = target.kind === "audit"
    ? await loadReviewInput(current.candidate, current.document, auditSettings(current.settings), tx) : current.input;
  let splitFirstAttemptId: number | null = null;
  if (target.kind === "split") {
    const { currentGate } = await import("@/lib/crawl/gate-split-tiebreak");
    const gate = await currentGate(tx, current, target);
    if (!("rows" in gate)) return false;
    expected = gate.input; splitFirstAttemptId = gate.first.id;
  }
  const supplied = structuredClone(input.snapshot);
  // 첫 화면은 이 호출이 새로 받은 외부 근거다. 그 외의 원본 필드는 잠긴 DB 사진과 같아야 한다.
  if (target.purpose === "screen") supplied.product.pageText = expected.snapshot.product.pageText;
  if (expected.inputHash !== input.inputHash || expected.policyHash !== input.policyHash
    || !isDeepStrictEqual(expected.snapshot, supplied)) return false;

  let valid = false;
  if (target.kind === "audit") {
    // 감사 결과 writer는 product → item 순서다. 그 순서를 뒤집어 행 잠금 교착을 만들지 않는다.
    const [product] = await tx.select().from(products).where(eq(products.slug, target.slug)).for("share");
    if (!product || !["seeded", "verified"].includes(product.status)) return false;
    const [item] = await tx.select().from(productAuditItems).where(eq(productAuditItems.id, target.itemId)).for("update");
    if (!item || item.productId !== product.id || item.slug !== target.slug || current.candidate.publishedSlug !== target.slug) return false;
    if (target.purpose === "audit") {
      const [campaign] = await tx.select().from(productAuditCampaigns).where(eq(productAuditCampaigns.id, item.campaignId));
      if (!campaign) return false;
      const reviewer = auditReviewer(campaign);
      valid = reviewer.provider === "qwen-direct" && reviewer.model === model
        && Boolean(await lockAuditDispatchItem(tx, { itemId: item.id, slug: target.slug, campaign: { ...campaign, ...reviewer } }));
    } else {
      valid = item.aiDecision === "reject" && item.humanDecision === null
        && (target.purpose === "screen" ? current.settings.qwenAuto.screenReview.enabled
          : current.settings.qwenAuto.auditSecondOpinion.enabled);
    }
  } else if (target.kind === "published") {
    const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, target.secondReviewId)).for("update");
    valid = Boolean(row && row.candidateId === current.candidate.id && row.status === "needs_human"
      && current.candidate.publishedSlug === target.slug && current.settings.qwenAuto.publishedFilter.enabled);
  } else if (target.kind === "candidate") {
    if (current.candidate.state !== "needs_review" || current.candidate.decidedBy !== "auto" || current.candidate.publishedSlug) return false;
    const pending = await tx.select({ id: secondReviews.id }).from(secondReviews)
      .where(and(eq(secondReviews.candidateId, current.candidate.id), eq(secondReviews.status, "pending"))).for("share");
    if (pending.length) return false;
    const [row] = await tx.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, target.attemptId)).for("update");
    valid = Boolean(row && row.candidateId === current.candidate.id && row.candidateId === target.candidateId && current.candidate.repo === target.repo
      && row.state === "running" && row.kind === "delegated" && row.leaseToken === job.token
      && row.inputHash === input.inputHash && row.sourceRevisionHash === input.sourceRevisionHash
      && row.policyHash === input.policyHash && row.promptVersion === REVIEW_PROMPT_VERSION && row.rulesVersion === REVIEW_RULES_VERSION
      && row.model === model && (target.purpose === "human_deepseek"
        ? row.provider === "m3-deepseek" && current.settings.humanReview.enabled
          && row.actor === deepseekActor(current.settings.humanReview.generation) && !heldQwenOwns(current.settings, current.candidate.reason)
        : row.provider === "qwen-direct" && heldQwenOwns(current.settings, current.candidate.reason)
          && row.actor === heldQwenActor(QWEN_V2_PROMPT_VERSION)));
  } else {
    if (current.candidate.state === "published" || current.candidate.publishedSlug) return false;
    const [row] = await tx.select().from(gateSplitTiebreaks).where(eq(gateSplitTiebreaks.id, target.tiebreakId)).for("update");
    valid = Boolean(row && row.candidateId === current.candidate.id && row.candidateId === target.candidateId
      && row.repo === target.repo && row.generationKey === target.generationKey
      && row.firstAttemptId === splitFirstAttemptId && row.promptVersion === QWEN_V2_PROMPT_VERSION
      && row.inputHash === input.inputHash && row.sourceRevisionHash === input.sourceRevisionHash
      && current.settings.qwenAuto.splitTiebreak.enabled
      && (target.purpose === "deepseek_confirm" ? current.settings.reviewMode === "enforce" && row.state === "succeeded"
        && row.applied === "awaiting_deepseek" && row.decision === "reject" && row.deepseekState === "running" && row.deepseekLeaseToken === job.token
        && row.deepseekModel === model : row.state === "running" && row.leaseToken === job.token && row.model === model));
  }
  if (!valid) return false;
  await assertJobLeaseAtWallTime(tx, job, "update");
  await assertRoleLease(tx, role);
  return true;
}
