import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { getSettings } from '../settings';
import { humanQueueOverview } from '../review-overview';
import { claimHumanReview, recordHumanReview, requeueInvalidHumanApprovals, humanReviewRepos, deferHumanReviewForModelCapacity,
  HUMAN_REVIEW_SCAN_FACTOR, delegatedApprovalRoute, refreshStaleDelegatedSources, releaseLostDelegatedReviews } from '../human-review-repository';
import { checkDelegatedRepository, type DelegatedRepoCheckResult } from '../delegated-repo-check';
import { withLocalModelCapacity } from '@/lib/llm/local-model-capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { REVIEW_FRESH_MS, REVIEW_PROMPT_VERSION, reviewEvidenceAgeHours } from '../agent-review-contract';
import { reviewWithDeepSeek } from '../deepseek-review';
import { DEEPSEEK_MIN_CONFIDENCE, deepseekReviewTimeoutMs } from '../deepseek-review-policy';
import { withDeepSeekSlot } from '../deepseek-slot';
import { heldQwenOwnedReasons } from '../held-qwen-retry-policy';

/** 한 틱에 시작하는 위임 호출의 상한 — 실제 수는 잡 예산(110초)과 마감이 정한다(호출 평균 10초, p90 13초) */
export const HUMAN_REVIEW_MAX_PER_TICK = 10;

/**
 * 사람 큐 위임 — 사람 몫으로 넘어온 후보를 M3 DeepSeek 이 대신 본다(One local inference at a time; as many as fit the budget,
 * at most HUMAN_REVIEW_MAX_PER_TICK per tick, three attempts per input).
 *
 * 2026-11-09 운영자 결정: 최신 것부터 보고, 최신 것이 끝나면 쌓인 과거 것도 본다. 근거가 24시간 지났다고 못 보게 자르지 않는다 —
 * 고르기는 humanReviewRepos(최근 들어온 것부터, 이 입력에서 끝낸 것 제외), 근거 나이는 any_age(agent-review-contract.ts).
 * 보류 Qwen-v2 재심사(held-qwen-retry.ts)가 맡은 사유는 그쪽이 지금 입력에서 끝낸 뒤에만 집는다(2026-11-10 운영자 결정, held-qwen-handoff.ts).
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
  // 주인이 사라진 위임 시도부터 닫는다 — 스위치와 상관없이. 남겨 두면 1차 심사가 그 후보를 영영 비킨다(2026-11-11 정체)
  const released = await releaseLostDelegatedReviews(lease);
  if (released.length) ctx.log('crawl.human_review_owner_lost', { released: released.length,
    attempts: released.slice(0, 20).map(row => ({ id: row.id, candidateId: row.candidateId, startedAt: row.startedAt.toISOString() })) });
  const requeued = await requeueInvalidHumanApprovals(lease);
  if (!settings.enabled || !settings.humanReview.enabled) {
    ctx.log('crawl.human_review_skipped', { reason: 'disabled', requeued });
    return { done: true };
  }
  // 72시간 넘은 근거라 보류한 승인의 원본 재수집 요청·결과 처리(보류 한 번에 요청 한 번) — 위임 앞뒤로 한 번씩
  const refreshed = await refreshStaleDelegatedSources(lease, settings);
  const delegated = await delegateToDeepSeek(ctx, lease, settings, requeued);
  const after = await refreshStaleDelegatedSources(lease, settings);
  if (refreshed.requested + refreshed.gone + refreshed.failed + after.requested + after.gone + after.failed)
    ctx.log('crawl.human_review_stale_refresh', { requested: refreshed.requested + after.requested,
      gone: refreshed.gone + after.gone, failed: refreshed.failed + after.failed });
  return { done: delegated === 0 };
}

/** DeepSeek 위임 — 끝낸 수(적용·보류·실패)를 돌려준다 */
async function delegateToDeepSeek(ctx: JobContext<null>, lease: NonNullable<JobContext<null>['lease']>, settings: Awaited<ReturnType<typeof getSettings>>,
  requeued: number): Promise<number> {
  const overview = await humanQueueOverview(settings);
  const ids = [...new Set([...overview.ids.human, ...overview.ids.agreed])];
  const repos = await humanReviewRepos(ids, heldQwenOwnedReasons(settings),
    { settings, limit: HUMAN_REVIEW_MAX_PER_TICK * HUMAN_REVIEW_SCAN_FACTOR });
  let started = 0, applied = 0, held = 0, failed = 0, unclaimed = 0, agedEvidence = 0, stale = 0, repoGone = 0, repoDeferred = 0;
  let oldestEvidenceHours: number | null = null;
  const callTimeoutMs = deepseekReviewTimeoutMs();
  const room = () => !ctx.signal?.aborted && ctx.hasBudget()
    && !(ctx.deadlineAt !== undefined && ctx.deadlineAt - Date.now() < callTimeoutMs + 2_000);
  for (const repo of repos) {
    if (started >= HUMAN_REVIEW_MAX_PER_TICK || !room()) break;
    const claim = await claimHumanReview(repo, lease);
    if (!claim) { unclaimed++; continue; }
    if (!room()) {
      await recordHumanReview(claim, { ok: false, error: 'cancelled' });
      break;
    }
    started++;
    const ageHours = reviewEvidenceAgeHours(claim.input);
    if (ageHours >= REVIEW_FRESH_MS / 3600_000) agedEvidence++;
    oldestEvidenceHours = Math.max(oldestEvidenceHours ?? ageHours, ageHours);
    const controller = new AbortController();
    const poll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
    poll.unref?.();
    let result: Awaited<ReturnType<typeof reviewWithDeepSeek>>;
    try {
      // M3 자리를 얻은 뒤 남은 예산을 다시 본다 — 갈림 확인(split-confirm)이 45초 호출을 붙잡고 있었을 수 있다. 못 부르면 멈춤으로 적는다(실패가 아니다)
      result = await withDeepSeekSlot(async () => {
        if (!room()) return { ok: false as const, error: 'cancelled' as const };
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
    // 24~72시간 근거의 승인은 발행 전에 저장소가 아직 있는지 묻는다(트랜잭션 밖, 한 번). 기록이 같은 나이로 다시 가른다
    let repoCheck: DelegatedRepoCheckResult | undefined;
    if (result.ok && result.outcome.decision === 'approve' && (result.outcome.confidence ?? 0) >= DEEPSEEK_MIN_CONFIDENCE
      && delegatedApprovalRoute(reviewEvidenceAgeHours(claim.input, claim.startedAt)) === 'check_repo')
      repoCheck = await checkDelegatedRepository(claim.repo, ctx.signal);
    const state = await recordHumanReview(claim, result, repoCheck ? { repoCheck } : {});
    if (state === 'applied') applied++;
    if (state === 'held') held++;
    if (state === 'failed') failed++;
    if (state === 'stale') stale++;
    if (state === 'repo_gone') repoGone++;
    if (state === 'deferred') repoDeferred++;
    // GitHub 를 못 물었으면(한도·전송) 이 틱의 나머지 승인도 같은 일을 겪는다 — 멈춘다
    if (!result.ok || state === 'deferred') break;
  }
  ctx.log('crawl.human_reviewed', { started, applied, held, failed, requeued, candidates: repos.length, unclaimed,
    agedEvidence, oldestEvidenceHours, stale, repoGone, repoDeferred });
  return applied + held + failed + stale + repoGone;
}
