import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { dbErrorTag } from "@/lib/db/error-fields";
import type { JobContext } from "@/lib/jobs/runner";
import { JobLeaseLostError } from "@/lib/jobs/control";
import { DrWriterFencedError } from "./dr/epoch";
import { markExitedCallerIndeterminate } from "./dr/exited-caller";
import { markOwnerGoneIndeterminate } from "./dr/owner-gone";
import { OWNER_GONE_MAX_REQUESTS, OWNER_GONE_QUIET_MS } from "./dr/owner-gone-contract";

/** Same service identity must never represent several long-lived replicas.
 * Web/scheduler instance IDs are deliberately absent; their successor boot is not proof of owner absence.
 */
const SINGLETON_OWNERS = Object.freeze([
  ...["crawler", "reviewer", "publisher", "text", "maintenance"].flatMap(role => [`m3-${role}`, `mini-${role}-standby`]),
  "ai2-consumer-m3", "agent-scan-consumer-m3",
]);
export type ModelCapacityReclaimCursor = { ownerGoneAfterQueueOrdinal: string; ownerGoneThroughQueueOrdinal?: string; httpHopAfterId?: string };
type Candidate = { requestId: string; queueOrdinal: string };

function validOrdinal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt("9223372036854775807");
}
async function candidatesAfter(after: string, through: string | null): Promise<{ candidates: Candidate[]; through: string }> {
  return onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const eligible = sql`state = 'dispatched' AND owner_instance_id IN (${sql.join(SINGLETON_OWNERS.map(owner => sql`${owner}`), sql`, `)})
      AND coalesce(dispatched_at, queued_at) <= clock_timestamp() - ${OWNER_GONE_QUIET_MS.default} * interval '1 millisecond'`;
    // A finite sweep must end even when newer requests keep arriving. Failed
    // checks are revisited on the next sweep without blocking this page's siblings.
    let ceiling = through;
    if (ceiling === null) {
      const [row] = await tx.execute<{ through: string }>(sql`SELECT coalesce(max(queue_ordinal), 0)::text AS through
        FROM model_capacity_requests WHERE ${eligible}`);
      ceiling = row.through;
    }
    const rows = await tx.execute<{ request_id: string; queue_ordinal: string }>(sql`
      SELECT request_id::text, queue_ordinal::text FROM model_capacity_requests
      WHERE ${eligible} AND queue_ordinal > ${after}::bigint AND queue_ordinal <= ${ceiling}::bigint
      ORDER BY queue_ordinal LIMIT ${OWNER_GONE_MAX_REQUESTS}`);
    return { candidates: Array.from(rows).map(row => ({ requestId: row.request_id, queueOrdinal: row.queue_ordinal })), through: ceiling };
  }, { accessMode: "read only" }));
}

/** A fair, bounded hint scan followed by the existing locked owner-gone judgement.
 * Age selects candidates only. A complete dispatch-time child-group exit proves
 * caller loss even under a live supervisor; otherwise the unchanged whole-owner
 * check requires quiet time, no live holds and positive exit/successor evidence.
 * Marks remain unreviewed indeterminate; no native terminal, release or business result is invented.
 */
export async function markAutomaticOwnerGone(ctx: JobContext<ModelCapacityReclaimCursor>, operator: string): Promise<ModelCapacityReclaimCursor | null> {
  const lease = ctx.lease;
  if (!lease || lease.name !== "model-capacity-reclaim") throw new Error("owner_gone_maintenance_lease_required");
  const ready = () => !ctx.signal?.aborted && ctx.hasBudget();
  const original = ctx.cursor ?? null;
  if (!ready()) return original;
  if (currentReplayDb()) throw new Error("dr_replay_unsupported");
  let after = validOrdinal(original?.ownerGoneAfterQueueOrdinal) ? original.ownerGoneAfterQueueOrdinal : "0";
  const ceiling = validOrdinal(original?.ownerGoneThroughQueueOrdinal) ? original.ownerGoneThroughQueueOrdinal : null;
  let page = await candidatesAfter(after, ceiling);
  if (!page.candidates.length && (after !== "0" || ceiling !== null) && ready()) {
    after = "0"; page = await candidatesAfter(after, null);
  }
  if (!page.candidates.length) {
    if (!ready()) return original;
    return original?.httpHopAfterId ? { ownerGoneAfterQueueOrdinal: "0", httpHopAfterId: original.httpHopAfterId } : null;
  }
  const { candidates, through } = page;
  let scanned = 0, marked = 0, kept = 0, errors = 0;
  for (const candidate of candidates) {
    if (!ready()) break;
    try {
      // A child can exit while its supervisor keeps the same owner boot and lease.
      // Check positive per-dispatch group exits before the whole-owner absence path.
      const caller = await markExitedCallerIndeterminate({ requestIds: [candidate.requestId], operator,
        allowedOwnerInstanceIds: SINGLETON_OWNERS, jobLease: lease }, true);
      if (caller.rows[0]?.kind === "marked") {
        marked++; scanned++; after = candidate.queueOrdinal;
        ctx.log("model_capacity.caller_exited_checked", { requestId: candidate.requestId, marked: true });
        if (ready()) await ctx.save({ ...original, ownerGoneAfterQueueOrdinal: after, ownerGoneThroughQueueOrdinal: through });
        continue;
      }
      const result = await markOwnerGoneIndeterminate({ requestIds: [candidate.requestId], operator,
        allowedOwnerInstanceIds: SINGLETON_OWNERS, jobLease: lease }, true);
      const row = result.rows[0];
      if (row.status === "marked") marked++;
      else kept++;
      ctx.log("model_capacity.owner_gone_checked", { requestId: candidate.requestId,
        marked: row.status === "marked", reason: row.reason });
    } catch (error) {
      // Losing this job or the DR writer fence stops every subsequent mutation.
      if (error instanceof JobLeaseLostError || error instanceof DrWriterFencedError
        || error instanceof Error && error.message.startsWith("dr_writer_")) throw error;
      errors++;
      ctx.log("model_capacity.owner_gone_error", { requestId: candidate.requestId, code: dbErrorTag(error)?.code ?? "owner_gone_check_failed" });
    }
    scanned++;
    after = candidate.queueOrdinal;
    if (ready()) await ctx.save({ ...original, ownerGoneAfterQueueOrdinal: after, ownerGoneThroughQueueOrdinal: through });
  }
  ctx.log("model_capacity.owner_gone_scan", { scanned, marked, kept, errors });
  return scanned ? { ...original, ownerGoneAfterQueueOrdinal: after, ownerGoneThroughQueueOrdinal: through } : original;
}
