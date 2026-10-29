import { emitPipelineEvent, measureReviewCall } from "@/lib/observability/review-pipeline";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { loadReviewDocument } from "./review-document";
import { getSettings } from "@/lib/crawl/settings";
import { isReviewCandidate, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { listReviewCandidates, loadReviewInput, claimAgentReview, recordAgentReview,
  requeueStaleReviewSources, handOffExhaustedFirstReviews, canStartLegacyAgentReview, type ModelCapacityReviewClaim,
  type CliModelCapacityReviewClaim, chooseFirstReviewForCandidate, listFirstReviewPoolCandidates,
  listOwnPendingFirstReviewCandidates, type PendingFirstReviewCandidate } from "@/lib/crawl/agent-review-repository";
import { holdSuspectedSpam } from "@/lib/crawl/repository";
import { firstReviewer, reviewWithAgent, REVIEW_CLI_TIMEOUT_MS } from "@/lib/crawl/agent-review";
import { reviewWithGateway, REVIEW_GATEWAY_TIMEOUT_MS, type PreparedAi1GatewayCall } from "@/lib/crawl/agent-review-gateway";
import { reviewWithGrokCli, GROK_REVIEW_TIMEOUT_MS } from "@/lib/crawl/agent-review-grok";
import { reviewSemanticNow } from "../review-replay-context";
import { prepareAgentReview } from "../agent-review-preparation";
import { assertReviewFixtureSettings, dispatchReviewFixtureCall } from "../review-fixture-transport";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { claimAgentReviewModelCapacity, reviewAgentReviewModelCapacity, abandonAgentReviewModelCapacity,
  type Ai1ReservationWaitEvent } from "../agent-review-model-capacity";
import type { Ai1ModelDispatch, CliModelDispatch } from "@/lib/llm/capacity";
import type { PreparedReviewCliCall } from "../review-cli-call";
import { firstReviewers, firstReviewerKey, firstReviewDeferralIsLocal, firstReviewPoolPosition, type FirstReviewCursor } from "../first-reviewers";
import { readBlockedFirstReviewerKeys } from "../first-reviewer-blocks";
import { agentReviewBinding } from "../agent-review-ownership";
import { itemBindingHash } from "@/lib/jobs/items/types";

const MAX_CONCURRENT_REVIEWS = 16;
const TICK_MS = 40_000;
const GROK_TICK_MS = 108_000;
const MAX_STARTS = 16;
// A local timeout cannot prove that a remote model stopped. Give the gateway its
// full transport ceiling; the former 24s cap could strand the only physical slot
// on a valid, slower completion. The worker already grants this job 110s.
const GATEWAY_TICK_MS = 108_000;
// 예약을 받은 뒤 domain claim TX·전송 직전 확인에 남기는 여유. 대기가 이 여유를 먹으면 받은 예약을 cancelled 로 버리게 된다.
const RESERVATION_CLAIM_MARGIN_MS = 3_000;

/** Refill bounded slots without changing the full input, reviewers or admission rules. */
export async function reviewCrawlCandidates(ctx: JobContext<FirstReviewCursor>): Promise<JobOutcome<FirstReviewCursor>> {
  const startedAt = Date.now();
  const settings = await getSettings();
  assertReviewFixtureSettings(settings);
  const poolEnabled = settings.firstReviewAdditional !== undefined;
  if (!settings.enabled || settings.reviewMode === "off") {
    ctx.log("crawl.agent_review_skipped", { reason: !settings.enabled ? "disabled" : "review_off" });
    return { done: true, ...(poolEnabled && ctx.cursor ? { cursor: ctx.cursor } : {}) };
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
  const primary = firstReviewer(settings);
  if (!primary) throw new Error("1차 심사자를 설정하거나 CRAWL_REVIEW_MODEL 을 넣어야 AI 심사를 켤 수 있습니다");
  const pool = firstReviewers(settings, primary);
  const blockedModels = poolEnabled ? await readBlockedFirstReviewerKeys() : new Set<string>();
  const concurrency = Math.min(settings.reviewConcurrency || 2, MAX_CONCURRENT_REVIEWS);
  const pending = poolEnabled ? await listOwnPendingFirstReviewCandidates(settings, lease) : [];
  if (pending.length) ctx.log("crawl.agent_review_pending_revisited", { count: pending.length,
    reserved: pending.filter(row => row.state === "reserved").length, waiting: pending.filter(row => row.state === "waiting").length });
  const after = poolEnabled ? firstReviewPoolPosition(ctx.cursor?.firstReviewPoolScan) : null;
  const pageLimit = Math.min(Math.max(20, concurrency * 2), 32 - pending.length);
  const page = poolEnabled ? await listFirstReviewPoolCandidates(settings, pageLimit, after) : null;
  const candidates = page ? page.map(row => row.candidate) : await listReviewCandidates(settings, Math.max(20, concurrency * 2));
  const work = [...pending.map(hint => ({ candidate: hint.candidate, hint, position: undefined })),
    ...candidates.map((candidate, index) => ({ candidate, hint: undefined, position: page?.[index].position }))];
  if (!work.length) {
    if (after) { await ctx.save({ ...ctx.cursor, firstReviewPoolScan: null }); return { done: false, continuation: "ready" }; }
    return { done: true, ...(poolEnabled && ctx.cursor ? { cursor: ctx.cursor } : {}) };
  }
  const tickMs = pool.some(reviewer => reviewer.provider === "grok-cli") ? GROK_TICK_MS
    : pool.some(reviewer => reviewer.provider === "abcllm") ? GATEWAY_TICK_MS : TICK_MS;
  // The runner starts its budget before claiming the job. Preparing inputs or
  // waiting for admission must not let us start a full call past that deadline.
  const deadlineAt = Math.min(startedAt + tickMs, ctx.deadlineAt ?? Infinity);
  const remaining = () => deadlineAt - Date.now();
  const timeoutFor = (provider: string) => provider === "abcllm" ? REVIEW_GATEWAY_TIMEOUT_MS
    : provider === "grok-cli" ? GROK_REVIEW_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;
  const minimumCeiling = Math.min(...pool.map(reviewer => timeoutFor(reviewer.provider)));
  const visited = new Set<number>();
  const controllers = new Set<AbortController>();
  const pausedModels = new Set<string>();
  let lastPagePosition: NonNullable<typeof page>[number]["position"] | undefined;
  let next = 0, admitted = 0, progress = 0, windowLeft = 0, stopped = false, stageBlocked = false, modelDeferred = false;
  // 틱 요약(crawl.agent_review_tick) — 배포 뒤 한 시간 안에 틱당 호출·예약 대기를 잴 수 있게 남긴다. 결과·장부에는 끼어들지 않는다
  const tally = { calls: 0, waits: 0, waitGranted: 0, waitPolls: 0, waitMs: 0, waitWindowClosed: 0, waitCapped: 0 };
  const perModel = new Map<string, { calls: number; waits: number; waitGranted: number }>();
  const modelTally = (name: string) => perModel.get(name) ?? perModel.set(name, { calls: 0, waits: 0, waitGranted: 0 }).get(name)!;
  const canStart = () => !stopped && !stageBlocked && !ctx.signal?.aborted && ctx.hasBudget() && remaining() >= minimumCeiling + 2_000;
  const canAdmit = () => !modelDeferred && canStart();
  const processCandidate = async (candidate: typeof candidates[number], hint?: PendingFirstReviewCandidate) => {
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
    const reviewer = settings.firstReviewAdditional === undefined ? primary
      : await chooseFirstReviewForCandidate({ candidate, document, settings, input }, undefined,
        new Set([...blockedModels, ...pausedModels]));
    if (!reviewer) return;
    const { provider: reviewProvider, model } = reviewer;
    if (hint && (hint.reviewer.provider !== reviewProvider || hint.reviewer.model !== model
      || hint.workKey !== `ai1:${candidate.id}:${itemBindingHash(agentReviewBinding(candidate.id, input, reviewer))}`)) return;
    const key = firstReviewerKey(reviewer), ceiling = timeoutFor(reviewProvider);
    const canExecuteClaim = () => canStart() && remaining() >= ceiling + 2_000;
    const canStartModel = () => canExecuteClaim() && !pausedModels.has(key);
    if (!canStartModel()) return;
    const preparation = await prepareAgentReview({ candidate, document, settings, input }, reviewer);
    const { verdict, hardReason, evidenceHold, provider } = preparation;
    // README 를 받고 나서 드러난 스팸·악성 의심은 모델에게 보내지 않고 사람에게 넘긴다
    if (preparation.spam) {
      const held = await holdSuspectedSpam(candidate, verdict, lease);
      ctx.log("crawl.agent_review_suspected_spam", { repo: candidate.repo, held });
      return;
    }
    if (!canAdmit() || !canStartModel()) return;
    const context = { candidate, document, settings, input };
    let claim: ModelCapacityReviewClaim | CliModelCapacityReviewClaim;
    let prepared: PreparedAi1GatewayCall | undefined;
    let waitEnded: Ai1ReservationWaitEvent["ended"] | undefined;
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
          // 줄에 선 이 후보의 예약을 틱 안에서 기다린다 — 미루고 떠나면 그 사이 받은 예약이 TTL 로 만료된다. 모든 물리 칸이 미확인
          // 점유로 막힌 모델(blockedModels)은 기다려도 풀리지 않으므로 기존처럼 바로 미룬다.
          const wait = blockedModels.has(key) ? undefined : {
            until: deadlineAt - ceiling - 2_000 - RESERVATION_CLAIM_MARGIN_MS,
            active: () => canAdmit() && !pausedModels.has(key),
            observe: (event: Ai1ReservationWaitEvent) => {
              waitEnded = event.ended;
              if (event.ended === "deadline") tally.waitWindowClosed++;
              if (event.ended === "cap") tally.waitCapped++;
              if (!event.queued) return;
              const row = modelTally(model);
              tally.waits++; row.waits++; tally.waitPolls += event.polls; tally.waitMs += event.waitedMs;
              if (event.granted) { tally.waitGranted++; row.waitGranted++; }
            },
          };
          const resumed = await claimAgentReviewModelCapacity({ ...context, lease, provider, model, signal: ctx.signal }, wait);
          claim = resumed.claim; prepared = resumed.call;
        }
      }
    } catch (error) {
      if (!(error instanceof ModelCapacityDeferredError)) throw error;
      // 틱의 시작 가능 시각이 지나 기다림을 그친 것은 슬롯 거절이 아니다 — 모델을 pause 하지 않는다. 줄에 선 행은 그대로 두고
      // 다음 틱이 맨 먼저 다시 본다(listOwnPendingFirstReviewCandidates). 그 틱이 늦지 않도록 이 틱은 요청을 남긴다(아래 windowLeft).
      if (error.reason === "capacity" && waitEnded === "deadline") {
        windowLeft++;
        ctx.log("crawl.agent_review_wait_window_closed", { repo: candidate.repo, provider: reviewProvider, model });
        return;
      }
      // 이 후보의 앞선 호출이 아직 dispatched/indeterminate 다 — 이 후보만 건너뛴다. 틱 전체를 미루면 목록 맨 앞에 남은 한 건이
      // 매 틱 다른 후보까지 막는다. claim TX 는 되감겼고 호출·시도·실패 기록은 없다.
      if (error.reason === "dispatched") {
        ctx.log("crawl.agent_review_skipped", { repo: candidate.repo, reason: "dispatched" });
        return;
      }
      // The claim TX has rolled back. Stop new claims without cancelling any
      // already admitted lane; all real work settles before returning deferred.
      if (settings.firstReviewAdditional !== undefined && firstReviewDeferralIsLocal(error.reason)) pausedModels.add(key);
      else modelDeferred = true;
      ctx.log("crawl.agent_review_deferred", { reason: error.reason, provider: reviewProvider, model });
      return;
    }
    if (claim.kind === "skipped") {
      if (claim.reason === "stage_inactive") stageBlocked = true;
      ctx.log("crawl.agent_review_skipped", { repo: candidate.repo, reason: claim.reason });
      return;
    }
    if (!canExecuteClaim()) {
      ctx.log("crawl.agent_review_claim_cancelled_before_transport", { provider: reviewProvider, model,
        elapsedMs: Date.now() - startedAt, remainingMs: remaining(), modelPaused: pausedModels.has(key),
        globalDeferred: modelDeferred, stageBlocked });
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
      // A peer's local capacity wait stops new admission, never this committed claim.
      if (!canExecuteClaim()) controller.abort();
      const options = { model, timeoutMs: ceiling, signal: controller.signal };
      const dispatch = claim.dispatch;
      const call = prepared;
      tally.calls++; modelTally(model).calls++;
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
      if (!result.ok) {
        if (settings.firstReviewAdditional !== undefined) pausedModels.add(key);
        else stopped = true;
      }
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
      while (next < work.length && admitted < MAX_STARTS && canAdmit()) {
        const { candidate, hint, position } = work[next++];
        if (position) lastPagePosition = position;
        if (visited.has(candidate.id)) continue;
        visited.add(candidate.id);
        admitted++;
        await processCandidate(candidate, hint);
      }
    } catch (error) {
      stopped = true;
      for (const controller of controllers) controller.abort();
      throw error;
    }
  });
  const settled = await Promise.allSettled(lanes);
  ctx.log("crawl.agent_review_tick", { admitted, calls: tally.calls, succeeded: progress, waits: tally.waits,
    waitGranted: tally.waitGranted, waitPolls: tally.waitPolls, waitMs: tally.waitMs, pendingRevisited: pending.length,
    waitWindowClosed: tally.waitWindowClosed, waitCapped: tally.waitCapped, pausedModels: pausedModels.size, modelDeferred, stageBlocked,
    durationMs: Date.now() - startedAt,
    models: Object.fromEntries(perModel) });
  const failure = settled.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  // Advance only examined hints. A paused model prefix must not repeat forever on later ticks.
  // This saves no provider authority, and preserves unrelated durable cursor fields.
  if (lastPagePosition) await ctx.save({ ...ctx.cursor, firstReviewPoolScan: lastPagePosition });
  else if (page && !page.length && after) await ctx.save({ ...ctx.cursor, firstReviewPoolScan: null });
  if (stageBlocked) return { done: false, deferred: "stage_blocked" };
  if (modelDeferred || pausedModels.size) return { done: false, deferred: "model_capacity" };
  // 줄에 선 채 틱이 끝난 후보가 있다. 진전이 있었으면 runner 가 곧바로 다시 요청하게 하고(전용 줄이 1초 뒤 다시 돈다),
  // 없으면 요청을 남겨 둔다 — scheduler 의 다음 요청(최대 1분)을 기다리면 그 사이 받은 예약이 TTL 로 만료된다.
  if (windowLeft) return progress && !stopped && !ctx.signal?.aborted && ctx.hasBudget()
    ? { done: false, continuation: "ready" } : { done: false, deferred: "model_capacity" };
  if (progress && !stopped && !ctx.signal?.aborted && ctx.hasBudget()) {
    const ready = await listReviewCandidates(settings, 1, { excludeCandidateIds: [...visited], readyOnly: true });
    if (ready.some(candidate => !visited.has(candidate.id))) return { done: false, continuation: "ready" };
  }
  return { done: false };
}
