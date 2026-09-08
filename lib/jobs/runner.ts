import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { JobLeaseLostError, requestJob, type JobLease } from "./control";

/** Existing bounded handlers keep their cursors; execution ownership belongs to this runner. */
export type JobContext<C> = {
  cursor: C | null;
  save: (cursor: C) => Promise<void>;
  hasBudget: () => boolean;
  log: (event: string, fields?: Record<string, unknown>) => void;
  lease?: JobLease;
};
export type JobOutcome<C> = { done: boolean; cursor?: C | null };
export type RunResult =
  | { status: "completed"; done: boolean; durationMs: number }
  | { status: "skipped"; reason: "locked" | "not_requested" | "backoff" | "stopping" }
  | { status: "failed"; error: string; durationMs: number };

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
    or(isNull(jobs.lockedAt), sql`${jobs.lockedAt} < now() - interval '10 minutes'`),
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
    sql`${jobs.lockedAt} >= now() - interval '10 minutes'`);
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
  const ctx: JobContext<C> = {
    get cursor() { return cursor; },
    lease,
    save: async next => {
      if (lost) throw new JobLeaseLostError();
      const [row] = await db.update(jobs).set({ cursor: next, updatedAt: sql`now()` })
        .where(owned).returning({ name: jobs.name });
      if (!row) { lost = true; throw new JobLeaseLostError(); }
      cursor = next;
    },
    hasBudget: () => !lost && !options.signal?.aborted && Date.now() - startedAt < (options.budgetMs ?? 25_000),
    log: (event, fields) => logger.info(event, { job: name, ...fields }),
  };
  try {
    const outcome = await handler(ctx);
    await stopHeartbeat();
    if (lost) throw new JobLeaseLostError();
    await db.transaction(async tx => {
      const [row] = await tx.update(jobs).set({
        cursor: (outcome.done ? null : (outcome.cursor ?? cursor)) as never,
        processedVersion: lease.requestedVersion,
        lockedAt: null, leaseToken: null, notBefore: null,
        lastSuccessAt: sql`now()`, lastError: null, updatedAt: sql`now()`,
      }).where(owned).returning({ name: jobs.name });
      if (!row) throw new JobLeaseLostError();
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
