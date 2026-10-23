import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { productAuditCampaigns, productAuditItems, products, secondReviews, crawlReviewAttempts, gateSplitTiebreaks } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { assertRoleLease, type RoleLease } from "@/lib/jobs/role-leader";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { lockedInput } from "@/lib/crawl/admin-review";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { auditSettings, lockAuditDispatchItem } from "@/lib/crawl/product-audit";
import { auditReviewer } from "@/lib/crawl/product-audit-reviewer";
import type { ReviewInput } from "@/lib/crawl/agent-review-contract";
import { localModelJob, type LocalModelTarget } from "./local-model-capacity-contract";

/** 예약을 잠근 같은 TX에서 실제 행·원본·설정·lease를 다시 증명한다. 외부 boolean 검증기를 받지 않는다. */
export async function proveLocalModelDomain(tx: ProductTransaction, target: LocalModelTarget, input: ReviewInput,
  job: JobLease, role: RoleLease, model: string): Promise<boolean> {
  if (job.name !== localModelJob(target) || role.role !== "reviewer") return false;
  await lockPipelineInputStages(tx);
  const current = await lockedInput(tx, input.snapshot.product.repo);
  if (!current || !current.settings.enabled || current.input.validUntil <= new Date()
    || current.input.sourceRevisionHash !== input.sourceRevisionHash) return false;
  const expected = target.kind === "audit"
    ? await loadReviewInput(current.candidate, current.document, auditSettings(current.settings), tx) : current.input;
  const supplied = structuredClone(input.snapshot);
  // 첫 화면은 이 호출이 새로 받은 외부 근거다. 그 외의 원본 필드는 잠긴 DB 사진과 같아야 한다.
  if (target.purpose === "screen") supplied.product.pageText = expected.snapshot.product.pageText;
  if (expected.inputHash !== input.inputHash || expected.policyHash !== input.policyHash
    || !isDeepStrictEqual(expected.snapshot, supplied)) return false;

  let valid = false;
  if (target.kind === "audit") {
    const [item] = await tx.select().from(productAuditItems).where(eq(productAuditItems.id, target.itemId)).for("update");
    if (!item || item.slug !== target.slug || current.candidate.publishedSlug !== target.slug) return false;
    const [product] = await tx.select().from(products).where(and(eq(products.id, item.productId), eq(products.slug, target.slug))).for("share");
    if (!product || !["seeded", "verified"].includes(product.status)) return false;
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
    const [row] = await tx.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, target.attemptId)).for("update");
    valid = Boolean(row && row.candidateId === current.candidate.id && row.candidateId === target.candidateId && current.candidate.repo === target.repo
      && row.state === "running" && row.kind === "delegated" && row.leaseToken === job.token
      && row.inputHash === input.inputHash && row.sourceRevisionHash === input.sourceRevisionHash
      && row.model === model && (target.purpose === "human_deepseek"
        ? row.provider === "m3-deepseek" && current.settings.humanReview.enabled
        : row.provider === "qwen-direct" && current.settings.qwenAuto.heldRetry.enabled));
  } else {
    const [row] = await tx.select().from(gateSplitTiebreaks).where(eq(gateSplitTiebreaks.id, target.tiebreakId)).for("update");
    valid = Boolean(row && row.candidateId === current.candidate.id && row.candidateId === target.candidateId
      && row.repo === target.repo && row.generationKey === target.generationKey
      && row.inputHash === input.inputHash && row.sourceRevisionHash === input.sourceRevisionHash
      && current.settings.qwenAuto.splitTiebreak.enabled
      && (target.purpose === "deepseek_confirm" ? row.deepseekState === "running" && row.deepseekLeaseToken === job.token
        && row.deepseekModel === model : row.state === "running" && row.leaseToken === job.token && row.model === model));
  }
  if (!valid) return false;
  await assertJobLeaseAtWallTime(tx, job, "update");
  await assertRoleLease(tx, role);
  return true;
}
