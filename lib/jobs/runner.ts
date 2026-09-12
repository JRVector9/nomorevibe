import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, operationsObservations } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { JobLeaseLostError, requestJob, type JobLease } from "./control";

/** Existing bounded handlers keep their cursors; execution ownership belongs to this runner. */
export type JobContext<C> = {
  cursor: C | null;
  save: (cursor: C) => Promise<void>;
  hasBudget: () => boolean;
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
export type JobOutcome<C> = { done: boolean; cursor?: C | null };
export type RunResult =
  | { status: "completed"; done: boolean; durationMs: number }
  | { status: "skipped"; reason: "locked" | "not_requested" | "backoff" | "stopping" }
  | { status: "failed"; error: string; durationMs: number };

/**
 * 주인이 사라진 잠금을 언제 넘겨받나.
 *
 * 심장 박동이 15초마다 lockedAt 을 갱신하므로 살아 있는 주인은 늘 최신이다. 10분이던 때는
 * 배포 때마다 2차 심사가 그만큼 놀았다(2026-09-12 실측 6분간 분당 0.3건). 여섯 번을 놓치면
 * 죽은 것으로 본다.
 */
const LEASE_TAKEOVER = sql`now() - interval '90 seconds'`;

export async function runJob<C>(
  name: string,
  handler: (ctx: JobContext<C>) => Promise<JobOutcome<C>>,
  options: { budgetMs?: number; requestedOnly?: boolean; signal?: AbortSignal } = {},
): Promise<RunResult> {
  if (options.signal?.aborted) return { status: "skipped", reason: "stopping" };
  const startedAt = Date.now();
  const token = randomUUID();
  await db.insert(jobs).values({ name }).onConflictDoNothing();
  const [claimed] = await db.update(jobs).set({
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
  const ctx: JobContext<C> = {
    get cursor() { return cursor; },
    lease,
    signal: options.signal,
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
      events.push({event:event.slice(0,100),counts:Object.fromEntries(Object.entries(fields ?? {}).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean')) as Record<string,number|boolean>});
      if(events.length>12)events.shift();
    },
  };
  try {
    const outcome = await handler(ctx);
    await stopHeartbeat();
    if (lost) throw new JobLeaseLostError();
    await db.transaction(async tx => {
      const [row] = await tx.update(jobs).set({
        // done은 "지금 할 일이 없다", cursor는 "내 상태"다. 둘을 묶으면 이어서 훑어야 하는
        // 작업이 완료를 알릴 때마다 진행 위치를 잃는다. 커서를 명시하면 그것을 따르고,
        // 말이 없으면 종전대로 done에서 비운다.
        cursor: (outcome.cursor !== undefined ? outcome.cursor : (outcome.done ? null : cursor)) as never,
        processedVersion: lease.requestedVersion,
        lockedAt: null, leaseToken: null, notBefore: null,
        lastSuccessAt: sql`now()`, lastError: null, updatedAt: sql`now()`,
      }).where(owned).returning({ name: jobs.name });
      if (!row) throw new JobLeaseLostError();
      const observedAt = new Date();
      const value = { requestedVersion: lease.requestedVersion, done: outcome.done, durationMs: Date.now()-startedAt, events };
      await tx.insert(operationsObservations).values({key:`job:${name}`,value,observedAt})
        .onConflictDoUpdate({target:operationsObservations.key,set:{value,observedAt}});
      // A single dependency, committed with the successful rollup tick.
      if (name === "click-rollup" && outcome.done) await requestJob("ranking-refresh", tx);
    });
    const durationMs = Date.now() - startedAt;
    logger.info("job.completed", { job: name, done: outcome.done, durationMs });
    return { status: "completed", done: outcome.done, durationMs };
  } catch (error) {
    await stopHeartbeat();
    const message = error instanceof Error ? error.message : String(error);
    // Preserve pending version/cursor and never release somebody else's lease.
    await db.update(jobs).set({
      lockedAt: null, leaseToken: null, lastError: message.slice(0, 2000),
      notBefore: sql`now() + interval '30 seconds'`, updatedAt: sql`now()`,
    }).where(owned);
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
