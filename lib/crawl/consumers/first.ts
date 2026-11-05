import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { crawlCandidates, crawlReviewAttempts } from '@/lib/db/schema';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from '@/lib/llm/capacity-deferred';
import type { ProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { logger } from '@/lib/observability/logger';
import type { HostAdmission } from '@/lib/operations/host-budget-runtime';
import { interruptibleSleep, type RuntimeReport } from '@/scripts/worker';
import { getSettings } from '../settings';
import { reviewCandidatePredicate } from '../agent-review-repository';
import { executeFirstReviewConsumerItem } from '../agent-review-item-lifecycle';
import { FirstReviewModelDeferredError, firstReviewDeferralIsLocal, firstReviewRankState, firstReviewerKey } from '../first-reviewers';
import { ensureReviewTaskRanks } from '../review-task-ranks';
import { readBlockedFirstReviewerKeys } from '../first-reviewer-blocks';

const PAGE_SIZE = 24, MAX_PAGES = 4, IDLE_MS = 5_000;
type Cursor = { id: number; reviewed: boolean; updatedAt: string; ceiling: number };
/** Fixed bounded hints; only the actual claim/writer can grant authority. */
async function hints(cursor: Cursor | null) {
  return onPrimary(async () => {
    const settings = await getSettings();
    const reviewed = sql<boolean>`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} seen
      WHERE seen.candidate_id = ${crawlCandidates.id} AND seen.state = 'succeeded')`;
    const ceiling = cursor ? sql<number>`${cursor.ceiling}::integer` : sql<number>`(SELECT coalesce(max(id), 0) FROM ${crawlCandidates})`;
    const rows = await db.select({ id: crawlCandidates.id, reviewed, updatedAt: sql<string>`${crawlCandidates.updatedAt}::text`, ceiling })
      .from(crawlCandidates).where(and(reviewCandidatePredicate(settings, { readyOnly: true }),
        cursor ? lte(crawlCandidates.id, cursor.ceiling) : undefined,
        cursor ? or(gt(reviewed, cursor.reviewed), and(eq(reviewed, cursor.reviewed), or(
          sql`${crawlCandidates.updatedAt} > (${cursor.updatedAt}::text)::timestamp`,
          and(sql`${crawlCandidates.updatedAt} = (${cursor.updatedAt}::text)::timestamp`, gt(crawlCandidates.id, cursor.id)),
        ))) : undefined)).orderBy(asc(reviewed), asc(crawlCandidates.updatedAt), asc(crawlCandidates.id)).limit(PAGE_SIZE);
    return { rows, settings };
  });
}
/** 같은 후보를 다음 순위로 다시 고르는 상한 — 순위 수(3)만큼(PR #792 의 잡 쪽 순위 대체와 같다) */
const MAX_RANK_RETRIES = 3;
export async function runFirstReviewConsumer(input: {
  owner: ItemOwner; signal?: AbortSignal; once?: boolean; report?: RuntimeReport;
  /** 새 hint·claim 만 멈추는 신호. 이미 보낸 호출은 signal 이 끊을 때까지 끝낸다(replay 구간 끝 drain). 없으면 signal 과 같다 */
  stopClaims?: AbortSignal;
  /** host 합계 장부(PR10e). 없으면 기존처럼 바로 claim 한다 */
  admit?: (job: string) => Promise<HostAdmission>;
  /** 고른 모델별 회로(늘 순위 고르기다 — PR C1 에서 단일 모델 회로는 없앴다). */
  circuits?: ProviderCircuits;
}): Promise<{ attempted: number; recorded: number; skipped: number; deferred: number }> {
  const owner = itemOwnerSchema.parse(input.owner), { signal, once, report, stopClaims } = input;
  const halt = stopClaims ? AbortSignal.any([stopClaims, ...(signal ? [signal] : [])]) : signal;
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const result = { attempted: 0, recorded: 0, skipped: 0, deferred: 0 };
  let cursor: Cursor | null = null, pages = 0;
  const pausedReviewers = new Set<string>();
  let degradedCode: string | null = null;
  while (!halt?.aborted) {
    report?.('polling');
    // 「작업 ↔ 모델」 순위·계약 스냅숏(PR C1): 이 소비자는 틱이 없어 쪽마다 같은 30초 주기로 새로 받는다 — 관리자가 순위를 저장하면 재시작 없이 다음 쪽부터 쓴다.
    // 순위가 없거나·표를 못 읽었거나·모두 쓸 수 없으면 기본값으로 대신 부르지 않고 쉰다(까닭은 로그와 1차 잡의 제 일 못 함으로 보인다).
    await ensureReviewTaskRanks();
    const { rows: queue, settings } = await hints(cursor);
    const ranks = firstReviewRankState(settings);
    if (ranks.degraded && queue.length) {
      if (degradedCode !== ranks.degraded.code) { degradedCode = ranks.degraded.code; logger.warn('pipeline_consumer.degraded', { stage: 'ai1', ...ranks.degraded }); }
      result.deferred++;
      if (halt?.aborted || once) break;
      report?.('idle'); await interruptibleSleep(IDLE_MS, halt); pages = 0; pausedReviewers.clear();
      continue;
    }
    degradedCode = null;
    const blockedReviewers = queue.length ? await readBlockedFirstReviewerKeys() : new Set<string>();
    let deferred = false, completed = false;
    for (const hint of queue) {
      if (halt?.aborted) break;
      // host 예산 거절은 이 hint 하나만 넘기고 쪽을 계속 본다(2026-10-31 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다") —
      // cursor 는 넘기지 않아 다음 패스가 다시 집고, 쪽 끝의 5초 쉼이 되풀이를 막는다
      const host = input.admit
        ? await input.admit('crawl-agent-review').catch(() => ({ admitted: false as const, reason: 'host_budget_unavailable' as const })) : null;
      if (host?.admitted === false) {
        logger.info('pipeline_consumer.deferred', { stage: 'ai1', reason: host.reason });
        result.deferred++; deferred = true; continue;
      }
      cursor = hint;
      result.attempted++; report?.('running', 'crawl-agent-review', Date.now());
      let stop = false;
      try {
        // 순위 대체(PR #792 의 뜻, PR C1 에서 소비자도): 고른 모델이 그 모델만의 까닭으로 거절되면 그 모델을 이 패스 동안 쉬게 하고 같은 후보를 다음 순위로 다시 고른다
        for (let retry = 0; retry <= MAX_RANK_RETRIES; retry++) {
          try {
            const written = await executeFirstReviewConsumerItem({ candidateId: hint.id, owner, signal,
              ...(stopClaims ? { stopClaims } : {}), pausedReviewers, blockedReviewers, reviewerCircuits: input.circuits });
            if (written.state === 'succeeded') { result.recorded++; completed = true; }
            else result.skipped++;
            break;
          } catch (error) {
            if (!(error instanceof ModelCapacityDeferredError)) throw error;
            // 이 후보의 앞선 호출만 아직 보내진 중이거나(dispatched) 같은 후보가 다른 요청에 묶였다(work_busy, fence) — 후보 하나를 건너뛰고
            // 쪽을 계속 본다. 모델을 pause 하지 않는다(2026-10-30 결정; 미확인 행은 더 이상 이 사유를 내지 않는다).
            if (modelCapacityDeferralIsPerWork(error.reason)) { result.skipped++; break; }
            result.deferred++; deferred = true;
            // 그 모델만의 미룸(포화·대기열·정책에 없음·계약 없음·장비 없음): 그 모델만 이 패스 동안 쉬고 같은 후보를 다음 순위로 다시 고른다.
            // 전역 미룸(draining·disabled·정책·owner)은 쪽을 접는다.
            if (error instanceof FirstReviewModelDeferredError && firstReviewDeferralIsLocal(error.reason)) {
              pausedReviewers.add(firstReviewerKey(error.reviewer));
              // Keep the workload member affinity once its admission callback was attempted.
              if (firstReviewRankState(settings).resolution?.execution?.mode === 'workload_pool') break;
              continue;
            }
            stop = true;
            break;
          }
        }
      } finally {
        if (host?.admitted) await host.release().catch(() => {});
        report?.('idle');
      }
      if (stop) break;
    }
    pages++;
    const end = queue.length < PAGE_SIZE;
    if (end && !deferred && !completed) cursor = null;
    if (halt?.aborted || once && (end || deferred || pages >= MAX_PAGES)) break;
    if (completed && !once) pages = 0;
    if (end && !completed || deferred || pages >= MAX_PAGES) {
      report?.('idle'); await interruptibleSleep(IDLE_MS, halt); pages = 0;
      pausedReviewers.clear();
    }
  }
  return result;
}
