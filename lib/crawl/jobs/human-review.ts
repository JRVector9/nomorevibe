import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { getSettings } from '../settings';
import { humanQueueOverview } from '../review-overview';
import { claimHumanReview, recordHumanReview, requeueInvalidHumanApprovals, humanReviewRepos, deferHumanReviewForModelCapacity,
  deferHumanReviewBeforeTransport } from '../human-review-repository';
import { withLocalModelCapacity } from '@/lib/llm/local-model-capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { REVIEW_PROMPT_VERSION } from '../agent-review-contract';
import { reviewWithDeepSeek } from '../deepseek-review';
import { deepseekReviewTimeoutMs } from '../deepseek-review-policy';
import { withDeepSeekSlot } from '../deepseek-slot';
import { heldQwenOwnedReasons } from '../held-qwen-retry-policy';

/**
 * 사람 큐 위임 — 사람 몫으로 넘어온 후보를 M3 DeepSeek 이 대신 본다(One local inference at a time; at most two per tick, three model attempts per input).
 * 보류 Qwen-v2 재심사(held-qwen-retry.ts)가 맡은 사유는 집지 않는다.
 *
 * 2026-10-31(PR 3a-C) 전에는 이 틱이 보류 Qwen-v2 재심사(gpu3090) → DeepSeek 위임(M3) → 갈림 판가름의 DeepSeek 확인(M3)을 차례로 돌았다 —
 * 한 장비의 느림이 다른 장비의 큐를 미뤘다. 이제 셋은 자기 잡·자기 줄이다: held-qwen-retry(jobs/held-qwen-retry.ts), 이 잡, split-confirm
 * (jobs/split-confirm.ts). M3 DeepSeek 에 한 번에 한 호출이라는 약속은 잡 lease 가 아니라 프로세스의 DeepSeek 자리(deepseek-slot.ts)가 지킨다.
 * 잡 예산(110초)은 그대로다.
 */
export async function reviewHumanQueue(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  const lease = ctx.lease;
  if (!lease) throw new Error('human_review_job_required');
  const requeued = await requeueInvalidHumanApprovals(lease);
  if (!settings.enabled || !settings.humanReview.enabled) {
    ctx.log('crawl.human_review_skipped', { reason: 'disabled', requeued });
    return { done: true };
  }
  const delegated = await delegateToDeepSeek(ctx, lease, settings, requeued);
  return { done: delegated === 0 };
}

/** DeepSeek 위임 — 끝낸 수(적용·보류·실패)를 돌려준다 */
async function delegateToDeepSeek(ctx: JobContext<null>, lease: NonNullable<JobContext<null>['lease']>, settings: Awaited<ReturnType<typeof getSettings>>,
  requeued: number): Promise<number> {
  const overview = await humanQueueOverview(settings);
  const ids = [...new Set([...overview.ids.human, ...overview.ids.agreed])];
  const repos = await humanReviewRepos(ids, heldQwenOwnedReasons(settings));
  let started = 0, applied = 0, held = 0, failed = 0;
  const callTimeoutMs = deepseekReviewTimeoutMs();
  const room = () => !ctx.signal?.aborted && ctx.hasBudget()
    && !(ctx.deadlineAt !== undefined && ctx.deadlineAt - Date.now() < callTimeoutMs + 2_000);
  for (const repo of repos) {
    if (started >= 2 || !room()) break;
    const claim = await claimHumanReview(repo, lease);
    if (!claim) continue;
    if (!room()) {
      await deferHumanReviewBeforeTransport(claim);
      break;
    }
    started++;
    const controller = new AbortController();
    const poll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
    poll.unref?.();
    let result: Awaited<ReturnType<typeof reviewWithDeepSeek>> | null;
    try {
      // No capacity wrapper or transport has been entered when this returns
      // null. Keep that proof separate from cancelled replies after dispatch.
      result = await withDeepSeekSlot(async () => {
        if (!room()) return null;
        return withLocalModelCapacity({ target: { kind: 'candidate', purpose: 'human_deepseek', attemptId: claim.attemptId,
          candidateId: claim.candidateId, repo: claim.repo }, input: claim.input, lease, promptVersion: REVIEW_PROMPT_VERSION },
        request => reviewWithDeepSeek(claim.input, { request,
          signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal }));
      });
    } catch (error) {
      if (!(error instanceof ModelCapacityDeferredError)) throw error;
      await deferHumanReviewForModelCapacity(claim);
      ctx.log('crawl.human_review_capacity_deferred', { reason: error.reason });
      break;
    } finally { clearInterval(poll); }
    if (result === null) {
      await deferHumanReviewBeforeTransport(claim);
      break;
    }
    const state = await recordHumanReview(claim, result);
    if (state === 'applied') applied++;
    if (state === 'held') held++;
    if (state === 'failed') failed++;
    if (!result.ok) break;
  }
  ctx.log('crawl.human_reviewed', { started, applied, held, failed, requeued });
  return applied + held + failed;
}
