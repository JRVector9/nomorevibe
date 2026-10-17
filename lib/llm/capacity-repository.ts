import { productTaglineKoMemberKeys, productTaglineKoLogicalWorkKey, productTaglineKoInputSchema,
  productTaglineKoDispatchBindingSchema, productTaglineKoDispatchBindingHash, productTaglineKoModelDispatchSchema,
  productTaglineKoGatewayTerminalEvidenceSchema, type ProductTaglineKoMember,
  type ProductTaglineKoDispatchBinding, type ProductTaglineKoModelDispatch } from "./capacity";
import type { ProductTaglineKoGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
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
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { slotOnlyModelCapacity } from "./capacity-consumer-scope";

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
  const snapshot = await transaction(tx => lockModelCapacityCallerControl(tx));
  // Every disabled-transport choice (coordinator, text/CLI admission) reads here. A background
  // consumer lane never takes that uncapped path, even if open flips to disabled mid-tick.
  if (snapshot.mode === "disabled" && slotOnlyModelCapacity()) throw new ModelCapacityDeferredError("disabled");
  return snapshot;
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
    // updated_at은 모드·정책이 바뀐 시각이다(판정 수집기가 구간 중 변경으로 읽는다). cursor 진행은 그 시각을 바꾸지 않는다.
    await tx.update(modelCapacityControl).set({ cursor: (position + 1) % cycle.length })
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

function requestSlot(checked: ModelCapacityRequest, logicalKey: string | null, memberKeys?: string[], crawl?: CrawlTaglineInput,
  websearch?: WebsearchQueryInput): Promise<ModelSlotResult> {
  return transaction(async tx => {
    const state = await control(tx);
    let original: RequestRow | undefined;
    if (crawl) {
      const rows = await lockCrawlTaglineRequests(tx, checked.requestId, crawl);
      original = rows.find(row => row.requestId === checked.requestId);
      assertCrawlTaglineParent(crawl, rows.find(row => row.requestId === crawl.parent?.requestId));
    } else {
      const [found] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId));
      original = found;
    }
    if (original) {
      sameIdentity(original, checked);
      if (logicalKey !== null && original.logicalWorkKey !== logicalKey) fail("model_capacity_logical_work_mismatch");
      if (memberKeys && !isDeepStrictEqual(original.logicalMemberKeys, memberKeys)) fail("model_capacity_logical_work_mismatch");
    }
    await expireRequests(tx, state);
    if (memberKeys && await (crawl ? crawlTaglineFence(tx, crawl, checked.requestId) : websearch ? websearchQueryFence(tx, websearch, checked.requestId)
      : checked.routeId === "product-search-verify" ? searchVerifyFence(tx, memberKeys, logicalKey!, checked.requestId)
      : checked.routeId === "product-translate" ? productTranslationFence(tx, memberKeys, checked.requestId)
      : checked.routeId === "product-tagline-ko" ? productTaglineKoFence(tx, memberKeys, checked.requestId)
        : checked.routeId === "product-intro-check" ? introCheckFence(tx, memberKeys, checked.requestId)
          : reasonTranslationFence(tx, memberKeys, checked.requestId))) return { kind: "deferred", reason: "capacity" };
    if (!memberKeys && logicalKey !== null && await (logicalKey.startsWith("ai2:")
      ? ai2Fence(tx, logicalKey, checked.requestId) : logicalKey.startsWith("text:profile:")
        ? textProfileFence(tx, logicalKey, checked.requestId) : logicalKey.startsWith("bg:")
          ? cliKeyFence(tx, logicalKey, checked.routeId, checked.requestId) : ai1Fence(tx, logicalKey, checked.requestId))) return { kind: "deferred", reason: "capacity" };
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
  const product = reasonBinding.success ? reasonBinding : productTranslationModelDispatchSchema.safeParse(value);
  const korean = product.success ? product : productTaglineKoModelDispatchSchema.safeParse(value);
  const crawlBound = korean.success ? korean : crawlTaglineModelDispatchSchema.safeParse(value);
  const searchVerifyBound = crawlBound.success ? crawlBound : searchVerifyModelDispatchSchema.safeParse(value);
  const websearchBound = searchVerifyBound.success ? searchVerifyBound : websearchQueryModelDispatchSchema.safeParse(value);
  const bound = websearchBound.success ? websearchBound : cliModelDispatchSchema.safeParse(value);
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
      || !isDeepStrictEqual(row.dispatchBinding, bound.data.binding))) fail(row.provider === "claude-cli" || row.provider === "grok-cli"
      ? "cli_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("ai2:")
        ? "ai2_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:profile:")
          ? "text_profile_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:reason:ko:")
            ? "reason_translation_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:product-translate:")
              ? "product_translation_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:product-tagline-ko:")
                ? "product_tagline_ko_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:crawl-tagline:")
                  ? "crawl_tagline_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:search-verify:")
                    ? "search_verify_capacity_dispatch_binding_mismatch" : row.logicalWorkKey?.startsWith("text:websearch-query:")
                      ? "websearch_query_capacity_dispatch_binding_mismatch" : "ai1_capacity_dispatch_binding_mismatch");
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


function fixedProductTaglineKoIdentity(value: ModelCapacityRequestIdentity, members: readonly ProductTaglineKoMember[]): string {
  const logical = productTaglineKoLogicalWorkKey(members);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "product-tagline-ko"
    || value.provider !== "abcllm" || !value.workKey.startsWith(`${logical}:`)
    || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1))) fail("invalid_product_tagline_ko_capacity_identity");
  return logical;
}
async function productTaglineKoFence(tx: ProductTransaction, keys: readonly string[], ownId: string): Promise<boolean> {
  const keyArray = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND ${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate')
      AND ${modelCapacityRequests.logicalMemberKeys} && ${keyArray})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'product-tagline-ko'
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
/** Durable sorted membership belongs to the very first waiting INSERT. */
export async function requestProductTaglineKoModelSlot(value: ModelCapacityRequest,
  members: readonly ProductTaglineKoMember[]): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value), snapshot = productTaglineKoInputSchema.shape.members.parse(members);
  return requestSlot(checked, fixedProductTaglineKoIdentity(checked, snapshot), productTaglineKoMemberKeys(snapshot));
}

declare const productTaglineKoLockBrand: unique symbol;
export type ProductTaglineKoCapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  readonly [productTaglineKoLockBrand]: true }>;
const productTaglineKoLocks = new WeakMap<ProductTaglineKoCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; members: readonly ProductTaglineKoMember[]; finished: boolean }>();

/** This UPDATE prefix must precede all stage/domain/item/job locks. No nested TX. */
export async function lockProductTaglineKoModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; members: readonly ProductTaglineKoMember[];
}): Promise<ProductTaglineKoCapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(value.identity);
  const members = productTaglineKoInputSchema.shape.members.parse(value.members);
  const logical = fixedProductTaglineKoIdentity(identity, members);
  const state = await control(tx);
  const snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests)
    .where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== logical) fail("model_capacity_logical_work_mismatch");
  if (!isDeepStrictEqual(row.logicalMemberKeys, productTaglineKoMemberKeys(members))) return null;
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId
    && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch
    || row.revision !== state.revision || row.policyHash !== state.policyHash
    || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await productTaglineKoFence(tx, productTaglineKoMemberKeys(members), row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as ProductTaglineKoCapacityDispatchLock;
  productTaglineKoLocks.set(locked, { tx, row, identity, members, finished: false });
  return locked;
}

export async function finishProductTaglineKoModelCapacityDispatch(tx: ProductTransaction, lock: ProductTaglineKoCapacityDispatchLock,
  value: ProductTaglineKoDispatchBinding): Promise<ProductTaglineKoModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = productTaglineKoLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_product_tagline_ko_capacity_dispatch_lock");
  const binding = productTaglineKoDispatchBindingSchema.parse(value);
  if (!isDeepStrictEqual(binding.members, proof.members) || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || binding.model !== proof.identity.model
    || `${binding.logicalWorkKey}:${binding.inputHash}` !== proof.identity.workKey
    || binding.role.instanceId !== proof.identity.owner.instanceId
    || binding.role.bootId !== proof.identity.owner.bootId) fail("product_tagline_ko_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = productTaglineKoDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("product_tagline_ko_model_reservation_lost");
  const dispatch = productTaglineKoModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}

export async function reconcileProductTaglineKoGatewayTerminal(terminal: ProductTaglineKoGatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readProductTaglineKoGatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readProductTaglineKoGatewayTerminal(terminal);
  if (!native) fail("invalid_product_tagline_ko_gateway_terminal");
  const evidence = productTaglineKoGatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    // Completion uses the historical dispatch, not today's policy validity.
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!owned(row, dispatch) || row.logicalWorkKey !== dispatch.binding.logicalWorkKey
      || !isDeepStrictEqual(row.logicalMemberKeys, productTaglineKoMemberKeys(dispatch.binding.members))
      || row.routeId !== dispatch.binding.routeId || row.provider !== dispatch.binding.provider
      || row.model !== dispatch.binding.model || row.class !== "background" || row.pool !== "text"
      || row.workKey !== `${dispatch.binding.logicalWorkKey}:${dispatch.binding.inputHash}`
      || row.dispatchBindingHash !== dispatch.bindingHash || !row.dispatchedAt
      || !isDeepStrictEqual(row.dispatchBinding, dispatch.binding)) fail("product_tagline_ko_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence))
        fail("product_tagline_ko_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("product_tagline_ko_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}

import { crawlTaglineMemberKeys, crawlTaglineLogicalWorkKey, crawlTaglineInputSchema, crawlTaglineInputHash,
  crawlTaglineGenerationHash, crawlTaglineDispatchBindingSchema, crawlTaglineDispatchBindingHash,
  crawlTaglineModelDispatchSchema, crawlTaglineGatewayTerminalEvidenceSchema,
  type CrawlTaglineInput, type CrawlTaglineDispatchBinding, type CrawlTaglineModelDispatch,
  type CrawlTaglineOutcome, type CrawlTaglineParent } from "./capacity";
import type { CrawlTaglineGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
declare const crawlTaglineLockBrand: unique symbol;
export type CrawlTaglineCapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  readonly [crawlTaglineLockBrand]: true }>;
export type CrawlTaglineContinuation = Readonly<{ generationHash: string;
  first: CrawlTaglineParent & Readonly<{ outcome: CrawlTaglineOutcome }>;
  second: (CrawlTaglineParent & Readonly<{ outcome: CrawlTaglineOutcome }>) | null }>;
const crawlTaglineLocks = new WeakMap<CrawlTaglineCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; input: CrawlTaglineInput; finished: boolean }>();
function fixedCrawlTaglineIdentity(value: ModelCapacityRequestIdentity, input: CrawlTaglineInput): string {
  const logical = crawlTaglineLogicalWorkKey(input);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "crawl-tagline" || value.provider !== "abcllm"
    || value.model !== input.model || value.workKey !== `${logical}:${crawlTaglineInputHash(input)}`) fail("invalid_crawl_tagline_capacity_identity");
  return logical;
}
async function crawlTaglineFence(tx: ProductTransaction, input: CrawlTaglineInput, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND (
      (${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate')
        AND ${modelCapacityRequests.logicalMemberKeys} && ARRAY[${crawlTaglineMemberKeys(input.member)[0]}]::text[])
      OR (${modelCapacityRequests.logicalWorkKey} = ${crawlTaglineLogicalWorkKey(input)}
        AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate','settled'))))
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'crawl-tagline'
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
function crawlTaglineRowMatches(row: RequestRow | undefined, dispatch: CrawlTaglineModelDispatch): row is RequestRow {
  return owned(row, dispatch) && row.logicalWorkKey === dispatch.binding.logicalWorkKey
    && isDeepStrictEqual(row.logicalMemberKeys, crawlTaglineMemberKeys(dispatch.binding.member))
    && row.routeId === dispatch.binding.routeId && row.provider === dispatch.binding.provider && row.model === dispatch.binding.model
    && row.class === "background" && row.pool === "text"
    && row.workKey === `${dispatch.binding.logicalWorkKey}:${dispatch.binding.inputHash}`
    && row.dispatchBindingHash === dispatch.bindingHash && !!row.dispatchedAt && isDeepStrictEqual(row.dispatchBinding, dispatch.binding);
}
function storedCrawlTaglineEvidence(row: RequestRow | undefined) {
  if (!row || row.state !== "settled" || !row.settledAt) return null;
  const parsed = crawlTaglineGatewayTerminalEvidenceSchema.safeParse(row.terminalEvidence);
  return parsed.success && crawlTaglineRowMatches(row, parsed.data.dispatch)
    && row.terminalEvidenceHash === reviewHash(parsed.data) && isDeepStrictEqual(row.terminalEvidence, parsed.data) ? parsed.data : null;
}
function crawlTaglineParentMatches(first: NonNullable<ReturnType<typeof storedCrawlTaglineEvidence>>, input: CrawlTaglineInput): boolean {
  return input.askOrdinal === 2 && input.parent !== null && first.dispatch.binding.askOrdinal === 1 && first.dispatch.binding.parent === null
    && first.dispatch.requestId === input.parent.requestId && first.dispatch.bindingHash === input.parent.bindingHash
    && first.responseHash === input.parent.responseHash && first.dispatch.binding.generationHash === crawlTaglineGenerationHash(input)
    && first.outcome.ok && first.outcome.tagline === "";
}
async function lockCrawlTaglineRequests(tx: ProductTransaction, ownId: string, input: CrawlTaglineInput): Promise<RequestRow[]> {
  return tx.select().from(modelCapacityRequests).where(sql`${modelCapacityRequests.requestId} = ${ownId}::uuid
    OR ${modelCapacityRequests.requestId} = ${input.parent?.requestId ?? ownId}::uuid`)
    .orderBy(asc(modelCapacityRequests.requestId)).for("update");
}
function assertCrawlTaglineParent(input: CrawlTaglineInput, parent: RequestRow | undefined): void {
  if (input.askOrdinal === 1) return;
  const evidence = storedCrawlTaglineEvidence(parent);
  if (!evidence || !crawlTaglineParentMatches(evidence, input)) fail("crawl_tagline_parent_mismatch");
}
/** Stable target and phase identity belong to the first waiting INSERT. */
export async function requestCrawlTaglineModelSlot(value: ModelCapacityRequest, input: CrawlTaglineInput): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value), snapshot = crawlTaglineInputSchema.parse(input);
  return requestSlot(checked, fixedCrawlTaglineIdentity(checked, snapshot), crawlTaglineMemberKeys(snapshot.member), snapshot);
}
/** Control/request/parent UPDATE prefix precedes batch/role/stage/domain/job locks. */
export async function lockCrawlTaglineModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; input: CrawlTaglineInput;
}): Promise<CrawlTaglineCapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation), identity = modelCapacityRequestIdentitySchema.parse(value.identity);
  const input = crawlTaglineInputSchema.parse(value.input), logical = fixedCrawlTaglineIdentity(identity, input);
  const state = await control(tx), snapshot = callerControlSnapshot(state);
  const rows = await lockCrawlTaglineRequests(tx, checked.requestId, input), row = rows.find(row => row.requestId === checked.requestId);
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== logical) fail("model_capacity_logical_work_mismatch");
  if (!isDeepStrictEqual(row.logicalMemberKeys, crawlTaglineMemberKeys(input.member))) return null;
  assertCrawlTaglineParent(input, rows.find(row => row.requestId === input.parent?.requestId));
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch || row.revision !== state.revision
    || row.policyHash !== state.policyHash || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await crawlTaglineFence(tx, input, row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as CrawlTaglineCapacityDispatchLock;
  crawlTaglineLocks.set(locked, { tx, row, identity, input, finished: false });
  return locked;
}
export async function finishCrawlTaglineModelCapacityDispatch(tx: ProductTransaction, lock: CrawlTaglineCapacityDispatchLock,
  value: CrawlTaglineDispatchBinding): Promise<CrawlTaglineModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = crawlTaglineLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_crawl_tagline_capacity_dispatch_lock");
  const binding = crawlTaglineDispatchBindingSchema.parse(value);
  const input = { member: binding.member, model: binding.model, askOrdinal: binding.askOrdinal, parent: binding.parent };
  if (!isDeepStrictEqual(input, proof.input) || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || `${binding.logicalWorkKey}:${binding.inputHash}` !== proof.identity.workKey
    || binding.role.instanceId !== proof.identity.owner.instanceId || binding.role.bootId !== proof.identity.owner.bootId)
    fail("crawl_tagline_capacity_dispatch_binding_mismatch");
  // The actual parent row was validated and UPDATE-locked by this same private TX capability.
  proof.finished = true;
  const bindingHash = crawlTaglineDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("crawl_tagline_model_reservation_lost");
  const dispatch = crawlTaglineModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}
export async function reconcileCrawlTaglineGatewayTerminal(terminal: CrawlTaglineGatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readCrawlTaglineGatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readCrawlTaglineGatewayTerminal(terminal);
  if (!native) fail("invalid_crawl_tagline_gateway_terminal");
  const evidence = crawlTaglineGatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch, evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!crawlTaglineRowMatches(row, dispatch)) fail("crawl_tagline_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence)) fail("crawl_tagline_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("crawl_tagline_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}
/** Stored outcomes are business data. This never issues an opaque proof or releases capacity. */
export async function readCrawlTaglineContinuation(value: Pick<CrawlTaglineInput, "member" | "model">): Promise<CrawlTaglineContinuation | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const snapshot = crawlTaglineInputSchema.parse({ member: value.member, model: value.model, askOrdinal: 1, parent: null });
  const generationHash = crawlTaglineGenerationHash(snapshot);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("share");
    if (!mutex) fail("model_capacity_control_missing");
    const rows = await tx.select().from(modelCapacityRequests).where(sql`${modelCapacityRequests.routeId}='crawl-tagline'
      AND ${modelCapacityRequests.state}='settled' AND ${modelCapacityRequests.dispatchBinding}->>'kind'='crawl_tagline_gateway'
      AND ${modelCapacityRequests.dispatchBinding}->>'generationHash'=${generationHash}`).orderBy(asc(modelCapacityRequests.queueOrdinal));
    if (!rows.length) return null;
    const phases = rows.map(row => storedCrawlTaglineEvidence(row));
    if (phases.some(phase => !phase || phase.dispatch.binding.generationHash !== generationHash)) fail("crawl_tagline_continuation_mismatch");
    const first = phases.filter(phase => phase!.dispatch.binding.askOrdinal === 1), second = phases.filter(phase => phase!.dispatch.binding.askOrdinal === 2);
    if (first.length !== 1 || second.length > 1 || second.length && !crawlTaglineParentMatches(first[0]!, second[0]!.dispatch.binding))
      fail("crawl_tagline_continuation_mismatch");
    const data = (phase: NonNullable<typeof phases[number]>) => Object.freeze({ requestId: phase.dispatch.requestId,
      bindingHash: phase.dispatch.bindingHash, responseHash: phase.responseHash, outcome: Object.freeze(structuredClone(phase.outcome)) });
    return Object.freeze({ generationHash, first: data(first[0]!), second: second[0] ? data(second[0]) : null });
  });
}

import { searchVerifyMemberKeys, searchVerifyLogicalWorkKey, searchVerifyInputSchema, searchVerifyInputHash, searchVerifyGenerationHash,
  searchVerifyDispatchBindingSchema, searchVerifyDispatchBindingHash, searchVerifyModelDispatchSchema,
  searchVerifyGatewayTerminalEvidenceSchema, searchVerifyMemberSchema, nextSearchVerifyStep, firstSearchVerifyStep,
  type SearchVerifyInput, type SearchVerifyDispatchBinding, type SearchVerifyModelDispatch, type SearchVerifyMember,
  type SearchVerifyOutcome, type SearchVerifyParent, type SearchVerifyStep } from "./capacity";
import type { SearchVerifyGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
declare const searchVerifyLockBrand: unique symbol;
/** parentDeadlineAt is the stored shared deadline of a locked settled parent; null only for an execution's first step. */
export type SearchVerifyCapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  parentDeadlineAt: number | null; readonly [searchVerifyLockBrand]: true }>;
export type SearchVerifyContinuation = Readonly<{ generationHash: string; nowMs: number; unresolved: boolean; nextExecution: number;
  latest: Readonly<{ execution: number; deadlineAt: number; parent: SearchVerifyParent; next: SearchVerifyStep | "done" | "stop";
    outcomes: readonly Readonly<{ step: SearchVerifyStep; outcome: SearchVerifyOutcome }>[] }> | null }>;
const searchVerifyLocks = new WeakMap<SearchVerifyCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; input: SearchVerifyInput; parentDeadlineAt: number | null; finished: boolean }>();
function fixedSearchVerifyIdentity(value: ModelCapacityRequestIdentity, input: SearchVerifyInput): string {
  const logical = searchVerifyLogicalWorkKey(input);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "product-search-verify" || value.provider !== "abcllm"
    || value.model !== input.model || value.workKey !== `${logical}:${searchVerifyInputHash(input)}`) fail("invalid_search_verify_capacity_identity");
  return logical;
}
/** Fixed product target fence from the first waiting INSERT; an exact step already dispatched or settled never repeats. */
async function searchVerifyFence(tx: ProductTransaction, keys: readonly string[], logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND (
      (${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate')
        AND ${modelCapacityRequests.logicalMemberKeys} && ARRAY[${keys[0]}]::text[])
      OR (${modelCapacityRequests.logicalWorkKey} = ${logicalKey}
        AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate','settled'))))
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'product-search-verify'
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
function searchVerifyRowMatches(row: RequestRow | undefined, dispatch: SearchVerifyModelDispatch): row is RequestRow {
  return owned(row, dispatch) && row.logicalWorkKey === dispatch.binding.logicalWorkKey
    && isDeepStrictEqual(row.logicalMemberKeys, searchVerifyMemberKeys(dispatch.binding.member))
    && row.routeId === dispatch.binding.routeId && row.provider === dispatch.binding.provider && row.model === dispatch.binding.model
    && row.class === "background" && row.pool === "text"
    && row.workKey === `${dispatch.binding.logicalWorkKey}:${dispatch.binding.inputHash}`
    && row.dispatchBindingHash === dispatch.bindingHash && !!row.dispatchedAt && isDeepStrictEqual(row.dispatchBinding, dispatch.binding);
}
function storedSearchVerifyEvidence(row: RequestRow | undefined) {
  if (!row || row.state !== "settled" || !row.settledAt) return null;
  const parsed = searchVerifyGatewayTerminalEvidenceSchema.safeParse(row.terminalEvidence);
  return parsed.success && searchVerifyRowMatches(row, parsed.data.dispatch)
    && row.terminalEvidenceHash === reviewHash(parsed.data) && isDeepStrictEqual(row.terminalEvidence, parsed.data) ? parsed.data : null;
}
type StoredSearchVerify = NonNullable<ReturnType<typeof storedSearchVerifyEvidence>>;
/** The parent must be the immediately preceding step of the same generation and execution, sharing its deadline. */
function searchVerifyParentMatches(parent: StoredSearchVerify, input: SearchVerifyInput): boolean {
  const binding = parent.dispatch.binding;
  return input.parent !== null && parent.dispatch.requestId === input.parent.requestId && parent.dispatch.bindingHash === input.parent.bindingHash
    && parent.responseHash === input.parent.responseHash && binding.generationHash === searchVerifyGenerationHash(input)
    && binding.execution === input.execution && isDeepStrictEqual(nextSearchVerifyStep(binding.member, binding.step, parent.outcome), input.step);
}
async function lockSearchVerifyRequests(tx: ProductTransaction, ownId: string, input: SearchVerifyInput): Promise<RequestRow[]> {
  return tx.select().from(modelCapacityRequests).where(sql`${modelCapacityRequests.requestId} = ${ownId}::uuid
    OR ${modelCapacityRequests.requestId} = ${input.parent?.requestId ?? ownId}::uuid`)
    .orderBy(asc(modelCapacityRequests.requestId)).for("update");
}
/** Stable target and exact generation/execution/step identity belong to the first waiting INSERT. */
export async function requestSearchVerifyModelSlot(value: ModelCapacityRequest, input: SearchVerifyInput): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value), snapshot = searchVerifyInputSchema.parse(input);
  return requestSlot(checked, fixedSearchVerifyIdentity(checked, snapshot), searchVerifyMemberKeys(snapshot.member));
}
/** Control/request/parent UPDATE prefix precedes batch/role/product/profile/job locks. No nested TX. */
export async function lockSearchVerifyModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; input: SearchVerifyInput;
}): Promise<SearchVerifyCapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation), identity = modelCapacityRequestIdentitySchema.parse(value.identity);
  const input = searchVerifyInputSchema.parse(value.input), logical = fixedSearchVerifyIdentity(identity, input);
  const state = await control(tx), snapshot = callerControlSnapshot(state);
  const rows = await lockSearchVerifyRequests(tx, checked.requestId, input), row = rows.find(row => row.requestId === checked.requestId);
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== logical) fail("model_capacity_logical_work_mismatch");
  if (!isDeepStrictEqual(row.logicalMemberKeys, searchVerifyMemberKeys(input.member))) return null;
  const parent = input.parent ? storedSearchVerifyEvidence(rows.find(row => row.requestId === input.parent?.requestId)) : null;
  if (input.parent && (!parent || !searchVerifyParentMatches(parent, input))) fail("search_verify_parent_mismatch");
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch || row.revision !== state.revision
    || row.policyHash !== state.policyHash || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await searchVerifyFence(tx, searchVerifyMemberKeys(input.member), logical, row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const parentDeadlineAt = parent?.dispatch.binding.deadlineAt ?? null;
  const locked = Object.freeze({ control: snapshot, parentDeadlineAt }) as SearchVerifyCapacityDispatchLock;
  searchVerifyLocks.set(locked, { tx, row, identity, input, parentDeadlineAt, finished: false });
  return locked;
}
export async function finishSearchVerifyModelCapacityDispatch(tx: ProductTransaction, lock: SearchVerifyCapacityDispatchLock,
  value: SearchVerifyDispatchBinding): Promise<SearchVerifyModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = searchVerifyLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_search_verify_capacity_dispatch_lock");
  const binding = searchVerifyDispatchBindingSchema.parse(value);
  const input = { member: binding.member, model: binding.model, execution: binding.execution, step: binding.step, parent: binding.parent };
  if (!isDeepStrictEqual(input, proof.input) || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || `${binding.logicalWorkKey}:${binding.inputHash}` !== proof.identity.workKey
    || proof.parentDeadlineAt !== null && binding.deadlineAt !== proof.parentDeadlineAt
    || binding.role.instanceId !== proof.identity.owner.instanceId || binding.role.bootId !== proof.identity.owner.bootId)
    fail("search_verify_capacity_dispatch_binding_mismatch");
  // The actual settled parent row was validated and UPDATE-locked by this same private TX capability.
  proof.finished = true;
  const bindingHash = searchVerifyDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("search_verify_model_reservation_lost");
  const dispatch = searchVerifyModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}
/** Historical settlement uses the dispatch, not today's job, role, policy or deadline. */
export async function reconcileSearchVerifyGatewayTerminal(terminal: SearchVerifyGatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readSearchVerifyGatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readSearchVerifyGatewayTerminal(terminal);
  if (!native) fail("invalid_search_verify_gateway_terminal");
  const evidence = searchVerifyGatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch, evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!searchVerifyRowMatches(row, dispatch)) fail("search_verify_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence)) fail("search_verify_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("search_verify_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}
type SearchVerifyChain = { chain: StoredSearchVerify[]; next: SearchVerifyStep | "done" | "stop"; parent: SearchVerifyParent | null;
  unresolved: { row: RequestRow; binding: SearchVerifyDispatchBinding }[] };
/** Every execution of a generation must be one exact parent chain of settled rows plus at most its unresolved tail. */
async function searchVerifyGeneration(tx: ProductTransaction, member: SearchVerifyMember, model: string, lock: boolean) {
  const generationHash = searchVerifyGenerationHash({ member, model });
  const query = tx.select().from(modelCapacityRequests).where(sql`${modelCapacityRequests.routeId}='product-search-verify'
    AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate','settled') AND ${modelCapacityRequests.dispatchBinding}->>'kind'='search_verify_gateway'
    AND ${modelCapacityRequests.dispatchBinding}->>'generationHash'=${generationHash}`).orderBy(asc(modelCapacityRequests.queueOrdinal));
  const rows = lock ? await query.for("share") : await query;
  const bindings = rows.map(row => searchVerifyDispatchBindingSchema.safeParse(row.dispatchBinding));
  if (bindings.some((binding, index) => !binding.success || binding.data.generationHash !== generationHash
    || rows[index].logicalWorkKey !== binding.data.logicalWorkKey || rows[index].workKey !== `${binding.data.logicalWorkKey}:${binding.data.inputHash}`
    || rows[index].dispatchBindingHash !== searchVerifyDispatchBindingHash(binding.data))) fail("search_verify_continuation_mismatch");
  const executions = new Map<number, SearchVerifyChain>();
  for (const execution of [...new Set(bindings.map(binding => binding.data!.execution))].sort((a, b) => a - b)) {
    const own = rows.map((row, index) => ({ row, binding: bindings[index].data! })).filter(entry => entry.binding.execution === execution);
    const settled = own.filter(entry => entry.row.state === "settled").map(entry => storedSearchVerifyEvidence(entry.row));
    if (settled.some(phase => !phase)) fail("search_verify_continuation_mismatch");
    const chain: StoredSearchVerify[] = [], pending = [...settled as StoredSearchVerify[]];
    let next: SearchVerifyStep | "done" | "stop" = firstSearchVerifyStep(member.mode), parent: SearchVerifyParent | null = null;
    while (pending.length) {
      const index = pending.findIndex(phase => isDeepStrictEqual(phase.dispatch.binding.step, next)
        && isDeepStrictEqual(phase.dispatch.binding.parent, parent));
      if (typeof next === "string" || index < 0) fail("search_verify_continuation_mismatch");
      const [phase] = pending.splice(index, 1), binding = phase.dispatch.binding;
      if (chain.length && binding.deadlineAt !== chain[0].dispatch.binding.deadlineAt) fail("search_verify_continuation_mismatch");
      chain.push(phase); parent = { requestId: phase.dispatch.requestId, bindingHash: phase.dispatch.bindingHash, responseHash: phase.responseHash };
      next = nextSearchVerifyStep(binding.member, binding.step, phase.outcome);
    }
    executions.set(execution, { chain, next, parent, unresolved: own.filter(entry => entry.row.state !== "settled") });
  }
  return { generationHash, executions };
}
/** Stored parser outcomes are business data only. Any unresolved physical call of the target is reported, never skipped;
 * every execution of the generation must be one exact parent chain. This never issues proof or releases capacity. */
export async function readSearchVerifyContinuation(value: { member: SearchVerifyMember; model: string }): Promise<SearchVerifyContinuation> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const member = searchVerifyMemberSchema.parse(value.member);
  const [key] = searchVerifyMemberKeys(member);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("share");
    if (!mutex) fail("model_capacity_control_missing");
    const [clock] = await tx.execute<{ now: number }>(sql`SELECT (extract(epoch from clock_timestamp())*1000)::float8 AS now`);
    const [active] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
      ${modelCapacityRequests.state} IN ('dispatched','indeterminate') AND (${modelCapacityRequests.logicalMemberKeys} && ARRAY[${key}]::text[]
        OR ${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'product-search-verify')`).limit(1);
    const { generationHash, executions } = await searchVerifyGeneration(tx, member, value.model, false);
    const nowMs = Math.floor(Number(clock.now)), ordinals = [...executions.keys()], last = ordinals.length ? executions.get(ordinals[ordinals.length - 1])! : null;
    const latest: SearchVerifyContinuation["latest"] = last && last.chain.length && last.parent ? Object.freeze({ execution: ordinals[ordinals.length - 1],
      deadlineAt: last.chain[0].dispatch.binding.deadlineAt, parent: Object.freeze(last.parent),
      next: typeof last.next === "string" ? last.next : Object.freeze(structuredClone(last.next)),
      outcomes: Object.freeze(last.chain.map(phase => Object.freeze({ step: Object.freeze(structuredClone(phase.dispatch.binding.step)),
        outcome: Object.freeze(structuredClone(phase.outcome)) }))) }) : null;
    return Object.freeze({ generationHash, nowMs, unresolved: !!active, latest,
      nextExecution: ordinals.length ? ordinals[ordinals.length - 1] + 1 : 0 });
  });
}
export type SearchVerifyResultChain = Readonly<{ kind: "done"; removed: readonly string[] } | { kind: "stop" | "open" | "unresolved" }>;
/** Positive-writer ledger wall inside the caller's TX: control SHARE, then every row of the generation FOR SHARE.
 * The execution must be the latest one, an exact settled parent chain sharing one deadline, optionally ending in one
 * unresolved physical call that is its exact next step. A stored outcome is business data, never write authority. */
export async function lockSearchVerifyResultChain(tx: ProductTransaction, value: { member: SearchVerifyMember; model: string;
  execution: number }): Promise<SearchVerifyResultChain | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const member = searchVerifyMemberSchema.parse(value.member);
  const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("share");
  if (!mutex) fail("model_capacity_control_missing");
  let generation: Awaited<ReturnType<typeof searchVerifyGeneration>>;
  try { generation = await searchVerifyGeneration(tx, member, value.model, true); }
  catch (error) { if (error instanceof Error && error.message === "search_verify_continuation_mismatch") return null; throw error; }
  const ordinals = [...generation.executions.keys()], found = generation.executions.get(value.execution);
  if (!found || ordinals[ordinals.length - 1] !== value.execution) return null;
  if (found.unresolved.length) {
    const [tail] = found.unresolved;
    return found.unresolved.length === 1 && typeof found.next !== "string" && isDeepStrictEqual(tail.binding.step, found.next)
      && isDeepStrictEqual(tail.binding.parent, found.parent) && (!found.chain.length || tail.binding.deadlineAt === found.chain[0].dispatch.binding.deadlineAt)
      ? Object.freeze({ kind: "unresolved" as const }) : null;
  }
  if (!found.chain.length) return null;
  if (found.next === "done") return Object.freeze({ kind: "done" as const,
    removed: Object.freeze(found.chain.flatMap(phase => phase.outcome.ok ? phase.outcome.removed : [])) });
  return Object.freeze({ kind: found.next === "stop" ? "stop" as const : "open" as const });
}

import { websearchQueryMemberKeys, websearchQueryLogicalWorkKey, websearchQueryInputSchema, websearchQueryInputHash,
  websearchQueryDispatchBindingSchema, websearchQueryDispatchBindingHash, websearchQueryModelDispatchSchema,
  websearchQueryGatewayTerminalEvidenceSchema, type WebsearchQueryInput, type WebsearchQueryDispatchBinding,
  type WebsearchQueryModelDispatch, type WebsearchQueryOutcome } from "./capacity";
import type { WebsearchQueryGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
declare const websearchQueryLockBrand: unique symbol;
export type WebsearchQueryCapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>;
  readonly [websearchQueryLockBrand]: true }>;
/** Settled outcome is business data for the same cache snapshot only; it never issues an opaque proof or releases capacity. */
export type WebsearchQueryContinuation = { kind: "none" } | { kind: "blocked" }
  | Readonly<{ kind: "settled"; requestId: string; bindingHash: string; responseHash: string; model: string; outcome: WebsearchQueryOutcome }>;
const websearchQueryLocks = new WeakMap<WebsearchQueryCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; input: WebsearchQueryInput; finished: boolean }>();
function fixedWebsearchQueryIdentity(value: ModelCapacityRequestIdentity, input: WebsearchQueryInput): string {
  const logical = websearchQueryLogicalWorkKey(input.member);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "search-query-translate" || value.provider !== "abcllm"
    || value.model !== input.model || value.workKey !== `${logical}:${websearchQueryInputHash(input)}`) fail("invalid_websearch_query_capacity_identity");
  return logical;
}
/** Another owner's active member, an unconsumed settled call for the same cache snapshot, or an unbound same-route call blocks. */
async function websearchQueryFence(tx: ProductTransaction, input: WebsearchQueryInput, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND (
      (${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate')
        AND ${modelCapacityRequests.logicalMemberKeys} && ARRAY[${websearchQueryMemberKeys(input.member)[0]}]::text[])
      OR (${modelCapacityRequests.logicalWorkKey} = ${websearchQueryLogicalWorkKey(input.member)} AND ${modelCapacityRequests.state} = 'settled'
        AND ${modelCapacityRequests.dispatchBinding}->>'kind' = 'websearch_query_gateway'
        AND ${modelCapacityRequests.dispatchBinding}->'member'->'cache' = ${JSON.stringify(input.member.cache)}::text::jsonb)))
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'search-query-translate'
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
function websearchQueryRowMatches(row: RequestRow | undefined, dispatch: WebsearchQueryModelDispatch): row is RequestRow {
  return owned(row, dispatch) && row.logicalWorkKey === dispatch.binding.logicalWorkKey
    && isDeepStrictEqual(row.logicalMemberKeys, websearchQueryMemberKeys(dispatch.binding.member))
    && row.routeId === dispatch.binding.routeId && row.provider === dispatch.binding.provider && row.model === dispatch.binding.model
    && row.class === "background" && row.pool === "text"
    && row.workKey === `${dispatch.binding.logicalWorkKey}:${dispatch.binding.inputHash}`
    && row.dispatchBindingHash === dispatch.bindingHash && !!row.dispatchedAt && isDeepStrictEqual(row.dispatchBinding, dispatch.binding);
}
function storedWebsearchQueryEvidence(row: RequestRow | undefined) {
  if (!row || row.state !== "settled" || !row.settledAt) return null;
  const parsed = websearchQueryGatewayTerminalEvidenceSchema.safeParse(row.terminalEvidence);
  return parsed.success && websearchQueryRowMatches(row, parsed.data.dispatch)
    && row.terminalEvidenceHash === reviewHash(parsed.data) && isDeepStrictEqual(row.terminalEvidence, parsed.data) ? parsed.data : null;
}
/** The fixed cache target is in the very first waiting INSERT. */
export async function requestWebsearchQueryModelSlot(value: ModelCapacityRequest, input: WebsearchQueryInput): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value), snapshot = websearchQueryInputSchema.parse(input);
  return requestSlot(checked, fixedWebsearchQueryIdentity(checked, snapshot), websearchQueryMemberKeys(snapshot.member), undefined, snapshot);
}
/** Control/request UPDATE prefix precedes the query cache lock. No nested TX. */
export async function lockWebsearchQueryModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; input: WebsearchQueryInput;
}): Promise<WebsearchQueryCapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation), identity = modelCapacityRequestIdentitySchema.parse(value.identity);
  const input = websearchQueryInputSchema.parse(value.input), logical = fixedWebsearchQueryIdentity(identity, input);
  const state = await control(tx), snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== logical) fail("model_capacity_logical_work_mismatch");
  if (!isDeepStrictEqual(row.logicalMemberKeys, websearchQueryMemberKeys(input.member))) return null;
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch || row.revision !== state.revision
    || row.policyHash !== state.policyHash || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await websearchQueryFence(tx, input, row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as WebsearchQueryCapacityDispatchLock;
  websearchQueryLocks.set(locked, { tx, row, identity, input, finished: false });
  return locked;
}
export async function finishWebsearchQueryModelCapacityDispatch(tx: ProductTransaction, lock: WebsearchQueryCapacityDispatchLock,
  value: WebsearchQueryDispatchBinding): Promise<WebsearchQueryModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = websearchQueryLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_websearch_query_capacity_dispatch_lock");
  const binding = websearchQueryDispatchBindingSchema.parse(value);
  if (!isDeepStrictEqual({ member: binding.member, model: binding.model }, proof.input) || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || `${binding.logicalWorkKey}:${binding.inputHash}` !== proof.identity.workKey
    || binding.process.instanceId !== proof.identity.owner.instanceId || binding.process.bootId !== proof.identity.owner.bootId)
    fail("websearch_query_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = websearchQueryDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("websearch_query_model_reservation_lost");
  const dispatch = websearchQueryModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}
/** Historical settlement and the bounded parser outcome commit together, independent of today's policy or owner. */
export async function reconcileWebsearchQueryGatewayTerminal(terminal: WebsearchQueryGatewayTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readWebsearchQueryGatewayTerminal } = await import("@/lib/crawl/agent-review-gateway");
  const native = readWebsearchQueryGatewayTerminal(terminal);
  if (!native) fail("invalid_websearch_query_gateway_terminal");
  const evidence = websearchQueryGatewayTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch, evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!websearchQueryRowMatches(row, dispatch)) fail("websearch_query_gateway_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence)) fail("websearch_query_gateway_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") fail("websearch_query_gateway_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}
/** Reads, inside the caller's primary TX, the settled outcome for exactly this cache snapshot. Any unresolved physical call
 * for the same target blocks reuse; duplicate or forged stored evidence fails closed. */
export async function readWebsearchQueryContinuation(tx: ProductTransaction, value: WebsearchQueryInput): Promise<WebsearchQueryContinuation> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const input = websearchQueryInputSchema.parse(value), [memberKey] = websearchQueryMemberKeys(input.member);
  await control(tx, "share");
  const [active] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.logicalMemberKeys} && ARRAY[${memberKey}]::text[] AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'search-query-translate'
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  if (active) return { kind: "blocked" };
  const rows = await tx.select().from(modelCapacityRequests).where(sql`${modelCapacityRequests.routeId}='search-query-translate'
    AND ${modelCapacityRequests.state}='settled' AND ${modelCapacityRequests.logicalWorkKey}=${websearchQueryLogicalWorkKey(input.member)}
    AND ${modelCapacityRequests.dispatchBinding}->>'kind'='websearch_query_gateway'
    AND ${modelCapacityRequests.dispatchBinding}->'member'->'cache'=${JSON.stringify(input.member.cache)}::text::jsonb`)
    .orderBy(asc(modelCapacityRequests.queueOrdinal));
  if (!rows.length) return { kind: "none" };
  const stored = rows.map(row => storedWebsearchQueryEvidence(row));
  if (rows.length !== 1 || !stored[0] || stored[0].dispatch.binding.member.cacheKey !== input.member.cacheKey
    || !isDeepStrictEqual(stored[0].dispatch.binding.member.cache, input.member.cache)) fail("websearch_query_continuation_mismatch");
  const evidence = stored[0]!;
  return Object.freeze({ kind: "settled" as const, requestId: evidence.dispatch.requestId, bindingHash: evidence.dispatch.bindingHash,
    responseHash: evidence.responseHash, model: evidence.dispatch.binding.model, outcome: Object.freeze(structuredClone(evidence.outcome)) });
}

import { cliDispatchBindingSchema, cliDispatchBindingHash, cliModelDispatchSchema, cliModelTerminalEvidenceSchema,
  introCheckInputSchema, introCheckMemberKeys, introCheckLogicalWorkKey, grokSessionLogicalWorkKey,
  type CliDispatchBinding, type CliModelDispatch, type IntroCheckMember } from "./capacity";
import { cliProcessTerminalEvidenceSchema } from "./cli-serving-contract";
import type { CliProcessTerminal } from "./cli-process-runner";
/** CLI 호출이 묶이는 고정 대상. AI1·AI2 는 gateway 와 같은 논리 키를, 감사·소개 검수·Grok 세션은 background/reviewer 키를 쓴다. */
export type CliTarget = Readonly<{ kind: "ai1"; candidateId: number }> | Readonly<{ kind: "ai2"; candidateId: number; vote: number }>
  | Readonly<{ kind: "audit"; itemId: number }> | Readonly<{ kind: "intro"; members: readonly IntroCheckMember[] }>
  | Readonly<{ kind: "grok-session"; instanceId: string }>;
type FixedCli = Readonly<{ target: CliTarget; logical: string; memberKeys: string[] | null; kinds: readonly CliDispatchBinding["kind"][] }>;
const CLI_TARGET_KEYS = { ai1: ["candidateId"], ai2: ["candidateId", "vote"], audit: ["itemId"], intro: ["members"], "grok-session": ["instanceId"] } as const;
const CLI_FIXED = {
  ai1: { class: "first", routeId: "crawl-agent-review", providers: ["claude-cli", "grok-cli"], kinds: ["ai1_legacy_cli", "ai1_item_cli"] },
  ai2: { class: "second", routeId: "second-review", providers: ["claude-cli", "grok-cli"], kinds: ["ai2_item_cli"] },
  audit: { class: "background", routeId: "product-audit", providers: ["claude-cli"], kinds: ["product_audit_cli"] },
  intro: { class: "background", routeId: "product-intro-check", providers: ["claude-cli"], kinds: ["intro_check_cli"] },
  "grok-session": { class: "background", routeId: "grok-session-check", providers: ["grok-cli"], kinds: ["grok_session_cli"] },
} as const;
const safeId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
/** Snapshot the caller's target before any held lock; malformed targets fail before SQL. */
function fixedCliIdentity(value: ModelCapacityRequestIdentity, raw: CliTarget): FixedCli {
  const kind = raw?.kind, keys = Object.hasOwn(CLI_TARGET_KEYS, kind ?? "") ? CLI_TARGET_KEYS[kind] : null;
  if (!keys || Object.keys(raw).length !== keys.length + 1 || keys.some(key => !Object.hasOwn(raw, key))) return fail("invalid_cli_capacity_identity");
  let target: CliTarget, logical: string, memberKeys: string[] | null = null;
  if (raw.kind === "intro") {
    const members = introCheckInputSchema.shape.members.safeParse(raw.members);
    if (!members.success) return fail("invalid_cli_capacity_identity");
    target = Object.freeze({ kind: "intro", members: Object.freeze(members.data) });
    memberKeys = introCheckMemberKeys(members.data); logical = introCheckLogicalWorkKey(members.data);
  } else if (raw.kind === "grok-session") {
    if (raw.instanceId !== value.owner.instanceId) return fail("invalid_cli_capacity_identity");
    target = Object.freeze({ kind: "grok-session", instanceId: raw.instanceId }); logical = grokSessionLogicalWorkKey(raw.instanceId);
  } else if (raw.kind === "ai2") {
    if (!safeId(raw.candidateId) || !safeId(raw.vote)) return fail("invalid_cli_capacity_identity");
    target = Object.freeze({ kind: "ai2", candidateId: raw.candidateId, vote: raw.vote }); logical = `ai2:${raw.candidateId}:${raw.vote}`;
  } else if (raw.kind === "ai1") {
    if (!safeId(raw.candidateId)) return fail("invalid_cli_capacity_identity");
    target = Object.freeze({ kind: "ai1", candidateId: raw.candidateId }); logical = `ai1:${raw.candidateId}`;
  } else {
    if (!safeId(raw.itemId)) return fail("invalid_cli_capacity_identity");
    target = Object.freeze({ kind: "audit", itemId: raw.itemId }); logical = `bg:audit:${raw.itemId}`;
  }
  const fixed = CLI_FIXED[target.kind];
  // AI1 legacy 는 gateway 선례처럼 work key 를 묶지 않는다(item 은 finish 에서 item bindingHash 로 묶는다)
  if (value.class !== fixed.class || value.pool !== "reviewer" || value.routeId !== fixed.routeId
    || !(fixed.providers as readonly string[]).includes(value.provider) || target.kind !== "ai1" && (!value.workKey.startsWith(`${logical}:`)
      || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1)))) return fail("invalid_cli_capacity_identity");
  return Object.freeze({ target, logical, memberKeys, kinds: fixed.kinds });
}
/** Same-key active work, or an unbound call on the same route, blocks a background CLI target. */
async function cliKeyFence(tx: ProductTransaction, logicalKey: string, routeId: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.logicalWorkKey} = ${logicalKey} AND ${modelCapacityRequests.requestId} <> ${ownId}
      AND ${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate'))
    OR (${modelCapacityRequests.logicalWorkKey} IS NULL AND ${modelCapacityRequests.routeId} = ${routeId}
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
/** Any overlapping intro member, or an unbound intro-check call, blocks the batch. */
async function introCheckFence(tx: ProductTransaction, keys: readonly string[], ownId: string): Promise<boolean> {
  const keyArray = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND ${modelCapacityRequests.state} IN ('waiting','reserved','dispatched','indeterminate')
      AND ${modelCapacityRequests.logicalMemberKeys} && ${keyArray})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = ${"product-intro-check"}
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate'))`).limit(1);
  return !!blocked;
}
function cliFence(tx: ProductTransaction, fixed: FixedCli, ownId: string): Promise<boolean> {
  return fixed.target.kind === "ai1" ? ai1Fence(tx, fixed.logical, ownId) : fixed.target.kind === "ai2" ? ai2Fence(tx, fixed.logical, ownId)
    : fixed.target.kind === "intro" ? introCheckFence(tx, fixed.memberKeys!, ownId) : cliKeyFence(tx, fixed.logical, CLI_FIXED[fixed.target.kind].routeId, ownId);
}
/** The fixed CLI target is in the very first waiting INSERT; AI1/AI2 share the gateway key so either transport fences the other. */
export async function requestCliModelSlot(value: ModelCapacityRequest, target: CliTarget): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value), fixed = fixedCliIdentity(checked, target);
  return requestSlot(checked, fixed.logical, fixed.memberKeys ?? undefined);
}
declare const cliLockBrand: unique symbol;
export type CliCapacityDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>; readonly [cliLockBrand]: true }>;
const cliLocks = new WeakMap<CliCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; fixed: FixedCli; finished: boolean }>();
/** This UPDATE prefix must precede all stage/domain/item/job locks. No nested TX. */
export async function lockCliModelCapacityDispatch(tx: ProductTransaction, value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; target: CliTarget;
}): Promise<CliCapacityDispatchLock | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value.reservation), identity = modelCapacityRequestIdentitySchema.parse(value.identity);
  const fixed = fixedCliIdentity(identity, value.target);
  const state = await control(tx), snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== fixed.logical) fail("model_capacity_logical_work_mismatch");
  if (!isDeepStrictEqual(row.logicalMemberKeys ?? null, fixed.memberKeys)) return null;
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== "reserved" || state.mode !== "open" || !route || row.epoch !== state.epoch || row.revision !== state.revision
    || row.policyHash !== state.policyHash || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await cliFence(tx, fixed, row.requestId)) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until > clock_timestamp() AS live
    FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const locked = Object.freeze({ control: snapshot }) as CliCapacityDispatchLock;
  cliLocks.set(locked, { tx, row, identity, fixed, finished: false });
  return locked;
}
/** The binding must be the target's own kind and fixed values; item kinds bind the item lease owner, others the exact input. */
function cliBindingFits(binding: CliDispatchBinding, fixed: FixedCli, identity: ModelCapacityRequestIdentity, logical: string | null): boolean {
  const target = fixed.target, ownerFits = (value: { instanceId: string; bootId: string }) =>
    value.instanceId === identity.owner.instanceId && value.bootId === identity.owner.bootId;
  if (!fixed.kinds.includes(binding.kind) || binding.logicalWorkKey !== logical || binding.logicalWorkKey !== fixed.logical
    || binding.routeId !== identity.routeId || binding.provider !== identity.provider || binding.model !== identity.model) return false;
  switch (binding.kind) {
    case "ai1_legacy_cli": return target.kind === "ai1" && binding.candidateId === target.candidateId;
    case "ai1_item_cli": return target.kind === "ai1" && binding.review.candidateId === target.candidateId
      && identity.workKey === `${binding.logicalWorkKey}:${binding.item.bindingHash}` && ownerFits(binding.item.owner);
    case "ai2_item_cli": return target.kind === "ai2" && binding.review.candidateId === target.candidateId && binding.review.vote === target.vote
      && identity.workKey === `${binding.logicalWorkKey}:${binding.item.bindingHash}` && ownerFits(binding.item.owner);
    case "product_audit_cli": return target.kind === "audit" && binding.itemId === target.itemId
      && identity.workKey === `${binding.logicalWorkKey}:${binding.inputHash}`;
    case "intro_check_cli": return target.kind === "intro" && isDeepStrictEqual(introCheckInputSchema.shape.members.parse(binding.members), target.members)
      && identity.workKey === `${binding.logicalWorkKey}:${binding.inputHash}`;
    case "grok_session_cli": return target.kind === "grok-session" && binding.instanceId === target.instanceId
      && identity.workKey === `${binding.logicalWorkKey}:${binding.inputHash}`;
  }
}
/** The fixed domain caller proves its own rows/lease in this same TX before this final reservation CAS. */
export async function finishCliModelCapacityDispatch(tx: ProductTransaction, lock: CliCapacityDispatchLock,
  value: CliDispatchBinding): Promise<CliModelDispatch> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const proof = cliLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail("invalid_cli_capacity_dispatch_lock");
  const binding = cliDispatchBindingSchema.parse(value);
  if (!cliBindingFits(binding, proof.fixed, proof.identity, proof.row.logicalWorkKey)) fail("cli_capacity_dispatch_binding_mismatch");
  proof.finished = true;
  const bindingHash = cliDispatchBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding,
    dispatchBindingHash: bindingHash, dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, proof.row.requestId), eq(modelCapacityRequests.state, "reserved"),
      eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) fail("cli_model_reservation_lost");
  const dispatch = cliModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
  return dispatch;
}
const CLI_KIND_CLASS: Record<CliDispatchBinding["kind"], RequestRow["class"]> = { ai1_legacy_cli: "first", ai1_item_cli: "first",
  ai2_item_cli: "second", product_audit_cli: "background", intro_check_cli: "background", grok_session_cli: "background" };
/** The historical dispatch rebuilt from the actual locked row; null unless every row column agrees with its immutable binding. */
function cliRowDispatch(row: RequestRow | undefined): CliModelDispatch | null {
  if (!row?.dispatchedAt || !row.token) return null;
  const parsed = cliModelDispatchSchema.safeParse({ requestId: row.requestId, owner: { instanceId: row.ownerInstanceId, bootId: row.ownerBootId },
    token: row.token, epoch: row.epoch, revision: row.revision, policyHash: row.policyHash, binding: row.dispatchBinding, bindingHash: row.dispatchBindingHash });
  if (!parsed.success) return null;
  const dispatch = parsed.data, binding = dispatch.binding;
  const workKey = binding.kind === "ai1_legacy_cli" ? row.workKey : binding.kind === "ai1_item_cli" || binding.kind === "ai2_item_cli"
    ? `${binding.logicalWorkKey}:${binding.item.bindingHash}` : `${binding.logicalWorkKey}:${binding.inputHash}`;
  const memberKeys = binding.kind === "intro_check_cli" ? introCheckMemberKeys(binding.members) : null;
  return row.logicalWorkKey === binding.logicalWorkKey && isDeepStrictEqual(row.logicalMemberKeys ?? null, memberKeys)
    && row.routeId === binding.routeId && row.provider === binding.provider && row.model === binding.model
    && row.class === CLI_KIND_CLASS[binding.kind] && row.pool === "reviewer" && row.workKey === workKey
    && isDeepStrictEqual(row.dispatchBinding, binding) ? dispatch : null;
}
/**
 * Only the runner's opaque terminal settles a CLI call — every ending (exited, killed, spawn_failed, not_started) is a physical end.
 * Its request, transport and C must equal the historical dispatch; today's policy, mode, owner or job never block completion.
 */
export async function reconcileCliProcessTerminal(terminal: CliProcessTerminal): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readCliProcessTerminal } = await import("./cli-process-runner");
  const native = readCliProcessTerminal(terminal);
  if (!native) fail("invalid_cli_process_terminal");
  const process = cliProcessTerminalEvidenceSchema.parse(native);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, process.requestId)).for("update");
    const dispatch = cliRowDispatch(row);
    if (!dispatch || process.totalTokenBound !== dispatch.binding.totalTokenBound
      || !isDeepStrictEqual(process.transport, dispatch.binding.transport)) return fail("cli_process_terminal_binding_mismatch");
    const evidence = cliModelTerminalEvidenceSchema.parse({ version: 1, kind: "cli_model_terminal", dispatch, process }), evidenceHash = reviewHash(evidence);
    if (row!.state === "settled") {
      if (row!.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row!.terminalEvidence, evidence)) fail("cli_process_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row!.state !== "dispatched" && row!.state !== "indeterminate") fail("cli_process_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row!.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row!.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}

import { z } from "zod";
import { modelDispatchReleaseEvidenceSchema, type ModelCapacityOwner, type ModelDispatchReleaseEvidence } from "./capacity";
/** 회수 판정에 넘기는 잠긴 행의 사실. 시각은 이 TX 의 DB clock(UTC, ms)이다. dispatchAt 은 dispatched_at 또는 첫 dispatch_started event. */
export type ModelDispatchReleaseCandidate = Readonly<{ requestId: string; owner: ModelCapacityOwner; state: "dispatched" | "indeterminate";
  providerBudgetId: string; dispatchAt: string | null; bindingHash: string | null; now: string; oldGeneration: boolean }>;
export type ModelDispatchReleaseResult = { kind: "released"; evidence: ModelDispatchReleaseEvidence } | { kind: "blocked"; reason: string }
  | { kind: "not_active" };
/**
 * D11·DR 회수 hook. caller TX 안에서 control UPDATE → request UPDATE 를 잡은 뒤 verify 가 같은 TX·같은 DB clock 으로 종료 근거를 다시
 * 평가한다. 근거가 이 행(요청·owner·상태·dispatch 시각·binding)과 이 시각에 묶일 때만 withdrawn 으로 바꾸고 같은 근거를 행과
 * dispatch_released event 에 남긴다. TTL·owner 죽음·정책 변경은 근거 kind 에 없다. caller 의 fence/promotion lock 은 이 호출보다 먼저다.
 */
export async function releaseModelDispatchWithEvidence(tx: ProductTransaction, requestId: string,
  verify: (candidate: ModelDispatchReleaseCandidate) => Promise<ModelDispatchReleaseEvidence | { blocked: string }>): Promise<ModelDispatchReleaseResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const id = z.uuid().parse(requestId);
  const state = await control(tx);
  const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, id)).for("update");
  if (!row || (row.state !== "dispatched" && row.state !== "indeterminate")) return { kind: "not_active" };
  const iso = (value: unknown) => sql`to_char((${value}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const [clock] = await tx.execute<{ dispatch_at: string | null; now: string }>(sql`SELECT ${iso(sql`coalesce(r.dispatched_at, (SELECT min(e.created_at)
    FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_started'))`)} AS dispatch_at, ${iso(sql`clock_timestamp()`)} AS now
    FROM model_capacity_requests r WHERE r.request_id = ${row.requestId}::uuid`);
  const owner = Object.freeze({ instanceId: row.ownerInstanceId, bootId: row.ownerBootId });
  const verdict = await verify(Object.freeze({ requestId: row.requestId, owner, state: row.state, providerBudgetId: row.providerBudgetId,
    dispatchAt: clock.dispatch_at, bindingHash: row.dispatchBindingHash, now: clock.now,
    oldGeneration: row.epoch !== state.epoch || row.revision !== state.revision || row.policyHash !== state.policyHash }));
  if ("blocked" in verdict) return { kind: "blocked", reason: verdict.blocked };
  const evidence = modelDispatchReleaseEvidenceSchema.parse(verdict);
  if (evidence.requestId !== row.requestId || evidence.owner.instanceId !== owner.instanceId || evidence.owner.bootId !== owner.bootId
    || evidence.fromState !== row.state || evidence.dispatchAt !== clock.dispatch_at || evidence.bindingHash !== row.dispatchBindingHash
    || evidence.evaluatedAt !== clock.now || evidence.kind === "dr_call_drain" && (evidence.scope !== `model:${row.providerBudgetId}`
      || row.epoch === state.epoch && row.revision === state.revision && row.policyHash === state.policyHash)) fail("model_capacity_release_evidence_mismatch");
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", terminalEvidence: evidence, terminalEvidenceHash: reviewHash(evidence),
    updatedAt: sql`clock_timestamp()` }).where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, row.state))).returning();
  if (!changed) fail("model_capacity_release_state_changed");
  await event(tx, changed, "dispatch_released", row.state, "withdrawn", null, evidence);
  return { kind: "released", evidence };
}
