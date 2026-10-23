import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { getSettings } from '../settings';
import { humanQueueOverview } from '../review-overview';
import { claimHumanReview, recordHumanReview, requeueInvalidHumanApprovals, humanReviewRepos, deferHumanReviewForModelCapacity } from '../human-review-repository';
import { withLocalModelCapacity } from '@/lib/llm/local-model-capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { REVIEW_PROMPT_VERSION } from '../agent-review-contract';
import { reviewWithDeepSeek } from '../deepseek-review';
import { DEEPSEEK_REVIEW_TIMEOUT_MS } from '../deepseek-review-policy';
import { runHeldQwenRetry } from '../held-qwen-retry';
import { heldQwenOwnedReasons } from '../held-qwen-retry-policy';
import { runSplitTiebreakConfirmations } from '../gate-split-confirm';

/**
 * 사람 큐 위임 — 이 잡이 M3 DeepSeek 을 쓰는 유일한 곳이다(한 번에 한 호출, 잡 lease 가 틱을 하나로 줄 세운다).
 *  1. 보류 Qwen-v2 재심사(held-qwen-retry.ts — 소개 없음·재시도 소진·판단 보류, 한 틱 perTick 개·budgetSeconds 초) — gpu3090, M3 를 쓰지 않는다
 *  2. DeepSeek 위임(One local inference at a time; at most two per tick, three attempts per input) — Qwen-v2 가 맡은 사유는 집지 않는다
 *  3. 2차 갈림 판가름의 DeepSeek 확인(gate-split-confirm.ts — 한 틱 SPLIT_CONFIRM_PER_TICK 건, 45초 호출) — 위임이 끝난 뒤에 차례로 부른다.
 *     위임이 꺼져 있어도 돈다(스위치는 qwenAuto.splitTiebreak). 잡 전체 예산(110초)은 그대로이고 각 단계는 남은 예산 안에서만 새로 부른다.
 */
export async function reviewHumanQueue(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  const lease = ctx.lease;
  if (!lease) throw new Error('human_review_job_required');
  const requeued = await requeueInvalidHumanApprovals(lease);
  const qwen = await runHeldQwenRetry(ctx, settings);
  ctx.log('crawl.held_qwen_retry', { started: qwen.started, pipeline: qwen.pipeline, rejected: qwen.rejected, held: qwen.held,
    failed: qwen.failed, reapplied: qwen.reapplied, refreshed: qwen.refreshed ?? 0, ...(qwen.skipped ? { skipped: qwen.skipped } : {}),
    ...(qwen.backoffUntil ? { backoffUntil: qwen.backoffUntil } : {}) });
  const qwenWorked = qwen.started + qwen.reapplied + (qwen.refreshed ?? 0) > 0;
  let delegated = 0;
  if (!settings.enabled || !settings.humanReview.enabled) ctx.log('crawl.human_review_skipped', { reason: 'disabled', requeued });
  else delegated = await delegateToDeepSeek(ctx, lease, settings, requeued);
  // 위임의 호출이 끝난 뒤에만 — M3 에 두 호출을 겹쳐 띄우지 않는다
  const confirm = await runSplitTiebreakConfirmations(ctx, lease);
  return { done: delegated === 0 && !qwenWorked && confirm.calls === 0 };
}

/** DeepSeek 위임 — 끝낸 수(적용·보류·실패)를 돌려준다 */
async function delegateToDeepSeek(ctx: JobContext<null>, lease: NonNullable<JobContext<null>['lease']>, settings: Awaited<ReturnType<typeof getSettings>>,
  requeued: number): Promise<number> {
  const overview = await humanQueueOverview(settings);
  const ids = [...new Set([...overview.ids.human, ...overview.ids.agreed])];
  const repos = await humanReviewRepos(ids, heldQwenOwnedReasons(settings));
  let started = 0, applied = 0, held = 0, failed = 0;
  for (const repo of repos) {
    if (started >= 2 || ctx.signal?.aborted || !ctx.hasBudget()
      || ctx.deadlineAt !== undefined && ctx.deadlineAt - Date.now() < DEEPSEEK_REVIEW_TIMEOUT_MS + 2_000) break;
    const claim = await claimHumanReview(repo, lease);
    if (!claim) continue;
    if (ctx.signal?.aborted || !ctx.hasBudget()
      || ctx.deadlineAt !== undefined && ctx.deadlineAt - Date.now() < DEEPSEEK_REVIEW_TIMEOUT_MS + 2_000) {
      await recordHumanReview(claim, { ok: false, error: 'cancelled' });
      break;
    }
    started++;
    const controller = new AbortController();
    const poll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
    poll.unref?.();
    let result: Awaited<ReturnType<typeof reviewWithDeepSeek>>;
    try {
      result = await withLocalModelCapacity({ target: { kind: 'candidate', purpose: 'human_deepseek', attemptId: claim.attemptId,
        candidateId: claim.candidateId, repo: claim.repo }, input: claim.input, lease, promptVersion: REVIEW_PROMPT_VERSION },
      request => reviewWithDeepSeek(claim.input, { request,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal }));
    } catch (error) {
      if (!(error instanceof ModelCapacityDeferredError)) throw error;
      await deferHumanReviewForModelCapacity(claim);
      ctx.log('crawl.human_review_capacity_deferred', { reason: error.reason });
      break;
    } finally { clearInterval(poll); }
    const state = await recordHumanReview(claim, result);
    if (state === 'applied') applied++;
    if (state === 'held') held++;
    if (state === 'failed') failed++;
    if (!result.ok) break;
  }
  ctx.log('crawl.human_reviewed', { started, applied, held, failed, requeued });
  return applied + held + failed;
}
