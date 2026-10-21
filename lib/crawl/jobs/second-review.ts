import { emitPipelineEvent, measureReviewCall } from "@/lib/observability/review-pipeline";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { runGateSplitTiebreak } from "@/lib/crawl/gate-split-tiebreak";
import { getSettings } from "@/lib/crawl/settings";
import { dispatchSecondReviewTransport, secondReviewTransportTimeoutMs } from "@/lib/crawl/second-review-transport";
import { closeSettledSecondReviews, enqueueSecondReviews, pendingSecondReviews, recordSecondReview, reopenOrphanedGateHolds,
  retryFailedSecondReviews } from "@/lib/crawl/second-review";
import { admitLegacySecondReview, canStartLegacySecondReview } from "@/lib/crawl/second-review-ownership";
import { assertReviewFixtureSettings } from "../review-fixture-transport";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";

/**
 * 한 틱에 함께 부르는 수와 틱의 길이.
 *
 * 예산 110초(scripts/worker.ts) 안에서 돈다. 잠금이 있어 틱이 겹치지 않으므로 긴 틱은 곧 쉬지
 * 않고 도는 것과 같다.
 *
 * 공유 게이트웨이에 여덟 요청을 한꺼번에 보내지 않는다. 모델을 바꿔도 제한을 유지하고,
 * 실패는 개별 호출의 시간·오류 코드로 기록해 작업 성공과 구분한다.
 */
const CONCURRENT = 4;
const TICK_MS = 108_000;
/** 한 틱에 집어 둘 일감 — 워커가 굶지 않을 만큼만 */
const FETCH = CONCURRENT * 6;

/**
 * 2차 심사. 올릴 것을 올리고, 끝난 것을 닫고, 대기 중인 것을 행에 적힌 모델로 본다.
 * 결과는 기록만 한다 — 대기 후보는 사람이 확정하고, 공개된 제품은 사람이 내릴지 정한다.
 */
export async function secondReviewCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const settings = await getSettings();
  assertReviewFixtureSettings(settings);
  if (!settings.enabled || !settings.secondReview.enabled) {
    ctx.log("crawl.second_review_skipped", { reason: !settings.enabled ? "disabled" : "second_review_off" });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Second review requires a valid worker job lease");
  const enqueued = await enqueueSecondReviews(settings, undefined, lease);
  const closed = await closeSettledSecondReviews(undefined, lease);
  const reopened = await reopenOrphanedGateHolds(settings, undefined, lease);
  await retryFailedSecondReviews(undefined, lease);
  /*
   * 갈림 판가름(gate-split-tiebreak.ts) — 관문에서 갈린 보류를 gpu3090 Qwen-v2 에 한 번 더 묻는다. 게이트웨이가 아닌 곳을 부르므로
   * 아래 표 심사와 나란히 돌고, 몫(perTick)·시간·실패는 따로 센다. 표 심사가 단계에 막혀도 돈다. 둘 다 끝난 뒤 틱을 닫는다.
   * gpu3090 은 감사 잡의 Qwen 호출과 같은 서버다 — 판가름은 감사 잡의 두 번째 의견·공개분 거르기와 두 번째 자리 하나를 나눠 쓰고, 물러나기도
   * 함께한다(qwen-endpoint-backoff.ts). 두 잡이 겹쳐 돌아도 동시 호출은 감사 자리(2~4) + 1
   */
  const tiebreak = runGateSplitTiebreak(ctx, lease, { deadlineAt: startedAt + TICK_MS }).then(() => null, (error: unknown) => ({ error }));
  const outcome = await reviewPendingVotes(ctx, lease, startedAt, { enqueued, closed, reopened })
    .catch(async (error: unknown) => { await tiebreak; throw error; });
  const failure = await tiebreak;
  if (failure) throw failure.error;
  return outcome;
}

/** 대기 중인 2차 표를 행에 적힌 모델로 본다 — 위 틱의 나머지다 */
async function reviewPendingVotes(ctx: JobContext<null>, lease: JobLease, startedAt: number,
  { enqueued, closed, reopened }: { enqueued: number; closed: number; reopened: number }): Promise<JobOutcome<null>> {
  if (!await canStartLegacySecondReview(lease)) {
    ctx.log("crawl.second_review_skipped", { reason: "stage_inactive" });
    return { done: false, deferred: "stage_blocked" };
  }
  const queue = [...await pendingSecondReviews(FETCH)];
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  let reviewed = 0, failed = 0, deferred = 0;
  const visited = new Set<number>();
  let stopped = false, stageBlocked = false, modelDeferred = false;

  const settled = await Promise.allSettled(Array.from({ length: CONCURRENT }, async () => {
    try {
      for (let hint = queue.shift(); hint; hint = queue.shift()) {
        if (stopped || stageBlocked || modelDeferred || ctx.signal?.aborted || visited.has(hint.id)) continue;
        if (!ctx.hasBudget()) { deferred++; continue; }
        visited.add(hint.id);
        let admission: Awaited<ReturnType<typeof admitLegacySecondReview>>;
        try { admission = await admitLegacySecondReview(hint.id, lease); }
        catch (error) {
          if (!(error instanceof ModelCapacityDeferredError)) throw error;
          modelDeferred = true;
          deferred++;
          ctx.log("crawl.second_review_deferred", { reason: error.reason });
          continue;
        }
        if (admission.kind === "skipped") {
          if (admission.reason === "stage_inactive") stageBlocked = true;
          deferred++;
          continue;
        }
        const { row, input, receipt } = admission;
        // Dispatch uses the actual admitted row, never nullable queue defaults.
        const { provider, model } = row;
        if (!provider || !model) throw new Error("invalid_second_review_reviewer");
        const limit = secondReviewTransportTimeoutMs(provider);
        /*
         * 남은 시간에 끝낼 수 없는 호출은 시작하지 않는다.
         *
         * 잘린 호출은 timeout 으로 적히고 한 시간 뒤에야 다시 본다 — 그냥 다음 온전한 틱에
         * 온전한 시간으로 부르는 편이 빠르다.
         */
        if (!await canStartLegacySecondReview(lease)) stageBlocked = true;
        if (stopped || stageBlocked || ctx.signal?.aborted || !ctx.hasBudget() || remaining() < limit + 2_000) { deferred++; continue; }
        // 멈추라는 신호를 그대로 넘긴다 — 배포 때 진행 중인 호출이 바로 끊겨야 잠금을 놓고 나갈 수 있다
        const callStartedAt = Date.now();
        const telemetry = { stage: "second" as const, candidateId: row.candidateId, secondReviewId: row.id,
          firstAttemptId: row.firstAttemptId ?? undefined, generationKey: row.generationKey,
          provider, model, job: lease.name, runId: String(lease.requestedVersion) };
        if (row.createdAt) emitPipelineEvent("queue", { ...telemetry, waitMs: Date.now() - row.createdAt.getTime() }, ctx.log);
        const result = await measureReviewCall(telemetry, () => dispatchSecondReviewTransport({ stage: "second",
          candidateId: row.candidateId, firstAttemptId: row.firstAttemptId, secondReviewId: row.id,
          generationKey: row.generationKey, vote: row.fallbackForId ?? row.id, provider, model }, input,
        { timeoutMs: limit, signal: ctx.signal }), ctx.log);
        if (ctx.signal?.aborted || !result.ok && result.error === "cancelled") {
          // The awaited transport has returned. Settle only this admitted owner;
          // cancellation is not a failed vote or permission for early reclaim.
          await recordSecondReview({ receipt, result: { ok: false, error: "cancelled", model, provider } });
          deferred++;
          continue;
        }
        if (!result.ok) {
          const written = await recordSecondReview({ receipt,
            result: { ok: false, error: result.error, detail: result.detail, model, provider } });
          if (written.state !== "recorded") { deferred++; continue; }
          failed += 1;
          ctx.log("crawl.second_review_failed", { id: row.id, model, error: result.error,
            detail: result.detail ?? null, durationMs: Date.now() - callStartedAt });
          continue;
        }
        const second = { decision: result.outcome.decision, confidence: result.outcome.confidence ?? null, provider, model };
        const written = await recordSecondReview({ receipt, result: { ok: true, ...second, reason: result.outcome.reason } });
        if (written.state === "recorded") reviewed++;
        else deferred++;
      }
    } catch (error) { stopped = true; throw error; }
  }));
  const failure = settled.find(result => result.status === "rejected");
  if (failure) throw failure.reason;

  ctx.log("crawl.second_reviewed", { enqueued, closed, reopened, reviewed, failed, deferred });
  // A budget-exhausted lane may not have reached row admission. This is a stage
  // observation, not a durable barrier between preflight and external dispatch.
  if (stageBlocked || !await canStartLegacySecondReview(lease)) return { done: false, deferred: "stage_blocked" };
  if (modelDeferred) return { done: false, deferred: "model_capacity" };
  if (reviewed && !failed && !ctx.signal?.aborted && ctx.hasBudget()) {
    const ready = await pendingSecondReviews(1);
    if (ready.some(row => !visited.has(row.id))) return { done: false, continuation: "ready" };
  }
  return { done: reviewed + failed === 0 };
}
