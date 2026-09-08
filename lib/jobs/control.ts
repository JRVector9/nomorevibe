import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { isJobName, JOB_CATALOG, jobsForRole, type JobRole } from "./catalog";

export const STALE_LOCK_MS = 10 * 60_000;
export type JobLease = { name: string; token: string; requestedVersion: number };
export class JobLeaseLostError extends Error {
  constructor() { super("job_lease_lost"); }
}

/** This is a job signal, not a payload queue. Caller transactions preserve request atomicity. */
export async function requestJob(name: string, tx: ProductTransaction | typeof db = db) {
  if (!isJobName(name)) throw new Error("unknown_job");
  const [row] = await tx.insert(jobs).values({ name, requestedVersion: 1 })
    .onConflictDoUpdate({ target: jobs.name, set: {
      requestedVersion: sql`${jobs.requestedVersion} + 1`, updatedAt: sql`now()`,
    }, setWhere: sql`${jobs.requestedVersion} < 9007199254740991` })
    .returning({ requestedVersion: jobs.requestedVersion });
  if (!row || !Number.isSafeInteger(row.requestedVersion)) throw new Error("job_version_exhausted");
  return { job: name, status: "queued" as const, requestedVersion: row.requestedVersion };
}

/** Coalesce scheduled signals and advance from the scheduled instant, not handler completion. */
export async function requestDueJobs(): Promise<number> {
  return db.transaction(async tx => {
    let count = 0;
    for (const job of JOB_CATALOG) {
      if (job.intervalMs === null) continue;
      await tx.insert(jobs).values({ name: job.name }).onConflictDoNothing();
      const duration = sql`${job.intervalMs} * interval '1 millisecond'`;
      const [due] = await tx.update(jobs).set({
        requestedVersion: sql`case when ${jobs.requestedVersion} = ${jobs.processedVersion}
          then ${jobs.requestedVersion} + 1 else ${jobs.requestedVersion} end`,
        nextScheduledAt: sql`coalesce(${jobs.nextScheduledAt}, now()) +
          (floor(extract(epoch from (now() - coalesce(${jobs.nextScheduledAt}, now()))) * 1000 / ${job.intervalMs}) + 1) * (${duration})`,
        updatedAt: sql`now()`,
      }).where(and(eq(jobs.name, job.name),
        or(isNull(jobs.nextScheduledAt), sql`${jobs.nextScheduledAt} <= now()`),
        sql`${jobs.requestedVersion} < 9007199254740991`,
      )).returning({ name: jobs.name });
      if (due) count++;
    }
    return count;
  });
}

export async function markWorkerSeen(names: string[]): Promise<void> {
  if (!names.length) return;
  await db.insert(jobs).values(names.map(name => ({ name, workerSeenAt: sql`now()` })))
    .onConflictDoUpdate({ target: jobs.name, set: { workerSeenAt: sql`now()` } });
}

export async function markSchedulerSeen(): Promise<void> { await markWorkerSeen(["heartbeat"]); }

export async function pendingJobNames(role: JobRole): Promise<string[]> {
  const rows = await db.select({ name: jobs.name }).from(jobs).where(and(
    inArray(jobs.name, jobsForRole(role)), sql`${jobs.requestedVersion} > ${jobs.processedVersion}`,
    or(isNull(jobs.notBefore), sql`${jobs.notBefore} <= now()`),
    or(isNull(jobs.lockedAt), sql`${jobs.lockedAt} < now() - interval '10 minutes'`),
  ));
  return rows.map(row => row.name);
}

/** Call inside the transaction that writes the result; never hold this across external work. */
export async function assertJobLease(tx: ProductTransaction, lease: JobLease): Promise<void> {
  const [owned] = await tx.select({ name: jobs.name }).from(jobs).where(and(
    eq(jobs.name, lease.name), eq(jobs.leaseToken, lease.token),
    sql`${jobs.lockedAt} >= now() - interval '10 minutes'`,
  )).for("share");
  if (!owned) throw new JobLeaseLostError();
}
