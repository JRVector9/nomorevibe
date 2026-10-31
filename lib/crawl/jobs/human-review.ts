import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { JobLeaseLostError } from '@/lib/jobs/lease';
import { DrWriterFencedError } from '@/lib/operations/dr/epoch';
import { getSettings } from '../settings';
import { humanQueueOverview } from '../review-overview';
import { claimHumanReview, recordHumanReview, requeueInvalidHumanApprovals, humanReviewRepos, deferHumanReviewForModelCapacity } from '../human-review-repository';
import { withLocalModelCapacity } from '@/lib/llm/local-model-capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { REVIEW_PROMPT_VERSION } from '../agent-review-contract';
import { reviewWithDeepSeek } from '../deepseek-review';
import { deepseekReviewTimeoutMs } from '../deepseek-review-policy';
import { runHeldQwenRetry } from '../held-qwen-retry';
import { heldQwenOwnedReasons } from '../held-qwen-retry-policy';
import { runSplitTiebreakConfirmations } from '../gate-split-confirm';

/**
 * 사람 큐 위임 — 이 잡이 M3 DeepSeek 을 쓰는 유일한 곳이다(한 번에 한 호출, 잡 lease 가 틱을 하나로 줄 세운다).
 *  1. 보류 Qwen-v2 재심사(held-qwen-retry.ts — 소개 없음·재시도 소진·판단 보류, 한 틱 perTick 개·budgetSeconds 초) — gpu3090, M3 를 쓰지 않는다
 *  2. DeepSeek 위임(One local inference at a time; at most two per tick, three attempts per input) — Qwen-v2 가 맡은 사유는 집지 않는다
 *  3. 2차 갈림 판가름의 DeepSeek 확인(gate-split-confirm.ts — 한 틱 SPLIT_CONFIRM_PER_TICK 건, 45초 호출) — 위임이 끝난 뒤에 차례로 부른다.
 *     위임이 꺼져 있어도 돈다(스위치는 qwenAuto.splitTiebreak). 잡 전체 예산(110초)은 그대로이고 각 단계는 남은 예산 안에서만 새로 부른다.
 *
 * 2026-10-31(PR 3a-B) 소유자 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다": 한 단계의 오류(모델 미룸·그 단계의 예외)는 그 단계만
 * 끝내고 다음 단계는 그대로 돈다 — 예전에는 1단계가 던지면 2·3단계가 이 틱을 통째로 잃었다. 모든 단계가 돈 뒤 첫 오류를 던져 틱은 실패로
 * 남는다(last_error 에 보이게). lease 잃음·DR fence 는 쓰기를 멈춰야 하므로 바로 던진다. 세 단계를 각자 잡으로 나누는 일은 3a-C 다.
 */
export async function reviewHumanQueue(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  const lease = ctx.lease;
  if (!lease) throw new Error('human_review_job_required');
  const failures: unknown[] = [];
  /** 한 단계를 돌린다 — 그 단계의 오류는 모아 두고 null 을 돌려준다(다음 단계는 계속). lease 잃음·DR fence 만 바로 던진다 */
  const phase = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try { return await run(); }
    catch (error) {
      if (error instanceof JobLeaseLostError || error instanceof DrWriterFencedError) throw error;
      ctx.log('crawl.human_review_phase_failed', { phase: name, error: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
      failures.push(error);
      return null;
    }
  };
  const requeued = await requeueInvalidHumanApprovals(lease);
  const qwen = await phase('held_qwen_retry', () => runHeldQwenRetry(ctx, settings));
  if (qwen) ctx.log('crawl.held_qwen_retry', { started: qwen.started, pipeline: qwen.pipeline, rejected: qwen.rejected, held: qwen.held,
    failed: qwen.failed, reapplied: qwen.reapplied, refreshed: qwen.refreshed ?? 0, ...(qwen.skipped ? { skipped: qwen.skipped } : {}),
    ...(qwen.backoffUntil ? { backoffUntil: qwen.backoffUntil } : {}) });
  const qwenWorked = qwen ? qwen.started + qwen.reapplied + (qwen.refreshed ?? 0) > 0 : false;
  let delegated = 0;
  if (!settings.enabled || !settings.humanReview.enabled) ctx.log('crawl.human_review_skipped', { reason: 'disabled', requeued });
  else delegated = await phase('deepseek_delegation', () => delegateToDeepSeek(ctx, lease, settings, requeued)) ?? 0;
  // 위임의 호출이 끝난 뒤에만 — M3 에 두 호출을 겹쳐 띄우지 않는다
  const confirm = await phase('split_confirm', () => runSplitTiebreakConfirmations(ctx, lease));
  if (failures.length) throw failures[0];
  return { done: delegated === 0 && !qwenWorked && (confirm?.calls ?? 0) === 0 };
}

/** DeepSeek 위임 — 끝낸 수(적용·보류·실패)를 돌려준다 */
async function delegateToDeepSeek(ctx: JobContext<null>, lease: NonNullable<JobContext<null>['lease']>, settings: Awaited<ReturnType<typeof getSettings>>,
  requeued: number): Promise<number> {
  const overview = await humanQueueOverview(settings);
  const ids = [...new Set([...overview.ids.human, ...overview.ids.agreed])];
  const repos = await humanReviewRepos(ids, heldQwenOwnedReasons(settings));
  let started = 0, applied = 0, held = 0, failed = 0;
  const callTimeoutMs = deepseekReviewTimeoutMs();
  for (const repo of repos) {
    if (started >= 2 || ctx.signal?.aborted || !ctx.hasBudget()
      || ctx.deadlineAt !== undefined && ctx.deadlineAt - Date.now() < callTimeoutMs + 2_000) break;
    const claim = await claimHumanReview(repo, lease);
    if (!claim) continue;
    if (ctx.signal?.aborted || !ctx.hasBudget()
      || ctx.deadlineAt !== undefined && ctx.deadlineAt - Date.now() < callTimeoutMs + 2_000) {
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
