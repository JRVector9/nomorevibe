import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { modelCapacityRequests, secondReviews } from '@/lib/db/schema';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel, modelCapacityDeferralIsPerWork } from '@/lib/llm/capacity-deferred';
import type { ProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { logger } from '@/lib/observability/logger';
import type { HostAdmission } from '@/lib/operations/host-budget-runtime';
import { interruptibleSleep, type RuntimeReport } from '@/scripts/worker';
import { executeSecondReviewConsumerItem } from '../second-review-item-lifecycle';
import { ensureReviewTaskRanks } from '../review-task-ranks';
import { secondReviewVotersDegraded } from '../second-review-voters';

// 빈 큐는 1초 뒤 다시 본다 — AI2 행이 생긴 뒤 집기까지의 대기가 종단 지연에 그대로 더해진다. 슬롯 미룸·회로 열림은 5초를 기다린다.
const PAGE_SIZE = 24, MAX_PAGES = 4, IDLE_MS = 1_000, DEFERRED_MS = 5_000;
type Cursor = { id: number; fallback: boolean };
type PriorityCursor = { ordinal: number; id: number };

/** Granted reservations and aged waiting requests can be behind the normal keyset. These are hints,
 * never permits: the lifecycle still checks the full current binding and slot.
 * Rotate separately so stale hints cannot hide another reservation or waiter. */
async function priorityHint(owner: ItemOwner, cursor: PriorityCursor | null, reserved: boolean) {
  const request = modelCapacityRequests;
  const [hint] = await onPrimary(() => db.select({ id: secondReviews.id,
    fallback: sql<boolean>`${secondReviews.fallbackForId} IS NOT NULL`, provider: secondReviews.provider, model: secondReviews.model,
    reserved: sql<boolean>`${reserved}`, ordinal: request.queueOrdinal }).from(request).innerJoin(secondReviews, and(
      eq(secondReviews.status, 'pending'), eq(request.provider, secondReviews.provider), eq(request.model, secondReviews.model),
      sql`${request.logicalWorkKey} = 'ai2:' || ${secondReviews.candidateId}::text || ':' || coalesce(${secondReviews.fallbackForId}, ${secondReviews.id})::text`,
    )).where(and(eq(request.ownerInstanceId, owner.instanceId), eq(request.ownerBootId, owner.bootId),
      eq(request.class, 'second'), eq(request.pool, 'reviewer'), eq(request.routeId, 'second-review'), eq(request.state, reserved ? 'reserved' : 'waiting'),
      // 오래 기다린 엔진 직접 표(local-direct, PR C1 부터 순위 저장이 만든 abcllm 형 직접 계약도)는 같은 투표자 칸의 다음 순위로 넘길 수 있다
      reserved ? sql`${request.reservedUntil} > clock_timestamp()` : and(inArray(request.provider, ['local-direct', 'abcllm']), isNull(secondReviews.fallbackForId),
        sql`${request.queueUntil} > clock_timestamp()`, sql`${request.queuedAt} <= clock_timestamp() - interval '15 seconds'`),
      cursor ? or(gt(request.queueOrdinal, cursor.ordinal),
        and(eq(request.queueOrdinal, cursor.ordinal), gt(secondReviews.id, cursor.id))) : undefined,
    )).orderBy(asc(request.queueOrdinal), asc(secondReviews.id)).limit(1));
  return hint;
}

/** Hints only. The fixed lifecycle rechecks stage, current domain and ownership. */
async function hints(cursor: Cursor | null) {
  const fallback = sql<boolean>`${secondReviews.fallbackForId} IS NOT NULL`;
  return onPrimary(() => db.select({ id: secondReviews.id, fallback, provider: secondReviews.provider, model: secondReviews.model }).from(secondReviews)
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
  /** provider·model 회로. 같은 provider 의 direct 모델 장애가 fallback 모델을 막지 않게 따로 센다 */
  circuits?: ProviderCircuits;
}): Promise<{ attempted: number; recorded: number; skipped: number; deferred: number }> {
  const owner = itemOwnerSchema.parse(input.owner), { signal, once, report, stopClaims } = input;
  const halt = stopClaims ? AbortSignal.any([stopClaims, ...(signal ? [signal] : [])]) : signal;
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const result = { attempted: 0, recorded: 0, skipped: 0, deferred: 0 };
  let cursor: Cursor | null = null, pages = 0;
  let reservedCursor: PriorityCursor | null = null, waitingCursor: PriorityCursor | null = null, resumeFallback = false;
  let degradedCode: string | null = null;
  while (!halt?.aborted) {
    report?.('polling');
    // 「작업 ↔ 모델」 투표자 순위(PR C1): 쪽마다 30초 스냅숏을 새로 받는다. 순위가 없거나·표를 못 읽었거나·모든 칸을 쓸 수 없으면 기본 투표자로 대신 부르지 않고 쉰다
    // (까닭은 로그와 2차 잡의 제 일 못 함으로 보인다)
    await ensureReviewTaskRanks();
    const degraded = secondReviewVotersDegraded();
    if (degraded) {
      if (degradedCode !== degraded.code) { degradedCode = degraded.code; logger.warn('pipeline_consumer.degraded', { stage: 'ai2', ...degraded }); }
      result.deferred++;
      if (halt?.aborted || once) break;
      report?.('idle'); await interruptibleSleep(DEFERRED_MS, halt);
      continue;
    }
    degradedCode = null;
    let reserved = await priorityHint(owner, reservedCursor, true);
    if (!reserved && reservedCursor) {
      reservedCursor = null;
      if (!halt?.aborted) reserved = await priorityHint(owner, null, true);
    }
    if (halt?.aborted) break;
    if (reserved) reservedCursor = { ordinal: reserved.ordinal, id: reserved.id };
    // After a routing change, let its new fallback reach the normal batch before
    // another aged waiter can reroute and end that batch again. Reservations stay first.
    const scanWaiting = !resumeFallback;
    resumeFallback = false;
    let waiting: Awaited<ReturnType<typeof priorityHint>> | undefined = scanWaiting ? await priorityHint(owner, waitingCursor, false) : undefined;
    if (scanWaiting && !waiting && waitingCursor) {
      waitingCursor = null;
      if (!halt?.aborted) waiting = await priorityHint(owner, null, false);
    }
    if (halt?.aborted) break;
    if (waiting) waitingCursor = { ordinal: waiting.ordinal, id: waiting.id };
    const normal = await hints(cursor);
    const priorities = [reserved, waiting].filter(hint => hint !== undefined);
    const queue = [...priorities, ...normal];
    let deferred = false, completed = false, circuitOpen = false, rerouted = false;
    // 그 모델만의 미룸(포화·대기열·정책에 없음·계약 없음·장비 없음)을 받은 provider:model — 이 패스(쪽) 동안만 그 모델의 표를 건너뛰고
    // 다른 모델의 표는 계속 본다(2026-10-31 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다"). 다음 쪽은 다시 한 번 묻는다.
    const pausedModels = new Set<string>();
    for (const hint of queue) {
      if (halt?.aborted || once && result.attempted >= 100) break;
      const priority = hint === reserved || hint === waiting;
      if (!priority && priorities.some(prioritized => hint.id === prioritized.id)) {
        cursor = { id: hint.id, fallback: hint.fallback };
        continue;
      }
      const modelKey = `${hint.provider ?? 'unknown'}:${hint.model ?? 'unknown'}`;
      if (pausedModels.has(modelKey)) {
        if (!priority) cursor = { id: hint.id, fallback: hint.fallback };
        result.deferred++; continue;
      }
      // 회로가 열린 provider·model 의 표만 claim 없이 건너뛰고 다른 모델은 계속 본다
      const circuit = input.circuits?.admit(`ai2:${modelKey}`);
      if (circuit?.admitted === false) {
        if (!priority) cursor = { id: hint.id, fallback: hint.fallback };
        result.deferred++; circuitOpen = true; continue;
      }
      // host 예산 거절은 이 hint 하나만 넘기고 쪽을 계속 본다 — cursor 는 넘기지 않아 다음 패스가 다시 집고, 쪽 끝의 5초 쉼이 되풀이를 막는다
      const host = input.admit
        ? await input.admit('second-review').catch(() => ({ admitted: false as const, reason: 'host_budget_unavailable' as const })) : null;
      if (host?.admitted === false) {
        circuit?.done(); logger.info('pipeline_consumer.deferred', { stage: 'ai2', reason: host.reason });
        result.deferred++; deferred = true; continue;
      }
      if (!priority) cursor = { id: hint.id, fallback: hint.fallback };
      result.attempted++;
      report?.('running', 'second-review', Date.now());
      try {
        // One awaited lane; neither pool ownership nor HTTP crosses the hint query.
        const written = await executeSecondReviewConsumerItem({ secondReviewId: hint.id, owner, signal,
          ...(stopClaims ? { stopClaims } : {}), ...(circuit ? { onProviderResult: circuit.record } : {}) });
        if (written.state === 'rerouted') {
          result.skipped++; cursor = null; rerouted = true; resumeFallback = true;
          break;
        }
        if (written.state === 'recorded') { result.recorded++; completed = true; }
        else result.skipped++;
      } catch (error) {
        if (!(error instanceof ModelCapacityDeferredError)) throw error;
        // 이 항목만의 미룸 — 앞선 호출이 아직 보내진 중(dispatched)이거나 같은 항목이 다른 요청에 묶였다(work_busy, fence; AI1 과 같은 #754 처리),
        // 장부 세대가 어긋났다(ledger_mismatch). 항목 하나를 건너뛰고 쪽을 계속 본다(미확인 행은 더 이상 이 사유를 내지 않는다).
        if (modelCapacityDeferralIsPerWork(error.reason)) { result.skipped++; continue; }
        result.deferred++;
        // 그 모델만의 미룸 — 이 쪽에서 그 provider:model 의 남은 표만 건너뛰고 다른 모델의 표는 계속 본다
        if (modelCapacityDeferralIsPerModel(error.reason)) { pausedModels.add(modelKey); continue; }
        // 전역 미룸(draining·disabled·정책·owner) — 어느 모델에도 새 요청을 낼 수 없다. 쪽을 접고 cursor 를 지킨 채 5초 쉰다
        deferred = true;
        if (!priority) break;
      } finally {
        circuit?.done();
        if (host?.admitted) await host.release().catch(() => {});
        report?.('idle');
      }
    }
    pages++;
    if (rerouted) {
      if (once && (pages >= MAX_PAGES || result.attempted >= 100)) break;
      if (!once) pages = 0;
      continue;
    }
    const end = normal.length < PAGE_SIZE;
    // An empty normal keyset reached EOF independently of the priority hint.
    // Repeated stale reservation deferrals must not pin it beyond the last row.
    if (normal.length === 0 || end && !deferred && !completed) cursor = null;
    if (halt?.aborted || once && (end || deferred || pages >= MAX_PAGES)) break;
    if (completed && !once) pages = 0;
    // Bound scans even when every pending row remains busy. Keep the keyset
    // across this backoff so low IDs cannot monopolize every pass.
    if (end && !completed || deferred || pages >= MAX_PAGES) {
      report?.('idle');
      await interruptibleSleep(deferred || circuitOpen || pausedModels.size ? DEFERRED_MS : IDLE_MS, halt);
      pages = 0;
    }
  }
  return result;
}
