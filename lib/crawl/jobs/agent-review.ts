import { emitPipelineEvent, measureReviewCall } from "@/lib/observability/review-pipeline";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { findRepositoryProduct } from "@/lib/domain/products/repository";
import { accessFromDocument } from "../rules";
import { loadReviewDocument } from "./review-document";
import { getSettings } from "@/lib/crawl/settings";
import { judgeStoredDocument } from "@/lib/crawl/rules";
import { isReviewCandidate, REVIEW_RULES_VERSION, type ReviewOutcome } from "@/lib/crawl/agent-review-contract";
import { listReviewCandidates, loadReviewInput, claimAgentReview, recordAgentReview,
  requeueStaleReviewSources } from "@/lib/crawl/agent-review-repository";
import { firstReviewer, reviewWithAgent, REVIEW_CLI_TIMEOUT_MS } from "@/lib/crawl/agent-review";
import { reviewWithGateway, REVIEW_GATEWAY_TIMEOUT_MS } from "@/lib/crawl/agent-review-gateway";

const MAX_CONCURRENT_REVIEWS = 16;
const TICK_MS = 40_000;
const MAX_STARTS = 16;
const FIRST_GATEWAY_MS = 24_000;

/** Refill bounded slots without changing the full input, reviewers or admission rules. */
export async function reviewCrawlCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const settings = await getSettings();
  if (!settings.enabled || settings.reviewMode === "off") {
    ctx.log("crawl.agent_review_skipped", { reason: !settings.enabled ? "disabled" : "review_off" });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("AI review requires a valid worker job lease");
  const reviewer = firstReviewer(settings);
  if (!reviewer) throw new Error("1차 심사자를 설정하거나 CRAWL_REVIEW_MODEL 을 넣어야 AI 심사를 켤 수 있습니다");
  const { provider: reviewProvider, model } = reviewer;
  const concurrency = Math.min(settings.reviewConcurrency || 2, MAX_CONCURRENT_REVIEWS);
  const requeued = await requeueStaleReviewSources(settings, lease, 20);
  if (requeued) ctx.log("crawl.agent_review_sources_queued", { count: requeued });
  const candidates = await listReviewCandidates(settings, Math.max(20, concurrency * 2));
  if (!candidates.length) return { done: true };
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  const ceiling = reviewProvider === "abcllm" ? Math.min(FIRST_GATEWAY_MS, REVIEW_GATEWAY_TIMEOUT_MS) : REVIEW_CLI_TIMEOUT_MS;
  const visited = new Set<number>();
  const controllers = new Set<AbortController>();
  let next = 0, admitted = 0, progress = 0, stopped = false;
  const canStart = () => !stopped && !ctx.signal?.aborted && ctx.hasBudget() && remaining() >= ceiling + 2_000;
  const processCandidate = async (candidate: typeof candidates[number]) => {
    if (!isReviewCandidate(candidate)) return;
    const document = await loadReviewDocument(candidate.repo, lease);
    if (!document) return;
    const input = await loadReviewInput(candidate, document, settings);
    if (input.validUntil.getTime() <= Date.now()) return;
    // 판정 잡과 같은 추출기로 규칙을 태운다. 여기서 PageFacts를 손으로 조립했을 때 본문이 빠져
    // "설치 유도 아님"을 지나쳤고, 재수집으로 본문에 npm install이 생긴 needs_review 후보를 모델이
    // 메타데이터만 보고 승인했다(codex 재현). 규칙이 거부하는 것은 모델에게 보내지 않는다.
    const verdict = judgeStoredDocument(document, settings, new Date(), settings.agentEvidence.enforceEligibility ? {
        relationship: input.snapshot.relationship, scanState: input.snapshot.scanState,
        observations: input.snapshot.evidence.map(evidence => evidence.observation),
      } : undefined);
    const access = accessFromDocument(document, settings);
    const existing = access && verdict.state !== "rejected"
      ? await findRepositoryProduct(document.repo, document.productUrl) : null;
    const hardReason = verdict.state === "rejected" ? verdict.reason
      : existing ? existing.status === "banned" ? "banned" : "already_listed" : null;
    // Missing development evidence is a hold, never proof the product is ineligible.
    // Enforce this before a model call: real-source review showed the model conflating the two.
    const evidenceHold = !hardReason && settings.agentEvidence.enforceEligibility
      && !input.snapshot.evidenceSummary.eligible ? input.snapshot.evidenceSummary.reason : null;
    const provider = hardReason || evidenceHold ? "rules" : reviewProvider;
    if (!canStart()) return;
    const context = { candidate, document, settings, input, lease };
    const claim = await claimAgentReview({ ...context, provider, model: provider === "rules" ? REVIEW_RULES_VERSION : model });
    if (claim.kind === "skipped") {
      ctx.log("crawl.agent_review_skipped", { repo: candidate.repo, reason: claim.reason });
      return;
    }
    if (!canStart()) {
      if (claim.kind === "claimed") await recordAgentReview({ ...context, attempt: claim.attempt,
        error: "cancelled", retryAfter: new Date(Date.now() + 60_000) });
      return;
    }
    const telemetry = { stage: "first" as const, candidateId: candidate.id, firstAttemptId: claim.attempt.id,
      sourceRevisionHash: input.sourceRevisionHash, provider, model, job: lease.name, runId: String(lease.requestedVersion) };
    if (claim.kind === "reused") emitPipelineEvent("reused", telemetry, ctx.log);
    if (claim.kind === "claimed") emitPipelineEvent("queue", { ...telemetry, waitMs: Date.now() - (candidate.updatedAt ?? candidate.judgedAt).getTime() }, ctx.log);
    if (hardReason || evidenceHold || claim.kind === "reused") {
      const outcome: ReviewOutcome | undefined = hardReason ? {
        decision: "reject", reason: `기존 등재 규칙에 해당합니다: ${hardReason}`, evidenceIds: ["product"],
      } : evidenceHold ? {
        decision: "needs_review", reason: `개발 근거 확인이 필요합니다 (${evidenceHold}). 현재 수집 내용만으로 승인하거나 부적격으로 확정하지 않습니다.`,
        evidenceIds: ["product", ...input.snapshot.evidence.slice(0, 8).map(item => item.id)],
      } : claim.attempt.outcome ?? undefined;
      const recorded = await recordAgentReview({ ...context, attempt: claim.attempt, outcome,
        ruleRejection: hardReason ? { reason: hardReason, ...(existing ? { existingSlug: existing.slug, existingStatus: existing.status } : {}) } : undefined });
      if (recorded.state === "succeeded") progress++;
      if (recorded.state !== "superseded") emitPipelineEvent("committed", { ...telemetry, state: recorded.state }, ctx.log);
      ctx.log("crawl.agent_reviewed", { repo: candidate.repo, provider, reused: claim.kind === "reused", ...recorded });
      return;
    }

    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    ctx.signal?.addEventListener("abort", abort, { once: true });
    const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
    ownershipPoll.unref?.();
    try {
      // Claim may have waited on a lock. Cancel and record it instead of leaving a running row.
      if (!canStart()) controller.abort();
      const options = { model, timeoutMs: ceiling, signal: controller.signal };
      let result = await measureReviewCall(telemetry, () => (reviewProvider === "abcllm"
        ? reviewWithGateway(input, options)
        : reviewWithAgent(input, options)), ctx.log);
      if (controller.signal.aborted) result = { ok: false, error: "cancelled" };
      if (!result.ok) stopped = true;
      const recorded = await recordAgentReview({
        ...context, attempt: claim.attempt,
        ...(result.ok ? { outcome: result.outcome, usage: result.usage } : {
          error: result.error, usage: result.usage,
          retryAfter: new Date(Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, claim.attempt.attemptNumber - 1))),
        }),
      });
      if (recorded.state === "succeeded") progress++;
      if (recorded.state !== "superseded") emitPipelineEvent("committed", { ...telemetry, state: recorded.state }, ctx.log);
      ctx.log("crawl.agent_reviewed", {
        repo: candidate.repo, provider, mode: settings.reviewMode, ...recorded,
        ...(result.ok ? { decision: result.outcome.decision } : { error: result.error }),
      });
    } finally {
      clearInterval(ownershipPoll);
      ctx.signal?.removeEventListener("abort", abort);
      controllers.delete(controller);
    }
  };
  const lanes = Array.from({ length: concurrency }, async () => {
    try {
      while (next < candidates.length && admitted < MAX_STARTS && canStart()) {
        const candidate = candidates[next++];
        if (visited.has(candidate.id)) continue;
        visited.add(candidate.id);
        admitted++;
        await processCandidate(candidate);
      }
    } catch (error) {
      stopped = true;
      for (const controller of controllers) controller.abort();
      throw error;
    }
  });
  const settled = await Promise.allSettled(lanes);
  const failure = settled.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  if (progress && !stopped && !ctx.signal?.aborted && ctx.hasBudget()) {
    const ready = await listReviewCandidates(settings, 1, { excludeCandidateIds: [...visited], readyOnly: true });
    if (ready.some(candidate => !visited.has(candidate.id))) return { done: false, continuation: "ready" };
  }
  return { done: false };
}
