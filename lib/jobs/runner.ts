import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { jobs, operationsObservations } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { assertReplayJobAdmission } from "@/lib/operations/pipeline-replay-execution";
import { JobLeaseLostError, assertJobLeaseAtWallTime, requestJob, type JobLease } from "./control";
import { STALE_LOCK_MS } from "./lease";
import { assertJobBatchAdmission, batchResultObservation, JobBatchBlockedError, type BatchExecutionIdentity } from "./batch-repository";
import { PAUSED_AFTER_MS } from "./status";
import { assertRoleLease, RoleLeaseLostError, type RoleLease } from "./role-leader";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { COLLECTOR_NAMES, createTally, jobTallyUpsert } from "./tally";
// 누적 실패는 오류 code·잘린 message 만 — drizzle 이 감싼 message 의 SQL·params 를 로그에 남기지 않는다
import { dbErrorFields } from "@/lib/db/error-fields";

/** Existing bounded handlers keep their cursors; execution ownership belongs to this runner. */
export type JobContext<C> = {
  cursor: C | null;
  save: (cursor: C) => Promise<void>;
  hasBudget: () => boolean;
  deadlineAt?: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  lease?: JobLease;
  /**
   * 멈추라는 신호. 바깥을 오래 기다리는 작업(모델 호출 등)에 그대로 넘긴다.
   *
   * 넘기지 않으면 종료 신호를 받고도 그 호출이 끝날 때까지(최대 1분) 프로세스가 남고,
   * 컨테이너가 먼저 죽어 잠금이 그대로 남는다 — 다음 컨테이너는 그 잠금이 만료될 때까지 논다.
   */
  signal?: AbortSignal;
};
export type JobDeferredReason = "stage_blocked" | "http_origin_permit" | "model_capacity" | "source_buffer";
/**
 * 돌았지만 제 일을 못 했다 — 검색이 실패했거나, 설정·키·서버가 없어 아무것도 하지 않았거나, 판정을 보류한 틱.
 *
 * 처리기가 실패를 잡고 그냥 돌아오면 러너는 그 틱을 성공으로 적었다(lastSuccessAt=now, lastError=null) — 운영센터는 초록이었다.
 * 이것을 돌려주면 러너는 요청·커서·잠금은 성공처럼 정리하되(같은 일을 30초마다 다시 두드리지 않는다) 성공 시각은 옮기지 않고,
 * job:<name> 관측에 까닭(code·detail)과 연속 횟수(streak)·시작 시각(since)을 남긴다. 조치할 일(job-health.ts)이 그것으로 경보한다.
 * - code: 짧은 소문자 코드(no_key·search_failed …). 모양이 틀리면 "unknown" 으로 적는다
 * - detail: 사람이 읽을 짧은 까닭(300자까지). 비밀·주소·본문을 넣지 않는다
 * - critical: 기다려도 풀리지 않고 해가 큰 것(자격 거절 등) — 연속 횟수를 기다리지 않고 바로 긴급으로 올린다
 */
export type JobDegraded = { code: string; detail?: string | null; critical?: boolean };
export type JobOutcome<C> = { done: boolean; cursor?: C | null; continuation?: "ready"; deferred?: never; degraded?: JobDegraded }
  | { done: false; deferred: JobDeferredReason; cursor?: never; continuation?: never; degraded?: never };
export type RunResult =
  | { status: "completed"; done: boolean; durationMs: number; sourceContinuation?: true; degraded?: string }
  | { status: "skipped"; reason: "locked" | "not_requested" | "backoff" | "stopping" }
  | { status: "deferred"; reason: JobDeferredReason; durationMs: number }
  | { status: "failed"; error: string; durationMs: number };

/**
 * 주인이 사라진 잠금을 언제 넘겨받나.
 *
 * 심장 박동이 15초마다 lockedAt 을 갱신하므로 살아 있는 주인은 늘 최신이다. 10분이던 때는
 * 배포 때마다 2차 심사가 그만큼 놀았다(2026-09-12 실측 6분간 분당 0.3건). 여섯 번을 놓치면
 * 죽은 것으로 본다.
 */
const LEASE_TAKEOVER = sql`now() - ${STALE_LOCK_MS} * interval '1 millisecond'`;
/**
 * 사람이 멈춘 작업(not_before 가 먼 미래, lib/jobs/status.ts)인가. 도는 중에 멈출 수 있다 — 틱을 끝내며
 * not_before 를 지우거나 30초 재시도로 덮으면 멈춘 작업이 저절로 다시 돈다.
 */
const PAUSED = sql`${jobs.notBefore} > now() + ${PAUSED_AFTER_MS} * interval '1 millisecond'`;

const DEGRADED_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** job:<name> 관측에 싣는 제 일 못 한 틱 — 모양을 고정한다(화면이 그대로 읽는다) */
export function degradedObservation(degraded: JobDegraded, at: Date) {
  const detail = typeof degraded.detail === "string" ? degraded.detail.replaceAll("\0", "").slice(0, 300) : "";
  const iso = at.toISOString();
  return { code: DEGRADED_CODE.test(degraded.code) ? degraded.code : "unknown", detail: detail || null,
    critical: degraded.critical === true, at: iso, streak: 1, since: iso };
}

/**
 * job:<name> 덮어쓰기. 이번 틱이 제 일 못 한 틱이면 지난 줄의 연속 횟수에 1을 더하고 시작 시각을 이어받는다.
 * 제대로 끝난 틱이면 연속을 끊고, 마지막으로 못 한 까닭은 lastDegraded 로 남긴다(관리자 화면의 "마지막 오류").
 */
const JOB_OBSERVATION_MERGE = sql`excluded.value || CASE
  WHEN jsonb_typeof(excluded.value->'degraded') = 'object' THEN jsonb_build_object('degraded', (excluded.value->'degraded') || jsonb_build_object(
    'streak', CASE WHEN jsonb_typeof(${operationsObservations.value}->'degraded'->'streak') = 'number'
      THEN least((${operationsObservations.value}->'degraded'->>'streak')::numeric + 1, 1000000000) ELSE 1 END,
    'since', CASE WHEN jsonb_typeof(${operationsObservations.value}->'degraded'->'since') = 'string'
      THEN ${operationsObservations.value}->'degraded'->'since' ELSE excluded.value->'degraded'->'at' END))
  WHEN jsonb_typeof(${operationsObservations.value}->'degraded') = 'object'
    THEN jsonb_build_object('lastDegraded', ${operationsObservations.value}->'degraded')
  WHEN jsonb_typeof(${operationsObservations.value}->'lastDegraded') = 'object'
    THEN jsonb_build_object('lastDegraded', ${operationsObservations.value}->'lastDegraded')
  ELSE '{}'::jsonb END`;

export async function runJob<C>(
  name: string,
  handler: (ctx: JobContext<C>) => Promise<JobOutcome<C>>,
  options: { budgetMs?: number; requestedOnly?: boolean; signal?: AbortSignal; roleLease?: RoleLease;
    /** 미룬 이유 관측(defer:<job>, lib/jobs/deferral-observation.ts). 결과·lease·일정에는 끼어들지 않고, 실패해도 무시한다 */
    onDeferred?: (reason: JobDeferredReason | "batch_blocked") => Promise<void>;
    /**
     * 수집기 회차 누적(job-tally:<job>, lib/jobs/tally.ts)을 남길지 — 미룸 관측처럼 워커(scripts/worker.ts)가 켠다.
     * 직접 부른 한 틱(시험·운영 확인 스크립트)은 남기지 않는다. 결과·lease·일정에는 끼어들지 않는다
     */
    tally?: boolean } = {},
): Promise<RunResult> {
  const noteDeferred = async (reason: JobDeferredReason | "batch_blocked") => {
    try { await options.onDeferred?.(reason); } catch { /* 관측 실패는 틱 결과를 바꾸지 않는다 */ }
  };
  // Dedicated replay scopes consume only these two existing review handlers.
  // Check before even a stopping return, and before role leadership or a DB claim.
  if (currentReplayDb()) {
    if (name !== "crawl-agent-review" && name !== "second-review") throw new Error("replay_job_not_allowed");
    if (options.roleLease) throw new Error("replay_role_lease_rejected");
  }
  if (options.signal?.aborted) return { status: "skipped", reason: "stopping" };
  const startedAt = Date.now();
  const token = randomUUID();
  let batchIdentity: BatchExecutionIdentity | null = null;
  let claimed: { cursor: unknown; requestedVersion: number } | undefined;
  try {
    [claimed] = await db.transaction(async tx => {
      await assertReplayJobAdmission(tx);
      // currentReplayDb revalidates the private verified DB/scope brand. Fixed v5/v6
      // replay profiles have an explicit legacy job-batch contract, independent of item mode.
      // Ordinary runtime callers always acquire the batch lock in this same claim TX.
      // DR writer fence가 그 앞의 첫 lock이다(seal의 fence UPDATE → batch → role → jobs와 같은 순서). fenced DB는 새 job을 claim하지 않는다.
      // 격리 replay DB는 batch admission처럼 fence도 건너뛴다(고정 handler profile에 fence 권한이 없다).
      if (!currentReplayDb()) {
        if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
        batchIdentity = await assertJobBatchAdmission(tx, name, options.roleLease);
      }
      if (options.roleLease) await assertRoleLease(tx, options.roleLease);
      await tx.insert(jobs).values({ name }).onConflictDoNothing();
      return tx.update(jobs).set({
    lockedAt: sql`now()`, lastRunAt: sql`now()`, updatedAt: sql`now()`,
    leaseToken: token, runs: sql`${jobs.runs} + 1`,
    // Direct callers retain one-tick behavior. Workers only consume an existing request.
    ...(options.requestedOnly ? {} : {
      requestedVersion: sql`greatest(${jobs.requestedVersion}, ${jobs.processedVersion}) + 1`,
    }),
      }).where(and(
    eq(jobs.name, name),
    or(isNull(jobs.lockedAt), sql`${jobs.lockedAt} < ${LEASE_TAKEOVER}`),
    sql`${jobs.requestedVersion} < 9007199254740991`,
    ...(options.requestedOnly ? [
      sql`${jobs.requestedVersion} > ${jobs.processedVersion}`,
      or(isNull(jobs.notBefore), sql`${jobs.notBefore} <= now()`),
    ] : []),
      )).returning({ cursor: jobs.cursor, requestedVersion: jobs.requestedVersion });
    });
  } catch (error) {
    if (error instanceof JobBatchBlockedError) await noteDeferred("batch_blocked");
    if (error instanceof RoleLeaseLostError || error instanceof JobBatchBlockedError || error instanceof DrWriterFencedError) return { status: 'skipped', reason: 'stopping' };
    throw error;
  }
  if (!claimed) {
    const state = await getJobState(name);
    const reason = options.requestedOnly && state && state.requestedVersion <= state.processedVersion
      ? "not_requested" : options.requestedOnly && state?.notBefore && state.notBefore > new Date()
        ? "backoff" : "locked";
    return { status: "skipped", reason };
  }

  const lease: JobLease = { name, token, requestedVersion: claimed.requestedVersion };
  const owned = and(eq(jobs.name, name), eq(jobs.leaseToken, token),
    sql`${jobs.lockedAt} >= ${LEASE_TAKEOVER}`);
  let cursor = (claimed.cursor ?? null) as C | null;
  let lost = false;
  let renewing: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = (async () => {
      const [row] = await db.update(jobs).set({ lockedAt: sql`now()`, workerSeenAt: sql`now()` })
        .where(owned).returning({ name: jobs.name });
      if (!row) lost = true;
    })().catch(() => { lost = true; }).finally(() => { renewing = null; });
  }, 15_000);
  timer.unref();
  const stopHeartbeat = async () => { clearInterval(timer); await renewing; };
  const events: Array<{event:string;counts:Record<string,number|boolean>}> = [];
  // 수집기 회차 누적(job-tally:<job>, lib/jobs/tally.ts) — 관측의 마지막 12개가 아니라 이 틱의 모든 이벤트를 더한다. 격리 replay 는 쓰지 않는다
  const tally = options.tally === true && COLLECTOR_NAMES.has(name) && !currentReplayDb() ? createTally() : null;
  const ctx: JobContext<C> = {
    get cursor() { return cursor; },
    lease,
    signal: options.signal,
    deadlineAt: startedAt + (options.budgetMs ?? 25_000),
    save: async next => {
      if (lost) throw new JobLeaseLostError();
      const [row] = await db.update(jobs).set({ cursor: next, updatedAt: sql`now()` })
        .where(owned).returning({ name: jobs.name });
      if (!row) { lost = true; throw new JobLeaseLostError(); }
      cursor = next;
    },
    hasBudget: () => !lost && !options.signal?.aborted && Date.now() - startedAt < (options.budgetMs ?? 25_000),
    log: (event, fields) => {
      logger.info(event, { job: name, ...fields });
      const entry = {event:event.slice(0,100),counts:Object.fromEntries(Object.entries(fields ?? {}).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean')) as Record<string,number|boolean>};
      events.push(entry);
      if(events.length>12)events.shift();
      tally?.add(entry);
    },
  };
  try {
    let outcome: JobOutcome<C>;
    try { outcome = await handler(ctx); } catch (error) {
      if (error instanceof HttpOriginPermitError) outcome = { done: false, deferred: "http_origin_permit" };
      else if (error instanceof ModelCapacityDeferredError) outcome = { done: false, deferred: "model_capacity" };
      else throw error;
    }
    await stopHeartbeat();
    if (lost) throw new JobLeaseLostError();
    if (outcome.deferred) {
      // No work was acknowledged. Preserve producer signals, cursor, pause and
      // historical success/error fields, including changes made during this tick.
      const release = async (tx: typeof db | ProductTransaction) => {
        return tx.update(jobs).set({ lockedAt: null, leaseToken: null })
          .where(owned).returning({ name: jobs.name });
      };
      const [row] = outcome.deferred === "http_origin_permit" || outcome.deferred === "model_capacity" || outcome.deferred === "source_buffer"
        ? await db.transaction(async tx => {
          // DR writer fence 가 이 release TX 의 첫 lock 이다(seal 의 fence UPDATE → … → jobs 와 같은 순서). fenced DB 에는 쓰지 않는다
          if (!currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
          await assertJobLeaseAtWallTime(tx, lease, "update");
          return release(tx);
        }) : await release(db);
      if (!row) throw new JobLeaseLostError();
      const durationMs = Date.now() - startedAt;
      logger.info("job.deferred", { job: name, reason: outcome.deferred, durationMs });
      await noteDeferred(outcome.deferred);
      return { status: "deferred", reason: outcome.deferred, durationMs };
    }
    const budgetMs = options.budgetMs ?? 25_000;
    const sourceReady = ["product-evidence-refresh", "product-site-evidence-refresh"].includes(name) && outcome.done === false
      && outcome.continuation === "ready" && !options.signal?.aborted && Date.now() - startedAt >= budgetMs;
    // 제작 근거 스캔도 남은 일을 알리면 여기서 다시 요청한다 — 다음 틱이 scheduler 의 다음 요청(1분)을 기다리지 않는다
    const reviewReady = outcome.continuation === "ready"
      && ["crawl-agent-review", "second-review", "agent-evidence-refresh"].includes(name) && !options.signal?.aborted;
    let sourceContinuation = false;
    await db.transaction(async tx => {
      // DR writer fence 가 ACK TX 의 첫 lock 이다(seal 의 fence UPDATE → … → jobs 와 같은 순서; jobs → fence 는 그 UPDATE 와 교착한다).
      // handler 가 도는 사이 fence 됐으면 ACK·결과 관측을 commit 하지 않는다. 격리 replay DB 는 claim 처럼 건너뛴다.
      if (!currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      const [row] = await tx.update(jobs).set({
        // done은 "지금 할 일이 없다", cursor는 "내 상태"다. 둘을 묶으면 이어서 훑어야 하는
        // 작업이 완료를 알릴 때마다 진행 위치를 잃는다. 커서를 명시하면 그것을 따르고,
        // 말이 없으면 종전대로 done에서 비운다.
        cursor: (outcome.cursor !== undefined ? outcome.cursor : (outcome.done ? null : cursor)) as never,
        processedVersion: lease.requestedVersion,
        ...(sourceReady || reviewReady ? {
          requestedVersion: sourceReady
            ? sql`case when ${jobs.notBefore} is not null and ${jobs.notBefore} > now() then ${jobs.requestedVersion}
                when ${jobs.requestedVersion} = ${lease.requestedVersion}
                  and ${jobs.requestedVersion} < 9007199254740991 then ${jobs.requestedVersion} + 1
                else ${jobs.requestedVersion} end`
            : sql`case when ${jobs.requestedVersion} = ${lease.requestedVersion}
                and ${jobs.requestedVersion} < 9007199254740991 then ${jobs.requestedVersion} + 1
                else ${jobs.requestedVersion} end`,
        } : {}),
        lockedAt: null, leaseToken: null,
        notBefore: sourceReady
          ? sql`case when ${jobs.notBefore} > now() then ${jobs.notBefore} end`
          : sql`case when ${PAUSED} then ${jobs.notBefore} end`,
        // 제 일 못 한 틱은 성공 시각을 옮기지 않는다 — lastSuccessAt 은 진짜 성공만 뜻한다. lastError 는 "던진 틱"이라 지운다
        ...(outcome.degraded ? {} : { lastSuccessAt: sql`now()` }), lastError: null, updatedAt: sql`now()`,
      }).where(owned).returning({
        name: jobs.name,
        pendingReady: sql<boolean>`${jobs.requestedVersion} > ${jobs.processedVersion} and (${jobs.notBefore} is null or ${jobs.notBefore} <= now())`,
      });
      if (!row) throw new JobLeaseLostError();
      sourceContinuation = sourceReady && row.pendingReady === true;
      const observedAt = new Date();
      const batchResult = batchResultObservation(batchIdentity, name, events, lease.requestedVersion);
      let batchRecordedAt: string | undefined;
      if (batchResult) {
        const [clock] = await tx.execute<{at:string}>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
        batchRecordedAt = clock.at;
      }
      const value = { ...(batchResult ? {batchResult:{...batchResult,recordedAt:batchRecordedAt}} : {}), requestedVersion: lease.requestedVersion, done: outcome.done, durationMs: Date.now()-startedAt, events,
        ...(outcome.degraded ? { degraded: degradedObservation(outcome.degraded, observedAt) } : {}) };
      await tx.insert(operationsObservations).values({key:`job:${name}`,value,observedAt})
        .onConflictDoUpdate({target:operationsObservations.key,set:{value:JOB_OBSERVATION_MERGE,observedAt}});
      // 같은 ACK TX 에서 누적에 더한다 — job:<name> 의 마지막 회차와 어긋나지 않게. 누적이 실패해도(모양이 틀린 옛 줄 등) 틱은 성공이다:
      // savepoint 로 그 문장만 되돌리고 남긴다
      if (tally) {
        // 제 일 못 한 틱도 회차(@ok)다 — 그중 몇 번이 못 했는지(@degraded)를 따로 센다
        try { await tx.transaction(async sp => { await sp.execute(jobTallyUpsert(name, { ...tally.counts(), "@ok": 1, ...(outcome.degraded ? { "@degraded": 1 } : {}) })); }); }
        catch (error) { logger.warn("job.tally_failed", { job: name, ...dbErrorFields(error) }); }
      }
      if (batchResult) {
        const key = `batch-result:${batchResult.instanceId}:${name}`;
        await tx.insert(operationsObservations).values({key,value:{batchResult:{...batchResult,recordedAt:batchRecordedAt}},observedAt})
          .onConflictDoUpdate({target:operationsObservations.key,set:{value:{batchResult:{...batchResult,recordedAt:batchRecordedAt}},observedAt}});
      }
      // A single dependency, committed with the successful rollup tick.
      if (name === "click-rollup" && outcome.done) await requestJob("ranking-refresh", tx);
    });
    const durationMs = Date.now() - startedAt;
    const degraded = outcome.degraded ? degradedObservation(outcome.degraded, new Date()).code : null;
    if (degraded) logger.warn("job.degraded", { job: name, done: outcome.done, durationMs, code: degraded });
    else logger.info("job.completed", { job: name, done: outcome.done, durationMs });
    return { status: "completed", done: outcome.done, durationMs, ...(sourceContinuation ? { sourceContinuation: true as const } : {}),
      ...(degraded ? { degraded } : {}) };
  } catch (error) {
    await stopHeartbeat();
    // fenced DB: 실패 기록도 쓰기다. lease 는 두고(seal 이 회수하거나 만료된다) 멈춘다 — claim 거절과 같은 결과
    if (error instanceof DrWriterFencedError) {
      logger.info("job.writer_fenced", { job: name, durationMs: Date.now() - startedAt });
      return { status: "skipped", reason: "stopping" };
    }
    // PostgreSQL rejects NUL even in diagnostic text. A failed error write used to
    // leave the lease locked and hide the original failure from operations.
    const message = (error instanceof Error ? error.message : String(error)).replaceAll("\0", "\\0");
    // Preserve pending version/cursor and never release somebody else's lease.
    await db.update(jobs).set({
      lockedAt: null, leaseToken: null, lastError: message.slice(0, 2000),
      notBefore: sql`case when ${PAUSED} then ${jobs.notBefore} else now() + interval '30 seconds' end`, updatedAt: sql`now()`,
    }).where(owned);
    // 이 lease 가 아직 제 것일 때만 누적에 "@failed"·lastFailedAt 을 남긴다(넘겨준 lease 의 실패는 그쪽 것이다). 관측일 뿐이라 실패해도 무시한다
    if (tally && !lost && !(error instanceof JobLeaseLostError)) {
      await db.transaction(async tx => {
        if (!await writerSiteActive(tx)) return;
        await tx.execute(jobTallyUpsert(name, { "@failed": 1 }, { failed: true }));
      }).catch(tallyError => logger.warn("job.tally_failed", { job: name, ...dbErrorFields(tallyError) }));
    }
    const durationMs = Date.now() - startedAt;
    logger.error("job.failed", { job: name, durationMs, error });
    return { status: "failed", error: message, durationMs };
  }
}

export async function getJobState(name: string) {
  return db.query.jobs.findFirst({ where: eq(jobs.name, name) });
}

/** Rows may exist before execution; lastRunAt=null means no tick has run. */
export async function listJobStates() {
  return db.select().from(jobs).orderBy(jobs.name);
}
