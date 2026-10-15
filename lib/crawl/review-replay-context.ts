import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type SQL } from "drizzle-orm";

const replay = new AsyncLocalStorage<Readonly<{ referenceMs: number }>>();

/** The admitted replay runner owns this scope; it never changes execution or DB lease clocks. */
export async function withReviewReplayContext<T>(options: { referenceTime: Date }, load: () => Promise<T>): Promise<T> {
  const referenceMs = options.referenceTime instanceof Date ? options.referenceTime.getTime() : NaN;
  if (!Number.isFinite(referenceMs)) throw new Error("invalid_replay_reference_time");
  const enclosing = replay.getStore();
  if (enclosing && enclosing.referenceMs !== referenceMs) throw new Error("replay_clock_scope_conflict");
  return replay.run(Object.freeze({ referenceMs }), load);
}

/** Evidence validity and rule age only; never use for events, leases, retries or deadlines. */
export function reviewSemanticNow(wallFallback = new Date()): Date {
  return new Date(replay.getStore()?.referenceMs ?? wallFallback.getTime());
}

export function reviewSemanticNowSql(): SQL {
  const current = replay.getStore();
  return current ? sql`${new Date(current.referenceMs).toISOString()}::timestamp` : sql`now()`;
}

/** A frozen replay must consume prepared evidence and cannot refresh README contents. */
export function storedReviewEvidenceRequired(): boolean {
  return replay.getStore() !== undefined;
}
