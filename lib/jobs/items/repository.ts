import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { pipelineItemLeases, pipelineStageModes } from "@/lib/db/schema";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { writerSiteActive } from "@/lib/operations/dr/epoch";
import { itemBindingHash, itemOwnerSchema, itemWorkKey, parseItemBinding,
  type ItemBinding, type ItemLease, type ItemOwner, type ItemStage } from "./types";

declare const guardBrand: unique symbol;
export type ItemStageGuard = Readonly<{ [guardBrand]: true }>;
export type StageState = typeof pipelineStageModes.$inferSelect;
type LeaseRow = typeof pipelineItemLeases.$inferSelect;
const guards = new WeakMap<ItemStageGuard, { tx: ProductTransaction; stage: ItemStage; txId: string }>();
const itemTransactions = new WeakSet<ProductTransaction>();
const fail = (code: string): never => { throw new Error(code); };

/** PostgreSQL17 support boundary: a stage lock first acquired in an open
 * subtransaction must not authenticate a guard that can outlive its rollback.
 * Check after awaiting the row lock, without relying on SELECT evaluation order.
 * A parent already holding the same/stronger lock keeps its valid mutex.
 * Revalidate this adapter boundary when changing PostgreSQL/Drizzle versions. */
async function assertStageLockContext(tx: ProductTransaction, txId: string, markItem = false): Promise<void> {
  const [context] = await tx.execute<{ tx_id: string; lock_count: number; top_only: boolean }>(sql`
    SELECT pg_current_xact_id()::text AS tx_id, count(*)::int AS lock_count,
      coalesce(bool_and(transactionid = pg_current_xact_id()::xid), false) AS top_only,
      CASE WHEN ${markItem} THEN set_config('nomorevibe.item_stage_guard', 'on', true) END AS item_channel
    FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid()
      AND locktype='transactionid' AND mode='ExclusiveLock' AND granted`);
  if (context.tx_id !== txId) return fail("item_stage_transaction_required");
  if (context.lock_count !== 1 || !context.top_only) fail("item_stage_nested_transaction_unsupported");
}

function validTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000) fail("invalid_item_lease_ttl");
}
const key = (stage: ItemStage, workKey: string) => and(eq(pipelineItemLeases.stage, stage), eq(pipelineItemLeases.workKey, workKey));
async function guardedStage(tx: ProductTransaction, guard: ItemStageGuard, stage: ItemStage): Promise<StageState> {
  const identity = guards.get(guard);
  if (!identity || identity.tx !== tx || identity.stage !== stage) return fail("invalid_item_stage_guard");
  // SHARE already protects this row. Re-read so even this transaction's own
  // control changes cannot leave an earlier guard with an obsolete mode/epoch.
  const [row] = await tx.select({ ...getTableColumns(pipelineStageModes), txId: sql<string>`pg_current_xact_id()::text` })
    .from(pipelineStageModes).where(eq(pipelineStageModes.stage, stage));
  if (!row) return fail("item_stage_missing");
  if (row.txId !== identity.txId) return fail("invalid_item_stage_guard");
  return row;
}
const canFinish = (stage: StageState, lease: ItemLease) => stage.writerContractVersion >= 1 && stage.epoch === lease.stageEpoch
  && (stage.mode === "items" || stage.mode === "draining" && stage.drainingFrom === "items");
function validateLease(lease: ItemLease): void {
  const binding = parseItemBinding(lease.binding);
  itemOwnerSchema.parse(lease.owner);
  if (binding.stage !== lease.stage || itemWorkKey(binding) !== lease.workKey || itemBindingHash(binding) !== lease.bindingHash
    || !Number.isSafeInteger(lease.stageEpoch) || lease.stageEpoch < 1
    || !Number.isSafeInteger(lease.itemEpoch) || lease.itemEpoch < 1) fail("invalid_item_lease");
}
function owned(lease: ItemLease) {
  return and(key(lease.stage, lease.workKey), eq(pipelineItemLeases.token, lease.token),
    eq(pipelineItemLeases.ownerInstanceId, lease.owner.instanceId), eq(pipelineItemLeases.ownerBootId, lease.owner.bootId),
    eq(pipelineItemLeases.stageEpoch, lease.stageEpoch), eq(pipelineItemLeases.itemEpoch, lease.itemEpoch),
    eq(pipelineItemLeases.bindingHash, lease.bindingHash), sql`${pipelineItemLeases.leaseUntil} > clock_timestamp()`);
}
function leaseFrom(row: LeaseRow): ItemLease {
  if (!row.token || !row.ownerInstanceId || !row.ownerBootId || !row.leaseUntil) return fail("item_lease_lost");
  return { stage: row.stage, workKey: row.workKey, binding: row.binding, bindingHash: row.bindingHash,
    owner: { instanceId: row.ownerInstanceId, bootId: row.ownerBootId }, token: row.token,
    stageEpoch: row.stageEpoch, itemEpoch: row.itemEpoch, leaseUntil: row.leaseUntil };
}
async function lockLease(tx: ProductTransaction, lease: ItemLease): Promise<boolean> {
  const [row] = await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases)
    .where(key(lease.stage, lease.workKey)).for("update");
  return Boolean(row);
}

/** First lock in every item transaction after the DR writer fence: stage SHARE, then caller domain, item,
 * and finally jobs/outbox. Await every repository call before committing the
 * caller transaction. Never keep it across external calls. */
export async function lockItemStage(tx: ProductTransaction, stage: ItemStage): Promise<ItemStageGuard> {
  const [row] = await tx.select({ ...getTableColumns(pipelineStageModes), txId: sql<string>`pg_current_xact_id()::text` })
    .from(pipelineStageModes).where(eq(pipelineStageModes.stage, stage)).for("share");
  if (!row) return fail("item_stage_missing");
  await assertStageLockContext(tx, row.txId, true);
  const guard = Object.freeze({}) as ItemStageGuard;
  guards.set(guard, { tx, stage, txId: row.txId });
  itemTransactions.add(tx);
  return guard;
}

/** Observe mode/epoch only under this transaction's actual stage mutex.
 * The returned row is not a replacement for the opaque guard or a lease. */
export async function readItemStage(tx: ProductTransaction, guard: ItemStageGuard): Promise<StageState> {
  const identity = guards.get(guard);
  if (!identity) return fail("invalid_item_stage_guard");
  return guardedStage(tx, guard, identity.stage);
}

/** A changed binding still competes for the same logical work slot.
 * The caller transaction takes the DR writer fence before the stage lock (ledger control or claimFetchItem). */
export async function claimItemLease(tx: ProductTransaction, guard: ItemStageGuard, value: ItemBinding,
  ownerValue: ItemOwner, ttlMs: number): Promise<ItemLease | null> {
  const binding = parseItemBinding(value), owner = itemOwnerSchema.parse(ownerValue);
  const stage = await guardedStage(tx, guard, binding.stage);
  validTtl(ttlMs);
  if (stage.mode !== "items" || stage.writerContractVersion < 1) return null;
  // 같은 TX 가 이미 잡은 fence SHARE 의 재확인이라 기다리지 않는다. fenced DB 는 새 item 소유권을 내주지 않는다
  // (AI1 의 재사용·rules claim 은 장부 draining 판정 전에 lease 를 commit 할 수 있었다). 격리 replay DB 는 fence 권한이 없다.
  if (!currentReplayDb() && !await writerSiteActive(tx)) return null;
  const workKey = itemWorkKey(binding), bindingHash = itemBindingHash(binding);
  // Serializes absent-row inserts without waiting on a unique-index conflict.
  // Hash collisions conservatively skip work rather than admit a second owner.
  const [advisory] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(1485804, hashtext(${`${binding.stage}:${workKey}`})) AS locked`);
  if (!advisory.locked) return null;
  let [row] = await tx.select().from(pipelineItemLeases).where(key(binding.stage, workKey)).for("update", { skipLocked: true });
  if (!row) {
    const [exists] = await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases).where(key(binding.stage, workKey));
    if (exists) return null;
    await tx.insert(pipelineItemLeases).values({ stage: binding.stage, workKey, binding, bindingHash, stageEpoch: stage.epoch })
      .onConflictDoNothing();
    [row] = await tx.select().from(pipelineItemLeases).where(key(binding.stage, workKey)).for("update", { skipLocked: true });
    if (!row) return null;
  }
  // clock_timestamp is evaluated only after the item lock was acquired; a
  // transaction's start time is not evidence that an owner is still healthy.
  const [claimed] = await tx.update(pipelineItemLeases).set({ binding, bindingHash,
    ownerInstanceId: owner.instanceId, ownerBootId: owner.bootId, token: randomUUID(), stageEpoch: stage.epoch,
    itemEpoch: sql`${pipelineItemLeases.itemEpoch} + 1`,
    leaseUntil: sql`clock_timestamp() + ${ttlMs} * interval '1 millisecond'`, updatedAt: sql`clock_timestamp()`,
  }).where(and(key(binding.stage, workKey), or(isNull(pipelineItemLeases.token), sql`${pipelineItemLeases.leaseUntil} <= clock_timestamp()`),
    sql`${pipelineItemLeases.itemEpoch} < 9007199254740991`)).returning();
  return claimed ? leaseFrom(claimed) : null;
}

/** Caller domain/result changes roll back with a lost ownership assertion. */
export async function assertItemLease(tx: ProductTransaction, guard: ItemStageGuard, lease: ItemLease): Promise<void> {
  validateLease(lease);
  const stage = await guardedStage(tx, guard, lease.stage);
  if (!canFinish(stage, lease) || !await lockLease(tx, lease)) return fail("item_lease_lost");
  const [row] = await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases).where(owned(lease));
  if (!row) fail("item_lease_lost");
}

/** TTL only bounds ownership; expiry is not proof an external call has exited. */
export async function renewItemLease(tx: ProductTransaction, guard: ItemStageGuard, lease: ItemLease,
  ttlMs: number): Promise<ItemLease | null> {
  validateLease(lease); validTtl(ttlMs);
  const stage = await guardedStage(tx, guard, lease.stage);
  if (!canFinish(stage, lease) || !await lockLease(tx, lease)) return null;
  const [row] = await tx.update(pipelineItemLeases).set({
    leaseUntil: sql`clock_timestamp() + ${ttlMs} * interval '1 millisecond'`, updatedAt: sql`clock_timestamp()`,
  }).where(owned(lease)).returning();
  return row ? leaseFrom(row) : null;
}

/** Release and requestJob belong in the caller's result transaction. */
export async function releaseItemLease(tx: ProductTransaction, guard: ItemStageGuard, lease: ItemLease): Promise<void> {
  validateLease(lease);
  const stage = await guardedStage(tx, guard, lease.stage);
  if (!canFinish(stage, lease) || !await lockLease(tx, lease)) return fail("item_lease_lost");
  const [row] = await tx.update(pipelineItemLeases).set({ ownerInstanceId: null, ownerBootId: null, token: null,
    leaseUntil: null, updatedAt: sql`clock_timestamp()` }).where(owned(lease)).returning({ workKey: pipelineItemLeases.workKey });
  if (!row) fail("item_lease_lost");
}

async function lockControlRow(tx: ProductTransaction, stage: ItemStage): Promise<StageState & { txId: string }> {
  if (itemTransactions.has(tx)) return fail("item_stage_lock_order");
  // Deny-only transaction-local marker also covers a child adapter object.
  // It grants no authority and does not defend against trusted raw SQL changes.
  const [channel] = await tx.execute<{ item_channel: string | null }>(sql`
    SELECT current_setting('nomorevibe.item_stage_guard', true) AS item_channel`);
  if (channel.item_channel === "on") return fail("item_stage_lock_order");
  const [row] = await tx.select({ ...getTableColumns(pipelineStageModes), txId: sql<string>`pg_current_xact_id()::text` })
    .from(pipelineStageModes).where(eq(pipelineStageModes.stage, stage)).for("update");
  if (!row) return fail("item_stage_missing");
  await assertStageLockContext(tx, row.txId);
  return row;
}

async function lockControlStage(tx: ProductTransaction, stage: ItemStage): Promise<StageState & { txId: string }> {
  const row = await lockControlRow(tx, stage);
  if (row.writerContractVersion < 1) return fail("item_stage_contract_required");
  return row;
}

/** Operator attestation that every writer honors the stage lock. Legacy only, one step up, never lowered. */
export async function bumpStageWriterContract(tx: ProductTransaction, stage: ItemStage): Promise<StageState> {
  const row = await lockControlRow(tx, stage);
  if (row.mode !== "legacy") return fail("item_stage_transition_invalid");
  const [bumped] = await tx.update(pipelineStageModes).set({ writerContractVersion: row.writerContractVersion + 1, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(pipelineStageModes.stage, stage), sql`pg_current_xact_id()::text = ${row.txId}`)).returning();
  if (!bumped) return fail("item_stage_transaction_required");
  return bumped;
}

/** Control APIs must run at transaction entry, before any domain/item lock.
 * Never upgrade an item transaction's SHARE after acquiring domain locks. */
export async function beginStageDrain(tx: ProductTransaction, stage: ItemStage): Promise<StageState> {
  const row = await lockControlStage(tx, stage);
  if (row.mode === "draining") return fail("item_stage_transition_invalid");
  const [draining] = await tx.update(pipelineStageModes).set({ mode: "draining", drainingFrom: row.mode, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(pipelineStageModes.stage, stage), sql`pg_current_xact_id()::text = ${row.txId}`)).returning();
  if (!draining) return fail("item_stage_transaction_required");
  return draining;
}

/** No forced fence: a transition cannot complete while any item is live. */
export async function completeStageTransition(tx: ProductTransaction, stage: ItemStage,
  target: "legacy" | "items"): Promise<StageState> {
  const row = await lockControlStage(tx, stage);
  if (row.mode !== "draining" || !["legacy", "items"].includes(target)) return fail("item_stage_transition_invalid");
  const [live] = await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases)
    .where(and(eq(pipelineItemLeases.stage, stage), sql`${pipelineItemLeases.leaseUntil} > clock_timestamp()`)).limit(1);
  if (live) return fail("item_stage_not_drained");
  if (row.epoch >= Number.MAX_SAFE_INTEGER) return fail("item_stage_epoch_exhausted");
  const [complete] = await tx.update(pipelineStageModes).set({ mode: target, drainingFrom: null,
    epoch: row.epoch + 1, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(pipelineStageModes.stage, stage), sql`pg_current_xact_id()::text = ${row.txId}`)).returning();
  if (!complete) return fail("item_stage_transaction_required");
  return complete;
}
