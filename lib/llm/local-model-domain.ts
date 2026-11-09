import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq } from "drizzle-orm";
import { productAuditCampaigns, productAuditItems, products, secondReviews, crawlReviewAttempts, gateSplitTiebreaks,
  crawlCandidates, crawlDocuments, crawlSettings, agentRepositoryScans, agentRepositoryObservations, aiConnections, aiTaskModels } from "@/lib/db/schema";
import { isManualCampaign, ROLLING_AUDIT_STATUS } from "@/lib/crawl/audit-stream";
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
import { freshLocalModelScreenProof, localModelJob, type LocalModelScreenProof, type LocalModelTarget } from "./local-model-capacity-contract";
import { readItemStage } from "@/lib/jobs/items/repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewEvidenceAge } from "@/lib/crawl/agent-review-contract";
import { deepseekActor } from "@/lib/crawl/deepseek-review-policy";
import { heldQwenActor, heldQwenOwns } from "@/lib/crawl/held-qwen-retry-policy";
import { QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import type { LocalModelDomainCheck, LocalModelDomainRefusal } from "./local-model-domain-refusal";

/** 관리자 재판정 loader는 발행 후보를 거절한다. direct 감사에는 발행 원본도 잠가야 한다. */
async function lockDirectInput(tx: ProductTransaction, repo: string, evidenceAge: ReviewEvidenceAge = "window") {
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
  return { candidate, document, settings, scan, input: await loadReviewInput(candidate, document, settings, tx, evidenceAge) };
}

/** 그 감사 항목이 공개분 변경 재판정 줄(status 'rolling')의 것인가 — 잠그지 않는 읽기(줄 행은 끝나지 않는다. 아래 감사 갈래가 잠근 행으로 다시 본다) */
async function onRecheckStream(tx: ProductTransaction, itemId: number): Promise<boolean> {
  const [row] = await tx.select({ status: productAuditCampaigns.status }).from(productAuditItems)
    .innerJoin(productAuditCampaigns, eq(productAuditCampaigns.id, productAuditItems.campaignId)).where(eq(productAuditItems.id, itemId));
  return row?.status === ROLLING_AUDIT_STATUS;
}

/**
 * 이 모델이 지금 「발행분 감사 · 변경 재판정」(작업 product-audit, 칸 1)의 켜진 API 순위인가 — 켜진 API 연결의 켜진 순위. 잠그지 않는 읽기다
 * (순위 저장 TX 는 model_capacity_control 을 먼저 잠그므로 이 dispatch TX 와 잠금 차례가 엇갈리지 않게 행을 잠그지 않는다)
 */
async function recheckDirectRankHolds(tx: ProductTransaction, model: string): Promise<boolean> {
  const [row] = await tx.select({ rank: aiTaskModels.rank }).from(aiTaskModels).innerJoin(aiConnections, eq(aiConnections.id, aiTaskModels.connectionId))
    .where(and(eq(aiTaskModels.task, "product-audit"), eq(aiTaskModels.slot, 1), eq(aiTaskModels.enabled, true), eq(aiTaskModels.model, model),
      eq(aiConnections.enabled, true), eq(aiConnections.kind, "api"))).limit(1);
  return Boolean(row);
}

/** 예약을 잠근 같은 TX에서 실제 행·원본·설정·lease를 다시 증명한다. 외부 boolean 검증기를 받지 않는다. */
export async function proveLocalModelDomain(tx: ProductTransaction, target: LocalModelTarget, input: LocalModelInput,
  job: JobLease, role: RoleLease, model: string, requestId?: string, screenProof?: LocalModelScreenProof): Promise<boolean> {
  return await localModelDomainRefusal(tx, target, input, job, role, model, requestId, screenProof) === null;
}

/** proveLocalModelDomain 과 같은 증명 — 통과면 null, 거절이면 처음 걸린 검사(검사 차례와 잠금 차례는 예전 그대로다) */
export async function localModelDomainRefusal(tx: ProductTransaction, target: LocalModelTarget, input: LocalModelInput,
  job: JobLease, role: RoleLease, model: string, requestId?: string, screenProof?: LocalModelScreenProof): Promise<LocalModelDomainRefusal | null> {
  const refuse = (check: LocalModelDomainCheck, validUntil?: Date): LocalModelDomainRefusal =>
    validUntil ? { check, validUntil: validUntil.toISOString() } : { check };
  if (job.name !== localModelJob(target) || role.role !== "reviewer") return refuse("job_mismatch");
  if (target.kind === "assist") {
    if (!isAssistCapacityInput(input) || !requestId) return refuse("assist_input_mismatch");
    if (target.purpose === "intro_correction") {
      if (input.kind !== "llm_assist_correction" || target.task !== "intro_recheck") return refuse("assist_input_mismatch");
      const { proveIntroCorrectionDomain } = await import("@/lib/domain/products/intro-assist-runtime");
      return await proveIntroCorrectionDomain(tx, { ...target, task: "intro_recheck" }, input, job, role) ? null : refuse("assist_domain");
    }
    if (input.kind !== "llm_assist") return refuse("assist_input_mismatch");
    const { proveAssistModelDomain } = await import("@/lib/domain/llm-assist/model-domain");
    return await proveAssistModelDomain(tx, target, input, job, role, requestId, model) ? null : refuse("assist_domain");
  }
  if (isAssistCapacityInput(input)) return refuse("assist_input_mismatch");
  const stages = await lockPipelineInputStages(tx);
  if (target.kind === "candidate" || target.kind === "split") {
    const ai1 = await readItemStage(tx, stages.ai1), ai2 = await readItemStage(tx, stages.ai2);
    if (ai1.mode === "draining" || ai2.mode === "draining") return refuse("pipeline_draining");
  }
  // 사람 큐 후보를 맡는 두 잡 — 사람 몫 위임 검수(human_deepseek)와 보류 Qwen-v2 재심사(held_qwen) — 만 근거 나이를 자르지 않는다
  // (2026-11-09 운영자 결정, ReviewEvidenceAge any_age). 원본·입력 해시·스냅숏·후보 상태·시도 행·lease 대조는 아래에서 그대로 한다 —
  // 빠지는 것은 24시간 기한 거절 하나다. 감사·공개분·갈림 판가름은 그대로 input_expired 로 거절한다
  const anyAge = target.kind === "candidate";
  // 공개분 변경 재판정 줄(0171)의 감사 항목 — 「발행분 감사 · 변경 재판정」의 API 순위가 묻는다(2026-11-09). 그 줄의 CLI 순위(lockAuditDispatchItem)처럼
  // 근거 나이(24시간 기한)로 거절하지 않는다 — 공개 제품의 원본·스캔은 대개 하루가 지났고(생존 확인은 fetched_at 을 바꾸지 않는다), 원본·입력 해시·스냅숏 대조는
  // 아래에서 그대로 한다. 줄 행은 끝나지 않으므로 여기서는 잠그지 않고 읽고, 아래 감사 갈래가 잠근 항목·감사 행으로 다시 본다
  const rolling = target.kind === "audit" && target.purpose === "audit" && await onRecheckStream(tx, target.itemId);
  const current = await lockDirectInput(tx, input.snapshot.product.repo, anyAge ? "any_age" : "window");
  const now = new Date(), screen = target.kind === "audit" && target.purpose === "screen";
  if (!current) return refuse("source_missing");
  if (!current.settings.enabled) return refuse("crawl_disabled");
  // A screen review judges a just-rendered page. Its archived crawl baseline still must match exactly,
  // but the candidate review's 24h baseline expiry cannot veto that fresh screenshot.
  if (screen) {
    if (!freshLocalModelScreenProof(screenProof, input.snapshot.product.url, now.getTime())) return refuse("screen_proof_stale");
    if (current.document.fetchedAt > now || Boolean(current.scan?.completedAt && current.scan.completedAt > now)) return refuse("screen_source_future");
  } else if (!anyAge && !rolling && current.input.validUntil <= now) return refuse("input_expired", current.input.validUntil);
  if (current.input.sourceRevisionHash !== input.sourceRevisionHash) return refuse("source_changed");
  let expected = target.kind === "audit"
    ? await loadReviewInput(current.candidate, current.document, auditSettings(current.settings), tx) : current.input;
  let splitFirstAttemptId: number | null = null;
  if (target.kind === "split") {
    const { currentGate } = await import("@/lib/crawl/gate-split-tiebreak");
    const gate = await currentGate(tx, current, target);
    if (!("rows" in gate)) return refuse("split_gate_closed");
    expected = gate.input; splitFirstAttemptId = gate.first.id;
  }
  const supplied = structuredClone(input.snapshot);
  // 첫 화면은 이 호출이 새로 받은 외부 근거다. 그 외의 원본 필드는 잠긴 DB 사진과 같아야 한다.
  if (target.purpose === "screen") supplied.product.pageText = expected.snapshot.product.pageText;
  if (expected.inputHash !== input.inputHash || expected.policyHash !== input.policyHash
    || !isDeepStrictEqual(expected.snapshot, supplied)) return refuse("input_changed");

  let valid = false;
  if (target.kind === "audit") {
    // 감사 결과 writer는 product → item 순서다. 그 순서를 뒤집어 행 잠금 교착을 만들지 않는다.
    const [product] = await tx.select().from(products).where(eq(products.slug, target.slug)).for("share");
    if (!product || !["seeded", "verified"].includes(product.status)) return refuse("product_unavailable");
    if (screen && !freshLocalModelScreenProof(screenProof, product.url)) return refuse("screen_proof_stale");
    const [item] = await tx.select().from(productAuditItems).where(eq(productAuditItems.id, target.itemId)).for("update");
    if (!item || item.productId !== product.id || item.slug !== target.slug || current.candidate.publishedSlug !== target.slug)
      return refuse("item_mismatch");
    if (target.purpose === "audit") {
      const [campaign] = await tx.select().from(productAuditCampaigns).where(eq(productAuditCampaigns.id, item.campaignId));
      if (!campaign) return refuse("campaign_missing");
      if (!isManualCampaign(campaign)) {
        // 재판정 줄: 감사 행에 굳힌 심사자가 없다 — 이 모델이 지금 「발행분 감사 · 변경 재판정」의 켜진 API 순위여야 하고, 항목은 지금 코드의 글 판으로 물을 수 있어야 한다
        valid = rolling && campaign.status === ROLLING_AUDIT_STATUS && await recheckDirectRankHolds(tx, model)
          && Boolean(await lockAuditDispatchItem(tx, { itemId: item.id, slug: target.slug, campaign: { id: campaign.id, provider: "local-direct", model,
            promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION } }));
      } else {
        const reviewer = auditReviewer(campaign);
        valid = reviewer.provider === "qwen-direct" && reviewer.model === model
          && Boolean(await lockAuditDispatchItem(tx, { itemId: item.id, slug: target.slug, campaign: { ...campaign, ...reviewer } }));
      }
    } else {
      if (!(target.purpose === "screen" ? current.settings.qwenAuto.screenReview.enabled
        : current.settings.qwenAuto.auditSecondOpinion.enabled)) return refuse("step_disabled");
      valid = item.aiDecision === "reject" && item.humanDecision === null;
    }
  } else if (target.kind === "published") {
    const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, target.secondReviewId)).for("update");
    if (!current.settings.qwenAuto.publishedFilter.enabled) return refuse("step_disabled");
    valid = Boolean(row && row.candidateId === current.candidate.id && row.status === "needs_human"
      && current.candidate.publishedSlug === target.slug);
  } else if (target.kind === "candidate") {
    if (current.candidate.state !== "needs_review" || current.candidate.decidedBy !== "auto" || current.candidate.publishedSlug)
      return refuse("target_not_open");
    const pending = await tx.select({ id: secondReviews.id }).from(secondReviews)
      .where(and(eq(secondReviews.candidateId, current.candidate.id), eq(secondReviews.status, "pending"))).for("share");
    if (pending.length) return refuse("target_not_open");
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
    if (current.candidate.state === "published" || current.candidate.publishedSlug) return refuse("target_not_open");
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
  if (!valid) return refuse("target_not_open");
  await assertJobLeaseAtWallTime(tx, job, "update");
  await assertRoleLease(tx, role);
  // Row/job/role locks may have waited since admission. Never dispatch an aged render.
  return !screen || freshLocalModelScreenProof(screenProof, input.snapshot.product.url) ? null : refuse("screen_proof_stale");
}
