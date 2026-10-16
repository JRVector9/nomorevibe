import { and, eq, sql, type SQL } from "drizzle-orm";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlSourceBufferControl, operationsObservations } from "@/lib/db/schema";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { discoveryAdmission, DiscoveryAdmissionDeadlineError, readDiscoveryAdmissionInTransaction,
  type DiscoveryAdmissionSnapshot } from "./discovery-admission";
import { mergeWithDefaults } from "./settings";
import { crawlSettingsSchema } from "./settings-schema";

export type SourceBufferDecision = { mode: "count"; blocked: boolean;
  reason: "count_pressure" | "measurement_unknown" | "ready"; measuredAt: string;
  R: null; targetHours: null; capHours: null };

/** Count thresholds are safety signals, never a measured final-review rate. */
export function sourceBufferAdmission(snapshot: DiscoveryAdmissionSnapshot, priorBlocked: boolean, wallTime: string): SourceBufferDecision {
  if (!Number.isFinite(Date.parse(wallTime)) || new Date(wallTime).toISOString() !== wallTime) throw new Error("invalid_source_buffer_wall");
  if (typeof priorBlocked !== "boolean" || !Array.isArray(snapshot.stages)
    || !Number.isSafeInteger(snapshot.recentNew) || snapshot.recentNew < 0
    || snapshot.stages.some(stage => !["fetch", "judge", "first", "second", "publish"].includes(stage.key)
      || !Number.isSafeInteger(stage.waiting) || stage.waiting < 0
      || stage.oldestMinutes !== null && (!Number.isFinite(stage.oldestMinutes) || stage.oldestMinutes < 0))) throw new Error("invalid_source_buffer_snapshot");
  const downstream = snapshot.stages.filter(stage => stage.key !== "fetch");
  const unknown = Boolean(snapshot.timedOut || snapshot.secondWindowLimited || snapshot.secondVoteWindowLimited || snapshot.secondObservationLimited)
    || downstream.length !== 4 || new Set(downstream.map(stage => stage.key)).size !== 4
    || downstream.some(stage => stage.waiting > 0 && stage.oldestMinutes === null);
  const blocked = unknown || discoveryAdmission({ ...snapshot, stages: downstream }, priorBlocked).throttled;
  return { mode: "count", blocked, reason: unknown ? "measurement_unknown" : blocked ? "count_pressure" : "ready",
    measuredAt: wallTime, R: null, targetHours: null, capHours: null };
}

/** Only thrown inside the owned control/read phase, then interpreted after TX rollback settles. */
export class SourceBufferReadDeferredError extends Error {
  constructor(cause: unknown) { super("source_buffer_read_deferred", { cause }); this.name = "SourceBufferReadDeferredError"; }
}
function readBudgetFailed(error: unknown): boolean {
  if (error instanceof DiscoveryAdmissionDeadlineError) return true;
  for (let value = error, depth = 0; value && typeof value === "object" && depth < 5; depth++) {
    if ("code" in value && ["57014", "55P03", "DB_POOL_WAIT_TIMEOUT"].includes(String(value.code))) return true;
    value = "cause" in value ? value.cause : null;
  }
  return false;
}

/** Current refresh work bypasses the new-repository gate before LIMIT, irrespective of its original signal. */
export function sourceBufferRefreshPredicate(): SQL {
  return sql`(exists(select 1 from ${crawlDocuments} where lower(${crawlDocuments.repo})=lower(${crawlFrontier.repo}))
    or exists(select 1 from ${crawlCandidates} where lower(${crawlCandidates.repo})=lower(${crawlFrontier.repo})))`;
}

/** Caller already holds fetch stage SHARE. No domain/item/job lock may precede this helper. */
export async function lockSourceBufferAdmission(tx: ProductTransaction): Promise<SourceBufferDecision | null> {
  const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
  const flag = crawlSettingsSchema.shape.discover.shape.sourceBuffer.parse(
    (saved?.values as { discover?: { sourceBuffer?: unknown } } | undefined)?.discover?.sourceBuffer);
  // In particular, existing restricted replay profiles need no grant on the new table.
  if (!flag.enabled) return null;
  if (currentReplayDb()) throw new Error("replay_source_buffer_unsupported");
  const settings = mergeWithDefaults(saved?.values);
  if (!settings.discover.sourceBuffer.enabled) throw new Error("invalid_source_buffer_settings");
  const deadlineAt = Date.now() + 3_000;
  const [prior] = await tx.execute<{ statement: string; lock: string; jit: string }>(sql`SELECT
    (select setting from pg_settings where name='statement_timeout') AS statement,
    (select setting from pg_settings where name='lock_timeout') AS lock, current_setting('jit') AS jit`);
  if (!prior || !/^\d+$/.test(prior.statement) || !/^\d+$/.test(prior.lock)) throw new Error("invalid_source_buffer_timeouts");
  let control: typeof crawlSourceBufferControl.$inferSelect | undefined;
  let snapshot: DiscoveryAdmissionSnapshot;
  let wall: string;
  try {
    const remaining = Math.floor(deadlineAt - Date.now() - 50);
    if (remaining < 1) throw new DiscoveryAdmissionDeadlineError();
    await tx.execute(sql`select set_config(name, (case when setting::bigint=0 then ${remaining}
      else least(setting::bigint, ${remaining}) end)::text || 'ms', true)
      from pg_settings where name in ('statement_timeout','lock_timeout')`);
    [control] = await tx.select().from(crawlSourceBufferControl).where(eq(crawlSourceBufferControl.id, 1)).for("update");
    if (!control || control.policyVersion !== 1) throw new Error("source_buffer_control_missing");
    const [clock] = await tx.execute<{ wall: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS wall`);
    wall = clock.wall;
    snapshot = await readDiscoveryAdmissionInTransaction(tx, settings, new Date(wall), deadlineAt);
  } catch (error) {
    if (readBudgetFailed(error)) throw new SourceBufferReadDeferredError(error);
    throw error;
  }
  // Restore only after a successful read. Never issue finally SQL into an aborted transaction.
  await tx.execute(sql`select set_config('statement_timeout', ${prior.statement + 'ms'}, true),
    set_config('lock_timeout', ${prior.lock + 'ms'}, true), set_config('jit', ${prior.jit}, true)`);
  const decision = sourceBufferAdmission(snapshot, control.blocked, wall);
  const changed = await tx.update(crawlSourceBufferControl).set({ blocked: decision.blocked,
    lastReason: decision.reason, lastDecisionAt: new Date(wall), revision: sql`${crawlSourceBufferControl.revision}+1` })
    .where(and(eq(crawlSourceBufferControl.id, 1), sql`${crawlSourceBufferControl.revision}<9007199254740991`)).returning({ id: crawlSourceBufferControl.id });
  if (!changed.length) throw new Error("source_buffer_revision_exhausted");
  const value = { ...decision, revision: control.revision + 1, rateEvidence: "unavailable",
    stages: snapshot.stages, secondUnvalidated: snapshot.secondUnvalidated ?? 0 };
  await tx.insert(operationsObservations).values({ key: "crawl:source-buffer", value, observedAt: new Date(wall) })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt: new Date(wall) } });
  return decision;
}
