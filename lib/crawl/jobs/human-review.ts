import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { getSettings } from '../settings';
import { humanQueueOverview } from '../review-overview';
import { claimHumanReview, recordHumanReview, requeueInvalidHumanApprovals, humanReviewRepos } from '../human-review-repository';
import { reviewWithDeepSeek } from '../deepseek-review';
import { DEEPSEEK_REVIEW_TIMEOUT_MS } from '../deepseek-review-policy';
import { runHeldQwenRetry } from '../held-qwen-retry';
import { heldQwenOwnedReasons } from '../held-qwen-retry-policy';

/**
 * 사람 큐 위임. 앞부분은 보류 Qwen-v2 재심사(held-qwen-retry.ts — 소개 없음·재시도 소진·판단 보류, 한 틱 perTick 개·budgetSeconds 초),
 * 뒷부분은 DeepSeek 위임(One local inference at a time; at most two per tick, three attempts per input).
 * DeepSeek 은 Qwen-v2 가 맡은 사유를 집지 않는다(heldQwenOwns).
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
  if (!settings.enabled || !settings.humanReview.enabled) {
    ctx.log('crawl.human_review_skipped', { reason: 'disabled', requeued });
    return { done: !qwenWorked };
  }
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
      result = await reviewWithDeepSeek(claim.input, {
        signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal,
      });
    } finally { clearInterval(poll); }
    const state = await recordHumanReview(claim, result);
    if (state === 'applied') applied++;
    if (state === 'held') held++;
    if (state === 'failed') failed++;
    if (!result.ok) break;
  }
  ctx.log('crawl.human_reviewed', { started, applied, held, failed, requeued });
  return { done: applied + held + failed === 0 && !qwenWorked };
}
