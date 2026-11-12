import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { jobs } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { isJobName } from "./catalog";
import { JobLeaseLostError, STALE_LOCK_MS } from "./lease";
import { batchPendingNames, lockJobBatch } from "./batch-repository";
import { batchJobsForRole, catalogJobsForBatch, type BatchRole } from "./batches";
import { registerReplayJobFinalAuthority } from "@/lib/operations/pipeline-replay-execution";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { readJobIntervalOverrides } from "./job-interval-reader";

export type JobLease = { name: string; token: string; requestedVersion: number };
export { JobLeaseLostError } from "./lease";

/** This is a job signal, not a payload queue. Caller transactions preserve request atomicity.
 * DR writer fence 를 여기서 잡지 않는다 — 호출자 TX 가 도메인·jobs 행을 잡은 뒤 부르므로(jobs → fence) seal 의
 * fence UPDATE → jobs 와 교착한다. fence 는 호출자 TX 의 첫 lock 이 맡는다(worker: withJobLeaseWrite·runJob, 웹: web-gate). */
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

/** requestDueJobs 가 이 batch 상태에서 일정을 미는 정기 잡. Oracle scheduler attest 도 같은 목록을 읽어 본다 */
export function scheduledJobs(batch: { mode: string; writerContractVersion: number }) {
  return catalogJobsForBatch(batch).filter(job => job.intervalMs !== null);
}

/**
 * Coalesce scheduled signals and advance from the scheduled instant, not handler completion.
 *
 * 주기는 카탈로그(intervalMs)이고, 운영 설정의 잡 주기 덮어쓰기(runtime_settings jobs.<잡>.intervalMs, lib/jobs/job-intervals.ts)가 있으면 그 값이다.
 * 덮어쓰기가 없는 잡은 예전과 같은 SQL 이다(tests/integration/job-interval-override.test.ts). 덮어쓴 잡은 하나만 더 본다 — 이미 잡힌 예약이 새 주기보다
 * 멀면(주기를 줄였다) 지금 요청하고 새 주기 안으로 다시 잡는다. 덮어쓰기를 지우면(코드 기본값으로) 이미 잡힌 예약까지는 그대로 기다린다.
 * options.overrides 는 시험용 주입이다(없으면 30초 나눠 쓰는 행 읽기 — TX 밖이라 읽기 실패가 이 TX 를 깨지 않는다).
 */
export async function requestDueJobs(
  acknowledge?: (tx: ProductTransaction, tick: { batchEpoch: number; requested: number }) => Promise<void>,
  options: { overrides?: ReadonlyMap<string, number> } = {},
): Promise<number> {
  const overrides = options.overrides ?? await readJobIntervalOverrides();
  return db.transaction(async tx => {
    // DR writer fence가 첫 lock이다(seal의 fence UPDATE → batch → jobs와 같은 순서). fenced DB의 scheduler는 정기 요청을 만들지 않는다.
    if (!await writerSiteActive(tx)) return 0;
    const batch = await lockJobBatch(tx);
    let count = 0;
    for (const job of scheduledJobs(batch)) {
      await tx.insert(jobs).values({ name: job.name }).onConflictDoNothing();
      const override = overrides.get(job.name);
      const intervalMs = override ?? job.intervalMs;
      const duration = sql`${intervalMs} * interval '1 millisecond'`;
      const [due] = await tx.update(jobs).set({
        requestedVersion: sql`case when ${jobs.requestedVersion} = ${jobs.processedVersion}
          then ${jobs.requestedVersion} + 1 else ${jobs.requestedVersion} end`,
        nextScheduledAt: sql`coalesce(${jobs.nextScheduledAt}, now()) +
          (floor(extract(epoch from (now() - coalesce(${jobs.nextScheduledAt}, now()))) * 1000 / ${intervalMs}) + 1) * (${duration})`,
        updatedAt: sql`now()`,
      }).where(and(eq(jobs.name, job.name),
        override === undefined
          ? or(isNull(jobs.nextScheduledAt), sql`${jobs.nextScheduledAt} <= now()`)
          : or(isNull(jobs.nextScheduledAt), sql`${jobs.nextScheduledAt} <= now()`, sql`${jobs.nextScheduledAt} > now() + (${duration})`),
        sql`${jobs.requestedVersion} < 9007199254740991`,
      )).returning({ name: jobs.name });
      if (due) count++;
    }
    // Oracle scheduler canary 의 ACK: fence 를 지나 이 요청과 함께 commit 된 tick 에만 남는다
    await acknowledge?.(tx, { batchEpoch: batch.epoch, requested: count });
    return count;
  });
}

export async function markWorkerSeen(names: string[]): Promise<void> {
  if (!names.length) return;
  await db.insert(jobs).values(names.map(name => ({ name, workerSeenAt: sql`now()` })))
    .onConflictDoUpdate({ target: jobs.name, set: { workerSeenAt: sql`now()` } });
}

export async function markSchedulerSeen(): Promise<void> { await markWorkerSeen(["heartbeat"]); }

export async function pendingJobNames(role: BatchRole): Promise<string[]> {
  const names = await batchPendingNames(role);
  if (!names.length) return [];
  const rows = await db.select({ name: jobs.name }).from(jobs).where(and(
    inArray(jobs.name, names), sql`${jobs.requestedVersion} > ${jobs.processedVersion}`,
    or(isNull(jobs.notBefore), sql`${jobs.notBefore} <= now()`),
    or(isNull(jobs.lockedAt), sql`${jobs.lockedAt} < now() - ${STALE_LOCK_MS} * interval '1 millisecond'`),
  ));
  return rows.map(row => row.name);
}

/** A healthy in-flight job may take longer than the progress sample interval. */
export async function hasActiveRoleJob(role: BatchRole): Promise<boolean> {
  const [row] = await db.select({ name: jobs.name }).from(jobs).where(and(
    inArray(jobs.name, [...new Set([...batchJobsForRole(role,"legacy"),...batchJobsForRole(role,"versioned")])]),
    sql`${jobs.leaseToken} is not null`,
    sql`${jobs.lockedAt} >= now() - ${STALE_LOCK_MS} * interval '1 millisecond'`,
  )).limit(1);
  return Boolean(row);
}

/** Call inside the transaction that writes the result; never hold this across external work. */
export async function assertJobLease(tx: ProductTransaction, lease: JobLease, mode: "share" | "update" = "share"): Promise<void> {
  const [owned] = await tx.select({ name: jobs.name }).from(jobs).where(and(
    eq(jobs.name, lease.name), eq(jobs.leaseToken, lease.token),
    sql`${jobs.lockedAt} >= now() - ${STALE_LOCK_MS} * interval '1 millisecond'`,
  )).for(mode);
  if (!owned) throw new JobLeaseLostError();
}

/** A result may wait for the job row. Check expiry against wall time only after
 * that wait; transaction-start now() cannot prove the owner is still healthy. */
export async function assertJobLeaseAtWallTime(tx: ProductTransaction, lease: JobLease,
  mode: "share" | "update" = "share"): Promise<void> {
  await tx.select({ name: jobs.name }).from(jobs).where(eq(jobs.name, lease.name)).for(mode);
  const [owned] = await tx.select({ name: jobs.name }).from(jobs).where(and(
    eq(jobs.name, lease.name), eq(jobs.leaseToken, lease.token),
    sql`${jobs.lockedAt} >= clock_timestamp() - ${STALE_LOCK_MS} * interval '1 millisecond'`,
  ));
  if (!owned) throw new JobLeaseLostError();
  await registerReplayJobFinalAuthority(tx, lease, mode);
}

/** Keep a worker side effect and its job-token check in one commit. */
export function withJobLeaseWrite<T>(lease: JobLease | undefined, write: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    // worker 쓰기(lease)는 DR writer fence 가 첫 lock 이다(seal 의 fence UPDATE → … → jobs 와 같은 순서). lease 없는 웹 호출은
    // 웹 쓰기 관문(web-gate)이, 격리 replay DB 는 runJob claim 처럼 fence 없이 간다.
    if (lease && !currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const result = await write(tx);
    if (lease) await assertJobLease(tx, lease);
    return result;
  });
}
