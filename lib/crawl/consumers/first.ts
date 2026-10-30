import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { crawlCandidates, crawlReviewAttempts } from '@/lib/db/schema';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import type { ProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { logger } from '@/lib/observability/logger';
import type { HostAdmission } from '@/lib/operations/host-budget-runtime';
import { interruptibleSleep, type RuntimeReport } from '@/scripts/worker';
import { getSettings } from '../settings';
import { reviewCandidatePredicate } from '../agent-review-repository';
import { executeFirstReviewConsumerItem } from '../agent-review-item-lifecycle';
import { FirstReviewModelDeferredError, firstReviewDeferralIsLocal, firstReviewerKey } from '../first-reviewers';
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
    return { rows, poolEnabled: settings.firstReviewAdditional !== undefined };
  });
}
export async function runFirstReviewConsumer(input: {
  owner: ItemOwner; signal?: AbortSignal; once?: boolean; report?: RuntimeReport;
  /** 새 hint·claim 만 멈추는 신호. 이미 보낸 호출은 signal 이 끊을 때까지 끝낸다(replay 구간 끝 drain). 없으면 signal 과 같다 */
  stopClaims?: AbortSignal;
  /** host 합계 장부(PR10e). 없으면 기존처럼 바로 claim 한다 */
  admit?: (job: string) => Promise<HostAdmission>;
  /** 기존 단일 회로를 유지하고, additive pool은 선택된 모델별로 회로를 나눈다. */
  circuits?: ProviderCircuits;
}): Promise<{ attempted: number; recorded: number; skipped: number; deferred: number }> {
  const owner = itemOwnerSchema.parse(input.owner), { signal, once, report, stopClaims } = input;
  const halt = stopClaims ? AbortSignal.any([stopClaims, ...(signal ? [signal] : [])]) : signal;
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const result = { attempted: 0, recorded: 0, skipped: 0, deferred: 0 };
  let cursor: Cursor | null = null, pages = 0;
  const pausedReviewers = new Set<string>();
  while (!halt?.aborted) {
    report?.('polling');
    const { rows: queue, poolEnabled } = await hints(cursor);
    const blockedReviewers = poolEnabled && queue.length ? await readBlockedFirstReviewerKeys() : new Set<string>();
    let deferred = false, completed = false;
    for (const hint of queue) {
      if (halt?.aborted) break;
      // claim 전 관문: 회로가 열렸거나 host 예산이 모자라면 claim·실패 기록 없이 이 hint 앞에서 쉰다(cursor 를 넘기지 않음)
      const circuit = poolEnabled ? undefined : input.circuits?.admit('ai1');
      const host = circuit?.admitted === false || !input.admit ? null
        : await input.admit('crawl-agent-review').catch(() => ({ admitted: false as const, reason: 'host_budget_unavailable' as const }));
      if (circuit?.admitted === false || host?.admitted === false) {
        if (circuit?.admitted) circuit.done();
        if (host?.admitted === false) logger.info('pipeline_consumer.deferred', { stage: 'ai1', reason: host.reason });
        result.deferred++; deferred = true; break;
      }
      cursor = hint;
      result.attempted++; report?.('running', 'crawl-agent-review', Date.now());
      try {
        const written = await executeFirstReviewConsumerItem({ candidateId: hint.id, owner, signal,
          ...(stopClaims ? { stopClaims } : {}), ...(circuit?.admitted ? { onProviderResult: circuit.record } : {}),
          ...(poolEnabled ? { pausedReviewers, blockedReviewers, reviewerCircuits: input.circuits } : {}) });
        if (written.state === 'succeeded') { result.recorded++; completed = true; }
        else result.skipped++;
      } catch (error) {
        if (!(error instanceof ModelCapacityDeferredError)) throw error;
        // 이 후보의 앞선 호출만 아직 보내진 중이다 — 후보 하나를 건너뛰고 쪽을 계속 본다(미확인 행은 더 이상 이 사유를 내지 않는다).
        if (error.reason === 'dispatched') { result.skipped++; continue; }
        result.deferred++; deferred = true;
        if (error instanceof FirstReviewModelDeferredError && firstReviewDeferralIsLocal(error.reason)) {
          pausedReviewers.add(firstReviewerKey(error.reviewer));
          continue;
        }
        break;
      } finally {
        if (circuit?.admitted) circuit.done();
        if (host?.admitted) await host.release().catch(() => {});
        report?.('idle');
      }
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
