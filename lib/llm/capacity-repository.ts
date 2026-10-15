import { randomUUID } from "node:crypto";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { modelCapacityControl, modelCapacityEvents, modelCapacityRequests } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import {
  modelCapacityClassCycle, modelCapacityDispatchSchema, modelCapacityPolicyHash, modelCapacityRequestSchema,
  modelCapacityReservationSchema, parseModelCapacityPolicy,
  type ModelCapacityDispatch, type ModelCapacityEventKind, type ModelCapacityIndeterminateReason,
  type ModelCapacityRequest, type ModelCapacityReservation, type ModelSlotResult,
} from "./capacity";

type RequestRow = typeof modelCapacityRequests.$inferSelect;
const fail = (code: string): never => { throw new Error(code); };

function transaction<T>(load: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  if (currentReplayDb()) return Promise.reject(new Error("model_capacity_replay_unsupported"));
  return onPrimary(() => db.transaction(load));
}

async function control(tx: ProductTransaction) {
  const [row] = await tx.select().from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
  if (!row) return fail("model_capacity_control_missing");
  const policy = row.policy === null ? null : parseModelCapacityPolicy(row.policy);
  if (policy !== null && modelCapacityPolicyHash(policy) !== row.policyHash) fail("model_capacity_policy_hash_mismatch");
  return { ...row, policy };
}
type Control = Awaited<ReturnType<typeof control>>;

/** The control mutex serializes every runtime writer. Existing rows selected
 * together for expiry are locked in queue order; newly inserted rows are owned
 * by this transaction before it can select one older waiting request. */
async function expireRequests(tx: ProductTransaction, state: Control): Promise<void> {
  const due = await tx.select().from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.state} = 'reserved' AND ${modelCapacityRequests.reservedUntil} <= clock_timestamp())
    OR (${modelCapacityRequests.state} = 'waiting' AND (${modelCapacityRequests.queueUntil} <= clock_timestamp()
      OR ${modelCapacityRequests.epoch} <> ${state.epoch} OR ${modelCapacityRequests.revision} <> ${state.revision}
      OR ${modelCapacityRequests.policyHash} IS DISTINCT FROM ${state.policyHash}))`)
    .orderBy(asc(modelCapacityRequests.queueOrdinal)).for("update");
  for (const row of due) {
    const [timing] = await tx.execute<{ expired: boolean }>(sql`SELECT CASE WHEN ${row.state} = 'reserved'
      THEN ${modelCapacityRequests.reservedUntil} <= clock_timestamp()
      ELSE ${modelCapacityRequests.queueUntil} <= clock_timestamp() END AS expired
      FROM ${modelCapacityRequests} WHERE ${modelCapacityRequests.requestId} = ${row.requestId}`);
    const kind = row.state === "reserved" ? "reservation_expired" : timing.expired ? "wait_expired" : "policy_changed";
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
      .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, row.state))).returning();
    if (changed) await event(tx, changed, kind, row.state, "withdrawn");
  }
}

async function grantOne(tx: ProductTransaction, state: Control): Promise<void> {
  const policy = state.policy;
  if (!policy) return fail("model_capacity_policy_missing");
  const cycle = modelCapacityClassCycle(policy);
  for (let offset = 0; offset < cycle.length; offset++) {
    const position = (state.cursor + offset) % cycle.length;
    // Only aggregate active charges and fetch a capacity-fit row. A saturated
    // queue head must not hide a later route in the same class that fits.
    const [candidate] = await tx.execute<{ request_id: string }>(sql`
      WITH active AS MATERIALIZED (
        SELECT provider_budget_id, group_id, pool FROM model_capacity_requests
        WHERE state IN ('reserved','dispatched','indeterminate')
      )
      SELECT q.request_id FROM model_capacity_requests q
      WHERE q.state = 'waiting' AND q.class = ${cycle[position]}
        AND q.epoch = ${state.epoch} AND q.revision = ${state.revision} AND q.policy_hash = ${state.policyHash}
        AND q.queue_until > clock_timestamp()
        AND (SELECT count(*) FROM active) < ${policy.globalLimit}
        AND (SELECT count(*) FROM active a WHERE a.provider_budget_id = q.provider_budget_id)
          < (${JSON.stringify(policy.providerLimits)}::text::jsonb ->> q.provider_budget_id)::integer
        AND (SELECT count(*) FROM active a WHERE a.group_id = q.group_id)
          < (${JSON.stringify(policy.groupLimits)}::text::jsonb ->> q.group_id)::integer
        AND (SELECT count(*) FROM active a WHERE a.pool = q.pool)
          < (${JSON.stringify(policy.poolLimits)}::text::jsonb ->> q.pool)::integer
      ORDER BY q.queue_ordinal LIMIT 1 FOR UPDATE OF q`);
    if (!candidate) continue;
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "reserved", token: randomUUID(),
      reservedUntil: sql`clock_timestamp() + ${policy.reservationTtlMs} * interval '1 millisecond'`,
      updatedAt: sql`clock_timestamp()` }).where(and(eq(modelCapacityRequests.requestId, candidate.request_id),
        eq(modelCapacityRequests.state, "waiting"), sql`${modelCapacityRequests.queueUntil} > clock_timestamp()`)).returning();
    if (!changed) continue;
    await event(tx, changed, "reserved", "waiting", "reserved");
    await tx.update(modelCapacityControl).set({ cursor: (position + 1) % cycle.length, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityControl.id, 1));
    return;
  }
}

async function event(tx: ProductTransaction, row: RequestRow, kind: ModelCapacityEventKind,
  fromState: RequestRow["state"] | null, toState: RequestRow["state"], reason: ModelCapacityIndeterminateReason | null = null) {
  await tx.insert(modelCapacityEvents).values({ requestId: row.requestId, kind, epoch: row.epoch,
    revision: row.revision, policyHash: row.policyHash, fromState, toState, reason });
}

function sameIdentity(row: RequestRow, value: ModelCapacityRequest): void {
  if (row.workKey !== value.workKey || row.ownerInstanceId !== value.owner.instanceId
    || row.ownerBootId !== value.owner.bootId || row.class !== value.class || row.pool !== value.pool
    || row.routeId !== value.routeId || row.provider !== value.provider || row.model !== value.model) {
    fail("model_capacity_request_identity_mismatch");
  }
}

function reservation(row: RequestRow): ModelCapacityReservation {
  return modelCapacityReservationSchema.parse({ requestId: row.requestId,
    owner: { instanceId: row.ownerInstanceId, bootId: row.ownerBootId }, token: row.token,
    epoch: row.epoch, revision: row.revision, policyHash: row.policyHash });
}

function owned(row: RequestRow | undefined, value: ModelCapacityReservation | ModelCapacityDispatch): row is RequestRow {
  return row !== undefined && row.requestId === value.requestId && row.ownerInstanceId === value.owner.instanceId
    && row.ownerBootId === value.owner.bootId && row.token === value.token && row.epoch === value.epoch
    && row.revision === value.revision && row.policyHash === value.policyHash;
}

async function expireReservation(tx: ProductTransaction, row: RequestRow): Promise<boolean> {
  if (row.state !== "reserved") return false;
  const [expired] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, "reserved"),
      sql`${modelCapacityRequests.reservedUntil} <= clock_timestamp()`)).returning();
  if (!expired) return false;
  await event(tx, expired, "reservation_expired", "reserved", "withdrawn");
  return true;
}

export async function requestModelSlot(value: ModelCapacityRequest): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value);
  return transaction(async tx => {
    const state = await control(tx);
    const [original] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId));
    if (original) sameIdentity(original, checked);
    await expireRequests(tx, state);
    const [existing] = await tx.select({ ...getTableColumns(modelCapacityRequests),
      live: sql<boolean>`${modelCapacityRequests.reservedUntil} > clock_timestamp()` }).from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, checked.requestId));
    if (existing) {
      sameIdentity(existing, checked);
      if (existing.state === "reserved" && existing.live) return { kind: "granted", reservation: reservation(existing) };
      if (existing.state === "reserved" && await expireReservation(tx, existing)) return { kind: "deferred", reason: "withdrawn" };
      if (existing.state !== "waiting") return { kind: "deferred", reason: existing.state === "withdrawn" ? "withdrawn" : "dispatched" };
    }
    if (state.mode !== "open") return { kind: "deferred", reason: state.mode };
    if (!state.policy) return fail("model_capacity_policy_missing");
    const route = state.policy.routes.find(route => route.routeId === checked.routeId
      && route.provider === checked.provider && route.model === checked.model);
    if (!route) return { kind: "deferred", reason: "unmapped" };
    const [oldActive] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests)
      .where(sql`${modelCapacityRequests.state} in ('reserved','dispatched','indeterminate') AND (
        ${modelCapacityRequests.epoch} <> ${state.epoch} OR ${modelCapacityRequests.revision} <> ${state.revision}
        OR ${modelCapacityRequests.policyHash} <> ${state.policyHash})`).limit(1);
    if (oldActive) return { kind: "deferred", reason: "policy_changed" };
    if (!existing) {
      const [duplicateWork] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests)
        .where(and(eq(modelCapacityRequests.ownerInstanceId, checked.owner.instanceId),
          eq(modelCapacityRequests.ownerBootId, checked.owner.bootId), eq(modelCapacityRequests.workKey, checked.workKey),
          sql`${modelCapacityRequests.state} in ('waiting','reserved','dispatched','indeterminate')`)).limit(1);
      if (duplicateWork) return { kind: "deferred", reason: "capacity" };
      const [queue] = await tx.select({ count: sql<number>`count(*)::integer` }).from(modelCapacityRequests)
        .where(eq(modelCapacityRequests.state, "waiting"));
      if (queue.count >= state.policy.maxWaiting) return { kind: "deferred", reason: "queue_full" };
      const [waiting] = await tx.insert(modelCapacityRequests).values({ requestId: checked.requestId,
        workKey: checked.workKey, ownerInstanceId: checked.owner.instanceId, ownerBootId: checked.owner.bootId,
        class: checked.class, pool: checked.pool, routeId: checked.routeId, provider: checked.provider,
        model: checked.model, providerBudgetId: route.providerBudgetId, groupId: route.groupId,
        epoch: state.epoch, revision: state.revision, policyHash: state.policyHash!, state: "waiting",
        queueUntil: sql`clock_timestamp() + ${state.policy.queueTtlMs} * interval '1 millisecond'` }).returning();
      await event(tx, waiting, "queued", null, "waiting");
    }
    await grantOne(tx, state);
    const [own] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId));
    sameIdentity(own, checked);
    return own.state === "reserved" ? { kind: "granted", reservation: reservation(own) }
      : { kind: "deferred", reason: "capacity" };
  });
}

export async function beginModelDispatch(value: ModelCapacityReservation): Promise<
  { kind: "dispatched"; dispatch: ModelCapacityDispatch } | { kind: "ownership_lost" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value);
  return transaction(async tx => {
    const state = await control(tx);
    await expireRequests(tx, state);
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (row && await expireReservation(tx, row)) return { kind: "ownership_lost" };
    if (!owned(row, checked) || row.state !== "reserved" || state.mode !== "open" || row.epoch !== state.epoch
      || row.revision !== state.revision || row.policyHash !== state.policyHash) return { kind: "ownership_lost" };
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", updatedAt: sql`clock_timestamp()` })
      .where(and(eq(modelCapacityRequests.requestId, row.requestId), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
    if (!changed) return { kind: "ownership_lost" };
    await event(tx, changed, "dispatch_started", "reserved", "dispatched");
    return { kind: "dispatched", dispatch: modelCapacityDispatchSchema.parse(checked) };
  });
}

export async function cancelReservedModelSlot(value: ModelCapacityReservation): Promise<boolean> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value);
  return transaction(async tx => {
    const state = await control(tx);
    await expireRequests(tx, state);
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (row && await expireReservation(tx, row)) return false;
    if (!owned(row, checked) || row.state !== "reserved") return false;
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "reservation_cancelled", "reserved", "withdrawn");
    return true;
  });
}

export async function markModelDispatchIndeterminate(value: ModelCapacityDispatch,
  reason: ModelCapacityIndeterminateReason): Promise<boolean> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityDispatchSchema.parse(value);
  if (!["transport_unknown", "local_abort", "process_exit", "commit_unknown"].includes(reason)) fail("invalid_model_capacity_reason");
  return transaction(async tx => {
    const state = await control(tx);
    await expireRequests(tx, state);
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (!owned(row, checked)) return false;
    if (row.state === "indeterminate") return true;
    if (row.state !== "dispatched") return false;
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "indeterminate", updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_indeterminate", "dispatched", "indeterminate", reason);
    return true;
  });
}
