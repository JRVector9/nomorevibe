import { productTranslationMemberKeys, productTranslationLogicalWorkKey, productTranslationInputSchema,
  productTranslationDispatchBindingSchema, productTranslationDispatchBindingHash, productTranslationModelDispatchSchema,
  productTranslationGatewayTerminalEvidenceSchema, type ProductTranslationMember,
  type ProductTranslationDispatchBinding, type ProductTranslationModelDispatch } from "./capacity";
import type { ProductTranslationGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
import { reasonTranslationMemberKeys, reasonTranslationLogicalWorkKey, reasonTranslationInputSchema,
  reasonTranslationDispatchBindingSchema, reasonTranslationDispatchBindingHash, reasonTranslationModelDispatchSchema,
  reasonTranslationGatewayTerminalEvidenceSchema, type ReasonTranslationMember,
  type ReasonTranslationDispatchBinding, type ReasonTranslationModelDispatch } from "./capacity";
import type { ReasonTranslationGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
import { textProfileDispatchBindingSchema, textProfileDispatchBindingHash, textProfileModelDispatchSchema,
  textProfileGatewayTerminalEvidenceSchema, type TextProfileDispatchBinding, type TextProfileModelDispatch } from "./capacity";
import type { TextProfileGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
import { ai1ItemDispatchBindingSchema, ai1ItemDispatchBindingHash, ai1ItemModelDispatchSchema,
  ai1ItemGatewayTerminalEvidenceSchema, type Ai1ItemDispatchBinding, type Ai1ItemModelDispatch } from "@/lib/llm/capacity";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { modelCapacityControl, modelCapacityEvents, modelCapacityRequests } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { Ai1GatewayTerminal, Ai2GatewayTerminal, Ai1ItemGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import {
  modelCapacityClassCycle, modelCapacityDispatchSchema, modelCapacityPolicyHash, modelCapacityRequestSchema,
  modelCapacityRequestIdentitySchema, modelCapacityReservationSchema, parseModelCapacityPolicy,
  type ModelCapacityDispatch, type ModelCapacityEventKind, type ModelCapacityIndeterminateReason,
  type ModelCapacityRequest, type ModelCapacityRequestIdentity, type ModelCapacityReservation, type ModelSlotResult,
  ai1DispatchBindingSchema, ai1DispatchBindingHash, ai1ModelDispatchSchema, ai1GatewayTerminalEvidenceSchema,
  type Ai1DispatchBinding, type Ai1ModelDispatch,
  ai2DispatchBindingSchema, ai2DispatchBindingHash, ai2ModelDispatchSchema, ai2GatewayTerminalEvidenceSchema,
  type Ai2DispatchBinding, type Ai2ModelDispatch,
} from "./capacity";

type RequestRow = typeof modelCapacityRequests.$inferSelect;
const fail = (code: string): never => { throw new Error(code); };

function transaction<T>(load: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  if (currentReplayDb()) return Promise.reject(new Error("model_capacity_replay_unsupported"));
  return onPrimary(() => db.transaction(load));
}

async function control(tx: ProductTransaction, lock: "share" | "update" = "update") {
  const [row] = await tx.select().from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for(lock);
  if (!row) return fail("model_capacity_control_missing");
  const policy = row.policy === null ? null : parseModelCapacityPolicy(row.policy);
  if (policy !== null && modelCapacityPolicyHash(policy) !== row.policyHash) fail("model_capacity_policy_hash_mismatch");
  return { ...row, policy };
}
type Control = Awaited<ReturnType<typeof control>>;

/** Policy read for a short domain claim TX, never a permit or dispatch proof.
 * The caller acquires this prefix before stage/domain/item/job locks. */
export async function lockModelCapacityCallerControl(tx: ProductTransaction) {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  return callerControlSnapshot(await control(tx, "share"));
}

/** Standalone primary read; the transaction has settled before transport starts.
 * This never expires requests, grants a reservation or appends an event. */
export async function readModelCapacityCallerControl() {
  return transaction(tx => lockModelCapacityCallerControl(tx));
}

function callerControlSnapshot(row: Control) {
  if (!["disabled", "open", "draining"].includes(row.mode)
    || !Number.isSafeInteger(row.epoch) || row.epoch < 1
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || row.policy === null && (row.mode !== "disabled" || row.policyHash !== null)) {
    throw new Error("model_capacity_control_invalid");
  }
  const policy = row.policy && Object.freeze({ ...row.policy,
    providerLimits: Object.freeze(row.policy.providerLimits), groupLimits: Object.freeze(row.policy.groupLimits),
    poolLimits: Object.freeze(row.policy.poolLimits), weights: Object.freeze(row.policy.weights),
    routes: Object.freeze(row.policy.routes.map(route => Object.freeze(route))),
  });
  return Object.freeze({ mode: row.mode, epoch: row.epoch, revision: row.revision, policyHash: row.policyHash, policy });
}

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
  fromState: RequestRow["state"] | null, toState: RequestRow["state"], reason: ModelCapacityIndeterminateReason | null = null,
  evidence: unknown = null) {
  await tx.insert(modelCapacityEvents).values({ requestId: row.requestId, kind, epoch: row.epoch,
    revision: row.revision, policyHash: row.policyHash, fromState, toState, reason, evidence });
}

function sameIdentity(row: RequestRow, value: ModelCapacityRequestIdentity): void {
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

/** Readback only, including expired or old-policy rows. Re-poll through
 * requestModelSlot for a current reservation; this never grants or expires work. */
export async function findOwnPendingModelRequest(value: ModelCapacityRequestIdentity): Promise<
  { requestId: string; state: "waiting" | "reserved" | "dispatched" | "indeterminate" } | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestIdentitySchema.parse(value);
  return transaction(async tx => {
    await control(tx, "share");
    const [row] = await tx.select().from(modelCapacityRequests).where(and(
      eq(modelCapacityRequests.ownerInstanceId, checked.owner.instanceId),
      eq(modelCapacityRequests.ownerBootId, checked.owner.bootId), eq(modelCapacityRequests.workKey, checked.workKey),
      sql`${modelCapacityRequests.state} in ('waiting','reserved','dispatched','indeterminate')`)).limit(1);
    if (!row || row.state === "withdrawn" || row.state === "settled") return null;
    sameIdentity(row, checked);
    return { requestId: row.requestId, state: row.state };
  });
}

export async function requestModelSlot(value: ModelCapacityRequest): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value);
  return requestSlot(checked, null);
}

/** Fixed AI1 logical fence starts with the original waiting INSERT, not dispatch. */
export async function requestAi1ModelSlot(value: ModelCapacityRequest, candidateId: number): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value);
  fixedAi1Identity(checked, candidateId);
  return requestSlot(checked, `ai1:${candidateId}`);
}

function fixedAi1Identity(value: ModelCapacityRequestIdentity, candidateId: number): void {
  if (!Number.isSafeInteger(candidateId) || candidateId < 1 || value.class !== "first" || value.pool !== "reviewer"
    || value.routeId !== "crawl-agent-review" || value.provider !== "abcllm") fail("invalid_ai1_capacity_identity");
}

async function ai1Fence(tx: ProductTransaction, logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.logicalWorkKey} = ${logicalKey} AND ${modelCapacityRequests.requestId} <> ${ownId}
      AND ${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate'))
    OR (${modelCapacityRequests.logicalWorkKey} IS NULL AND ${modelCapacityRequests.routeId} = 'crawl-agent-review'
      AND ${modelCapacityRequests.provider} = 'abcllm' AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}

function requestSlot(checked: ModelCapacityRequest, logicalKey: string | null, memberKeys?: string[]): Promise<ModelSlotResult> {
  return transaction(async tx => {
    const state = await control(tx);
    const [original] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId));
    if (original) {
      sameIdentity(original, checked);
      if (logicalKey !== null && original.logicalWorkKey !== logicalKey) fail("model_capacity_logical_work_mismatch");
      if (memberKeys && !isDeepStrictEqual(original.logicalMemberKeys, memberKeys)) fail("model_capacity_logical_work_mismatch");
    }
    await expireRequests(tx, state);
    if (memberKeys && await (checked.routeId === "product-translate" ? productTranslationFence(tx, memberKeys, checked.requestId)
      : reasonTranslationFence(tx, memberKeys, checked.requestId))) return { kind: "deferred", reason: "capacity" };
    if (!memberKeys && logicalKey !== null && await (logicalKey.startsWith("ai2:")
      ? ai2Fence(tx, logicalKey, checked.requestId) : logicalKey.startsWith("text:profile:")
        ? textProfileFence(tx, logicalKey, checked.requestId) : ai1Fence(tx, logicalKey, checked.requestId))) return { kind: "deferred", reason: "capacity" };
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
        logicalWorkKey: logicalKey, ...(memberKeys ? { logicalMemberKeys: memberKeys } : {}),
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
    if (row?.logicalWorkKey !== null && row?.logicalWorkKey !== undefined) fail("ai1_bound_dispatch_required");
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
  const first = ai1ModelDispatchSchema.safeParse(value);
  const second = first.success ? first : ai2ModelDispatchSchema.safeParse(value);
  const item = second.success ? second : ai1ItemModelDispatchSchema.safeParse(value);
  const profile = item.success ? item : textProfileModelDispatchSchema.safeParse(value);
  const reasonBinding = profile.success ? profile : reasonTranslationModelDispatchSchema.safeParse(value);
  const bound = reasonBinding.success ? reasonBinding : productTranslationModelDispatchSchema.safeParse(value);
  const checked = bound.success ? modelCapacityDispatchSchema.parse({ requestId: bound.data.requestId,
    owner: bound.data.owner, token: bound.data.token, epoch: bound.data.epoch, revision: bound.data.revision,
    policyHash: bound.data.policyHash }) : modelCapacityDispatchSchema.parse(value);
  if (!["transport_unknown", "local_abort", "process_exit", "commit_unknown"].includes(reason)) fail("invalid_model_capacity_reason");
  return transaction(async tx => {
    const state = await control(tx);
    await expireRequests(tx, state);
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (!owned(row, checked)) return false;
    if (row.logicalWorkKey !== null && (!bound.success || row.dispatchBindingHash !== bound.data.bindingHash
      || !isDeepStrictEqual(row.dispatchBinding, bound.data.binding))) fail(row.logicalWorkKey?.startsWith("ai2:")
        ? "ai2_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:profile:")
          ? "text_profile_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:reason:ko:")
            ? "reason_translation_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:product-translate:")
              ? "product_translation_capacity_dispatch_binding_mismatch" : "ai1_capacity_dispatch_binding_mismatch");
    if (row.state === "indeterminate") return true;
    if (row.state !== "dispatched") return false;
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "indeterminate", updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_indeterminate", "dispatched", "indeterminate", reason);
    return true;
  });
}

declare const ai1LockBrand: unique symbol;
export type Ai1CapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  readonly [ai1LockBrand]: true }>;
const ai1Locks = new WeakMap<Ai1CapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; candidateId: number; finished: boolean }>();

/** This UPDATE prefix must precede all stage/domain/item/job locks. No nested TX. */
export async function lockAi1ModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; candidateId: number;
}): Promise<Ai1CapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(value.identity), candidateId = value.candidateId;
  fixedAi1Identity(identity, candidateId);
  const state = await control(tx);
  const snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests)
    .where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== `ai1:${candidateId}`) fail("model_capacity_logical_work_mismatch");
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId
    && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch
    || row.revision !== state.revision || row.policyHash !== state.policyHash
    || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await ai1Fence(tx, `ai1:${candidateId}`, row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as Ai1CapacityDispatchLock;
  ai1Locks.set(locked, { tx, row, identity, candidateId, finished: false });
  return locked;
}

/** The fixed domain caller proves the current candidate/input/attempt/job before
 * this final reservation CAS. A locked reservation alone is not domain proof. */
export async function finishAi1ModelCapacityDispatch(tx: ProductTransaction, lock: Ai1CapacityDispatchLock,
  value: Ai1DispatchBinding): Promise<Ai1ModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = ai1Locks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_ai1_capacity_dispatch_lock");
  const binding = ai1DispatchBindingSchema.parse(value);
  if (binding.candidateId !== proof.candidateId || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || binding.model !== proof.identity.model) fail("ai1_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = ai1DispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("ai1_model_reservation_lost");
  const dispatch = ai1ModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}

/** Only a native terminal issued by the fixed gateway can settle a bound call.
 * Actual completion remains valid after job expiry or policy/mode changes. */
export async function reconcileAi1GatewayTerminal(terminal: Ai1GatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readAi1GatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readAi1GatewayTerminal(terminal);
  if (!native) fail("invalid_ai1_gateway_terminal");
  const evidence = ai1GatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    // Completion uses the historical dispatch, not today's policy validity.
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!owned(row, dispatch) || row.logicalWorkKey !== dispatch.binding.logicalWorkKey
      || row.routeId !== dispatch.binding.routeId || row.provider !== dispatch.binding.provider
      || row.model !== dispatch.binding.model || row.class !== "first" || row.pool !== "reviewer"
      || row.dispatchBindingHash !== dispatch.bindingHash || !row.dispatchedAt
      || !isDeepStrictEqual(row.dispatchBinding, dispatch.binding)) fail("ai1_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence))
        fail("ai1_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("ai1_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}

type Ai2Target = Readonly<{ candidateId: number; vote: number }>;
function fixedAi2Target(value: Ai2Target): Ai2Target {
  if (!value || Object.keys(value).length !== 2
    || Object.keys(value).some(key => key !== "candidateId" && key !== "vote") || !Number.isSafeInteger(value.candidateId) || value.candidateId < 1
    || !Number.isSafeInteger(value.vote) || value.vote < 1) fail("invalid_ai2_capacity_target");
  return Object.freeze({ candidateId: value.candidateId, vote: value.vote });
}
function fixedAi2Identity(value: ModelCapacityRequestIdentity, target: Ai2Target): string {
  const logical = `ai2:${target.candidateId}:${target.vote}`;
  if (value.class !== "second" || value.pool !== "reviewer" || value.routeId !== "second-review"
    || value.provider !== "abcllm" || !value.workKey.startsWith(`${logical}:`)
    || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1))) fail("invalid_ai2_capacity_identity");
  return logical;
}

/** Historical unbound second-review calls have no trustworthy chain identity. */
async function ai2Fence(tx: ProductTransaction, logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.logicalWorkKey} = ${logicalKey} AND ${modelCapacityRequests.requestId} <> ${ownId}
      AND ${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate'))
    OR (${modelCapacityRequests.logicalWorkKey} IS NULL AND ${modelCapacityRequests.routeId} = 'second-review'
      AND ${modelCapacityRequests.provider} = 'abcllm' AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}

/** The chain fence exists from the original waiting INSERT, including cross-boot retries. */
export async function requestAi2ItemModelSlot(value: ModelCapacityRequest, valueTarget: Ai2Target): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value), target = fixedAi2Target(valueTarget);
  return requestSlot(checked, fixedAi2Identity(checked, target));
}

declare const ai2LockBrand: unique symbol;
export type Ai2CapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  readonly [ai2LockBrand]: true }>;
const ai2Locks = new WeakMap<Ai2CapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; target: Ai2Target; finished: boolean }>();

/** UPDATE prefix before stage/domain/attempt/item/job locks; never opens a nested TX. */
export async function lockAi2ItemModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; target: Ai2Target;
}): Promise<Ai2CapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(value.identity), target = fixedAi2Target(value.target);
  const logical = fixedAi2Identity(identity, target);
  const state = await control(tx), snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests)
    .where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== logical) fail("model_capacity_logical_work_mismatch");
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId
    && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch
    || row.revision !== state.revision || row.policyHash !== state.policyHash
    || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await ai2Fence(tx, logical, row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as Ai2CapacityDispatchLock;
  ai2Locks.set(locked, { tx, row, identity, target, finished: false });
  return locked;
}

/** The item caller must validate actual item/domain authority in this same TX.
 * This final CAS atomically records the immutable dispatch and its event. */
export async function finishAi2ItemModelCapacityDispatch(tx: ProductTransaction, lock: Ai2CapacityDispatchLock,
  value: Ai2DispatchBinding): Promise<Ai2ModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = ai2Locks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_ai2_capacity_dispatch_lock");
  const binding = ai2DispatchBindingSchema.parse(value);
  if (binding.review.candidateId !== proof.target.candidateId || binding.review.vote !== proof.target.vote
    || binding.logicalWorkKey !== proof.row.logicalWorkKey || binding.model !== proof.identity.model
    || `${binding.logicalWorkKey}:${binding.item.bindingHash}` !== proof.identity.workKey
    || binding.item.owner.instanceId !== proof.identity.owner.instanceId
    || binding.item.owner.bootId !== proof.identity.owner.bootId) fail("ai2_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = ai2DispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("ai2_model_reservation_lost");
  const dispatch = ai2ModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}

/** Only the fixed native gateway's opaque terminal can settle the historical call.
 * Today's stage/item/job/owner/policy liveness cannot undo actual completion. */
export async function reconcileAi2GatewayTerminal(terminal: Ai2GatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readAi2GatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readAi2GatewayTerminal(terminal);
  if (!native) fail("invalid_ai2_gateway_terminal");
  const evidence = ai2GatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!owned(row, dispatch) || row.logicalWorkKey !== dispatch.binding.logicalWorkKey
      || row.routeId !== dispatch.binding.routeId || row.provider !== dispatch.binding.provider
      || row.model !== dispatch.binding.model || row.class !== "second" || row.pool !== "reviewer"
      || row.workKey !== `${dispatch.binding.logicalWorkKey}:${dispatch.binding.item.bindingHash}`
      || row.dispatchBindingHash !== dispatch.bindingHash || !row.dispatchedAt
      || !isDeepStrictEqual(row.dispatchBinding, dispatch.binding)) fail("ai2_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence))
        fail("ai2_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("ai2_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}

/** Item caller proves actual fresh attempt and item in this same TX. Shares the original AI1 lock. */
export async function finishAi1ItemModelCapacityDispatch(tx: ProductTransaction, lock: Ai1CapacityDispatchLock,
  value: Ai1ItemDispatchBinding): Promise<Ai1ItemModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = ai1Locks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_ai1_capacity_dispatch_lock");
  const binding = ai1ItemDispatchBindingSchema.parse(value);
  if (binding.review.candidateId !== proof.candidateId || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || binding.model !== proof.identity.model
    || `${binding.logicalWorkKey}:${binding.item.bindingHash}` !== proof.identity.workKey
    || binding.item.owner.instanceId !== proof.identity.owner.instanceId
    || binding.item.owner.bootId !== proof.identity.owner.bootId) fail("ai1_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = ai1ItemDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("ai1_model_reservation_lost");
  const dispatch = ai1ItemModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}


/** Fixed native item verifier only; historical settlement does not depend on current item liveness. */
export async function reconcileAi1ItemGatewayTerminal(terminal: Ai1ItemGatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readAi1ItemGatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readAi1ItemGatewayTerminal(terminal);
  if (!native) fail("invalid_ai1_item_gateway_terminal");
  const evidence = ai1ItemGatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    // Completion uses the historical dispatch, not today's policy validity.
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!owned(row, dispatch) || row.logicalWorkKey !== dispatch.binding.logicalWorkKey
      || row.routeId !== dispatch.binding.routeId || row.provider !== dispatch.binding.provider
      || row.model !== dispatch.binding.model || row.class !== "first" || row.pool !== "reviewer"
      || row.workKey !== `${dispatch.binding.logicalWorkKey}:${dispatch.binding.item.bindingHash}`
      || row.dispatchBindingHash !== dispatch.bindingHash || !row.dispatchedAt
      || !isDeepStrictEqual(row.dispatchBinding, dispatch.binding)) fail("ai1_item_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence))
        fail("ai1_item_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("ai1_item_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}

function fixedTextProfileIdentity(value: ModelCapacityRequestIdentity, productId: number): string {
  const logical = `text:profile:${productId}`;
  if (!Number.isSafeInteger(productId) || productId < 1 || value.class !== "background" || value.pool !== "text"
    || value.routeId !== "product-search-profile" || value.provider !== "abcllm"
    || !value.workKey.startsWith(`${logical}:`) || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1)))
    fail("invalid_text_profile_capacity_identity");
  return logical;
}
async function textProfileFence(tx: ProductTransaction, logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.logicalWorkKey} = ${logicalKey} AND ${modelCapacityRequests.requestId} <> ${ownId}
      AND ${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate'))
    OR (${modelCapacityRequests.logicalWorkKey} IS NULL AND ${modelCapacityRequests.routeId} = 'product-search-profile'
      AND ${modelCapacityRequests.provider} = 'abcllm' AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
/** Logical fence is present in the original waiting INSERT, never patched after grant. */
export async function requestTextProfileModelSlot(value: ModelCapacityRequest, productId: number): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value);
  return requestSlot(checked, fixedTextProfileIdentity(checked, productId));
}

declare const textProfileLockBrand: unique symbol;
export type TextProfileCapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  readonly [textProfileLockBrand]: true }>;
const textProfileLocks = new WeakMap<TextProfileCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; productId: number; finished: boolean }>();

/** This UPDATE prefix must precede all stage/domain/item/job locks. No nested TX. */
export async function lockTextProfileModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; productId: number;
}): Promise<TextProfileCapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(value.identity), productId = value.productId;
  fixedTextProfileIdentity(identity, productId);
  const state = await control(tx);
  const snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests)
    .where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== `text:profile:${productId}`) fail("model_capacity_logical_work_mismatch");
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId
    && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch
    || row.revision !== state.revision || row.policyHash !== state.policyHash
    || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await textProfileFence(tx, `text:profile:${productId}`, row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as TextProfileCapacityDispatchLock;
  textProfileLocks.set(locked, { tx, row, identity, productId, finished: false });
  return locked;
}

export async function finishTextProfileModelCapacityDispatch(tx: ProductTransaction, lock: TextProfileCapacityDispatchLock,
  value: TextProfileDispatchBinding): Promise<TextProfileModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = textProfileLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_text_profile_capacity_dispatch_lock");
  const binding = textProfileDispatchBindingSchema.parse(value);
  if (binding.productId !== proof.productId || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || binding.model !== proof.identity.model
    || `${binding.logicalWorkKey}:${binding.inputHash}` !== proof.identity.workKey
    || binding.role.instanceId !== proof.identity.owner.instanceId
    || binding.role.bootId !== proof.identity.owner.bootId) fail("text_profile_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = textProfileDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("text_profile_model_reservation_lost");
  const dispatch = textProfileModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}

export async function reconcileTextProfileGatewayTerminal(terminal: TextProfileGatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readTextProfileGatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readTextProfileGatewayTerminal(terminal);
  if (!native) fail("invalid_text_profile_gateway_terminal");
  const evidence = textProfileGatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    // Completion uses the historical dispatch, not today's policy validity.
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!owned(row, dispatch) || row.logicalWorkKey !== dispatch.binding.logicalWorkKey
      || row.routeId !== dispatch.binding.routeId || row.provider !== dispatch.binding.provider
      || row.model !== dispatch.binding.model || row.class !== "background" || row.pool !== "text"
      || row.workKey !== `${dispatch.binding.logicalWorkKey}:${dispatch.binding.inputHash}`
      || row.dispatchBindingHash !== dispatch.bindingHash || !row.dispatchedAt
      || !isDeepStrictEqual(row.dispatchBinding, dispatch.binding)) fail("text_profile_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence))
        fail("text_profile_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("text_profile_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}


function fixedReasonTranslationIdentity(value: ModelCapacityRequestIdentity, members: readonly ReasonTranslationMember[]): string {
  const logical = reasonTranslationLogicalWorkKey(members);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "reason-translate"
    || value.provider !== "abcllm" || !value.workKey.startsWith(`${logical}:`)
    || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1))) fail("invalid_reason_translation_capacity_identity");
  return logical;
}
async function reasonTranslationFence(tx: ProductTransaction, keys: readonly string[], ownId: string): Promise<boolean> {
  const keyArray = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND ${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate')
      AND ${modelCapacityRequests.logicalMemberKeys} && ${keyArray})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'reason-translate'
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
/** Durable sorted membership belongs to the very first waiting INSERT. */
export async function requestReasonTranslationModelSlot(value: ModelCapacityRequest,
  members: readonly ReasonTranslationMember[]): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value), snapshot = reasonTranslationInputSchema.shape.members.parse(members);
  return requestSlot(checked, fixedReasonTranslationIdentity(checked, snapshot), reasonTranslationMemberKeys(snapshot));
}

declare const reasonTranslationLockBrand: unique symbol;
export type ReasonTranslationCapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  readonly [reasonTranslationLockBrand]: true }>;
const reasonTranslationLocks = new WeakMap<ReasonTranslationCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; members: readonly ReasonTranslationMember[]; finished: boolean }>();

/** This UPDATE prefix must precede all stage/domain/item/job locks. No nested TX. */
export async function lockReasonTranslationModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; members: readonly ReasonTranslationMember[];
}): Promise<ReasonTranslationCapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(value.identity);
  const members = reasonTranslationInputSchema.shape.members.parse(value.members);
  const logical = fixedReasonTranslationIdentity(identity, members);
  const state = await control(tx);
  const snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests)
    .where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== logical) fail("model_capacity_logical_work_mismatch");
  if (!isDeepStrictEqual(row.logicalMemberKeys, reasonTranslationMemberKeys(members))) return null;
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId
    && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch
    || row.revision !== state.revision || row.policyHash !== state.policyHash
    || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await reasonTranslationFence(tx, reasonTranslationMemberKeys(members), row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as ReasonTranslationCapacityDispatchLock;
  reasonTranslationLocks.set(locked, { tx, row, identity, members, finished: false });
  return locked;
}

export async function finishReasonTranslationModelCapacityDispatch(tx: ProductTransaction, lock: ReasonTranslationCapacityDispatchLock,
  value: ReasonTranslationDispatchBinding): Promise<ReasonTranslationModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = reasonTranslationLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_reason_translation_capacity_dispatch_lock");
  const binding = reasonTranslationDispatchBindingSchema.parse(value);
  if (!isDeepStrictEqual(binding.members, proof.members) || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || binding.model !== proof.identity.model
    || `${binding.logicalWorkKey}:${binding.inputHash}` !== proof.identity.workKey
    || binding.role.instanceId !== proof.identity.owner.instanceId
    || binding.role.bootId !== proof.identity.owner.bootId) fail("reason_translation_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = reasonTranslationDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("reason_translation_model_reservation_lost");
  const dispatch = reasonTranslationModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}

export async function reconcileReasonTranslationGatewayTerminal(terminal: ReasonTranslationGatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readReasonTranslationGatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readReasonTranslationGatewayTerminal(terminal);
  if (!native) fail("invalid_reason_translation_gateway_terminal");
  const evidence = reasonTranslationGatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    // Completion uses the historical dispatch, not today's policy validity.
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!owned(row, dispatch) || row.logicalWorkKey !== dispatch.binding.logicalWorkKey
      || !isDeepStrictEqual(row.logicalMemberKeys, reasonTranslationMemberKeys(dispatch.binding.members))
      || row.routeId !== dispatch.binding.routeId || row.provider !== dispatch.binding.provider
      || row.model !== dispatch.binding.model || row.class !== "background" || row.pool !== "text"
      || row.workKey !== `${dispatch.binding.logicalWorkKey}:${dispatch.binding.inputHash}`
      || row.dispatchBindingHash !== dispatch.bindingHash || !row.dispatchedAt
      || !isDeepStrictEqual(row.dispatchBinding, dispatch.binding)) fail("reason_translation_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence))
        fail("reason_translation_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("reason_translation_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}


function fixedProductTranslationIdentity(value: ModelCapacityRequestIdentity, members: readonly ProductTranslationMember[]): string {
  const logical = productTranslationLogicalWorkKey(members);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "product-translate"
    || value.provider !== "abcllm" || !value.workKey.startsWith(`${logical}:`)
    || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1))) fail("invalid_product_translation_capacity_identity");
  return logical;
}
async function productTranslationFence(tx: ProductTransaction, keys: readonly string[], ownId: string): Promise<boolean> {
  const keyArray = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND ${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate')
      AND ${modelCapacityRequests.logicalMemberKeys} && ${keyArray})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'product-translate'
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
/** Durable sorted membership belongs to the very first waiting INSERT. */
export async function requestProductTranslationModelSlot(value: ModelCapacityRequest,
  members: readonly ProductTranslationMember[]): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value), snapshot = productTranslationInputSchema.shape.members.parse(members);
  return requestSlot(checked, fixedProductTranslationIdentity(checked, snapshot), productTranslationMemberKeys(snapshot));
}

declare const productTranslationLockBrand: unique symbol;
export type ProductTranslationCapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  readonly [productTranslationLockBrand]: true }>;
const productTranslationLocks = new WeakMap<ProductTranslationCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; members: readonly ProductTranslationMember[]; finished: boolean }>();

/** This UPDATE prefix must precede all stage/domain/item/job locks. No nested TX. */
export async function lockProductTranslationModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; members: readonly ProductTranslationMember[];
}): Promise<ProductTranslationCapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(value.identity);
  const members = productTranslationInputSchema.shape.members.parse(value.members);
  const logical = fixedProductTranslationIdentity(identity, members);
  const state = await control(tx);
  const snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests)
    .where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== logical) fail("model_capacity_logical_work_mismatch");
  if (!isDeepStrictEqual(row.logicalMemberKeys, productTranslationMemberKeys(members))) return null;
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId
    && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch
    || row.revision !== state.revision || row.policyHash !== state.policyHash
    || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await productTranslationFence(tx, productTranslationMemberKeys(members), row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as ProductTranslationCapacityDispatchLock;
  productTranslationLocks.set(locked, { tx, row, identity, members, finished: false });
  return locked;
}

export async function finishProductTranslationModelCapacityDispatch(tx: ProductTransaction, lock: ProductTranslationCapacityDispatchLock,
  value: ProductTranslationDispatchBinding): Promise<ProductTranslationModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = productTranslationLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_product_translation_capacity_dispatch_lock");
  const binding = productTranslationDispatchBindingSchema.parse(value);
  if (!isDeepStrictEqual(binding.members, proof.members) || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || binding.model !== proof.identity.model
    || `${binding.logicalWorkKey}:${binding.inputHash}` !== proof.identity.workKey
    || binding.role.instanceId !== proof.identity.owner.instanceId
    || binding.role.bootId !== proof.identity.owner.bootId) fail("product_translation_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = productTranslationDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("product_translation_model_reservation_lost");
  const dispatch = productTranslationModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}

export async function reconcileProductTranslationGatewayTerminal(terminal: ProductTranslationGatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readProductTranslationGatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readProductTranslationGatewayTerminal(terminal);
  if (!native) fail("invalid_product_translation_gateway_terminal");
  const evidence = productTranslationGatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    // Completion uses the historical dispatch, not today's policy validity.
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!owned(row, dispatch) || row.logicalWorkKey !== dispatch.binding.logicalWorkKey
      || !isDeepStrictEqual(row.logicalMemberKeys, productTranslationMemberKeys(dispatch.binding.members))
      || row.routeId !== dispatch.binding.routeId || row.provider !== dispatch.binding.provider
      || row.model !== dispatch.binding.model || row.class !== "background" || row.pool !== "text"
      || row.workKey !== `${dispatch.binding.logicalWorkKey}:${dispatch.binding.inputHash}`
      || row.dispatchBindingHash !== dispatch.bindingHash || !row.dispatchedAt
      || !isDeepStrictEqual(row.dispatchBinding, dispatch.binding)) fail("product_translation_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence))
        fail("product_translation_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("product_translation_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}
