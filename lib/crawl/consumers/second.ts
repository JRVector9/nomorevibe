import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { secondReviews } from '@/lib/db/schema';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import type { ProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { logger } from '@/lib/observability/logger';
import type { HostAdmission } from '@/lib/operations/host-budget-runtime';
import { interruptibleSleep, type RuntimeReport } from '@/scripts/worker';
import { executeSecondReviewConsumerItem } from '../second-review-item-lifecycle';

// 빈 큐는 1초 뒤 다시 본다 — AI2 행이 생긴 뒤 집기까지의 대기가 종단 지연에 그대로 더해진다. 슬롯 미룸은 5초를 기다린다.
const PAGE_SIZE = 24, MAX_PAGES = 4, IDLE_MS = 1_000, DEFERRED_MS = 5_000;
type Cursor = { id: number; fallback: boolean };

/** Hints only. The fixed lifecycle rechecks stage, current domain and ownership. */
async function hints(cursor: Cursor | null) {
  const fallback = sql<boolean>`${secondReviews.fallbackForId} IS NOT NULL`;
  return onPrimary(() => db.select({ id: secondReviews.id, fallback, provider: secondReviews.provider }).from(secondReviews)
    .where(and(eq(secondReviews.status, 'pending'), cursor ? or(
      and(eq(fallback, cursor.fallback), gt(secondReviews.id, cursor.id)),
      cursor.fallback ? isNull(secondReviews.fallbackForId) : undefined,
    ) : undefined)).orderBy(desc(fallback), secondReviews.id).limit(PAGE_SIZE));
}

export async function runSecondReviewConsumer(input: {
  owner: ItemOwner; signal?: AbortSignal; once?: boolean; report?: RuntimeReport;
  /** 새 hint·claim 만 멈추는 신호. 이미 보낸 호출은 signal 이 끊을 때까지 끝낸다(replay 구간 끝 drain). 없으면 signal 과 같다 */
  stopClaims?: AbortSignal;
  /** host 합계 장부(PR10e). 없으면 기존처럼 바로 claim 한다 */
  admit?: (job: string) => Promise<HostAdmission>;
  /** provider 회로(PR06e). 표마다 provider 가 달라 provider 마다(ai2:<provider>) 센다 */
  circuits?: ProviderCircuits;
}): Promise<{ attempted: number; recorded: number; skipped: number; deferred: number }> {
  const owner = itemOwnerSchema.parse(input.owner), { signal, once, report, stopClaims } = input;
  const halt = stopClaims ? AbortSignal.any([stopClaims, ...(signal ? [signal] : [])]) : signal;
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const result = { attempted: 0, recorded: 0, skipped: 0, deferred: 0 };
  let cursor: Cursor | null = null, pages = 0;
  while (!halt?.aborted) {
    report?.('polling');
    const queue = await hints(cursor);
    let deferred = false, completed = false;
    for (const hint of queue) {
      if (halt?.aborted) break;
      // 회로가 열린 provider 의 표는 claim 없이 건너뛰고 다른 provider 의 표는 계속 본다
      const circuit = input.circuits?.admit(`ai2:${hint.provider ?? 'unknown'}`);
      if (circuit?.admitted === false) { cursor = { id: hint.id, fallback: hint.fallback }; result.deferred++; continue; }
      // host 예산은 프로세스 전체라 모자라면 이 hint 앞에서 쉰다(cursor 를 넘기지 않음)
      const host = input.admit
        ? await input.admit('second-review').catch(() => ({ admitted: false as const, reason: 'host_budget_unavailable' as const })) : null;
      if (host?.admitted === false) {
        circuit?.done(); logger.info('pipeline_consumer.deferred', { stage: 'ai2', reason: host.reason });
        result.deferred++; deferred = true; break;
      }
      cursor = { id: hint.id, fallback: hint.fallback };
      result.attempted++;
      report?.('running', 'second-review', Date.now());
      try {
        // One awaited lane; neither pool ownership nor HTTP crosses the hint query.
        const written = await executeSecondReviewConsumerItem({ secondReviewId: hint.id, owner, signal,
          ...(stopClaims ? { stopClaims } : {}), ...(circuit ? { onProviderResult: circuit.record } : {}) });
        if (written.state === 'recorded') { result.recorded++; completed = true; }
        else result.skipped++;
      } catch (error) {
        if (!(error instanceof ModelCapacityDeferredError)) throw error;
        result.deferred++; deferred = true;
        break;
      } finally {
        circuit?.done();
        if (host?.admitted) await host.release().catch(() => {});
        report?.('idle');
      }
    }
    pages++;
    const end = queue.length < PAGE_SIZE;
    if (end && !deferred && !completed) cursor = null;
    if (halt?.aborted || once && (end || deferred || pages >= MAX_PAGES)) break;
    if (completed && !once) pages = 0;
    // Bound scans even when every pending row remains busy. Keep the keyset
    // across this backoff so low IDs cannot monopolize every pass.
    if (end && !completed || deferred || pages >= MAX_PAGES) {
      report?.('idle');
      await interruptibleSleep(deferred ? DEFERRED_MS : IDLE_MS, halt);
      pages = 0;
    }
  }
  return result;
}
