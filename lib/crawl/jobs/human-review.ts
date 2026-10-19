import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { getSettings } from '../settings';
import { humanQueueOverview } from '../review-overview';
import { claimHumanReview, recordHumanReview, requeueInvalidHumanApprovals, humanReviewRepos } from '../human-review-repository';
import { reviewWithDeepSeek } from '../deepseek-review';
import { DEEPSEEK_REVIEW_TIMEOUT_MS } from '../deepseek-review-policy';

/** One local inference at a time; at most two per tick, three attempts per input. */
export async function reviewHumanQueue(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  const lease = ctx.lease;
  if (!lease) throw new Error('human_review_job_required');
  const requeued = await requeueInvalidHumanApprovals(lease);
  if (!settings.enabled || !settings.humanReview.enabled) {
    ctx.log('crawl.human_review_skipped', { reason: 'disabled', requeued });
    return { done: true };
  }
  const overview = await humanQueueOverview(settings);
  const ids = [...new Set([...overview.ids.human, ...overview.ids.agreed])];
  const repos = await humanReviewRepos(ids);
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
  return { done: applied + held + failed === 0 };
}
