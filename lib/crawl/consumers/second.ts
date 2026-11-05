import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { modelCapacityRequests, secondReviews } from '@/lib/db/schema';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel, modelCapacityDeferralIsPerWork } from '@/lib/llm/capacity-deferred';
import type { ProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { logger } from '@/lib/observability/logger';
import { jobKnob } from '@/lib/operations/runtime-settings-schema';
import { runtimeSettings } from '@/lib/operations/runtime-settings-store';
import { readAiTaskExecutionConfig } from '@/lib/llm/ai-task-execution-snapshot';
import type { HostAdmission } from '@/lib/operations/host-budget-runtime';
import { interruptibleSleep, type RuntimeReport } from '@/scripts/worker';
import { executeSecondReviewConsumerItem } from '../second-review-item-lifecycle';
import { ensureReviewTaskRanks } from '../review-task-ranks';
import { secondReviewVotersDegraded } from '../second-review-voters';
import { secondReviewHasWorkloadPool, secondReviewWorkloadSlots } from '../second-review-workload';

// 빈 큐는 1초 뒤 다시 본다 — AI2 행이 생긴 뒤 집기까지의 대기가 종단 지연에 그대로 더해진다. 슬롯 미룸·회로 열림은 5초를 기다린다.
const PAGE_SIZE = 24, MAX_PAGES = 4, IDLE_MS = 1_000, DEFERRED_MS = 5_000;
type Cursor = { id: number; fallback: boolean };
type PriorityCursor = { ordinal: number; id: number };

/** Granted reservations and aged waiting requests can be behind the normal keyset. These are hints,
 * never permits: the lifecycle still checks the full current binding and slot.
 * Rotate separately so stale hints cannot hide another reservation or waiter. */
async function priorityHint(owner: ItemOwner, cursor: PriorityCursor | null, reserved: boolean) {
  const request = modelCapacityRequests;
  const [hint] = await onPrimary(() => db.select({ id: secondReviews.id, candidateId: secondReviews.candidateId,
    vote: sql<number>`coalesce(${secondReviews.fallbackForId}, ${secondReviews.id})`,
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
  return onPrimary(() => db.select({ id: secondReviews.id, candidateId: secondReviews.candidateId,
    vote: sql<number>`coalesce(${secondReviews.fallbackForId}, ${secondReviews.id})`, fallback, provider: secondReviews.provider, model: secondReviews.model }).from(secondReviews)
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
      // A pool switch must not hide an already-existing legacy vote/reservation.
      // This only scans hints: the fixed row/domain/contract/capacity claim still authorizes every execution.
      const legacyContinuation = secondReviewHasWorkloadPool() && secondReviewWorkloadSlots()[0].legacy
        .some(candidate => candidate.binding && !candidate.unusable);
      if (!legacyContinuation) {
        result.deferred++;
        if (halt?.aborted || once) break;
        report?.('idle'); await interruptibleSleep(DEFERRED_MS, halt);
        continue;
      }
    } else degradedCode = null;
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
    const concurrency = jobKnob(runtimeSettings(), 'second-review', 'consumerConcurrency');
    // Preserve the serial fallback's quiet behavior; these observations describe pool/parallel work only.
    const observeWorkload = concurrency > 1 || readAiTaskExecutionConfig('second-review', 1).mode === 'workload_pool';
    const active = new Map<number, number>(), scheduledVotes = new Set<number>();
    let next = 0, stopNewClaims = false, normalPosition = -1, peak = 0, validatedInputHints = 0;
    const inputReadyCandidates = new Set<number>();
    const advance = (hint: (typeof queue)[number]) => {
      const position = normal.indexOf(hint);
      if (position > normalPosition) { normalPosition = position; cursor = { id: hint.id, fallback: hint.fallback }; }
    };
    const reportActive = () => {
      if (active.size) report?.('running', 'second-review', Math.min(...active.values()));
      else report?.('idle');
    };
    // 그 모델만의 미룸(포화·대기열·정책에 없음·계약 없음·장비 없음)을 받은 provider:model — 이 패스(쪽) 동안만 그 모델의 표를 건너뛰고
    // 다른 모델의 표는 계속 본다(2026-10-31 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다"). 다음 쪽은 다시 한 번 묻는다.
    const pausedModels = new Set<string>();
    const execute = async (hint: (typeof queue)[number]) => {
      if (halt?.aborted || stopNewClaims) return;
      const priority = hint === reserved || hint === waiting;
      // Root/fallback/priority hints for one vote share one lifecycle in this pass.
      if (scheduledVotes.has(hint.vote)) { if (!priority) advance(hint); return; }
      scheduledVotes.add(hint.vote);
      const modelKey = `${hint.provider ?? 'unknown'}:${hint.model ?? 'unknown'}`;
      if (pausedModels.has(modelKey)) {
        if (!priority) advance(hint);
        result.deferred++; return;
      }
      const circuit = input.circuits?.admit(`ai2:${modelKey}`);
      if (circuit?.admitted === false) {
        if (!priority) advance(hint);
        result.deferred++; circuitOpen = true; return;
      }
      let host: HostAdmission | null = null;
      try {
        host = input.admit
          ? await input.admit('second-review').catch(() => ({ admitted: false as const, reason: 'host_budget_unavailable' as const })) : null;
        if (host?.admitted === false) {
          logger.info('pipeline_consumer.deferred', { stage: 'ai2', reason: host.reason });
          result.deferred++; deferred = true; return;
        }
        // A sibling can stop admission while this lifecycle awaits its host permit.
        if (halt?.aborted || stopNewClaims || once && result.attempted >= 100) return;
        if (!priority) advance(hint);
        result.attempted++;
        active.set(hint.id, Date.now()); peak = Math.max(peak, active.size); reportActive();
        const written = await executeSecondReviewConsumerItem({ secondReviewId: hint.id, owner, signal,
          ...(stopClaims ? { stopClaims } : {}), ...(circuit ? { onProviderResult: circuit.record } : {}),
          onInputReady: () => { validatedInputHints++; inputReadyCandidates.add(hint.candidateId); } });
        if (written.state === 'rerouted') {
          result.skipped++; cursor = null; rerouted = true; resumeFallback = true; stopNewClaims = true;
          return;
        }
        if (written.state === 'recorded') { result.recorded++; completed = true; }
        else {
          result.skipped++;
          if (observeWorkload) logger.info('pipeline_consumer.claim_skipped', { stage: 'ai2', reason: 'reason' in written ? written.reason : written.state });
        }
      } catch (error) {
        if (!(error instanceof ModelCapacityDeferredError)) { stopNewClaims = true; throw error; }
        if (modelCapacityDeferralIsPerWork(error.reason)) { result.skipped++; return; }
        result.deferred++;
        if (observeWorkload) logger.info('pipeline_consumer.deferred', { stage: 'ai2', reason: error.reason });
        if (modelCapacityDeferralIsPerModel(error.reason)) { pausedModels.add(modelKey); return; }
        // Global denial stops NEW claims; already admitted lifecycles still finish.
        deferred = true; stopNewClaims = true;
      } finally {
        circuit?.done();
        if (host?.admitted) await host.release().catch(() => {});
        active.delete(hint.id); reportActive();
      }
    };
    // The limit is lifecycle work, not votes/member count or a physical-slot grant.
    const lanes = Array.from({ length: concurrency }, async () => {
      while (next < queue.length && !halt?.aborted && !stopNewClaims && !(once && result.attempted >= 100)) {
        try { await execute(queue[next++]); }
        catch (error) { stopNewClaims = true; throw error; }
      }
    });
    const outcomes = await Promise.allSettled(lanes);
    if (observeWorkload) logger.info('pipeline_consumer.page', { stage: 'ai2', pendingHints: normal.length,
      uniqueCandidateHints: new Set(normal.map(hint => hint.candidateId)).size,
      scheduledVotes: scheduledVotes.size, validatedInputHints, inputReadyCandidateHints: inputReadyCandidates.size, lifecycleLimit: concurrency, lifecyclePeak: peak,
      rerouted, deferred });
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'second_review_lifecycles_failed');
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
    if (halt?.aborted || once && (end || deferred || pages >= MAX_PAGES || result.attempted >= 100)) break;
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
