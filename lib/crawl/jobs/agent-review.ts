import { emitPipelineEvent, measureReviewCall } from "@/lib/observability/review-pipeline";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { loadReviewDocument } from "./review-document";
import { getSettings } from "@/lib/crawl/settings";
import { isReviewCandidate, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { listReviewCandidates, loadReviewInput, claimAgentReview, recordAgentReview,
  requeueStaleReviewSources, handOffExhaustedFirstReviews, canStartLegacyAgentReview, type ModelCapacityReviewClaim,
  type CliModelCapacityReviewClaim } from "@/lib/crawl/agent-review-repository";
import { holdSuspectedSpam } from "@/lib/crawl/repository";
import { firstReviewer, reviewWithAgent, REVIEW_CLI_TIMEOUT_MS } from "@/lib/crawl/agent-review";
import { reviewWithGateway, REVIEW_GATEWAY_TIMEOUT_MS, type PreparedAi1GatewayCall } from "@/lib/crawl/agent-review-gateway";
import { reviewWithGrokCli, GROK_REVIEW_TIMEOUT_MS } from "@/lib/crawl/agent-review-grok";
import { reviewSemanticNow } from "../review-replay-context";
import { prepareAgentReview } from "../agent-review-preparation";
import { assertReviewFixtureSettings, dispatchReviewFixtureCall } from "../review-fixture-transport";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { claimAgentReviewModelCapacity, reviewAgentReviewModelCapacity, abandonAgentReviewModelCapacity } from "../agent-review-model-capacity";
import type { Ai1ModelDispatch, CliModelDispatch } from "@/lib/llm/capacity";
import type { PreparedReviewCliCall } from "../review-cli-call";

const MAX_CONCURRENT_REVIEWS = 16;
const TICK_MS = 40_000;
const GROK_TICK_MS = 108_000;
const MAX_STARTS = 16;
const FIRST_GATEWAY_MS = 24_000;

/** Refill bounded slots without changing the full input, reviewers or admission rules. */
export async function reviewCrawlCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const settings = await getSettings();
  assertReviewFixtureSettings(settings);
  if (!settings.enabled || settings.reviewMode === "off") {
    ctx.log("crawl.agent_review_skipped", { reason: !settings.enabled ? "disabled" : "review_off" });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("AI review requires a valid worker job lease");
  const requeued = await requeueStaleReviewSources(settings, lease, 20);
  if (requeued) ctx.log("crawl.agent_review_sources_queued", { count: requeued });
  const handedOff = await handOffExhaustedFirstReviews(settings, lease, 20);
  if (handedOff) ctx.log("crawl.agent_review_exhausted_handed_off", { count: handedOff });
  if (!await canStartLegacyAgentReview(lease)) {
    ctx.log("crawl.agent_review_skipped", { reason: "stage_inactive" });
    return { done: false, deferred: "stage_blocked" };
  }
  const reviewer = firstReviewer(settings);
  if (!reviewer) throw new Error("1차 심사자를 설정하거나 CRAWL_REVIEW_MODEL 을 넣어야 AI 심사를 켤 수 있습니다");
  const { provider: reviewProvider, model } = reviewer;
  const concurrency = Math.min(settings.reviewConcurrency || 2, MAX_CONCURRENT_REVIEWS);
  const candidates = await listReviewCandidates(settings, Math.max(20, concurrency * 2));
  if (!candidates.length) return { done: true };
  const tickMs = reviewProvider === "grok-cli" ? GROK_TICK_MS : TICK_MS;
  const remaining = () => tickMs - (Date.now() - startedAt);
  const ceiling = reviewProvider === "abcllm" ? Math.min(FIRST_GATEWAY_MS, REVIEW_GATEWAY_TIMEOUT_MS)
    : reviewProvider === "grok-cli" ? GROK_REVIEW_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;
  const visited = new Set<number>();
  const controllers = new Set<AbortController>();
  let next = 0, admitted = 0, progress = 0, stopped = false, stageBlocked = false, modelDeferred = false;
  const canStart = () => !stopped && !stageBlocked && !ctx.signal?.aborted && ctx.hasBudget() && remaining() >= ceiling + 2_000;
  const canAdmit = () => !modelDeferred && canStart();
  const processCandidate = async (candidate: typeof candidates[number]) => {
    if (!isReviewCandidate(candidate)) return;
    if (!await canStartLegacyAgentReview(lease, candidate.id)) {
      // Candidate-level refusal can mean a healthy foreign item. Only an actual
      // global stage refusal defers this request; this read is not dispatch fencing.
      if (!await canStartLegacyAgentReview(lease)) stageBlocked = true;
      return;
    }
    const document = await loadReviewDocument(candidate.repo, lease);
    if (!document) return;
    const input = await loadReviewInput(candidate, document, settings);
    if (input.validUntil <= reviewSemanticNow()) return;
    const preparation = await prepareAgentReview({ candidate, document, settings, input }, reviewer);
    const { verdict, hardReason, evidenceHold, provider } = preparation;
    // README 를 받고 나서 드러난 스팸·악성 의심은 모델에게 보내지 않고 사람에게 넘긴다
    if (preparation.spam) {
      const held = await holdSuspectedSpam(candidate, verdict, lease);
      ctx.log("crawl.agent_review_suspected_spam", { repo: candidate.repo, held });
      return;
    }
    if (!canAdmit()) return;
    const context = { candidate, document, settings, input };
    let claim: ModelCapacityReviewClaim | CliModelCapacityReviewClaim;
    let prepared: PreparedAi1GatewayCall | undefined;
    // CLI 심사자(05c-4)는 같은 되감은 claim 에서 CLI coordinator 로 간다. gateway·disabled 경로는 그대로다.
    let cli: { capacity: typeof import("../review-cli-model-capacity"); call: PreparedReviewCliCall } | undefined;
    try {
      try {
        claim = await claimAgentReview({ ...context, lease, provider, model: provider === "rules" ? REVIEW_RULES_VERSION : model });
      } catch (error) {
        if (!(error instanceof ModelCapacityDeferredError) || error.reason !== "reservation_required") throw error;
        if (provider === "claude-cli" || provider === "grok-cli") {
          const capacity = await import("../review-cli-model-capacity");
          const resumed = await capacity.claimAgentReviewCliModelCapacity({ ...context, lease, provider, model, timeoutMs: ceiling, signal: ctx.signal });
          claim = resumed.claim; cli = { capacity, call: resumed.call };
        } else {
          const resumed = await claimAgentReviewModelCapacity({ ...context, lease, provider, model, signal: ctx.signal });
          claim = resumed.claim; prepared = resumed.call;
        }
      }
    } catch (error) {
      if (!(error instanceof ModelCapacityDeferredError)) throw error;
      // 이 후보의 앞선 호출이 아직 dispatched/indeterminate 다 — 이 후보만 건너뛴다. 틱 전체를 미루면 목록 맨 앞에 남은 한 건이
      // 매 틱 다른 후보까지 막는다. claim TX 는 되감겼고 호출·시도·실패 기록은 없다.
      if (error.reason === "dispatched") {
        ctx.log("crawl.agent_review_skipped", { repo: candidate.repo, reason: "dispatched" });
        return;
      }
      // The claim TX has rolled back. Stop new claims without cancelling any
      // already admitted lane; all real work settles before returning deferred.
      modelDeferred = true;
      ctx.log("crawl.agent_review_deferred", { reason: error.reason });
      return;
    }
    if (claim.kind === "skipped") {
      if (claim.reason === "stage_inactive") stageBlocked = true;
      ctx.log("crawl.agent_review_skipped", { repo: candidate.repo, reason: claim.reason });
      return;
    }
    if (!canStart()) {
      // CLI 는 spawn 하지 않은, gateway 는 fetch 를 부르지 않은 dispatch 를 not_started 로 정산한다(D5) — 결과 기록은 기존 cancelled+60s 그대로다
      if (claim.dispatch && cli) await cli.capacity.abandonCliModelCapacity(claim.dispatch as CliModelDispatch, cli.call);
      else if (claim.dispatch) await abandonAgentReviewModelCapacity(claim.dispatch as Ai1ModelDispatch, prepared);
      await recordAgentReview({ ...context, receipt: claim.receipt,
        error: "cancelled", retryAfter: new Date(Date.now() + 60_000) });
      return;
    }
    const telemetry = { stage: "first" as const, candidateId: candidate.id, firstAttemptId: claim.attempt.id,
      sourceRevisionHash: input.sourceRevisionHash, provider, model, job: lease.name, runId: String(lease.requestedVersion) };
    if (claim.kind === "reused") emitPipelineEvent("reused", telemetry, ctx.log);
    if (claim.kind === "claimed") emitPipelineEvent("queue", { ...telemetry, waitMs: Date.now() - (candidate.updatedAt ?? candidate.judgedAt).getTime() }, ctx.log);
    if (hardReason || evidenceHold || claim.kind === "reused") {
      const outcome = preparation.outcome ?? claim.attempt.outcome ?? undefined;
      const recorded = await recordAgentReview({ ...context, receipt: claim.receipt, outcome,
        ruleRejection: preparation.ruleRejection });
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
      const dispatch = claim.dispatch;
      const call = prepared;
      let result = await measureReviewCall(telemetry, async () => {
        // CLI 제한 시간은 준비한 호출에 묶여 spawn 부터 센다. 틱 여유는 바로 위 canStart 가 spawn 직전에 다시 본다.
        if (dispatch && cli) return cli.capacity.reviewCliModelCapacity(input, dispatch as CliModelDispatch, cli.call, { signal: controller.signal });
        if (dispatch) {
          if (!call) throw new Error("ai1_model_prepared_call_missing");
          return reviewAgentReviewModelCapacity(input, dispatch as Ai1ModelDispatch, call, options);
        }
        return (await dispatchReviewFixtureCall({ stage: "first",
        candidateId: candidate.id, firstAttemptId: claim.attempt.id, provider: reviewProvider, model }, input, options)) ?? (reviewProvider === "abcllm"
        ? reviewWithGateway(input, options)
        : reviewProvider === "grok-cli" ? reviewWithGrokCli(input, options) : reviewWithAgent(input, options));
      }, ctx.log);
      if (controller.signal.aborted) result = { ok: false, error: "cancelled" };
      if (!result.ok) stopped = true;
      const recorded = await recordAgentReview({
        ...context, receipt: claim.receipt,
        ...(result.ok ? { outcome: result.outcome, usage: result.usage } : {
          error: result.error, detail: result.detail, usage: result.usage,
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
      while (next < candidates.length && admitted < MAX_STARTS && canAdmit()) {
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
  if (stageBlocked) return { done: false, deferred: "stage_blocked" };
  if (modelDeferred) return { done: false, deferred: "model_capacity" };
  if (progress && !stopped && !ctx.signal?.aborted && ctx.hasBudget()) {
    const ready = await listReviewCandidates(settings, 1, { excludeCandidateIds: [...visited], readyOnly: true });
    if (ready.some(candidate => !visited.has(candidate.id))) return { done: false, continuation: "ready" };
  }
  return { done: false };
}
