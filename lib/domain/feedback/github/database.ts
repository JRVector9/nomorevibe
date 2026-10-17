import { sql } from "drizzle-orm";
import { db, onPrimary, withTransactionSetup } from "@/lib/db";
import { dbPoolConfig, withDbDeadline } from "@/lib/db/pool";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import type { FeedbackTransaction } from "../repository";

export class FeedbackDatabaseDeadlineError extends Error {
  constructor() { super("feedback_database_deadline"); }
}

/** Recomputed before every query; statement cancellation preserves the session.
 * https://www.postgresql.org/docs/17/runtime-config-client.html
 * No timeout is relaxed, and SET LOCAL works with transaction-mode PgBouncer.
 */
export async function setFeedbackTransactionDeadline(tx: FeedbackTransaction, deadlineAt: number): Promise<void> {
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 100) throw new FeedbackDatabaseDeadlineError();
  const settings = await tx.execute(sql`select name, set_config(name,
    (case when setting::bigint = 0 then ${remaining - 100} else least(setting::bigint, ${remaining - 100}) end)::text || 'ms', true)
    from pg_settings where name in ('statement_timeout', 'lock_timeout')`);
  if (settings.length !== 2) throw new Error("feedback_database_timeouts_unavailable");
}

export async function feedbackSql<T>(tx: FeedbackTransaction, deadlineAt: number | undefined, query: () => PromiseLike<T>): Promise<T> {
  if (deadlineAt !== undefined) await setFeedbackTransactionDeadline(tx, deadlineAt);
  return await query();
}

/** Await every DB lifecycle; only unsent pool wait is cancelled by the driver. */
export function feedbackDatabaseWrite<T>(lease: JobLease | undefined, write: (tx: FeedbackTransaction) => Promise<T>, deadlineAt?: number): Promise<T> {
  const transaction = () => onPrimary(() => db.transaction(async (tx) => {
    if (deadlineAt !== undefined) await setFeedbackTransactionDeadline(tx, deadlineAt);
    const result = await write(tx);
    if (lease) await feedbackSql(tx, deadlineAt, () => assertJobLease(tx, lease));
    // The job share lock and all side effects remain in the same transaction.
    // Refresh and check after the final lease query, before awaited COMMIT.
    if (deadlineAt !== undefined) await setFeedbackTransactionDeadline(tx, deadlineAt);
    if (deadlineAt !== undefined && Date.now() >= deadlineAt - 100) throw new FeedbackDatabaseDeadlineError();
    return result;
  }));
  if (deadlineAt === undefined) return transaction();
  // Initial/replacement connection handshakes retain the driver's bounded
  // connect timeout, so stop pool assignment early enough to reserve it.
  const acquisitionMargin = dbPoolConfig().connectSeconds * 1000 + 250;
  if (deadlineAt - Date.now() <= acquisitionMargin) return Promise.reject(new FeedbackDatabaseDeadlineError());
  // 웹 쓰기 범위의 prelude(fence SHARE)도 이 기한 안에서 기다리게 — 기한을 prelude 보다 먼저 건다
  return withDbDeadline(deadlineAt - acquisitionMargin, () => withTransactionSetup(tx => setFeedbackTransactionDeadline(tx, deadlineAt), transaction));
}
