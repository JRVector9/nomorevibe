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
import { firstReviewer, reviewCliTimeoutMs, reviewWithAgent } from "@/lib/crawl/agent-review";
import { reviewGatewayTimeoutMs, reviewWithGateway, type PreparedAi1GatewayCall } from "@/lib/crawl/agent-review-gateway";
import { grokReviewTimeoutMs, reviewWithGrokCli } from "@/lib/crawl/agent-review-grok";
import { reviewSemanticNow } from "../review-replay-context";
import { prepareAgentReview } from "../agent-review-preparation";
import { assertReviewFixtureSettings, dispatchReviewFixtureCall } from "../review-fixture-transport";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { claimAgentReviewModelCapacity, reviewAgentReviewModelCapacity, abandonAgentReviewModelCapacity,
  type Ai1ReservationWaitEvent } from "../agent-review-model-capacity";
import type { Ai1ModelDispatch, CliModelDispatch } from "@/lib/llm/capacity";
import type { PreparedReviewCliCall } from "../review-cli-call";
import { firstReviewers, firstReviewerKey, firstReviewDeferralIsLocal, firstReviewPoolPosition, type FirstReviewCursor } from "../first-reviewers";
import { readBlockedFirstReviewerKeys } from "../first-reviewer-blocks";
import { agentReviewBinding } from "../agent-review-ownership";
import { itemBindingHash } from "@/lib/jobs/items/types";
import { AGENT_REVIEW_ALL_SKIPPED } from "../agent-review-skip";

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
  if (!primary) throw new Error("관리자 설정에서 1차 심사자를 골라야 AI 심사를 켤 수 있습니다");
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
    : pool.some(reviewer => reviewer.provider === "abcllm" || reviewer.provider === "local-direct") ? GATEWAY_TICK_MS : TICK_MS;
  // The runner starts its budget before claiming the job. Preparing inputs or
  // waiting for admission must not let us start a full call past that deadline.
  const deadlineAt = Math.min(startedAt + tickMs, ctx.deadlineAt ?? Infinity);
  const remaining = () => deadlineAt - Date.now();
  // 제공자별 호출 상한은 이 틱의 등록부(관리자 실시간 한도 포함)에서 읽는다
  const timeoutFor = (provider: string) => provider === "abcllm" || provider === "local-direct" ? reviewGatewayTimeoutMs()
    : provider === "grok-cli" ? grokReviewTimeoutMs() : reviewCliTimeoutMs();
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
  // 들인 후보가 호출 없이 끝난 까닭. 모든 건너뜀은 crawl.agent_review_skipped 로 남고 틱 요약(skipped)에 센다 — 2026-11-01 AI1 정체는
  // 들인 14건이 모두 말없이 return 해 틱 로그(admitted 14 · calls 0) 말고는 아무 흔적이 없었다
  const skipped: Record<string, number> = {};
  const skip = (repo: string, reason: string, fields: Record<string, unknown> = {}) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    ctx.log("crawl.agent_review_skipped", { repo, reason, ...fields });
  };
  const canStart = () => !stopped && !stageBlocked && !ctx.signal?.aborted && ctx.hasBudget() && remaining() >= minimumCeiling + 2_000;
  const canAdmit = () => !modelDeferred && canStart();
  const processCandidate = async (candidate: typeof candidates[number], hint?: PendingFirstReviewCandidate) => {
    if (!isReviewCandidate(candidate)) return skip(candidate.repo, "not_review_candidate");
    if (!await canStartLegacyAgentReview(lease, candidate.id)) {
      // Candidate-level refusal can mean a healthy foreign item. Only an actual
      // global stage refusal defers this request; this read is not dispatch fencing.
      if (!await canStartLegacyAgentReview(lease)) stageBlocked = true;
      return skip(candidate.repo, stageBlocked ? "stage_inactive" : "item_owned");
    }
    const document = await loadReviewDocument(candidate.repo, lease);
    if (!document) return skip(candidate.repo, "document_missing");
    const input = await loadReviewInput(candidate, document, settings);
    if (input.validUntil <= reviewSemanticNow()) return skip(candidate.repo, "input_expired");
    const reviewer = settings.firstReviewAdditional === undefined ? primary
      : await chooseFirstReviewForCandidate({ candidate, document, settings, input }, undefined,
        new Set([...blockedModels, ...pausedModels]));
    // 진행 중·식별 불가 시도나 다른 모델의 활성 의도에 묶여 지금 풀에서 고를 심사자가 없다(first-reviewers.ts selectFirstReviewer)
    if (!reviewer) return skip(candidate.repo, "reviewer_unassigned");
    const { provider: reviewProvider, model } = reviewer;
    if (hint && (hint.reviewer.provider !== reviewProvider || hint.reviewer.model !== model
      || hint.workKey !== `ai1:${candidate.id}:${itemBindingHash(agentReviewBinding(candidate.id, input, reviewer))}`))
      return skip(candidate.repo, "pending_hint_mismatch", { provider: reviewProvider, model });
    const key = firstReviewerKey(reviewer), ceiling = timeoutFor(reviewProvider);
    const canExecuteClaim = () => canStart() && remaining() >= ceiling + 2_000;
    const canStartModel = () => canExecuteClaim() && !pausedModels.has(key);
    const notStartable = () => pausedModels.has(key) ? "model_paused" : modelDeferred ? "model_deferred"
      : stageBlocked ? "stage_inactive" : "tick_window_closed";
    if (!canStartModel()) return skip(candidate.repo, notStartable(), { provider: reviewProvider, model });
    const preparation = await prepareAgentReview({ candidate, document, settings, input }, reviewer);
    const { verdict, hardReason, evidenceHold, provider } = preparation;
    // README 를 받고 나서 드러난 스팸·악성 의심은 모델에게 보내지 않고 사람에게 넘긴다
    if (preparation.spam) {
      const held = await holdSuspectedSpam(candidate, verdict, lease);
      ctx.log("crawl.agent_review_suspected_spam", { repo: candidate.repo, held });
      return;
    }
    if (!canAdmit() || !canStartModel()) return skip(candidate.repo, notStartable(), { provider: reviewProvider, model });
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
      // 이 후보의 앞선 호출이 아직 보내진 중이거나(dispatched) 같은 후보가 다른 요청에 묶였다(work_busy, fence) — 이 후보만 건너뛴다.
      // 모델을 pause 하거나 틱 전체를 미루면 목록 맨 앞에 남은 한 건이 매 틱 다른 후보까지 막는다(2026-10-30 결정).
      // claim TX 는 되감겼고 호출·시도·실패 기록은 없다.
      if (modelCapacityDeferralIsPerWork(error.reason)) return skip(candidate.repo, error.reason);
      // The claim TX has rolled back. Stop new claims without cancelling any
      // already admitted lane; all real work settles before returning deferred.
      if (settings.firstReviewAdditional !== undefined && firstReviewDeferralIsLocal(error.reason)) pausedModels.add(key);
      else modelDeferred = true;
      ctx.log("crawl.agent_review_deferred", { reason: error.reason, provider: reviewProvider, model });
      return;
    }
    if (claim.kind === "skipped") {
      if (claim.reason === "stage_inactive") stageBlocked = true;
      return skip(candidate.repo, claim.reason);
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
        // 엔진 직접(local-direct) 1차는 공통 장부의 dispatch 로만 보낸다 — 장부 밖 호환 경로로는 보내지 않는다(AI2 와 같다, PR 3b-C)
        : reviewProvider === "local-direct" ? { ok: false as const, error: "not_configured" as const }
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
    durationMs: Date.now() - startedAt, skipped,
    models: Object.fromEntries(perModel) });
  const failure = settled.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  // Advance only examined hints. A paused model prefix must not repeat forever on later ticks.
  // This saves no provider authority, and preserves unrelated durable cursor fields.
  if (lastPagePosition) await ctx.save({ ...ctx.cursor, firstReviewPoolScan: lastPagePosition });
  else if (page && !page.length && after) await ctx.save({ ...ctx.cursor, firstReviewPoolScan: null });
  if (stageBlocked) return { done: false, deferred: "stage_blocked" };
  // 심사를 남긴 틱은 완료 틱이다 — 요청(processedVersion)도 인정한다. 미룸은 처리 건수를 안 실으면 성공 시각을 옮기지 않고
  // 요청도 인정하지 않는다. 풀의 모델 하나가 멈춰(포화·실패·미매핑) 매 틱 미룸으로 끝나면 시간당 1천여 건을 남기면서도
  // last_success_at 이 멈췄다(2026-10-31 01:26Z~). 한 모델만 멈췄으면 남은 일이 있으니 곧바로 다시 요청한다.
  // 전역 미룸(draining·owner 등)이면 완료로 적되 다시 요청하지 않는다 — scheduler 의 다음 요청을 기다린다.
  // 아무것도 남기지 못한 틱은 예전처럼 미룸이다(processed 없음 → 성공 시각 유지).
  if (modelDeferred || pausedModels.size) {
    if (!progress) return { done: false, deferred: "model_capacity" };
    return !modelDeferred && !stopped && !ctx.signal?.aborted && ctx.hasBudget() ? { done: false, continuation: "ready" } : { done: false };
  }
  // 줄에 선 채 틱이 끝난 후보가 있다. 진전이 있었으면 runner 가 곧바로 다시 요청하게 하고(전용 줄이 1초 뒤 다시 돈다),
  // 없으면 요청을 남겨 둔다 — scheduler 의 다음 요청(최대 1분)을 기다리면 그 사이 받은 예약이 TTL 로 만료된다.
  if (windowLeft) return progress && !stopped && !ctx.signal?.aborted && ctx.hasBudget()
    ? { done: false, continuation: "ready" } : { done: false, deferred: "model_capacity" };
  if (progress && !stopped && !ctx.signal?.aborted && ctx.hasBudget()) {
    const ready = await listReviewCandidates(settings, 1, { excludeCandidateIds: [...visited], readyOnly: true });
    if (ready.some(candidate => !visited.has(candidate.id))) return { done: false, continuation: "ready" };
  }
  // 들인 후보가 모두 이름 붙은 까닭으로 건너뛰어졌다 — 호출도 진전도 없다. 프로세스 결함이 아니라 입력·배정의 일이라 재시작으로 고쳐지지
  // 않는다. 제 일 못 한 틱(degraded)으로 적어 성공 시각을 옮기지 않고(조치할 일 경보), 진행 감시는 이것을 보고 reviewer 를 재시작하지 않는다
  // (worker-progress-query.ts applyAllSkippedBlock).
  const skippedTotal = Object.values(skipped).reduce((sum, n) => sum + n, 0);
  if (admitted > 0 && !progress && !tally.calls && skippedTotal === admitted) return { done: false, degraded: {
    code: AGENT_REVIEW_ALL_SKIPPED, detail: Object.entries(skipped).sort(([a], [b]) => a.localeCompare(b)).map(([reason, n]) => `${reason}=${n}`).join(" ") } };
  return { done: false };
}
