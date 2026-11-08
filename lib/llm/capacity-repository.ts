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
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { modelCapacityControl, modelCapacityDevices, modelCapacityEvents, modelCapacityRequests } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { Ai1GatewayTerminal, Ai2GatewayTerminal, Ai1ItemGatewayTerminal, GatewayNotStarted } from "@/lib/crawl/agent-review-gateway";
import { gatewayNotStartedEvidenceSchema, GATEWAY_DISPATCH_PROVIDERS, isGatewayDispatchProvider, type GatewayDispatchProvider,
  type GatewayNotStartedDispatch } from "./capacity";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { providerBoundaryCanonicalHash } from "./provider-boundary-contract";
import {
  compatibleModelCapacityGeneration, modelCapacityDispatchSchema, modelCapacityPolicyHash, modelCapacityRequestSchema,
  modelCapacityRequestIdentitySchema, modelCapacityReservationSchema, parseModelCapacityPolicy,
  type ModelCapacityDispatch, type ModelCapacityEventKind, type ModelCapacityIndeterminateReason, MODEL_CAPACITY_INDETERMINATE_REASONS,
  operatorReviewEvidenceSchema, operatorReviewEvidenceHash, type OperatorReviewEvidence, type ModelCapacityState,
  type ModelCapacityRequest, type ModelCapacityRequestIdentity, type ModelCapacityReservation, type ModelSlotResult,
  ai1DispatchBindingSchema, ai1DispatchBindingHash, ai1ModelDispatchSchema, ai1GatewayTerminalEvidenceSchema,
  type Ai1DispatchBinding, type Ai1ModelDispatch,
  ai2DispatchBindingSchema, ai2DispatchBindingHash, ai2ModelDispatchSchema, ai2GatewayTerminalEvidenceSchema,
  type Ai2DispatchBinding, type Ai2ModelDispatch,
} from "./capacity";
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { LocalModelDomainRefusedError, localModelDomainRefusalEvidence } from "./local-model-domain-refusal";
import { liveStateSql, occupyingStateSql, inFlightStateSql, sentStateSql } from "./capacity-states";
import { deviceCandidateSql, deviceFallbackLimit, type ModelCapacityGeneration } from "./capacity-devices";
import { helperGateStateFromRow, helperGateStatesSql, type HelperGateState, type HelperGateStateRow } from "./capacity-helpers";
import { slotOnlyModelCapacity } from "./capacity-consumer-scope";
import { DrWriterFencedError, fenceFromRow, writerSiteActive } from "@/lib/operations/dr/epoch";
import { takeGatewayLocalEnd, type GatewayLocalEnd } from "./gateway-local-end";
import { trackOverdueDispatch } from "./capacity-overdue";
import { localModelBindingSchema, localModelBindingHash, localModelDispatchSchema, localModelLogicalKey,
  localModelRoute, localModelTargetSchema, localModelTerminalEvidenceSchema,
  type LocalModelTarget, type LocalModelBinding, type LocalModelDispatch, type LocalModelScreenProof } from "./local-model-capacity-contract";
import type { JobLease } from "@/lib/jobs/control";
import type { RoleLease } from "@/lib/jobs/role-leader";

type RequestRow = typeof modelCapacityRequests.$inferSelect;
const fail = (code: string): never => { throw new Error(code); };

function transaction<T>(load: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  if (currentReplayDb()) return Promise.reject(new Error("model_capacity_replay_unsupported"));
  return onPrimary(() => db.transaction(load));
}

/** DR writer fence가 첫 lock이다(seal의 fence UPDATE → control UPDATE와 같은 순서; control → fence는 그 UPDATE와 교착한다).
 * fenced DB(옛 primary·승격 전 사본)는 admission을 닫는다: draining으로 보며, 원래 transport로 가는 disabled로도 내려가지 않는다. */
async function control(tx: ProductTransaction, lock: "share" | "update" = "update") {
  const fenced = !await writerSiteActive(tx);
  const [row] = await tx.select().from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for(lock);
  return parsedControl(row, fenced);
}
function parsedControl<T extends { mode: typeof modelCapacityControl.$inferSelect.mode; policy: unknown; policyHash: string | null }>(
  row: T | undefined, fenced: boolean,
) {
  if (!row) return fail("model_capacity_control_missing");
  const policy = row.policy === null ? null : parseModelCapacityPolicy(row.policy);
  if (policy !== null && modelCapacityPolicyHash(policy) !== row.policyHash) fail("model_capacity_policy_hash_mismatch");
  return { ...row, mode: fenced ? "draining" as const : row.mode, policy, fenced };
}
type Control = Awaited<ReturnType<typeof control>>;

/** Policy read for a short domain claim TX, never a permit or dispatch proof.
 * The caller acquires this prefix before stage/domain/item/job locks. */
export async function lockModelCapacityCallerControl(tx: ProductTransaction) {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  return callerControlSnapshot(await control(tx, "share"));
}

/** Standalone primary read; the transaction has settled before transport starts.
 * This never expires requests, grants a reservation or appends an event.
 *
 * 잠그지 않고 읽는다(2026-10-31 장부 control 행 경합): 이 스냅숏은 전송 경로(legacy/장부)와 route 매핑을 고르는 데만 쓰이고, 입장·dispatch 는
 * 그 뒤의 TX 가 control 을 FOR UPDATE/FOR SHARE 로 다시 잠가 mode·policy 를 재확인한다. FOR SHARE 는 "지금 쓰는 TX 가 끝난 뒤의 값"을
 * 보장했지만 그 값도 이 함수가 돌아온 순간 이미 과거다 — 대신 호출마다 control 잠금 줄에 서서(writer 뒤·다음 writer 앞) 55P03 과 convoy 를 만들었다. */
export async function readModelCapacityCallerControl() {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const snapshot = await onPrimary(async () => callerControlSnapshot(await unlockedControl(db)));
  // Every disabled-transport choice (coordinator, text/CLI admission) reads here. A background
  // consumer lane never takes that uncapped path, even if open flips to disabled mid-tick.
  if (snapshot.mode === "disabled" && slotOnlyModelCapacity()) throw new ModelCapacityDeferredError("disabled");
  return snapshot;
}

/** SELECT-only primary observation, never caller admission. One statement observes the fence and control consistently,
 * without row locks, request expiry/grants or the transport-only slotOnlyModelCapacity behavior. */
export async function readModelCapacityControlObservation() {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  return onPrimary(async () => callerControlSnapshot(await unlockedControl(db)));
}
/** 한 문장으로 control 과 writer fence 를 잠금 없이 읽는다(읽기 전용 관측·readback 전용 — admission·dispatch 근거가 아니다).
 * control FOR UPDATE 를 오래 쥔 TX 가 있어도 lock_timeout(55P03)으로 끝나지 않는다(2026-10-31, product-search-profile 이 10-29 부터
 * 매 틱 첫 readback 의 FOR SHARE 에서 멈췄다). */
async function unlockedControl(executor: Pick<ProductTransaction, "execute">) {
  const [row] = await executor.execute<{
    mode: typeof modelCapacityControl.$inferSelect.mode; epoch: string | number; revision: string | number;
    policy: unknown; policy_hash: string | null; writer_fence: Parameters<typeof fenceFromRow>[0] | null;
  }>(sql`SELECT mode, epoch, revision, policy, policy_hash,
    (SELECT to_jsonb(f) FROM dr_writer_fence f WHERE f.id = 1) AS writer_fence
    FROM model_capacity_control WHERE id = 1`);
  if (!row) return fail("model_capacity_control_missing");
  const fence = fenceFromRow(row.writer_fence ?? undefined);
  return parsedControl({ mode: row.mode, epoch: Number(row.epoch), revision: Number(row.revision),
    policy: row.policy, policyHash: row.policy_hash }, fence.state !== "active");
}

function callerControlSnapshot(row: Pick<Control, "mode" | "epoch" | "revision" | "policyHash" | "policy" | "fenced">) {
  if (!["disabled", "open", "draining"].includes(row.mode)
    || !Number.isSafeInteger(row.epoch) || row.epoch < 1
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || row.policy === null && (row.mode !== "disabled" && !row.fenced || row.policyHash !== null)) { // fenced는 policy 없이도 draining
    throw new Error("model_capacity_control_invalid");
  }
  // 입장이 읽지 않는 선언 칸(providerLimits·groupLimits·poolLimits·weights)은 있을 때만 그대로 얼린다(PR 1b: 선택 칸).
  const policy = row.policy && Object.freeze({ ...row.policy,
    ...(row.policy.providerLimits ? { providerLimits: Object.freeze(row.policy.providerLimits) } : {}),
    ...(row.policy.groupLimits ? { groupLimits: Object.freeze(row.policy.groupLimits) } : {}),
    ...(row.policy.poolLimits ? { poolLimits: Object.freeze(row.policy.poolLimits) } : {}),
    ...(row.policy.weights ? { weights: Object.freeze(row.policy.weights) } : {}),
    routes: Object.freeze(row.policy.routes.map(route => Object.freeze(route))),
  });
  return Object.freeze({ mode: row.mode, epoch: row.epoch, revision: row.revision, policyHash: row.policyHash, policy });
}

/** The control mutex serializes every runtime writer. Existing rows selected
 * together for expiry are locked in queue order; newly inserted rows are owned
 * by this transaction before it can select one older waiting request. */
async function expireRequests(tx: ProductTransaction, state: Control): Promise<void> {
  if (state.fenced) return; // fenced DB: owner 자신의 정산(cancel·indeterminate)만 쓰고 남의 행 만료 정리는 하지 않는다
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

/**
 * 장비별 입장(PR 1b). 현재 세대의 대기 행이 있는 장비(group_id)마다 `deviceCandidateSql` 을 한 번 실행해 맞는 행 하나를 예약한다 —
 * 장비마다 pass 당 하나, control 행 FOR UPDATE 아래. 판정은 DB 안에서만: 장비 D 의 enabled 설정 행(없으면 정책 groupLimits 대체, 둘 다 없으면
 * grant 없음), 점유 = reserved·dispatched(모든 세대, indeterminate 제외), 우선(rank 1) 바쁨 = 대기·점유·최근(idle_ms) rank-1 행,
 * fits ⇔ active < limit AND (rank = 1 OR secondaryActive < (primaryBusy ? cap : max(cap, limit − reserve))), (rank, queue_ordinal) 최소 하나.
 * 전역·공급자·풀 한도와 class 가중치 순환은 더 읽지 않는다. cursor 는 0 에 머문다(control 행을 쓰지 않는다).
 */
async function grantOne(tx: ProductTransaction, state: Control): Promise<void> {
  const policy = state.policy;
  if (!policy) return fail("model_capacity_policy_missing");
  if (state.policyHash === null) return fail("model_capacity_policy_hash_missing");
  const generation: ModelCapacityGeneration = { epoch: state.epoch, revision: state.revision, policyHash: state.policyHash };
  const groupLimitsJson = JSON.stringify(policy.groupLimits ?? {});
  const devices = await tx.execute<{ group_id: string }>(sql`SELECT DISTINCT group_id FROM model_capacity_requests
    WHERE state = 'waiting' AND epoch = ${generation.epoch} AND revision = ${generation.revision} AND policy_hash = ${generation.policyHash}
      AND queue_until > clock_timestamp() ORDER BY group_id`);
  for (const { group_id } of devices) {
    const [candidate] = await tx.execute<{ request_id: string }>(deviceCandidateSql(group_id, generation, groupLimitsJson));
    if (!candidate) continue;
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "reserved", token: randomUUID(),
      reservedUntil: sql`clock_timestamp() + ${policy.reservationTtlMs} * interval '1 millisecond'`,
      updatedAt: sql`clock_timestamp()` }).where(and(eq(modelCapacityRequests.requestId, candidate.request_id),
        eq(modelCapacityRequests.state, "waiting"), sql`${modelCapacityRequests.queueUntil} > clock_timestamp()`)).returning();
    if (changed) await event(tx, changed, "reserved", "waiting", "reserved");
  }
}

/** 장비(route 의 groupId)에 설정 출처가 있는가: enabled 설정 행 또는 정책 groupLimits 대체. 둘 다 없으면 `device_unconfigured`(대기 행 없음). */
async function deviceConfigured(tx: ProductTransaction, policy: NonNullable<Control["policy"]>, deviceId: string): Promise<boolean> {
  if (deviceFallbackLimit(policy.groupLimits, deviceId) !== null) return true;
  const [row] = await tx.select({ deviceId: modelCapacityDevices.deviceId }).from(modelCapacityDevices)
    .where(and(eq(modelCapacityDevices.deviceId, deviceId), eq(modelCapacityDevices.enabled, true))).limit(1);
  return row !== undefined;
}

/**
 * 이 요청의 (route, provider, model) 이 장비의 도우미 경로인가(PR 2a Layer B). 0 줄 = 도우미 경로가 아니다(우선·보통 역할: 도우미 상태와 무관).
 * 줄이 있으면 helper_gate.ok·배정 점유·max_slots 로 판정한다 — 입장 후보 SQL(deviceCandidateSql)과 같은 helperGateCte 조각, 같은 control 잠금 아래.
 */
async function helperRouteGates(tx: ProductTransaction, deviceId: string, value: ModelCapacityRequestIdentity): Promise<HelperGateState[]> {
  const rows = await tx.execute<HelperGateStateRow>(helperGateStatesSql(deviceId,
    { routeId: value.routeId, provider: value.provider, model: value.model }));
  return rows.map(helperGateStateFromRow);
}

async function event(tx: ProductTransaction, row: RequestRow, kind: ModelCapacityEventKind,
  fromState: RequestRow["state"] | null, toState: RequestRow["state"], reason: ModelCapacityIndeterminateReason | null = null,
  evidence: unknown = null) {
  await tx.insert(modelCapacityEvents).values({ requestId: row.requestId, kind, epoch: row.epoch,
    revision: row.revision, policyHash: row.policyHash, fromState, toState, reason, evidence });
  if (kind === "dispatch_started") trackOwnDispatch(row, evidence);
}

/**
 * 모든 「전송 중」 전환은 이 사건을 쓴다 — 여기서 이 프로세스의 dispatch 를 주인 정리(capacity-overdue)에 넣는다. 사건에 dispatch 손잡이가
 * 실린 전환만(현재 CLI 를 뺀 12 경로 전부). CLI 실행기(*_cli binding)는 별도 실행기가 경계 종료 근거를 남겨 넣지 않는다.
 * TX 커밋 전이다: 커밋 응답을 받지 못한 행도 잡으려는 것이고, 되돌려진 행은 정리가 dispatched 가 아님을 읽고 버린다.
 */
function trackOwnDispatch(row: RequestRow, evidence: unknown): void {
  const dispatch = evidence && typeof evidence === "object" ? (evidence as { dispatch?: ModelCapacityDispatch }).dispatch : undefined;
  if (!dispatch) return;
  const kind = (dispatch as { binding?: { kind?: unknown } }).binding?.kind;
  if (typeof kind === "string" && Object.hasOwn(CLI_KIND_CLASS, kind)) return;
  trackOverdueDispatch(dispatch, row.routeId);
}

/** 주인 정리(capacity-overdue)의 첫 읽기 — 잠금 없이 상태·주인·binding hash 만. 표시는 markModelDispatchIndeterminate 가 잠긴 행으로 다시 판정한다. */
export async function readModelDispatchStates(requestIds: readonly string[]): Promise<Map<string, {
  requestId: string; state: RequestRow["state"]; ownerInstanceId: string; ownerBootId: string; dispatchBindingHash: string | null }>> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  if (!requestIds.length) return new Map();
  const rows = await onPrimary(() => db.select({ requestId: modelCapacityRequests.requestId, state: modelCapacityRequests.state,
    ownerInstanceId: modelCapacityRequests.ownerInstanceId, ownerBootId: modelCapacityRequests.ownerBootId,
    dispatchBindingHash: modelCapacityRequests.dispatchBindingHash }).from(modelCapacityRequests)
    .where(inArray(modelCapacityRequests.requestId, [...requestIds])));
  return new Map(rows.map(row => [row.requestId, row]));
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
 * requestModelSlot for a current reservation; this never grants or expires work.
 *
 * control 을 잠그지 않는 한 문장 읽기(2026-10-31). 돌려준 requestId 는 requestSlot 이 control FOR UPDATE 아래에서 행을 다시 읽어
 * sameIdentity·만료·상태를 재판정하고, capacityRefusalReason 의 capacity/work_busy 구분은 다음 poll 이 바로잡는 일시 분류다 —
 * FOR SHARE 가 더해 주던 것은 "지금 쓰는 TX 가 끝나길 기다린 뒤 읽기"뿐이었고 그 대가가 매 항목 control 잠금 줄 서기였다. */
export async function findOwnPendingModelRequest(value: ModelCapacityRequestIdentity): Promise<
  { requestId: string; state: "waiting" | "reserved" | "dispatched" } | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestIdentitySchema.parse(value);
  const [row] = await onPrimary(() => db.select().from(modelCapacityRequests).where(and(
    eq(modelCapacityRequests.ownerInstanceId, checked.owner.instanceId),
    eq(modelCapacityRequests.ownerBootId, checked.owner.bootId), eq(modelCapacityRequests.workKey, checked.workKey),
    sql`${liveStateSql(modelCapacityRequests.state)}`)).limit(1));
  // indeterminate 는 살아 있는 행이 아니다(capacity-states.ts): 같은 work key 는 새 requestId 로 다시 접수된다.
  if (!row || row.state === "withdrawn" || row.state === "settled" || row.state === "indeterminate") return null;
  sameIdentity(row, checked);
  return { requestId: row.requestId, state: row.state };
}

export type OwnPendingTextProfileRequest = Readonly<{ productId: number; workKey: string }>;

/** Priority metadata only. The normal coordinator must re-poll the exact input
 * key and validate all current domain, role, job and dispatch fences. */
export async function findOwnPendingTextProfileRequests(value: {
  owner: ModelCapacityRequestIdentity["owner"]; model: string; provider?: GatewayDispatchProvider;
}): Promise<OwnPendingTextProfileRequest[]> {
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: value.owner, model: value.model, workKey: "profile-queue-readback",
    class: "background", pool: "text", routeId: "product-search-profile", provider: value.provider ?? "abcllm" });
  return transaction(async tx => {
    // 우선순위 메타데이터만 — control 을 잠그지 않는다. 결과는 coordinator 가 control 을 잡고 다시 확인한다(2026-10-31: 이 첫 readback 의
    // FOR SHARE 가 lock_timeout 으로 product-search-profile 의 매 틱을 멈췄다).
    const state = await unlockedControl(tx);
    const route = state.policy?.routes.find(route => route.routeId === identity.routeId
      && route.provider === identity.provider && route.model === identity.model);
    if (state.fenced || state.mode !== "open" || !route) return [];
    const rows = await tx.select({ workKey: modelCapacityRequests.workKey, logicalWorkKey: modelCapacityRequests.logicalWorkKey })
      .from(modelCapacityRequests).where(and(
        eq(modelCapacityRequests.ownerInstanceId, identity.owner.instanceId), eq(modelCapacityRequests.ownerBootId, identity.owner.bootId),
        eq(modelCapacityRequests.class, identity.class), eq(modelCapacityRequests.pool, identity.pool),
        eq(modelCapacityRequests.routeId, identity.routeId), eq(modelCapacityRequests.provider, identity.provider),
        eq(modelCapacityRequests.model, identity.model), eq(modelCapacityRequests.epoch, state.epoch),
        eq(modelCapacityRequests.revision, state.revision), eq(modelCapacityRequests.policyHash, state.policyHash!),
        eq(modelCapacityRequests.providerBudgetId, route.providerBudgetId), eq(modelCapacityRequests.groupId, route.groupId),
        sql`((${modelCapacityRequests.state} = 'reserved' AND ${modelCapacityRequests.reservedUntil} > clock_timestamp())
          OR (${modelCapacityRequests.state} = 'waiting' AND ${modelCapacityRequests.queueUntil} > clock_timestamp()))`,
        sql`${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.dispatchBinding} IS NULL
          AND ${modelCapacityRequests.dispatchBindingHash} IS NULL AND ${modelCapacityRequests.dispatchedAt} IS NULL
          AND ${modelCapacityRequests.terminalEvidence} IS NULL
          AND ${modelCapacityRequests.terminalEvidenceHash} IS NULL AND ${modelCapacityRequests.settledAt} IS NULL`
      )).orderBy(sql`CASE WHEN ${modelCapacityRequests.state} = 'reserved' THEN 0 ELSE 1 END`, asc(modelCapacityRequests.queueOrdinal)).limit(32);
    return rows.flatMap(row => {
      const match = /^text:profile:([1-9][0-9]*):[a-f0-9]{64}$/.exec(row.workKey);
      const productId = match && Number(match[1]);
      return productId && Number.isSafeInteger(productId) && row.logicalWorkKey === `text:profile:${productId}`
        ? [{ productId, workKey: row.workKey }] : [];
    });
  });
}

export type OwnPendingReasonTranslationRequest = Readonly<{
  request: ModelCapacityRequest; memberKeys: string[]; state: "waiting" | "reserved";
  epoch: number; revision: number; policyHash: string; token: string | null;
}>;

/** Membership readback only. A changed queue head must not hide an already
 * granted batch from this exact process boot. Every reuse still re-polls and
 * passes the normal complete domain/dispatch binding checks. */
export async function findOwnPendingReasonTranslationRequests(value: {
  owner: ModelCapacityRequestIdentity["owner"]; model: string; provider?: GatewayDispatchProvider;
}): Promise<OwnPendingReasonTranslationRequest[]> {
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: value.owner, model: value.model, workKey: "reason-batch-readback",
    class: "background", pool: "text", routeId: "reason-translate", provider: value.provider ?? "abcllm" });
  return transaction(async tx => {
    // readback 전용 — control 을 잠그지 않는다(findOwnPendingTextProfileRequests 와 같은 이유, 2026-10-31). 후보는
    // cancelOwnPendingReasonTranslationRequest(control FOR UPDATE + 행 FOR UPDATE + 상태·token·세대 CAS)와 requestSlot 이 다시 확인한다.
    const state = await unlockedControl(tx);
    if (state.mode !== "open") return [];
    const rows = await tx.select().from(modelCapacityRequests).where(and(
      eq(modelCapacityRequests.ownerInstanceId, identity.owner.instanceId), eq(modelCapacityRequests.ownerBootId, identity.owner.bootId),
      eq(modelCapacityRequests.class, identity.class), eq(modelCapacityRequests.pool, identity.pool),
      eq(modelCapacityRequests.routeId, identity.routeId), eq(modelCapacityRequests.provider, identity.provider),
      eq(modelCapacityRequests.model, identity.model), eq(modelCapacityRequests.epoch, state.epoch),
      eq(modelCapacityRequests.revision, state.revision), eq(modelCapacityRequests.policyHash, state.policyHash!),
      sql`((${modelCapacityRequests.state} = 'reserved' AND ${modelCapacityRequests.reservedUntil} > clock_timestamp())
        OR (${modelCapacityRequests.state} = 'waiting' AND ${modelCapacityRequests.queueUntil} > clock_timestamp()))`,
      sql`${modelCapacityRequests.logicalMemberKeys} IS NOT NULL AND ${modelCapacityRequests.dispatchBinding} IS NULL
        AND ${modelCapacityRequests.dispatchBindingHash} IS NULL AND ${modelCapacityRequests.dispatchedAt} IS NULL`
    )).orderBy(sql`CASE WHEN ${modelCapacityRequests.state} = 'reserved' THEN 0 ELSE 1 END`, asc(modelCapacityRequests.queueOrdinal)).limit(32);
    return rows.map(row => ({ request: { ...identity, requestId: row.requestId, workKey: row.workKey },
      memberKeys: row.logicalMemberKeys!, state: row.state as "waiting" | "reserved",
      epoch: row.epoch, revision: row.revision, policyHash: row.policyHash, token: row.token }));
  });
}

/** Abandon only this exact readback of an unstarted own batch. This cannot
 * release remote work or cancel a successor token/policy generation. */
export async function cancelOwnPendingReasonTranslationRequest(value: OwnPendingReasonTranslationRequest): Promise<boolean> {
  const checked = modelCapacityRequestSchema.parse(value.request), snapshot = structuredClone(value);
  return transaction(async tx => {
    const state = await control(tx);
    if (state.fenced || state.mode !== "open") return false;
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (!row || !["waiting", "reserved"].includes(row.state) || row.state !== snapshot.state
      || row.ownerInstanceId !== checked.owner.instanceId || row.ownerBootId !== checked.owner.bootId
      || row.epoch !== snapshot.epoch || row.revision !== snapshot.revision || row.policyHash !== snapshot.policyHash
      || row.epoch !== state.epoch || row.revision !== state.revision || row.policyHash !== state.policyHash
      || row.token !== snapshot.token || !isDeepStrictEqual(row.logicalMemberKeys, snapshot.memberKeys)
      || row.dispatchBinding !== null || row.dispatchBindingHash !== null || row.dispatchedAt !== null
      || row.terminalEvidence !== null || row.terminalEvidenceHash !== null || row.settledAt !== null) return false;
    sameIdentity(row, checked);
    if (checked.routeId !== "reason-translate" || checked.class !== "background" || checked.pool !== "text" || !isGatewayDispatchProvider(checked.provider))
      fail("invalid_reason_translation_capacity_identity");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
      .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, row.state))).returning();
    if (!changed) return false;
    await event(tx, changed, row.state === "waiting" ? "wait_cancelled" : "reservation_cancelled", row.state, "withdrawn");
    return true;
  });
}

type ProductTextBatchIdentity = { owner: ModelCapacityRequestIdentity["owner"]; model: string;
  routeId: "product-translate" | "product-tagline-ko"; provider?: GatewayDispatchProvider };
export type OwnPendingProductTextRequest = OwnPendingReasonTranslationRequest;
function productTextBatchIdentity(value: ProductTextBatchIdentity) {
  if (!["product-translate", "product-tagline-ko"].includes(value.routeId)) fail("invalid_product_text_batch_route");
  return modelCapacityRequestIdentitySchema.parse({ owner: value.owner, model: value.model, routeId: value.routeId, workKey: "product-text-batch-readback",
    class: "background", pool: "text", provider: value.provider ?? "abcllm" });
}

/** Recover complete unstarted membership independently of a newly selected queue page. No grant or expiry. */
export async function findOwnPendingProductTextRequests(value: ProductTextBatchIdentity): Promise<OwnPendingProductTextRequest[]> {
  const identity = productTextBatchIdentity(value);
  return transaction(async tx => {
    // readback 전용 — control 을 잠그지 않는다(2026-10-31). cancelOwnPendingProductTextRequest·requestSlot 이 FOR UPDATE 아래에서 재확인한다.
    const state = await unlockedControl(tx);
    if (state.fenced || state.mode !== "open") return [];
    const rows = await tx.select().from(modelCapacityRequests).where(and(
      eq(modelCapacityRequests.ownerInstanceId, identity.owner.instanceId), eq(modelCapacityRequests.ownerBootId, identity.owner.bootId),
      eq(modelCapacityRequests.class, identity.class), eq(modelCapacityRequests.pool, identity.pool),
      eq(modelCapacityRequests.routeId, identity.routeId), eq(modelCapacityRequests.provider, identity.provider),
      eq(modelCapacityRequests.model, identity.model), eq(modelCapacityRequests.epoch, state.epoch),
      eq(modelCapacityRequests.revision, state.revision), eq(modelCapacityRequests.policyHash, state.policyHash!),
      sql`((${modelCapacityRequests.state} = 'reserved' AND ${modelCapacityRequests.reservedUntil} > clock_timestamp())
        OR (${modelCapacityRequests.state} = 'waiting' AND ${modelCapacityRequests.queueUntil} > clock_timestamp()))`,
      sql`${modelCapacityRequests.logicalMemberKeys} IS NOT NULL AND ${modelCapacityRequests.dispatchBinding} IS NULL
        AND ${modelCapacityRequests.dispatchBindingHash} IS NULL AND ${modelCapacityRequests.dispatchedAt} IS NULL`
    )).orderBy(sql`CASE WHEN ${modelCapacityRequests.state} = 'reserved' THEN 0 ELSE 1 END`, asc(modelCapacityRequests.queueOrdinal)).limit(32);
    return rows.map(row => ({ request: { ...identity, requestId: row.requestId, workKey: row.workKey },
      memberKeys: row.logicalMemberKeys!, state: row.state as "waiting" | "reserved",
      epoch: row.epoch, revision: row.revision, policyHash: row.policyHash, token: row.token }));
  });
}

/** Exact own readback CAS only: never release dispatched/unknown work, a foreign owner or a successor generation. */
export async function cancelOwnPendingProductTextRequest(value: OwnPendingProductTextRequest,
  expected: ProductTextBatchIdentity): Promise<boolean> {
  const identity = productTextBatchIdentity(expected), checked = modelCapacityRequestSchema.parse(value.request), snapshot = structuredClone(value);
  if (checked.owner.instanceId !== identity.owner.instanceId || checked.owner.bootId !== identity.owner.bootId
    || checked.routeId !== identity.routeId || checked.model !== identity.model || checked.provider !== identity.provider
    || checked.class !== identity.class || checked.pool !== identity.pool) return false;
  return transaction(async tx => {
    const state = await control(tx);
    if (state.fenced || state.mode !== "open") return false;
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (!row || !["waiting", "reserved"].includes(row.state) || row.state !== snapshot.state
      || row.ownerInstanceId !== identity.owner.instanceId || row.ownerBootId !== identity.owner.bootId
      || row.epoch !== snapshot.epoch || row.revision !== snapshot.revision || row.policyHash !== snapshot.policyHash
      || row.epoch !== state.epoch || row.revision !== state.revision || row.policyHash !== state.policyHash
      || row.token !== snapshot.token || !isDeepStrictEqual(row.logicalMemberKeys, snapshot.memberKeys)
      || row.dispatchBinding !== null || row.dispatchBindingHash !== null || row.dispatchedAt !== null
      || row.terminalEvidence !== null || row.terminalEvidenceHash !== null || row.settledAt !== null) return false;
    sameIdentity(row, checked);
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
      .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, row.state))).returning();
    if (!changed) return false;
    await event(tx, changed, row.state === "waiting" ? "wait_cancelled" : "reservation_cancelled", row.state, "withdrawn");
    return true;
  });
}

export async function requestModelSlot(value: ModelCapacityRequest): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value);
  if (checked.provider === "local-direct") fail("local_model_bound_request_required");
  return requestSlot(checked, null);
}

/** 첫 waiting INSERT부터 기기·모델·owner와 무관한 도메인 작업의 중복을 막는다. */
export async function requestLocalModelSlot(value: ModelCapacityRequest, target: LocalModelTarget): Promise<ModelSlotResult> {
  const checked = modelCapacityRequestSchema.parse(value), parsed = localModelTargetSchema.parse(target);
  if (checked.provider !== "local-direct" || checked.class !== "background" || checked.pool !== "reviewer"
    || checked.routeId !== localModelRoute(parsed)) fail("invalid_local_model_capacity_identity");
  return requestSlot(checked, localModelLogicalKey(parsed));
}

/** 새 직접 호출의 dispatch는 이 고정 도메인 증명 경로만 통과한다. */
const localDispatches = new WeakSet<object>();
/** 커밋된 원본 handle만 실제 전송을 한 번 시작할 수 있다. 직렬화된 binding은 권한이 아니다. */
export function consumeLocalModelDispatch(value: unknown): LocalModelDispatch | null {
  if (!value || typeof value !== "object" || !localDispatches.has(value)) return null;
  localDispatches.delete(value);
  return value as LocalModelDispatch;
}

/**
 * 예약을 이 대상의 실제 전송으로 바꾼다. 장부 쪽 경합(정책·예약 만료·소유권·같은 작업 fence)은 null(일시 — 다음 틱),
 * 도메인 증명의 거절은 그 예약을 물리고(evidence 에 검사) LocalModelDomainRefusedError(reason reservation_lost)를 던진다.
 */
export async function dispatchLocalModelCapacity(value: {
  reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; binding: LocalModelBinding;
  input: import("./local-model-input").LocalModelInput; job: JobLease; role: RoleLease; screenProof?: LocalModelScreenProof;
}): Promise<LocalModelDispatch | null> {
  const reservationValue = modelCapacityReservationSchema.parse(value.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(value.identity), binding = localModelBindingSchema.parse(value.binding);
  if (identity.provider !== binding.provider || identity.model !== binding.model || identity.routeId !== binding.routeId
    || identity.workKey !== `${binding.logicalWorkKey}:${binding.inputHash}`
    || identity.class !== "background" || identity.pool !== "reviewer" || identity.owner.instanceId !== value.role.instanceId
    || identity.owner.bootId !== value.role.bootId || binding.inputHash !== value.input.inputHash
    || binding.sourceRevisionHash !== value.input.sourceRevisionHash || binding.reviewPolicyHash !== value.input.policyHash
    || binding.job.name !== value.job.name || binding.job.token !== value.job.token || binding.job.requestedVersion !== value.job.requestedVersion)
    fail("local_model_dispatch_binding_mismatch");
  const committed = await transaction(async tx => {
    const state = await control(tx);
    if (state.mode !== "open" || !state.policy) return null;
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, reservationValue.requestId)).for("update");
    if (!owned(row, reservationValue)) return null;
    sameIdentity(row, identity);
    const route = state.policy.routes.find(route => route.routeId === identity.routeId && route.provider === identity.provider && route.model === identity.model);
    if (!route || route.groupId !== binding.physicalGroup || route.providerBudgetId !== binding.backendId
      || row.groupId !== route.groupId || row.providerBudgetId !== route.providerBudgetId || row.state !== "reserved"
      || row.logicalWorkKey !== binding.logicalWorkKey || row.epoch !== state.epoch || row.revision !== state.revision
      || row.policyHash !== state.policyHash || await localModelFence(tx, binding.logicalWorkKey, row.requestId)) return null;
    const { localModelDomainRefusal } = await import("./local-model-domain");
    const refusal = await localModelDomainRefusal(tx, binding.target, value.input, value.job, value.role, binding.model, row.requestId, value.screenProof);
    if (refusal) {
      // 증명이 거절한 예약은 같은 TX 에서 물리고 어느 검사인지 evidence 에 남긴다(2026-11-03 — 예전에는 호출자 정리가 evidence 없이 물렸다)
      const [withdrawn] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
        .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, "reserved"),
          eq(modelCapacityRequests.token, row.token!))).returning();
      if (withdrawn) await event(tx, withdrawn, "reservation_cancelled", "reserved", "withdrawn", null, localModelDomainRefusalEvidence(refusal));
      return { refused: refusal };
    }
    const bindingHash = localModelBindingHash(binding);
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "dispatched", dispatchBinding: binding, dispatchBindingHash: bindingHash,
      dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(and(eq(modelCapacityRequests.requestId, row.requestId),
      eq(modelCapacityRequests.state, "reserved"), eq(modelCapacityRequests.token, row.token!),
      sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
    if (!changed) return null;
    if (binding.target.kind === "assist") {
      const { bindAssistModelRequest } = await import("@/lib/domain/llm-assist/model-domain");
      await bindAssistModelRequest(tx, binding.target, changed.requestId);
    }
    const dispatch = localModelDispatchSchema.parse({ ...reservation(changed), binding, bindingHash }) as LocalModelDispatch;
    await event(tx, changed, "dispatch_started", "reserved", "dispatched", null, { dispatch });
    return dispatch;
  });
  if (committed && "refused" in committed) throw new LocalModelDomainRefusedError(committed.refused);
  if (committed) localDispatches.add(committed);
  return committed;
}

/** local-direct 행의 동일성: 같은 owner handle 에 provider·class·pool·logical key·route·model·physical group·backend·bindingHash·binding 이 그대로다. */
function localModelRowMatches(row: RequestRow | undefined, dispatch: LocalModelDispatch): row is RequestRow {
  return owned(row, dispatch) && row.provider === "local-direct" && row.class === "background" && row.pool === "reviewer"
    && row.logicalWorkKey === dispatch.binding.logicalWorkKey && row.routeId === dispatch.binding.routeId && row.model === dispatch.binding.model
    && row.groupId === dispatch.binding.physicalGroup && row.providerBudgetId === dispatch.binding.backendId && !!row.dispatchedAt
    && row.dispatchBindingHash === dispatch.bindingHash && isDeepStrictEqual(row.dispatchBinding, dispatch.binding);
}

/** 실제 adapter가 발급한 원본 증인만 받는다. 현재 job·정책이 바뀌어도 과거 물리 호출은 정산한다. */
export async function reconcileLocalModelTerminal(terminal: unknown): Promise<{ kind: "settled" | "already_settled" }> {
  const { readLocalModelTerminal } = await import("./local-model-terminal");
  const native = readLocalModelTerminal(terminal);
  if (!native) return fail("invalid_local_model_terminal");
  const evidence = localModelTerminalEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) return fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!localModelRowMatches(row, dispatch as LocalModelDispatch)) return fail("local_model_terminal_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence)) return fail("local_model_terminal_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched" && row.state !== "indeterminate") return fail("local_model_terminal_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence, terminalEvidenceHash: evidenceHash,
      settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", row.state, "settled", null, evidence);
    return { kind: "settled" };
  });
}

async function localModelFence(tx: ProductTransaction, logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    ${modelCapacityRequests.requestId} <> ${ownId} AND ${liveStateSql(modelCapacityRequests.state)}
    AND (${modelCapacityRequests.logicalWorkKey}=${logicalKey}
      OR (${logicalKey} ~ '^direct:audit:[1-9][0-9]*:audit$'
        AND ${modelCapacityRequests.logicalWorkKey}='bg:audit:' || split_part(${logicalKey},':',3))
      OR (${logicalKey} ~ '^direct:(candidate|split):' AND (
        (${modelCapacityRequests.logicalWorkKey} ~ '^direct:(candidate|split):'
          AND split_part(${modelCapacityRequests.logicalWorkKey},':',3)=split_part(${logicalKey},':',3))
        OR ${modelCapacityRequests.logicalWorkKey}='ai1:' || split_part(${logicalKey},':',3)
        OR ${modelCapacityRequests.logicalWorkKey} LIKE 'ai2:' || split_part(${logicalKey},':',3) || ':%')))`).limit(1);
  return Boolean(blocked);
}

/** Fixed AI1 logical fence starts with the original waiting INSERT, not dispatch. */
export async function requestAi1ModelSlot(value: ModelCapacityRequest, candidateId: number): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityRequestSchema.parse(value);
  fixedAi1Identity(checked, candidateId);
  return requestSlot(checked, `ai1:${candidateId}`);
}

/** AI1 게이트웨이 kind 의 고정 identity. provider 는 abcllm 계약 또는 local-direct 엔진이다(PR 3b-C, 0157). */
function fixedAi1Identity(value: ModelCapacityRequestIdentity, candidateId: number): void {
  if (!Number.isSafeInteger(candidateId) || candidateId < 1 || value.class !== "first" || value.pool !== "reviewer"
    || value.routeId !== "crawl-agent-review" || !(GATEWAY_DISPATCH_PROVIDERS as readonly string[]).includes(value.provider))
    fail("invalid_ai1_capacity_identity");
}

async function ai1Fence(tx: ProductTransaction, logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.logicalWorkKey} = ${logicalKey} AND ${modelCapacityRequests.requestId} <> ${ownId}
      AND ${liveStateSql(modelCapacityRequests.state)})
    OR (${modelCapacityRequests.logicalWorkKey} ~ '^direct:(candidate|split):'
      AND split_part(${modelCapacityRequests.logicalWorkKey},':',3)=split_part(${logicalKey},':',2)
      AND ${liveStateSql(modelCapacityRequests.state)})
    OR (${modelCapacityRequests.logicalWorkKey} IS NULL AND ${modelCapacityRequests.routeId} = 'crawl-agent-review'
      AND ${modelCapacityRequests.provider} = 'abcllm' AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
  return !!blocked;
}

function requestSlot(checked: ModelCapacityRequest, logicalKey: string | null, memberKeys?: string[], crawl?: CrawlTaglineInput,
  websearch?: WebsearchQueryInput): Promise<ModelSlotResult> {
  return transaction(async tx => {
    const state = await control(tx);
    if (state.fenced) return { kind: "deferred", reason: "draining" }; // fenced: 만료 정리·대기 행·예약을 쓰지 않는다
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
        : checked.routeId === "product-intro-check" || checked.routeId === "crawl-publish-classify" ? introCheckFence(tx, memberKeys, checked.requestId, checked.routeId)
          : reasonTranslationFence(tx, memberKeys, checked.requestId))) return { kind: "deferred", reason: "capacity" };
    if (!memberKeys && logicalKey !== null && await (logicalKey.startsWith("direct:")
      ? localModelFence(tx, logicalKey, checked.requestId) : logicalKey.startsWith("ai2:")
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
    if (!await deviceConfigured(tx, state.policy, route.groupId)) return { kind: "deferred", reason: "device_unconfigured" };
    // 도우미 경로(PR 2a): 닫혀 있거나(신호 없음·만료·다른 epoch·판·계정, 감시자 꺼짐, 정지·mode·판정) 배정 점유가 찼으면 대기 행·event 없이 미룬다.
    // 도우미가 아닌 경로는 0 줄이라 이 검사를 지나간다 — 우선 역할 일은 도우미 상태로 막히지 않는다.
    const helperGates = await helperRouteGates(tx, route.groupId, checked);
    if (helperGates.some(gate => !gate.ok || gate.active >= gate.maxSlots)) return { kind: "deferred", reason: "helper_ineligible" };
    const oldActive = await tx.select({ epoch: modelCapacityRequests.epoch, revision: modelCapacityRequests.revision,
      policyHash: modelCapacityRequests.policyHash }).from(modelCapacityRequests)
      .where(sql`${occupyingStateSql(modelCapacityRequests.state)} AND (
        ${modelCapacityRequests.epoch} <> ${state.epoch} OR ${modelCapacityRequests.revision} <> ${state.revision}
        OR ${modelCapacityRequests.policyHash} <> ${state.policyHash})`);
    if (oldActive.some(row => !compatibleModelCapacityGeneration(state.policy!, row, state)))
      return { kind: "deferred", reason: "policy_changed" };
    if (!existing) {
      const [duplicateWork] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests)
        .where(and(eq(modelCapacityRequests.ownerInstanceId, checked.owner.instanceId),
          eq(modelCapacityRequests.ownerBootId, checked.owner.bootId), eq(modelCapacityRequests.workKey, checked.workKey),
          sql`${liveStateSql(modelCapacityRequests.state)}`)).limit(1);
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
    if (own.state === "reserved") return { kind: "granted", reservation: reservation(own) };
    // 도우미 요청은 grant-or-nothing: 이 pass 에서 예약되지 않으면 같은 TX 에서 대기 행을 거둔다. 1칸 장비에 남은 대기 행이 나중에 예약되면
    // 쓸 사람 없이 우선 역할의 칸을 예약 TTL 동안 쥐기 때문이다(pr2-plan §2.3).
    if (helperGates.length && own.state === "waiting") {
      const [withdrawn] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
        .where(and(eq(modelCapacityRequests.requestId, own.requestId), eq(modelCapacityRequests.state, "waiting"))).returning();
      if (withdrawn) await event(tx, withdrawn, "wait_cancelled", "waiting", "withdrawn");
    }
    return { kind: "deferred", reason: "capacity" };
  });
}

export async function beginModelDispatch(value: ModelCapacityReservation): Promise<
  { kind: "dispatched"; dispatch: ModelCapacityDispatch } | { kind: "ownership_lost" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const checked = modelCapacityReservationSchema.parse(value);
  return transaction(async tx => {
    const state = await control(tx);
    if (state.fenced) return { kind: "ownership_lost" }; // fenced: dispatch도 만료 정리도 쓰지 않는다
    await expireRequests(tx, state);
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (row && await expireReservation(tx, row)) return { kind: "ownership_lost" };
    if (row?.provider === "local-direct") fail("local_model_bound_dispatch_required");
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

/** Assist pre-dispatch abandonment only. This is no provider termination evidence.
 * Never sweeps another request, grants capacity, or alters a dispatched/bound row. */
export async function cancelOwnPendingLocalModelRequest(value: ModelCapacityRequest, target: LocalModelTarget): Promise<boolean> {
  const checked = modelCapacityRequestSchema.parse(value), parsed = localModelTargetSchema.parse(target);
  if (parsed.kind !== "assist" || checked.provider !== "local-direct" || checked.class !== "background"
    || checked.pool !== "reviewer" || checked.routeId !== localModelRoute(parsed)) fail("invalid_assist_pending_cancellation");
  return transaction(async tx => {
    const state = await control(tx);
    if (state.fenced) return false;
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (!row || !["waiting", "reserved"].includes(row.state) || row.ownerInstanceId !== checked.owner.instanceId
      || row.ownerBootId !== checked.owner.bootId || row.logicalWorkKey !== localModelLogicalKey(parsed)
      || row.dispatchBinding !== null || row.dispatchBindingHash !== null || row.dispatchedAt !== null
      || row.terminalEvidence !== null || row.terminalEvidenceHash !== null || row.settledAt !== null) return false;
    sameIdentity(row, checked);
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
      .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, row.state),
        sql`${modelCapacityRequests.dispatchBinding} is null and ${modelCapacityRequests.dispatchedAt} is null`)).returning();
    if (!changed) return false;
    await event(tx, changed, row.state === "waiting" ? "wait_cancelled" : "reservation_cancelled", row.state, "withdrawn");
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
  const publicationBound = websearchBound.success ? websearchBound : publicationClassifyApiDispatchSchema.safeParse(value);
  const cliBound = publicationBound.success ? publicationBound : cliModelDispatchSchema.safeParse(value);
  const bound = cliBound.success ? cliBound : localModelDispatchSchema.safeParse(value);
  const checked = bound.success ? modelCapacityDispatchSchema.parse({ requestId: bound.data.requestId,
    owner: bound.data.owner, token: bound.data.token, epoch: bound.data.epoch, revision: bound.data.revision,
    policyHash: bound.data.policyHash }) : modelCapacityDispatchSchema.parse(value);
  if (!MODEL_CAPACITY_INDETERMINATE_REASONS.includes(reason)) fail("invalid_model_capacity_reason");
  const marked = await transaction(async tx => {
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
  // PR15d: 이 프로세스가 같은 호출의 게이트웨이 로컬 종료를 직접 봤으면(MODEL_CAPACITY_LOCAL_END 일 때만 생김) 사실로 남긴다. 해제는 아니다.
  // 기록 실패는 indeterminate 결과를 바꾸지 않는다 — 회수 근거가 없을 뿐이고 점유·C 는 그대로다.
  const witness = marked ? takeGatewayLocalEnd(checked.requestId) : null;
  if (witness) await recordModelDispatchLocalEnd(checked, bound.success ? bound.data.bindingHash : null, witness).catch(() => {});
  return marked;
}

/**
 * 사람 검토 완료(0151, 2026-10-30 소유자 결정). indeterminate 행은 점유가 아니므로 용량은 바뀌지 않는다 — 검토 목록에서 빼고 운영자·메모·DB 시각을
 * 행(terminal_evidence·hash)과 dispatch_reviewed event 에 같은 값으로 남긴다. dispatch binding(C)은 그대로, 사용량 근거는 없다. 늦은 종료 근거는
 * 이 뒤로는 받지 않는다(withdrawn). 호출자(관리자 action)가 operations_audit 를 따로 남긴다.
 */
export async function closeModelCapacityUnknownReview(value: { requestId: string; operator: string; note: string }): Promise<
  { kind: "reviewed"; evidence: OperatorReviewEvidence } | { kind: "not_indeterminate"; state: ModelCapacityState | null }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const requestId = z.uuid().parse(value.requestId);
  return transaction(async tx => {
    const state = await control(tx);
    if (state.fenced) fail("dr_writer_site_fenced");
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, requestId)).for("update");
    if (!row || row.state !== "indeterminate") return { kind: "not_indeterminate", state: row?.state ?? null };
    const [clock] = await tx.execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
    const evidence = operatorReviewEvidenceSchema.parse({ version: 1, kind: "operator_review", requestId: row.requestId,
      owner: { instanceId: row.ownerInstanceId, bootId: row.ownerBootId }, fromState: "indeterminate",
      operator: value.operator, note: value.note, reviewedAt: clock.now });
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", terminalEvidence: evidence,
      terminalEvidenceHash: operatorReviewEvidenceHash(evidence), updatedAt: sql`clock_timestamp()` })
      .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, "indeterminate"))).returning();
    if (!changed) fail("model_capacity_review_state_changed");
    await event(tx, changed, "dispatch_reviewed", "indeterminate", "withdrawn", null, evidence);
    return { kind: "reviewed", evidence };
  });
}

export type OwnerGoneCandidate = Readonly<{ requestId: string; queueOrdinal: number; owner: Readonly<{ instanceId: string; bootId: string }>;
  state: ModelCapacityState; providerBudgetId: string; dispatchAt: string | null; now: string }>;
/** owner_gone 근거가 이 행에 묶이는 최소 모양(전체 스키마는 lib/operations/dr/owner-gone.ts). */
export type OwnerGoneBoundEvidence = Readonly<{ kind: "owner_gone"; requestId: string; owner: Readonly<{ instanceId: string; bootId: string }>;
  fromState: "dispatched"; dispatchAt: string; evaluatedAt: string }>;
export type OwnerGoneMarkResult<E> = { kind: "marked"; evidence: E } | { kind: "blocked"; reason: string }
  | { kind: "not_dispatched"; state: ModelCapacityState | null };

/**
 * 소유 프로세스 부재(owner_gone) 운영자 전환 hook(2026-11-02). caller TX(fence SHARE 뒤) 안에서 요청 행만 FOR UPDATE 로 잠그고 — control 은 잠그지
 * 않는다(이 전환은 점유를 줄이기만 하고 control 을 쓰지 않는다; 다른 경로의 fence → control → 행 순서와 교착하지 않는다) — 같은 TX·DB clock 으로
 * verify 가 소유자 부재 근거를 다시 읽어 판정한다. dispatched 일 때만 indeterminate 로 바꾸고(released 아님 — 제공자 쪽 생성이 끝났는지 모른다),
 * 같은 근거를 dispatch_indeterminate event(reason process_exit)에 남긴다. 행의 binding·token·terminal 칸은 그대로라 늦은 종료 근거는 여전히 정산하고,
 * 사람 검토(closeModelCapacityUnknownReview)가 닫을 수 있다. 이미 다른 상태면 아무것도 쓰지 않는다.
 */
export async function markOwnerGoneDispatchIndeterminate<E extends OwnerGoneBoundEvidence>(tx: ProductTransaction, requestId: string,
  verify: (candidate: OwnerGoneCandidate) => Promise<E | { blocked: string }>): Promise<OwnerGoneMarkResult<E>> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const id = z.uuid().parse(requestId);
  const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, id)).for("update");
  if (!row || row.state !== "dispatched") return { kind: "not_dispatched", state: row?.state ?? null };
  const iso = (value: unknown) => sql`to_char((${value}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const [clock] = await tx.execute<{ dispatch_at: string | null; now: string }>(sql`SELECT ${iso(sql`coalesce(r.dispatched_at, (SELECT min(e.created_at)
    FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_started'))`)} AS dispatch_at, ${iso(sql`clock_timestamp()`)} AS now
    FROM model_capacity_requests r WHERE r.request_id = ${row.requestId}::uuid`);
  const owner = Object.freeze({ instanceId: row.ownerInstanceId, bootId: row.ownerBootId });
  const verdict = await verify(Object.freeze({ requestId: row.requestId, queueOrdinal: row.queueOrdinal, owner, state: row.state,
    providerBudgetId: row.providerBudgetId, dispatchAt: clock.dispatch_at, now: clock.now }));
  if ("blocked" in verdict) return { kind: "blocked", reason: verdict.blocked };
  if (verdict.kind !== "owner_gone" || verdict.requestId !== row.requestId || verdict.owner.instanceId !== owner.instanceId
    || verdict.owner.bootId !== owner.bootId || verdict.fromState !== "dispatched" || verdict.dispatchAt !== clock.dispatch_at
    || verdict.evaluatedAt !== clock.now) fail("model_capacity_owner_gone_evidence_mismatch");
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "indeterminate", updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, "dispatched"))).returning();
  if (!changed) fail("model_capacity_owner_gone_state_changed");
  await event(tx, changed, "dispatch_indeterminate", "dispatched", "indeterminate", "process_exit", verdict);
  return { kind: "marked", evidence: verdict };
}

/** 소유 handle 이 잠긴 행과 같고 행이 indeterminate 일 때만, 요청당 한 번 dispatch_local_ended 사실을 쓴다(lock 순서: fence → control → 행).
 * 두 번째 기록은 0099 부분 unique index 에서 조용히 빠진다. 대상 없는 ON CONFLICT 라 events SELECT 권한이 없는 최소권한 principal 도 쓸 수 있다. */
async function recordModelDispatchLocalEnd(checked: ModelCapacityDispatch, bindingHash: string | null, witness: GatewayLocalEnd): Promise<void> {
  await transaction(async tx => {
    await control(tx);
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for("update");
    if (!owned(row, checked) || row.state !== "indeterminate" || row.dispatchBindingHash !== bindingHash || witness.requestId !== row.requestId) return;
    await tx.insert(modelCapacityEvents).values({ requestId: row.requestId, kind: "dispatch_local_ended", epoch: row.epoch, revision: row.revision,
      policyHash: row.policyHash, fromState: "indeterminate", toState: "indeterminate", reason: null, evidence: gatewayLocalEndFactSchema.parse({ version: 1,
        kind: "gateway_local_end", requestId: row.requestId, owner: { instanceId: row.ownerInstanceId, bootId: row.ownerBootId },
        bindingHash: row.dispatchBindingHash, dispatches: witness.dispatches, terminals: witness.terminals }) }).onConflictDoNothing();
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
    || binding.model !== proof.identity.model || binding.provider !== proof.identity.provider) fail("ai1_capacity_dispatch_binding_mismatch");
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
    || !["abcllm", "local-direct"].includes(value.provider) || !value.workKey.startsWith(`${logical}:`)
    || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1))) fail("invalid_ai2_capacity_identity");
  return logical;
}

/** Historical unbound second-review calls have no trustworthy chain identity. */
async function ai2Fence(tx: ProductTransaction, logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.logicalWorkKey} = ${logicalKey} AND ${modelCapacityRequests.requestId} <> ${ownId}
      AND ${liveStateSql(modelCapacityRequests.state)})
    OR (${modelCapacityRequests.logicalWorkKey} ~ '^direct:(candidate|split):'
      AND split_part(${modelCapacityRequests.logicalWorkKey},':',3)=split_part(${logicalKey},':',2)
      AND ${liveStateSql(modelCapacityRequests.state)})
    OR (${modelCapacityRequests.logicalWorkKey} IS NULL AND ${modelCapacityRequests.routeId} = 'second-review'
      AND ${modelCapacityRequests.provider} = 'abcllm' AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
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
    || binding.provider !== proof.identity.provider
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
    || binding.model !== proof.identity.model || binding.provider !== proof.identity.provider
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

/** text 풀 게이트웨이 행의 동일성(각 text terminal reconcile 과 같은 규칙): background·text 풀·`logical:inputHash` workKey·route/provider/model·
 * (member 경로는) logicalMemberKeys·bindingHash·dispatchedAt·binding 전체가 같은 owner handle 의 행에 그대로다. */
function textGatewayRowMatches(row: RequestRow | undefined, dispatch: ModelCapacityDispatch & Readonly<{ bindingHash: string;
  binding: Readonly<{ logicalWorkKey: string; inputHash: string; routeId: string; provider: string; model: string }> }>,
  memberKeys: readonly string[] | null): row is RequestRow {
  return owned(row, dispatch) && row.logicalWorkKey === dispatch.binding.logicalWorkKey
    && (memberKeys === null || isDeepStrictEqual(row.logicalMemberKeys, memberKeys))
    && row.routeId === dispatch.binding.routeId && row.provider === dispatch.binding.provider
    && row.model === dispatch.binding.model && row.class === "background" && row.pool === "text"
    && row.workKey === `${dispatch.binding.logicalWorkKey}:${dispatch.binding.inputHash}`
    && row.dispatchBindingHash === dispatch.bindingHash && !!row.dispatchedAt
    && isDeepStrictEqual(row.dispatchBinding, dispatch.binding);
}
/** AI1 legacy·AI1 item·AI2 item 행의 동일성(0102 그대로): reviewer 풀, legacy 는 first 에 workKey 자유, item 은 `logical:item.bindingHash`. */
function reviewerGatewayRowMatches(row: RequestRow | undefined, dispatch: Ai1ModelDispatch | Ai1ItemModelDispatch | Ai2ModelDispatch): row is RequestRow {
  const binding = dispatch.binding;
  const expected = binding.kind === "ai1_legacy_gateway" ? { class: "first", workKey: null }
    : { class: binding.kind === "ai2_item_gateway" ? "second" : "first", workKey: `${binding.logicalWorkKey}:${binding.item.bindingHash}` };
  return owned(row, dispatch) && row.logicalWorkKey === binding.logicalWorkKey && row.routeId === binding.routeId
    && row.provider === binding.provider && row.model === binding.model && row.class === expected.class && row.pool === "reviewer"
    && (expected.workKey === null || row.workKey === expected.workKey)
    && row.dispatchBindingHash === dispatch.bindingHash && !!row.dispatchedAt && isDeepStrictEqual(row.dispatchBinding, binding);
}
/** not_started 증인의 dispatch 가 가리키는 행이 그 binding kind 의 terminal reconcile 과 같은 동일성 규칙을 만족하는가. */
function gatewayNotStartedRowMatches(row: RequestRow | undefined, dispatch: GatewayNotStartedDispatch): row is RequestRow {
  const binding = dispatch.binding;
  switch (binding.kind) {
    case "ai1_legacy_gateway": return reviewerGatewayRowMatches(row, dispatch as Ai1ModelDispatch);
    case "ai1_item_gateway": return reviewerGatewayRowMatches(row, dispatch as Ai1ItemModelDispatch);
    case "ai2_item_gateway": return reviewerGatewayRowMatches(row, dispatch as Ai2ModelDispatch);
    case "text_profile_gateway": return textGatewayRowMatches(row, dispatch as TextProfileModelDispatch, null);
    case "reason_translation_gateway":
      return textGatewayRowMatches(row, dispatch as ReasonTranslationModelDispatch, reasonTranslationMemberKeys(binding.members));
    case "product_translation_gateway":
      return textGatewayRowMatches(row, dispatch as ProductTranslationModelDispatch, productTranslationMemberKeys(binding.members));
    case "product_tagline_ko_gateway":
      return textGatewayRowMatches(row, dispatch as ProductTaglineKoModelDispatch, productTaglineKoMemberKeys(binding.members));
    case "crawl_tagline_gateway": return crawlTaglineRowMatches(row, dispatch as CrawlTaglineModelDispatch);
    case "search_verify_gateway": return searchVerifyRowMatches(row, dispatch as SearchVerifyModelDispatch);
    case "websearch_query_gateway": return websearchQueryRowMatches(row, dispatch as WebsearchQueryModelDispatch);
    case "publication_classify_gateway": return publicationApiRowMatches(row, dispatch as PublicationClassifyApiDispatch);
    case "local_model_direct": return localModelRowMatches(row, dispatch as LocalModelDispatch);
  }
}

/**
 * fetch 를 부르지 않았거나 요청 바이트를 하나도 쓰지 못한 채 닫은 게이트웨이 dispatch 의 정산(CLI D5 not_started 의 게이트웨이판, 0102 → 0149 모든 kind).
 * 게이트웨이 모듈이 낸 원본 증인만 받는다. 같은 owner handle·binding 의 dispatched 행만 settled 로 바꾼다 — indeterminate 는 전송 여부를
 * 이미 모른다는 기록이라 받지 않는다. 행 동일성은 binding kind 별 terminal reconcile 의 규칙 그대로다(AI1/AI2 는 0102 와 같다).
 * 점유만 끝나고 binding 의 C 는 그대로다(사용량 증거 없음). 역사적 dispatch 로 정산하므로 지금의 정책·mode·job 은 막지 않는다.
 */
export async function reconcileGatewayNotStarted(terminal: GatewayNotStarted): Promise<{ kind: "settled" | "already_settled" }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const { readGatewayNotStarted } = await import("@/lib/crawl/agent-review-gateway");
  const native = readGatewayNotStarted(terminal);
  if (!native) fail("invalid_gateway_not_started");
  const evidence = gatewayNotStartedEvidenceSchema.parse(native), dispatch = evidence.dispatch;
  const evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    if (!mutex) fail("model_capacity_control_missing");
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
    if (!gatewayNotStartedRowMatches(row, dispatch)) fail("gateway_not_started_binding_mismatch");
    if (row.state === "settled") {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence)) fail("gateway_not_started_conflict");
      return { kind: "already_settled" };
    }
    if (row.state !== "dispatched") fail("gateway_not_started_state_mismatch");
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "settled", terminalEvidence: evidence,
      terminalEvidenceHash: evidenceHash, settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, "dispatch_settled", "dispatched", "settled", null, evidence);
    return { kind: "settled" };
  });
}

function fixedTextProfileIdentity(value: ModelCapacityRequestIdentity, productId: number): string {
  const logical = `text:profile:${productId}`;
  if (!Number.isSafeInteger(productId) || productId < 1 || value.class !== "background" || value.pool !== "text"
    || value.routeId !== "product-search-profile" || !isGatewayDispatchProvider(value.provider)
    || !value.workKey.startsWith(`${logical}:`) || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1)))
    fail("invalid_text_profile_capacity_identity");
  return logical;
}
async function textProfileFence(tx: ProductTransaction, logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.logicalWorkKey} = ${logicalKey} AND ${modelCapacityRequests.requestId} <> ${ownId}
      AND ${liveStateSql(modelCapacityRequests.state)})
    OR (${modelCapacityRequests.logicalWorkKey} IS NULL AND ${modelCapacityRequests.routeId} = 'product-search-profile'
      AND ${modelCapacityRequests.provider} = 'abcllm' AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
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
    if (!textGatewayRowMatches(row, dispatch, null)) fail("text_profile_gateway_terminal_binding_mismatch");
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
    || !isGatewayDispatchProvider(value.provider) || !value.workKey.startsWith(`${logical}:`)
    || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1))) fail("invalid_reason_translation_capacity_identity");
  return logical;
}
async function reasonTranslationFence(tx: ProductTransaction, keys: readonly string[], ownId: string): Promise<boolean> {
  const keyArray = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND ${liveStateSql(modelCapacityRequests.state)}
      AND ${modelCapacityRequests.logicalMemberKeys} && ${keyArray})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'reason-translate'
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
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
    if (!textGatewayRowMatches(row, dispatch, reasonTranslationMemberKeys(dispatch.binding.members)))
      fail("reason_translation_gateway_terminal_binding_mismatch");
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
    || !isGatewayDispatchProvider(value.provider) || !value.workKey.startsWith(`${logical}:`)
    || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1))) fail("invalid_product_translation_capacity_identity");
  return logical;
}
async function productTranslationFence(tx: ProductTransaction, keys: readonly string[], ownId: string): Promise<boolean> {
  const keyArray = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND ${liveStateSql(modelCapacityRequests.state)}
      AND ${modelCapacityRequests.logicalMemberKeys} && ${keyArray})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'product-translate'
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
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
    if (!textGatewayRowMatches(row, dispatch, productTranslationMemberKeys(dispatch.binding.members)))
      fail("product_translation_gateway_terminal_binding_mismatch");
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
    || !isGatewayDispatchProvider(value.provider) || !value.workKey.startsWith(`${logical}:`)
    || !/^[a-f0-9]{64}$/.test(value.workKey.slice(logical.length + 1))) fail("invalid_product_tagline_ko_capacity_identity");
  return logical;
}
async function productTaglineKoFence(tx: ProductTransaction, keys: readonly string[], ownId: string): Promise<boolean> {
  const keyArray = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND ${liveStateSql(modelCapacityRequests.state)}
      AND ${modelCapacityRequests.logicalMemberKeys} && ${keyArray})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'product-tagline-ko'
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
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
    if (!textGatewayRowMatches(row, dispatch, productTaglineKoMemberKeys(dispatch.binding.members)))
      fail("product_tagline_ko_gateway_terminal_binding_mismatch");
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
/** 세대의 마지막 단계가 gateway_not_started(0149, 요청 바이트 0)로 정산됐다 — 결과가 없고, 같은 단계는 고유 색인 때문에 이 세대에서 다시
 * 보낼 수 없다. 호출자는 이 세대를 실패 한 번으로 닫아(시도·재시도 시각) 다음 세대로 넘긴다. ask 2 면 first 는 그 부모(빈 줄)다. */
export type CrawlTaglineNotStartedContinuation = Readonly<{ generationHash: string;
  notStarted: Readonly<{ requestId: string; bindingHash: string; askOrdinal: 1 | 2 }>;
  first: (CrawlTaglineParent & Readonly<{ outcome: CrawlTaglineOutcome }>) | null }>;
/** `broken`: a settled row of this generation has no readable phase chain (forged, duplicated or re-ordered evidence). The caller skips
 * this one target as `ledger_mismatch` (2026-10-31, PR 3a-B) instead of guessing — the reader no longer throws, so one target's rows cannot
 * end the tick for the rest. Nothing is written. */
export type CrawlTaglineBrokenContinuation = Readonly<{ generationHash: string; broken: true }>;
const crawlTaglineLocks = new WeakMap<CrawlTaglineCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; input: CrawlTaglineInput; finished: boolean }>();
function fixedCrawlTaglineIdentity(value: ModelCapacityRequestIdentity, input: CrawlTaglineInput): string {
  const logical = crawlTaglineLogicalWorkKey(input);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "crawl-tagline" || !isGatewayDispatchProvider(value.provider)
    || value.model !== input.model || value.workKey !== `${logical}:${crawlTaglineInputHash(input)}`) fail("invalid_crawl_tagline_capacity_identity");
  return logical;
}
async function crawlTaglineFence(tx: ProductTransaction, input: CrawlTaglineInput, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND (
      (${liveStateSql(modelCapacityRequests.state)}
        AND ${modelCapacityRequests.logicalMemberKeys} && ARRAY[${crawlTaglineMemberKeys(input.member)[0]}]::text[])
      OR (${modelCapacityRequests.logicalWorkKey} = ${crawlTaglineLogicalWorkKey(input)}
        AND ${sentStateSql(modelCapacityRequests.state)})))
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'crawl-tagline'
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
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
/** 이 경로의 settled gateway_not_started 행(0149) — 증거가 이 행 자신의 dispatch handle·binding 과 같을 때만. 전송 0 이라 결과도 부모 자격도 없다. */
function storedCrawlTaglineNotStarted(row: RequestRow | undefined): CrawlTaglineModelDispatch | null {
  if (!row || row.state !== "settled" || !row.settledAt) return null;
  const parsed = gatewayNotStartedEvidenceSchema.safeParse(row.terminalEvidence);
  if (!parsed.success || parsed.data.dispatch.binding.kind !== "crawl_tagline_gateway") return null;
  const dispatch = parsed.data.dispatch as CrawlTaglineModelDispatch;
  return crawlTaglineRowMatches(row, dispatch) && row.terminalEvidenceHash === reviewHash(parsed.data)
    && isDeepStrictEqual(row.terminalEvidence, parsed.data) ? dispatch : null;
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
/** Stored outcomes are business data. This never issues an opaque proof or releases capacity.
 * A settled gateway_not_started phase (0149) has no outcome: it is reported as `notStarted` so the caller closes the generation with
 * one recorded failure instead of reading it as a broken chain (2026-10-31: such a row stopped crawl-tagline on every tick). */
export async function readCrawlTaglineContinuation(value: Pick<CrawlTaglineInput, "member" | "model">):
  Promise<CrawlTaglineContinuation | CrawlTaglineNotStartedContinuation | CrawlTaglineBrokenContinuation | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const snapshot = crawlTaglineInputSchema.parse({ member: value.member, model: value.model, askOrdinal: 1, parent: null });
  const generationHash = crawlTaglineGenerationHash(snapshot);
  const broken: CrawlTaglineBrokenContinuation = Object.freeze({ generationHash, broken: true });
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("share");
    if (!mutex) fail("model_capacity_control_missing");
    const rows = await tx.select().from(modelCapacityRequests).where(sql`${modelCapacityRequests.routeId}='crawl-tagline'
      AND ${modelCapacityRequests.state}='settled' AND ${modelCapacityRequests.dispatchBinding}->>'kind'='crawl_tagline_gateway'
      AND ${modelCapacityRequests.dispatchBinding}->>'generationHash'=${generationHash}`).orderBy(asc(modelCapacityRequests.queueOrdinal));
    if (!rows.length) return null;
    const unsent = rows.map(row => storedCrawlTaglineNotStarted(row)).filter(dispatch => dispatch !== null);
    const phases = rows.map(row => storedCrawlTaglineEvidence(row)).filter(phase => phase !== null);
    if (phases.length + unsent.length !== rows.length || [...phases.map(phase => phase.dispatch), ...unsent]
      .some(dispatch => dispatch.binding.generationHash !== generationHash)) return broken;
    const first = phases.filter(phase => phase.dispatch.binding.askOrdinal === 1), second = phases.filter(phase => phase.dispatch.binding.askOrdinal === 2);
    const data = (phase: typeof phases[number]) => Object.freeze({ requestId: phase.dispatch.requestId,
      bindingHash: phase.dispatch.bindingHash, responseHash: phase.responseHash, outcome: Object.freeze(structuredClone(phase.outcome)) });
    if (unsent.length) {
      // 한 세대에 보내지 않은 단계는 하나뿐이고(단계 고유 색인) 그 뒤 단계는 없다. ask 2 면 부모는 이 세대의 빈 줄 ask 1 이다.
      const [skip] = unsent, ordinal = skip.binding.askOrdinal;
      if (unsent.length > 1 || second.length || (ordinal === 1 ? first.length !== 0
        : first.length !== 1 || !crawlTaglineParentMatches(first[0], skip.binding))) return broken;
      return Object.freeze({ generationHash, first: first[0] ? data(first[0]) : null,
        notStarted: Object.freeze({ requestId: skip.requestId, bindingHash: skip.bindingHash, askOrdinal: ordinal }) });
    }
    if (first.length !== 1 || second.length > 1 || second.length && !crawlTaglineParentMatches(first[0], second[0].dispatch.binding)) return broken;
    return Object.freeze({ generationHash, first: data(first[0]), second: second[0] ? data(second[0]) : null });
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
/** `broken`: a row of this generation has no readable execution — the caller skips this target (ledger_mismatch) rather than guess. */
export type SearchVerifyContinuation = Readonly<{ generationHash: string; nowMs: number; unresolved: boolean; broken: boolean; nextExecution: number;
  latest: Readonly<{ execution: number; deadlineAt: number; parent: SearchVerifyParent; next: SearchVerifyStep | "done" | "stop";
    outcomes: readonly Readonly<{ step: SearchVerifyStep; outcome: SearchVerifyOutcome }>[] }> | null }>;
const searchVerifyLocks = new WeakMap<SearchVerifyCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; input: SearchVerifyInput; parentDeadlineAt: number | null; finished: boolean }>();
function fixedSearchVerifyIdentity(value: ModelCapacityRequestIdentity, input: SearchVerifyInput): string {
  const logical = searchVerifyLogicalWorkKey(input);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "product-search-verify" || !isGatewayDispatchProvider(value.provider)
    || value.model !== input.model || value.workKey !== `${logical}:${searchVerifyInputHash(input)}`) fail("invalid_search_verify_capacity_identity");
  return logical;
}
/** Fixed product target fence from the first waiting INSERT; an exact step already dispatched or settled never repeats. */
async function searchVerifyFence(tx: ProductTransaction, keys: readonly string[], logicalKey: string, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND (
      (${liveStateSql(modelCapacityRequests.state)}
        AND ${modelCapacityRequests.logicalMemberKeys} && ARRAY[${keys[0]}]::text[])
      OR (${modelCapacityRequests.logicalWorkKey} = ${logicalKey}
        AND ${sentStateSql(modelCapacityRequests.state)})))
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'product-search-verify'
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
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
type SearchVerifyEntry = { row: RequestRow; binding: SearchVerifyDispatchBinding };
/** `broken`: this execution's rows do not form one exact chain — it is closed (never resumed, never written) and the next
 * execution starts after it. `notStarted`: its next step settled as gateway_not_started (0149, zero request bytes) — no outcome,
 * and that exact step can never be sent again in this execution (unique step index), so the execution is closed too. */
type SearchVerifyChain = { chain: StoredSearchVerify[]; next: SearchVerifyStep | "done" | "stop"; parent: SearchVerifyParent | null;
  unresolved: SearchVerifyEntry[]; notStarted: SearchVerifyEntry[]; broken: boolean };
/** A settled gateway_not_started row of this route whose evidence is the row's own dispatch handle and binding. */
function storedSearchVerifyNotStarted(row: RequestRow, binding: SearchVerifyDispatchBinding): boolean {
  if (row.state !== "settled" || !row.settledAt) return false;
  const parsed = gatewayNotStartedEvidenceSchema.safeParse(row.terminalEvidence);
  return parsed.success && parsed.data.dispatch.binding.kind === "search_verify_gateway"
    && isDeepStrictEqual(parsed.data.dispatch.binding, binding) && searchVerifyRowMatches(row, parsed.data.dispatch as SearchVerifyModelDispatch)
    && row.terminalEvidenceHash === reviewHash(parsed.data) && isDeepStrictEqual(row.terminalEvidence, parsed.data);
}
/** Every execution of a generation is checked on its own: one exact parent chain of settled rows plus at most its unresolved or
 * not-started tail. A broken execution is isolated (closed) instead of failing the whole generation; #754 principle, 2026-10-31 —
 * one not_started row used to fail every later tick of product-search-verify with search_verify_continuation_mismatch.
 * `broken` on the generation means a row whose execution cannot be read at all: callers skip this target. */
async function searchVerifyGeneration(tx: ProductTransaction, member: SearchVerifyMember, model: string, lock: boolean) {
  const generationHash = searchVerifyGenerationHash({ member, model });
  const query = tx.select().from(modelCapacityRequests).where(sql`${modelCapacityRequests.routeId}='product-search-verify'
    AND ${sentStateSql(modelCapacityRequests.state)} AND ${modelCapacityRequests.dispatchBinding}->>'kind'='search_verify_gateway'
    AND ${modelCapacityRequests.dispatchBinding}->>'generationHash'=${generationHash}`).orderBy(asc(modelCapacityRequests.queueOrdinal));
  const rows = lock ? await query.for("share") : await query;
  const entries: SearchVerifyEntry[] = [], brokenExecutions = new Set<number>();
  let broken = false;
  for (const row of rows) {
    const binding = searchVerifyDispatchBindingSchema.safeParse(row.dispatchBinding);
    if (binding.success && binding.data.generationHash === generationHash && row.logicalWorkKey === binding.data.logicalWorkKey
      && row.workKey === `${binding.data.logicalWorkKey}:${binding.data.inputHash}` && row.dispatchBindingHash === searchVerifyDispatchBindingHash(binding.data)) {
      entries.push({ row, binding: binding.data }); continue;
    }
    const raw = (row.dispatchBinding as { execution?: unknown } | null)?.execution;
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) brokenExecutions.add(raw); else broken = true;
  }
  const executions = new Map<number, SearchVerifyChain>();
  const closed = (own: SearchVerifyEntry[]): SearchVerifyChain => ({ chain: [], next: "stop", parent: null, unresolved: own.filter(entry => entry.row.state !== "settled"),
    notStarted: [], broken: true });
  for (const execution of [...new Set([...entries.map(entry => entry.binding.execution), ...brokenExecutions])].sort((a, b) => a - b)) {
    const own = entries.filter(entry => entry.binding.execution === execution);
    if (brokenExecutions.has(execution)) { executions.set(execution, closed(own)); continue; }
    const notStarted = own.filter(entry => storedSearchVerifyNotStarted(entry.row, entry.binding));
    const settled = own.filter(entry => entry.row.state === "settled" && !notStarted.includes(entry)).map(entry => storedSearchVerifyEvidence(entry.row));
    if (settled.some(phase => !phase)) { executions.set(execution, closed(own)); continue; }
    const chain: StoredSearchVerify[] = [], pending = [...settled as StoredSearchVerify[]];
    let next: SearchVerifyStep | "done" | "stop" = firstSearchVerifyStep(member.mode), parent: SearchVerifyParent | null = null, exact = true;
    while (pending.length) {
      const index = pending.findIndex(phase => isDeepStrictEqual(phase.dispatch.binding.step, next)
        && isDeepStrictEqual(phase.dispatch.binding.parent, parent));
      if (typeof next === "string" || index < 0) { exact = false; break; }
      const [phase] = pending.splice(index, 1), binding = phase.dispatch.binding;
      if (chain.length && binding.deadlineAt !== chain[0].dispatch.binding.deadlineAt) { exact = false; break; }
      chain.push(phase); parent = { requestId: phase.dispatch.requestId, bindingHash: phase.dispatch.bindingHash, responseHash: phase.responseHash };
      next = nextSearchVerifyStep(binding.member, binding.step, phase.outcome);
    }
    executions.set(execution, exact ? { chain, next, parent, unresolved: own.filter(entry => entry.row.state !== "settled"), notStarted, broken: false }
      : closed(own));
  }
  return { generationHash, executions, broken };
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
      ${inFlightStateSql(modelCapacityRequests.state)} AND (${modelCapacityRequests.logicalMemberKeys} && ARRAY[${key}]::text[]
        OR ${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'product-search-verify')`).limit(1);
    const { generationHash, executions, broken } = await searchVerifyGeneration(tx, member, value.model, false);
    const nowMs = Math.floor(Number(clock.now)), ordinals = [...executions.keys()], last = ordinals.length ? executions.get(ordinals[ordinals.length - 1])! : null;
    // A closed execution (broken chain or a not-started next step) is never resumed: the next tick starts a new execution after it.
    const latest: SearchVerifyContinuation["latest"] = last && !last.broken && !last.notStarted.length && last.chain.length && last.parent ? Object.freeze({ execution: ordinals[ordinals.length - 1],
      deadlineAt: last.chain[0].dispatch.binding.deadlineAt, parent: Object.freeze(last.parent),
      next: typeof last.next === "string" ? last.next : Object.freeze(structuredClone(last.next)),
      outcomes: Object.freeze(last.chain.map(phase => Object.freeze({ step: Object.freeze(structuredClone(phase.dispatch.binding.step)),
        outcome: Object.freeze(structuredClone(phase.outcome)) }))) }) : null;
    return Object.freeze({ generationHash, nowMs, unresolved: !!active, broken, latest,
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
  const generation = await searchVerifyGeneration(tx, member, value.model, true);
  const ordinals = [...generation.executions.keys()], found = generation.executions.get(value.execution);
  if (generation.broken || !found || found.broken || ordinals[ordinals.length - 1] !== value.execution) return null;
  // A not-started tail is the exact next step that provably never left: its result is unknown to the business, like an unresolved call.
  const tails = [...found.unresolved, ...found.notStarted];
  if (tails.length) {
    const [tail] = tails;
    return tails.length === 1 && typeof found.next !== "string" && isDeepStrictEqual(tail.binding.step, found.next)
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
/** `broken`: the settled rows for this exact snapshot cannot be read as one outcome (duplicate or forged evidence). The caller skips this
 * one target as `ledger_mismatch` (2026-10-31, PR 3a-B) — the reader no longer throws, so one query's rows cannot fail the surrounding TX. */
export type WebsearchQueryContinuation = { kind: "none" } | { kind: "blocked" } | { kind: "broken" }
  | Readonly<{ kind: "settled"; requestId: string; bindingHash: string; responseHash: string; model: string; outcome: WebsearchQueryOutcome }>;
const websearchQueryLocks = new WeakMap<WebsearchQueryCapacityDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; input: WebsearchQueryInput; finished: boolean }>();
function fixedWebsearchQueryIdentity(value: ModelCapacityRequestIdentity, input: WebsearchQueryInput): string {
  const logical = websearchQueryLogicalWorkKey(input.member);
  if (value.class !== "background" || value.pool !== "text" || value.routeId !== "search-query-translate" || !isGatewayDispatchProvider(value.provider)
    || value.model !== input.model || value.workKey !== `${logical}:${websearchQueryInputHash(input)}`) fail("invalid_websearch_query_capacity_identity");
  return logical;
}
/** Another owner's active member, an unconsumed settled call for the same cache snapshot, or an unbound same-route call blocks. */
async function websearchQueryFence(tx: ProductTransaction, input: WebsearchQueryInput, ownId: string): Promise<boolean> {
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND (
      (${liveStateSql(modelCapacityRequests.state)}
        AND ${modelCapacityRequests.logicalMemberKeys} && ARRAY[${websearchQueryMemberKeys(input.member)[0]}]::text[])
      OR (${modelCapacityRequests.logicalWorkKey} = ${websearchQueryLogicalWorkKey(input.member)} AND ${modelCapacityRequests.state} = 'settled'
        AND ${modelCapacityRequests.dispatchBinding}->>'kind' = 'websearch_query_gateway'
        AND ${modelCapacityRequests.dispatchBinding}->'member'->'cache' = ${JSON.stringify(input.member.cache)}::text::jsonb)))
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'search-query-translate'
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
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
    (${modelCapacityRequests.logicalMemberKeys} && ARRAY[${memberKey}]::text[] AND ${inFlightStateSql(modelCapacityRequests.state)})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'search-query-translate'
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
  if (active) return { kind: "blocked" };
  const rows = await tx.select().from(modelCapacityRequests).where(sql`${modelCapacityRequests.routeId}='search-query-translate'
    AND ${modelCapacityRequests.state}='settled' AND ${modelCapacityRequests.logicalWorkKey}=${websearchQueryLogicalWorkKey(input.member)}
    AND ${modelCapacityRequests.dispatchBinding}->>'kind'='websearch_query_gateway'
    AND ${modelCapacityRequests.dispatchBinding}->'member'->'cache'=${JSON.stringify(input.member.cache)}::text::jsonb`)
    .orderBy(asc(modelCapacityRequests.queueOrdinal));
  if (!rows.length) return { kind: "none" };
  const stored = rows.map(row => storedWebsearchQueryEvidence(row));
  if (rows.length !== 1 || !stored[0] || stored[0].dispatch.binding.member.cacheKey !== input.member.cacheKey
    || !isDeepStrictEqual(stored[0].dispatch.binding.member.cache, input.member.cache)) return { kind: "broken" };
  const evidence = stored[0]!;
  return Object.freeze({ kind: "settled" as const, requestId: evidence.dispatch.requestId, bindingHash: evidence.dispatch.bindingHash,
    responseHash: evidence.responseHash, model: evidence.dispatch.binding.model, outcome: Object.freeze(structuredClone(evidence.outcome)) });
}

import { cliDispatchBindingSchema, cliDispatchBindingHash, cliModelDispatchSchema, cliModelTerminalEvidenceSchema,
  introCheckInputSchema, introCheckMemberKeys, introCheckLogicalWorkKey, grokSessionLogicalWorkKey,
  publicationClassifyInputSchema, publicationClassifyMemberKeys, publicationClassifyLogicalWorkKey,
  type CliDispatchBinding, type CliModelDispatch, type IntroCheckMember, type PublicationClassifyMember } from "./capacity";
import { cliProcessTerminalEvidenceSchema } from "./cli-serving-contract";
import type { CliProcessTerminal } from "./cli-process-runner";
/** CLI 호출이 묶이는 고정 대상. AI1·AI2 는 gateway 와 같은 논리 키를, 감사·소개 검수·Grok 세션은 background/reviewer 키를 쓴다. */
export type CliTarget = Readonly<{ kind: "ai1"; candidateId: number }> | Readonly<{ kind: "ai2"; candidateId: number; vote: number }>
  | Readonly<{ kind: "audit"; itemId: number }> | Readonly<{ kind: "intro"; members: readonly IntroCheckMember[] }>
  | Readonly<{ kind: "grok-session"; instanceId: string }> | Readonly<{ kind: "publication-classify"; members: readonly PublicationClassifyMember[] }>;
type FixedCli = Readonly<{ target: CliTarget; logical: string; memberKeys: string[] | null; kinds: readonly CliDispatchBinding["kind"][] }>;
const CLI_TARGET_KEYS = { ai1: ["candidateId"], ai2: ["candidateId", "vote"], audit: ["itemId"], intro: ["members"], "grok-session": ["instanceId"], "publication-classify": ["members"] } as const;
const CLI_FIXED = {
  ai1: { class: "first", routeId: "crawl-agent-review", providers: ["claude-cli", "grok-cli", "opencode-cli"], kinds: ["ai1_legacy_cli", "ai1_item_cli"] },
  ai2: { class: "second", routeId: "second-review", providers: ["claude-cli", "grok-cli", "opencode-cli"], kinds: ["ai2_item_cli"] },
  audit: { class: "background", routeId: "product-audit", providers: ["claude-cli", "opencode-cli"], kinds: ["product_audit_cli"] },
  intro: { class: "background", routeId: "product-intro-check", providers: ["claude-cli", "opencode-cli"], kinds: ["intro_check_cli"] },
  "publication-classify": { class: "background", routeId: "crawl-publish-classify", providers: ["claude-cli", "codex-cli"], kinds: ["publication_classify_cli"] },
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
  } else if (raw.kind === "publication-classify") {
    const members = publicationClassifyInputSchema.shape.members.safeParse(raw.members);
    if (!members.success) return fail("invalid_cli_capacity_identity");
    target = Object.freeze({ kind: "publication-classify", members: Object.freeze(members.data) });
    memberKeys = publicationClassifyMemberKeys(members.data); logical = publicationClassifyLogicalWorkKey(members.data);
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
      AND ${liveStateSql(modelCapacityRequests.state)})
    OR (${logicalKey} ~ '^bg:audit:[1-9][0-9]*$'
      AND ${modelCapacityRequests.logicalWorkKey}='direct:audit:' || split_part(${logicalKey},':',3) || ':audit'
      AND ${liveStateSql(modelCapacityRequests.state)})
    OR (${modelCapacityRequests.logicalWorkKey} IS NULL AND ${modelCapacityRequests.routeId} = ${routeId}
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
  return !!blocked;
}
/** Any overlapping intro member, or an unbound intro-check call, blocks the batch. */
async function introCheckFence(tx: ProductTransaction, keys: readonly string[], ownId: string, routeId = "product-intro-check"): Promise<boolean> {
  const keyArray = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
    (${modelCapacityRequests.requestId} <> ${ownId} AND ${liveStateSql(modelCapacityRequests.state)}
      AND ${modelCapacityRequests.logicalMemberKeys} && ${keyArray})
    OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = ${routeId}
      AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
  return !!blocked;
}
function cliFence(tx: ProductTransaction, fixed: FixedCli, ownId: string): Promise<boolean> {
  return fixed.target.kind === "ai1" ? ai1Fence(tx, fixed.logical, ownId) : fixed.target.kind === "ai2" ? ai2Fence(tx, fixed.logical, ownId)
    : fixed.target.kind === "intro" || fixed.target.kind === "publication-classify"
      ? introCheckFence(tx, fixed.memberKeys!, ownId, CLI_FIXED[fixed.target.kind].routeId) : cliKeyFence(tx, fixed.logical, CLI_FIXED[fixed.target.kind].routeId, ownId);
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
    case "publication_classify_cli": return target.kind === "publication-classify"
      && isDeepStrictEqual(publicationClassifyInputSchema.shape.members.parse(binding.members), target.members)
      && ownerFits(binding.publisherRole) && identity.workKey === `${binding.logicalWorkKey}:${binding.inputHash}`;
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
  ai2_item_cli: "second", product_audit_cli: "background", intro_check_cli: "background", grok_session_cli: "background", publication_classify_cli: "background" };
/** The historical dispatch rebuilt from the actual locked row; null unless every row column agrees with its immutable binding. */
function cliRowDispatch(row: RequestRow | undefined): CliModelDispatch | null {
  if (!row?.dispatchedAt || !row.token) return null;
  const parsed = cliModelDispatchSchema.safeParse({ requestId: row.requestId, owner: { instanceId: row.ownerInstanceId, bootId: row.ownerBootId },
    token: row.token, epoch: row.epoch, revision: row.revision, policyHash: row.policyHash, binding: row.dispatchBinding, bindingHash: row.dispatchBindingHash });
  if (!parsed.success) return null;
  const dispatch = parsed.data, binding = dispatch.binding;
  const workKey = binding.kind === "ai1_legacy_cli" ? row.workKey : binding.kind === "ai1_item_cli" || binding.kind === "ai2_item_cli"
    ? `${binding.logicalWorkKey}:${binding.item.bindingHash}` : `${binding.logicalWorkKey}:${binding.inputHash}`;
  const memberKeys = binding.kind === "intro_check_cli" ? introCheckMemberKeys(binding.members)
    : binding.kind === "publication_classify_cli" ? publicationClassifyMemberKeys(binding.members) : null;
  return row.logicalWorkKey === binding.logicalWorkKey && isDeepStrictEqual(row.logicalMemberKeys ?? null, memberKeys)
    && row.routeId === binding.routeId && row.provider === binding.provider && row.model === binding.model
    && row.class === CLI_KIND_CLASS[binding.kind] && row.pool === "reviewer" && row.workKey === workKey
    && isDeepStrictEqual(row.dispatchBinding, binding) ? dispatch : null;
}
/** Readback is observation only: saved terminal JSON never grants the runner's native reconciliation capability. */
export async function readCliModelDispatchRecord(requestId: string) {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const [row] = await onPrimary(() => db.select().from(modelCapacityRequests)
    .where(eq(modelCapacityRequests.requestId, requestId)).limit(1));
  if (!row) return null;
  const dispatch = cliRowDispatch(row);
  return dispatch ? { state: row.state, dispatch, terminalEvidence: row.terminalEvidence, terminalEvidenceHash: row.terminalEvidenceHash } : null;
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
import { modelDispatchReleaseEvidenceSchema, gatewayLocalEndFactSchema, type ModelCapacityOwner, type ModelDispatchReleaseEvidence } from "./capacity";
/** owner 가 남긴 게이트웨이 로컬 종료 사실(dispatch_local_ended). endedAt 은 그 event 의 DB clock(기록 시각 ≥ 실제 로컬 종료)이다. */
export type ModelDispatchLocalEnd = Readonly<{ endedAt: string; owner: ModelCapacityOwner; bindingHash: string | null; dispatches: number; terminals: number }>;
/** 회수 판정에 넘기는 잠긴 행의 사실. 시각은 이 TX 의 DB clock(UTC, ms)이다. dispatchAt 은 dispatched_at 또는 첫 dispatch_started event.
 * localEnd 는 indeterminate 행에 남은 owner 의 로컬 종료 사실(없으면 null). */
export type ModelDispatchReleaseCandidate = Readonly<{ requestId: string; owner: ModelCapacityOwner; state: "dispatched" | "indeterminate";
  providerBudgetId: string; dispatchAt: string | null; bindingHash: string | null; now: string; oldGeneration: boolean; localEnd?: ModelDispatchLocalEnd | null }>;
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
  // 행 lock 뒤에 읽는다. 사실 event 는 append-only·요청당 하나이고 같은 행 lock 아래에서만 쓰인다.
  const [fact] = row.state === "indeterminate" ? await tx.execute<{ evidence: unknown; at: string }>(sql`SELECT evidence, ${iso(sql`created_at`)} AS at
    FROM model_capacity_events WHERE request_id = ${row.requestId}::uuid AND kind = 'dispatch_local_ended'`) : [];
  const parsedFact = fact ? gatewayLocalEndFactSchema.parse(fact.evidence) : null;
  const localEnd = fact && parsedFact ? Object.freeze({ endedAt: fact.at, owner: Object.freeze({ ...parsedFact.owner }), bindingHash: parsedFact.bindingHash,
    dispatches: parsedFact.dispatches, terminals: parsedFact.terminals }) : null;
  const verdict = await verify(Object.freeze({ requestId: row.requestId, owner, state: row.state, providerBudgetId: row.providerBudgetId,
    dispatchAt: clock.dispatch_at, bindingHash: row.dispatchBindingHash, now: clock.now,
    oldGeneration: row.epoch !== state.epoch || row.revision !== state.revision || row.policyHash !== state.policyHash, localEnd }));
  if ("blocked" in verdict) return { kind: "blocked", reason: verdict.blocked };
  const evidence = modelDispatchReleaseEvidenceSchema.parse(verdict);
  if (evidence.kind === "cli_executor_indeterminate_boundary_exit" || evidence.kind === "cli_executor_indeterminate_removed_boundary_exit") {
    const [current] = await tx.execute<{ row_hash: string }>(sql`SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') row_hash
      FROM model_capacity_requests r WHERE request_id=${row.requestId}::uuid`);
    if (current.row_hash !== evidence.plan.request.rowHash || row.terminalEvidenceHash !== null)
      fail("model_capacity_cli_executor_indeterminate_row_changed");
  }
  if (evidence.kind === "cli_executor_boundary_exit" || evidence.kind === "cli_executor_removed_boundary_exit"
    || evidence.kind === "cli_executor_indeterminate_boundary_exit" || evidence.kind === "cli_executor_indeterminate_removed_boundary_exit") {
    const p = evidence.plan, q = p.request;
    const [exact] = await tx.execute<{ at: string; lineage_id: string; writer_epoch: string; fence_state: string }>(sql`SELECT
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      f.lineage_id::text, f.writer_epoch::text, f.state AS fence_state FROM model_capacity_control c CROSS JOIN dr_writer_fence f WHERE c.id=1 AND f.id=1`);
    const b = row.dispatchBinding;
    if (state.fenced || state.mode !== "draining" || state.epoch !== p.control.epoch || state.revision !== p.control.revision
      || state.policyHash !== p.control.policyHash || exact.at !== p.control.updatedAt || exact.fence_state !== "active"
      || exact.lineage_id !== p.writer.lineageId || Number(exact.writer_epoch) !== p.writer.writerEpoch
      || row.state !== q.state || row.terminalEvidence !== null || row.settledAt !== null || row.token === null
      || createHash("sha256").update(row.token).digest("hex") !== q.tokenHash
      || row.epoch !== q.epoch || row.revision !== q.revision || row.policyHash !== q.policyHash
      || row.providerBudgetId !== q.providerBudgetId || row.groupId !== q.groupId || row.routeId !== q.routeId
      || row.provider !== q.provider || row.model !== q.model || row.logicalWorkKey !== q.logicalWorkKey
      || !b || b.kind !== "publication_classify_cli" || cliDispatchBindingHash(b) !== row.dispatchBindingHash || b.inputHash !== q.inputHash || b.payloadHash !== q.payloadHash
      || b.totalTokenBound !== q.totalTokenBound || b.chargedTokens !== q.chargedTokens || !isDeepStrictEqual(b.transport, q.transport))
      fail("model_capacity_cli_executor_boundary_conflict");
  }
  if (evidence.kind === "replaced_provider_boundary_exit") {
    const [facts] = await tx.execute<{ valid: boolean }>(sql`SELECT nmv_replaced_provider_records_valid(${JSON.stringify(evidence)}::text::jsonb,to_jsonb(r)) valid
      FROM model_capacity_requests r WHERE request_id=${row.requestId}::uuid`);
    if (facts?.valid !== true) fail("replaced_provider_boundary_records_mismatch");
  }
  if (evidence.kind === "replaced_path_boundary_exit") {
    const [facts] = await tx.execute<{ valid: boolean }>(sql`SELECT nmv_replaced_path_records_valid(${JSON.stringify(evidence)}::text::jsonb,to_jsonb(r)) valid
      FROM model_capacity_requests r WHERE request_id=${row.requestId}::uuid`);
    if (facts?.valid !== true) fail("replaced_path_boundary_records_mismatch");
  }
  if (evidence.kind === "provider_boundary_exit") {
    const expected = evidence.plan.request, expectedControl = evidence.plan.control;
    const [exactControl] = await tx.execute<{ at: string }>(sql`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM model_capacity_control WHERE id=1`);
    if (state.fenced || state.mode !== "draining" || state.epoch !== expectedControl.epoch || state.revision !== expectedControl.revision
      || state.policyHash !== expectedControl.policyHash || exactControl.at !== expectedControl.updatedAt || row.state !== "indeterminate" || row.token === null
      || createHash("sha256").update(row.token).digest("hex") !== expected.tokenHash
      || row.epoch !== expected.epoch || row.revision !== expected.revision || row.policyHash !== expected.policyHash
      || row.providerBudgetId !== expected.providerBudgetId || row.groupId !== expected.groupId
      || !row.dispatchBinding || !("servingContractHash" in row.dispatchBinding)
      || row.dispatchBinding.servingContractHash !== expected.servingContractHash) fail("model_capacity_provider_boundary_conflict");
    if (evidence.plan.version === 3) {
      const [facts] = await tx.execute<{valid:boolean}>(sql`SELECT nmv_boot_records_valid(${JSON.stringify(evidence.plan)}::text::jsonb,to_jsonb(r)) valid
        FROM model_capacity_requests r WHERE request_id=${row.requestId}::uuid`);
      if (facts?.valid !== true) fail("provider_boot_boundary_records_mismatch");
    }
    if (evidence.plan.version === 2 || evidence.plan.version === 4) {
      const { assertHistoricalBoundaryOwner } = await import("@/lib/operations/dr/provider-boundary-owner");
      await assertHistoricalBoundaryOwner(tx, evidence.plan, { owner, dispatchAt: clock.dispatch_at, bindingHash: row.dispatchBindingHash, localEnd });
    }
    if (evidence.plan.version === 4) {
      const [facts] = await tx.execute<{ valid: boolean }>(sql`SELECT nmv_boot_historical_records_valid(${JSON.stringify(evidence.plan)}::text::jsonb,to_jsonb(r)) valid
        FROM model_capacity_requests r WHERE request_id=${row.requestId}::uuid`);
      if (facts?.valid !== true) fail("provider_boot_historical_records_mismatch");
    }
  }
  if (evidence.requestId !== row.requestId || evidence.owner.instanceId !== owner.instanceId || evidence.owner.bootId !== owner.bootId
    || evidence.fromState !== row.state || evidence.dispatchAt !== clock.dispatch_at || evidence.bindingHash !== row.dispatchBindingHash
    || evidence.evaluatedAt !== clock.now || evidence.kind === "dr_call_drain" && (evidence.scope !== `model:${row.providerBudgetId}`
      || row.epoch === state.epoch && row.revision === state.revision && row.policyHash === state.policyHash)) fail("model_capacity_release_evidence_mismatch");
  // local_call_ended 는 이 행에 남은 같은 owner·binding 의 로컬 종료 사실과 그 기록 시각에만 묶인다.
  if (evidence.kind === "local_call_ended" && (row.state !== "indeterminate" || !localEnd || evidence.endedAt !== localEnd.endedAt
    || localEnd.owner.instanceId !== owner.instanceId || localEnd.owner.bootId !== owner.bootId || localEnd.bindingHash !== row.dispatchBindingHash
    || evidence.localEnd.dispatches !== localEnd.dispatches || evidence.localEnd.terminals !== localEnd.terminals)) fail("model_capacity_release_evidence_mismatch");
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", terminalEvidence: evidence,
    terminalEvidenceHash: evidence.kind === "replaced_provider_boundary_exit" || evidence.kind === "replaced_path_boundary_exit" || evidence.kind === "provider_boundary_exit" || evidence.kind === "cli_executor_boundary_exit" || evidence.kind === "cli_executor_removed_boundary_exit" || evidence.kind === "cli_executor_indeterminate_boundary_exit" || evidence.kind === "cli_executor_indeterminate_removed_boundary_exit" ? providerBoundaryCanonicalHash(evidence) : reviewHash(evidence),
    updatedAt: sql`clock_timestamp()` }).where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, row.state))).returning();
  if (!changed) fail("model_capacity_release_state_changed");
  await event(tx, changed, "dispatch_released", row.state, "withdrawn", null, evidence);
  return { kind: "released", evidence };
}

import type { ModelCapacityMode } from "./capacity";
import { MODEL_CAPACITY_PREDECESSORS_MAX, MODEL_CAPACITY_ROUTES_MAX, modelCapacityPolicyAdditive, modelCapacityPredecessorChain, modelCapacityRouteSchema,
  type ModelCapacityPredecessor, type ModelCapacityRoute } from "./capacity";
/**
 * 운영자 control 쓰기(PR06d). caller TX 가 fence 다음 첫 lock 으로 부른다. 장부 행은 건드리지 않는다 — dispatched/indeterminate 는 그대로 점유한다.
 * 정책은 open 이 아닐 때만 바꾸고 revision 을 올린다(옛 대기는 다음 poll 에서 policy_changed 로 거둬진다).
 * 앞 판 사슬(`compatiblePredecessors`, PR 3b-B)은 정책 문서를 싣지 않으므로 여기서 증명한다: 모든 칸이 지금 정책의 사슬 또는 지금 세대여야 하고,
 * 새 정책이 지금 정책의 덧붙이기만이어야 한다(modelCapacityPolicyAdditive). 아니면 `model_capacity_predecessor_unproven`.
 */
export async function setModelCapacityPolicy(tx: ProductTransaction, value: unknown) {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const state = await control(tx);
  if (state.mode === "open") fail("model_capacity_transition_invalid");
  const policy = parseModelCapacityPolicy(value);
  if (policy.compatiblePredecessors) {
    const vouched = state.policy && state.policyHash !== null
      ? [...modelCapacityPredecessorChain(state.policy), { epoch: state.epoch, revision: state.revision, policyHash: state.policyHash }] : [];
    if (!state.policy || !modelCapacityPolicyAdditive(state.policy, policy) || policy.compatiblePredecessors.some(entry => !vouched.some(known =>
      known.epoch === entry.epoch && known.revision === entry.revision && known.policyHash === entry.policyHash))) fail("model_capacity_predecessor_unproven");
  }
  const [row] = await tx.update(modelCapacityControl).set({ policy, policyHash: modelCapacityPolicyHash(policy),
    revision: sql`${modelCapacityControl.revision} + 1`, cursor: 0, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityControl.id, 1), sql`${modelCapacityControl.revision} < 9007199254740991`)).returning();
  if (!row) fail("model_capacity_revision_exhausted");
  return row;
}
/** mode 는 draining 을 거쳐서만 오간다(disabled ⇄ draining ⇄ open). disabled 밖은 정책이 있어야 한다. */
export async function setModelCapacityMode(tx: ProductTransaction, mode: ModelCapacityMode) {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const state = await control(tx);
  if ((state.mode === "draining") === (mode === "draining")) fail("model_capacity_transition_invalid");
  if (mode !== "disabled" && !state.policy) fail("model_capacity_policy_missing");
  const [row] = await tx.update(modelCapacityControl).set({ mode, updatedAt: sql`clock_timestamp()` })
    .where(eq(modelCapacityControl.id, 1)).returning();
  return row;
}

/**
 * 사슬 칸 중 장부에 그 세대의 살아 있는 행(waiting·reserved·dispatched)이 남은 것만, 같은 순서로(PR 3b-B). epoch 가 지금과 다른 칸은 무엇도 인증하지
 * 못하므로 뺀다. 같은 세대가 두 번 들어오면 한 번만 남긴다. 호출자가 control FOR UPDATE 를 쥐고 있다.
 */
async function liveCapacityPredecessors(tx: ProductTransaction, epoch: number, entries: readonly ModelCapacityPredecessor[]): Promise<ModelCapacityPredecessor[]> {
  const live = await tx.execute<{ epoch: string | number; revision: string | number; policy_hash: string }>(sql`SELECT DISTINCT epoch, revision, policy_hash
    FROM model_capacity_requests WHERE ${liveStateSql(modelCapacityRequests.state)}`);
  const kept: ModelCapacityPredecessor[] = [];
  for (const entry of entries) {
    if (entry.epoch !== epoch || kept.some(other => other.epoch === entry.epoch && other.revision === entry.revision)) continue;
    if (live.some(row => Number(row.epoch) === entry.epoch && Number(row.revision) === entry.revision && row.policy_hash === entry.policyHash))
      kept.push({ epoch: entry.epoch, revision: entry.revision, policyHash: entry.policyHash });
  }
  return kept;
}

/** 덧붙일 정책 route(5칸 전부). */
export type NewModelCapacityRoute = ModelCapacityRoute;
const routeKey = (route: Pick<ModelCapacityRoute, "routeId" | "provider" | "model">) => JSON.stringify([route.routeId, route.provider, route.model]);
const sameRoute = (a: ModelCapacityRoute, b: ModelCapacityRoute) => routeKey(a) === routeKey(b)
  && a.providerBudgetId === b.providerBudgetId && a.groupId === b.groupId;

/**
 * 정책에 route 를 **덧붙이기만** 한다(PR 3b-A, 배정 표 저장). DRAIN 없이 mode 를 그대로 두고 revision 을 올린다 — 호출자의 TX 안에서
 * DR fence(SHARE) → control FOR UPDATE(입장 TX 와 같은 잠금 순서). 옛 route 는 지우지도 순서를 바꾸지도 않는다.
 * - (routeId, provider, model, providerBudgetId, groupId) 다섯 칸이 모두 같은 route 가 이미 있으면 건너뛴다. 덧붙일 것이 없으면 아무것도 쓰지 않고
 *   지금 revision 을 돌려준다(같은 저장을 다시 해도 revision 이 그대로다).
 * - 같은 (routeId, provider, model) 이 다른 예산·장비로 있으면 `model_capacity_route_conflict` — 옛 route 를 바꾸는 것은 정책 개정(DRAIN)이다.
 * - 합이 MODEL_CAPACITY_ROUTES_MAX 를 넘으면 `model_capacity_routes_cap`.
 * - 잡힌 행(reserved·dispatched, indeterminate 는 점유가 아니다)은 앞 판 사슬(`compatiblePredecessors`, PR 3b-B)로 살린다 —
 *   compatibleModelCapacityGeneration 이 그 행의 (epoch, revision, policy_hash) 를 사슬 칸과 견준다. 덧붙일 때마다:
 *   지금 사슬(옛 단일 `compatiblePredecessor` 는 그 문서 hash 의 한 칸으로 읽는다) + 지금 세대 → 장부에 그 세대의 waiting·reserved·dispatched 행이
 *   하나도 없거나 epoch 가 다른 칸은 뺀다 → 남은 칸이 MODEL_CAPACITY_PREDECESSORS_MAX 를 넘으면 `model_capacity_append_chain_full`
 *   (아무것도 바꾸지 않는다; 옛 세대 행이 끝난 뒤 다시 저장한다). 비면 사슬 칸을 쓰지 않는다(옛 parser 도 읽는 정책).
 *   지금 세대의 hash 는 control 을 읽을 때 문서와 대조됐다(parsedControl). 장부 확인과 쓰기가 같은 control FOR UPDATE 아래라 사이에 새 행이 생기지 않는다.
 * 대기 행은 다음 poll 에서 여느 정책 변경처럼 policy_changed 로 거둬지고, 옛 판의 reserved 행은 dispatch 에서 ownership_lost 다(점유는 인증된다).
 * 사슬 칸이 있는 정책은 옛 parser 가 읽지 못한다 — 모든 용량 소비자가 이 판을 돈 뒤에만 배정을 저장한다(같은 창 배포).
 */
export async function appendCompatibleRoutes(tx: ProductTransaction, routes: readonly NewModelCapacityRoute[]):
  Promise<{ appended: ModelCapacityRoute[]; policyRevision: number }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const wanted: ModelCapacityRoute[] = [];
  for (const value of routes) {
    const parsed = modelCapacityRouteSchema.safeParse(value);
    if (!parsed.success) return fail("model_capacity_route_invalid");
    const route = Object.freeze(parsed.data);
    const twin = wanted.find(other => routeKey(other) === routeKey(route));
    if (twin && !sameRoute(twin, route)) fail("model_capacity_route_conflict");
    if (!twin) wanted.push(route);
  }
  const state = await control(tx);
  if (state.fenced) throw new DrWriterFencedError("site_fenced");
  if (!state.policy || state.policyHash === null) return fail("model_capacity_policy_missing");
  const current = state.policy;
  const added: ModelCapacityRoute[] = [];
  for (const route of wanted) {
    const existing = current.routes.find(other => routeKey(other) === routeKey(route));
    if (existing && !sameRoute(existing, route)) fail("model_capacity_route_conflict");
    if (!existing) added.push(route);
  }
  if (!added.length) return { appended: [], policyRevision: state.revision };
  if (current.routes.length + added.length > MODEL_CAPACITY_ROUTES_MAX) fail("model_capacity_routes_cap");
  if (state.revision >= 9007199254740991) fail("model_capacity_revision_exhausted");
  const chain = await liveCapacityPredecessors(tx, state.epoch, [...modelCapacityPredecessorChain(current),
    { epoch: state.epoch, revision: state.revision, policyHash: state.policyHash }]);
  if (chain.length > MODEL_CAPACITY_PREDECESSORS_MAX) return fail("model_capacity_append_chain_full");
  const { compatiblePredecessor: _single, compatiblePredecessors: _chain, ...base } = current;
  void _single; void _chain;
  const next = parseModelCapacityPolicy({ ...base, routes: [...current.routes, ...added], ...(chain.length ? { compatiblePredecessors: chain } : {}) });
  const [row] = await tx.update(modelCapacityControl).set({ policy: next, policyHash: modelCapacityPolicyHash(next),
    revision: sql`${modelCapacityControl.revision} + 1`, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityControl.id, 1), eq(modelCapacityControl.revision, state.revision))).returning({ revision: modelCapacityControl.revision });
  if (!row) return fail("model_capacity_revision_exhausted");
  return { appended: added, policyRevision: Number(row.revision) };
}

/** Fixed AI2 pre-dispatch handoff. The caller must finish its domain transition
 * in this same TX or roll back the withdrawal. Never grants provider authority. */
export type Ai2PreDispatchFallbackReason = "capacity_wait_timeout" | "primary_preflight_failed";
export async function withdrawUndispatchedAi2ItemForFallback(tx: ProductTransaction, value: {
  requestId: string; identity: ModelCapacityRequestIdentity; target: Ai2Target; reason: Ai2PreDispatchFallbackReason;
}): Promise<ReturnType<typeof callerControlSnapshot> | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const requestId = modelCapacityRequestSchema.shape.requestId.parse(value.requestId);
  const reason = ["capacity_wait_timeout", "primary_preflight_failed"].includes(value.reason) ? value.reason : fail("invalid_ai2_fallback_reason");
  const identity = modelCapacityRequestIdentitySchema.parse(value.identity), target = fixedAi2Target(value.target);
  const logical = fixedAi2Identity(identity, target);
  // 엔진 직접 표만(local-direct, 또는 「작업 ↔ 모델」 순위 저장이 만든 abcllm 형 직접 계약 — PR C1). CLI 표는 물리지 않는다
  if (identity.provider !== "local-direct" && identity.provider !== "abcllm") return null;
  const state = await control(tx), snapshot = callerControlSnapshot(state);
  const [row] = await tx.select().from(modelCapacityRequests)
    .where(eq(modelCapacityRequests.requestId, requestId)).for("update");
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId
    && route.provider === identity.provider && route.model === identity.model);
  if (!row || state.mode !== "open" || !route || !(row.state === "waiting" || reason === "primary_preflight_failed" && row.state === "reserved")
    || row.workKey !== identity.workKey || row.ownerInstanceId !== identity.owner.instanceId || row.ownerBootId !== identity.owner.bootId
    || row.class !== identity.class || row.pool !== identity.pool || row.routeId !== identity.routeId
    || row.provider !== identity.provider || row.model !== identity.model || row.logicalWorkKey !== logical
    || row.epoch !== state.epoch || row.revision !== state.revision || row.policyHash !== state.policyHash
    || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || row.state === "waiting" && (row.token !== null || row.reservedUntil !== null)
    || row.dispatchBinding !== null || row.dispatchBindingHash !== null
    || row.dispatchedAt !== null || row.terminalEvidence !== null || row.terminalEvidenceHash !== null || row.settledAt !== null
    || await ai2Fence(tx, logical, requestId)) return null;
  const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityRequests.requestId, requestId), eq(modelCapacityRequests.state, row.state),
      reason === "capacity_wait_timeout" ? sql`${modelCapacityRequests.queuedAt} <= clock_timestamp() - interval '15 seconds'` : undefined,
      row.state === "waiting" ? sql`${modelCapacityRequests.queueUntil} > clock_timestamp()`
        : sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`)).returning();
  if (!changed) return null;
  await event(tx, changed, row.state === "waiting" ? "wait_cancelled" : "reservation_cancelled", row.state, "withdrawn");
  return snapshot;
}

export type TextTargetPoolInput = Readonly<
  { routeId: 'crawl-tagline'; member: CrawlTaglineInput['member'] }
  | { routeId: 'product-search-verify'; member: SearchVerifyInput['member'] }
  | { routeId: 'search-query-translate'; member: WebsearchQueryInput['member'] }
>;
/** Affinity metadata only. Exact current member hashes use existing live-work and generation/snapshot indexes.
 * Never grants/cancels requests, issues native proof, or supplies a business writer. */
export async function readTextTargetPoolAffinities(target: TextTargetPoolInput, models: readonly string[],
  owner: ModelCapacityRequestIdentity['owner']): Promise<Readonly<{ model: string; provider: GatewayDispatchProvider }>[]> {
  const checkedModels = [...new Set(models)];
  if (!checkedModels.length) return [];
  if (checkedModels.length > 8) throw new Error('invalid_text_pool_affinity_models');
  const first = checkedModels.map(model => {
    if (target.routeId === 'crawl-tagline') {
      const input = crawlTaglineInputSchema.parse({ member: target.member, model, askOrdinal: 1, parent: null });
      return { model, logical: crawlTaglineLogicalWorkKey(input), hash: crawlTaglineInputHash(input), generation: crawlTaglineGenerationHash(input) };
    }
    if (target.routeId === 'product-search-verify') {
      const input = searchVerifyInputSchema.parse({ member: target.member, model, execution: 0,
        step: firstSearchVerifyStep(target.member.mode), parent: null });
      return { model, logical: searchVerifyLogicalWorkKey(input), hash: searchVerifyInputHash(input), generation: searchVerifyGenerationHash(input) };
    }
    const input = websearchQueryInputSchema.parse({ member: target.member, model });
    return { model, logical: websearchQueryLogicalWorkKey(input.member), hash: websearchQueryInputHash(input), generation: '' };
  });
  const key = target.routeId === 'crawl-tagline' ? crawlTaglineMemberKeys(target.member)
    : target.routeId === 'product-search-verify' ? searchVerifyMemberKeys(target.member) : websearchQueryMemberKeys(target.member);
  const wanted = first.map(input => `${input.logical}:${input.hash}`);
  return onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const state = await unlockedControl(tx);
    if (state.fenced || state.mode !== 'open') throw new ModelCapacityDeferredError(state.mode === 'disabled' ? 'disabled' : 'draining');
    const pending = await tx.select().from(modelCapacityRequests).where(and(
      eq(modelCapacityRequests.ownerInstanceId, owner.instanceId), eq(modelCapacityRequests.ownerBootId, owner.bootId),
      sql`${modelCapacityRequests.workKey} IN (${sql.join(wanted.map(value => sql`${value}`), sql`, `)})`,
      eq(modelCapacityRequests.routeId, target.routeId), eq(modelCapacityRequests.class, 'background'), eq(modelCapacityRequests.pool, 'text'),
      sql`${modelCapacityRequests.state} IN ('waiting','reserved')`,
      eq(modelCapacityRequests.epoch, state.epoch), eq(modelCapacityRequests.revision, state.revision),
      eq(modelCapacityRequests.policyHash, state.policyHash!),
      sql`((${modelCapacityRequests.state}='waiting' AND ${modelCapacityRequests.queueUntil}>clock_timestamp())
        OR (${modelCapacityRequests.state}='reserved' AND ${modelCapacityRequests.reservedUntil}>clock_timestamp()))`));
    const matches: { model: string; provider: GatewayDispatchProvider }[] = [];
    for (const row of pending) {
      const expected = first.find(input => row.workKey === `${input.logical}:${input.hash}` && row.model === input.model);
      const route = state.policy?.routes.find(route => route.routeId === row.routeId && route.provider === row.provider && route.model === row.model);
      if (!expected || !route || route.groupId !== row.groupId || route.providerBudgetId !== row.providerBudgetId
        || row.logicalWorkKey !== expected.logical || !isDeepStrictEqual(row.logicalMemberKeys, key)
        || row.dispatchBinding !== null || !isGatewayDispatchProvider(row.provider)) throw new ModelCapacityDeferredError('ledger_mismatch');
      matches.push({ model: row.model, provider: row.provider });
    }
    const prefixPredicate = target.routeId === 'search-query-translate'
      ? sql`${modelCapacityRequests.dispatchBinding}->>'kind'='websearch_query_gateway'
        AND ${modelCapacityRequests.dispatchBinding}->>'logicalWorkKey'=${websearchQueryLogicalWorkKey(target.member)}
        AND ${modelCapacityRequests.dispatchBinding}->'member'->'cache'=${JSON.stringify(target.member.cache)}::text::jsonb`
      : target.routeId === 'crawl-tagline' ? sql`${modelCapacityRequests.dispatchBinding}->>'kind'='crawl_tagline_gateway'
        AND ${modelCapacityRequests.dispatchBinding}->>'generationHash' IN (${sql.join(first.map(input => sql`${input.generation}`), sql`, `)})`
      : sql`${modelCapacityRequests.dispatchBinding}->>'kind'='search_verify_gateway'
        AND ${modelCapacityRequests.dispatchBinding}->>'generationHash' IN (${sql.join(first.map(input => sql`${input.generation}`), sql`, `)})`;
    const rows = await tx.select().from(modelCapacityRequests).where(sql`${prefixPredicate}
      AND ${modelCapacityRequests.state} IN ('dispatched','indeterminate','settled') AND ${modelCapacityRequests.routeId}=${target.routeId}`);
    for (const row of rows) {
      const envelope = { requestId: row.requestId, owner: { instanceId: row.ownerInstanceId, bootId: row.ownerBootId },
        token: row.token, epoch: row.epoch, revision: row.revision, policyHash: row.policyHash,
        binding: row.dispatchBinding, bindingHash: row.dispatchBindingHash };
      if (target.routeId === 'crawl-tagline') {
        const parsed = crawlTaglineDispatchBindingSchema.safeParse(row.dispatchBinding);
        const native = storedCrawlTaglineEvidence(row), unsent = storedCrawlTaglineNotStarted(row);
        const dispatch = crawlTaglineModelDispatchSchema.safeParse(envelope);
        if (!parsed.success || !isDeepStrictEqual(parsed.data.member, target.member)
          || row.state === 'settled' && !native && !unsent
          || row.state !== 'settled' && (!dispatch.success || !crawlTaglineRowMatches(row, dispatch.data)))
          throw new ModelCapacityDeferredError('ledger_mismatch');
        matches.push({ model: parsed.data.model, provider: parsed.data.provider });
      } else if (target.routeId === 'product-search-verify') {
        const parsed = searchVerifyDispatchBindingSchema.safeParse(row.dispatchBinding);
        const dispatch = searchVerifyModelDispatchSchema.safeParse(envelope);
        if (!parsed.success || !isDeepStrictEqual(parsed.data.member, target.member)
          || row.state === 'settled' && !storedSearchVerifyEvidence(row) && !storedSearchVerifyNotStarted(row, parsed.data)
          || row.state !== 'settled' && (!dispatch.success || !searchVerifyRowMatches(row, dispatch.data)))
          throw new ModelCapacityDeferredError('ledger_mismatch');
        matches.push({ model: parsed.data.model, provider: parsed.data.provider });
      } else {
        const parsed = websearchQueryDispatchBindingSchema.safeParse(row.dispatchBinding);
        const dispatch = websearchQueryModelDispatchSchema.safeParse(envelope);
        if (!parsed.success || !isDeepStrictEqual(parsed.data.member, target.member)
          || row.state === 'settled' && !storedWebsearchQueryEvidence(row)
          || row.state !== 'settled' && (!dispatch.success || !websearchQueryRowMatches(row, dispatch.data)))
          throw new ModelCapacityDeferredError('ledger_mismatch');
        matches.push({ model: parsed.data.model, provider: parsed.data.provider });
      }
    }
    return [...new Map(matches.map(match => [JSON.stringify([match.provider, match.model]), match])).values()];
  }, { accessMode: 'read only', isolationLevel: 'repeatable read' }));
}

// Publication API classification: distinct typed boundary, existing member fence and capacity authority.
import { publicationClassifyApiInputSchema, publicationClassifyApiInputHash, publicationClassifyApiBindingSchema, publicationClassifyApiBindingHash,
  publicationClassifyApiDispatchSchema, publicationClassifyApiTerminalSchema,
  type PublicationClassifyApiInput, type PublicationClassifyApiBinding, type PublicationClassifyApiDispatch } from './capacity';
import type { PublicationClassifyGatewayTerminal } from '@/lib/crawl/publication-classify-gateway';
function fixedPublicationApiIdentity(identity: ModelCapacityRequestIdentity, input: PublicationClassifyApiInput) {
  const logical = publicationClassifyLogicalWorkKey(input.members);
  if (identity.class !== 'background' || identity.pool !== 'reviewer' || identity.routeId !== 'crawl-publish-classify'
    || identity.provider !== input.provider || identity.model !== input.model || identity.workKey !== `${logical}:${publicationClassifyApiInputHash(input)}`)
    fail('publication_classify_api_identity_mismatch');
  return logical;
}
function publicationApiRowMatches(row: RequestRow | undefined, dispatch: PublicationClassifyApiDispatch): row is RequestRow {
  const b = dispatch.binding;
  return owned(row, dispatch) && row.class === 'background' && row.pool === 'reviewer' && row.routeId === b.routeId
    && row.provider === b.provider && row.model === b.model && row.logicalWorkKey === b.logicalWorkKey
    && row.workKey === `${b.logicalWorkKey}:${b.inputHash}` && isDeepStrictEqual(row.logicalMemberKeys, publicationClassifyMemberKeys(b.members))
    && row.dispatchBindingHash === dispatch.bindingHash && !!row.dispatchedAt && isDeepStrictEqual(row.dispatchBinding, b);
}
export async function requestPublicationApiSlot(value: ModelCapacityRequest, input: PublicationClassifyApiInput): Promise<ModelSlotResult> {
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const checked = modelCapacityRequestSchema.parse(value), snapshot = publicationClassifyApiInputSchema.parse(input);
  return requestSlot(checked, fixedPublicationApiIdentity(checked, snapshot), publicationClassifyMemberKeys(snapshot.members));
}
declare const publicationApiLockBrand: unique symbol;
export type PublicationApiDispatchLock = Readonly<{ control: ReturnType<typeof callerControlSnapshot>; readonly [publicationApiLockBrand]: true }>;
const publicationApiLocks = new WeakMap<PublicationApiDispatchLock, { tx: ProductTransaction; row: RequestRow;
  identity: ModelCapacityRequestIdentity; input: PublicationClassifyApiInput; finished: boolean }>();
/** This capacity prefix must precede publisher/stage/domain/job locks in the same TX. */
export async function lockPublicationApiDispatch(tx: ProductTransaction, value: { reservation: ModelCapacityReservation;
  identity: ModelCapacityRequestIdentity; input: PublicationClassifyApiInput }): Promise<PublicationApiDispatchLock | null> {
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const checked = modelCapacityReservationSchema.parse(value.reservation), identity = modelCapacityRequestIdentitySchema.parse(value.identity);
  const input = publicationClassifyApiInputSchema.parse(value.input), logical = fixedPublicationApiIdentity(identity, input);
  const state = await control(tx);
  const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for('update');
  if (!owned(row, checked)) return null;
  sameIdentity(row, identity);
  if (row.logicalWorkKey !== logical || !isDeepStrictEqual(row.logicalMemberKeys, publicationClassifyMemberKeys(input.members))) return null;
  const route = state.policy?.routes.find(route => route.routeId === identity.routeId && route.provider === identity.provider && route.model === identity.model);
  if (row.state !== 'reserved' || state.mode !== 'open' || !route || row.epoch !== state.epoch || row.revision !== state.revision
    || row.policyHash !== state.policyHash || row.providerBudgetId !== route.providerBudgetId || row.groupId !== route.groupId
    || await introCheckFence(tx, publicationClassifyMemberKeys(input.members), row.requestId, 'crawl-publish-classify')) return null;
  const [timing] = await tx.execute<{ live: boolean }>(sql`SELECT reserved_until>clock_timestamp() AS live FROM model_capacity_requests WHERE request_id=${row.requestId}::uuid`);
  if (!timing?.live) return null;
  const lock = Object.freeze({ control: callerControlSnapshot(state) }) as PublicationApiDispatchLock;
  publicationApiLocks.set(lock, { tx, row, identity, input, finished: false }); return lock;
}
export async function finishPublicationApiDispatch(tx: ProductTransaction, lock: PublicationApiDispatchLock,
  value: PublicationClassifyApiBinding): Promise<PublicationClassifyApiDispatch> {
  const proof = publicationApiLocks.get(lock);
  if (!proof || proof.tx !== tx || proof.finished) return fail('invalid_publication_api_dispatch_lock');
  const binding = publicationClassifyApiBindingSchema.parse(value);
  const { members, provider, model, payloadHash, definitionsHash, configRevision, memberId } = binding;
  if (!isDeepStrictEqual({ members, provider, model, payloadHash, definitionsHash, configRevision, memberId }, proof.input) || binding.logicalWorkKey !== proof.row.logicalWorkKey
    || `${binding.logicalWorkKey}:${binding.inputHash}` !== proof.identity.workKey
    || binding.publisherRole.instanceId !== proof.identity.owner.instanceId || binding.publisherRole.bootId !== proof.identity.owner.bootId)
    fail('publication_classify_api_binding_mismatch');
  proof.finished = true;
  const bindingHash = publicationClassifyApiBindingHash(binding);
  const [changed] = await tx.update(modelCapacityRequests).set({ state: 'dispatched', dispatchBinding: binding, dispatchBindingHash: bindingHash,
    dispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(and(eq(modelCapacityRequests.requestId, proof.row.requestId),
      eq(modelCapacityRequests.state, 'reserved'), eq(modelCapacityRequests.token, proof.row.token!), sql`${modelCapacityRequests.reservedUntil}>clock_timestamp()`)).returning();
  if (!changed) fail('publication_classify_api_reservation_lost');
  const dispatch = publicationClassifyApiDispatchSchema.parse({ ...reservation(changed), binding, bindingHash });
  await event(tx, changed, 'dispatch_started', 'reserved', 'dispatched', null, { dispatch }); return dispatch;
}
export async function reconcilePublicationApiTerminal(terminal: PublicationClassifyGatewayTerminal): Promise<{ kind: 'settled' | 'already_settled' }> {
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const { readPublicationClassifyTerminal } = await import('@/lib/crawl/publication-classify-gateway');
  const native = readPublicationClassifyTerminal(terminal);
  if (!native) fail('invalid_publication_api_terminal');
  const evidence = publicationClassifyApiTerminalSchema.parse(native), dispatch = evidence.dispatch, evidenceHash = reviewHash(evidence);
  return transaction(async tx => {
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for('update');
    if (!mutex) fail('model_capacity_control_missing');
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for('update');
    if (!publicationApiRowMatches(row, dispatch)) fail('publication_api_terminal_binding_mismatch');
    if (row.state === 'settled') {
      if (row.terminalEvidenceHash !== evidenceHash || !isDeepStrictEqual(row.terminalEvidence, evidence)) fail('publication_api_terminal_conflict');
      return { kind: 'already_settled' };
    }
    if (row.state !== 'dispatched' && row.state !== 'indeterminate') fail('publication_api_terminal_state_mismatch');
    const [changed] = await tx.update(modelCapacityRequests).set({ state: 'settled', terminalEvidence: evidence, terminalEvidenceHash: evidenceHash,
      settledAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(modelCapacityRequests.requestId, row.requestId)).returning();
    await event(tx, changed, 'dispatch_settled', row.state, 'settled', null, evidence); return { kind: 'settled' };
  });
}

export type OwnPendingPublicationApiBatch = Readonly<{
  request: ModelCapacityRequest; state: 'waiting' | 'reserved'; token: string | null; epoch: number; revision: number; policyHash: string;
  requestId: string; provider: GatewayDispatchProvider; model: string; workKey: string;
  logicalWorkKey: string; memberKeys: readonly string[]; candidateIds: readonly number[];
}>;
/** Read-only priority metadata, never input/source/dispatch authority. The coordinator must reconstruct
 * the current original batch and match its full input/work key, then re-poll the exact request ID.
 * Read only this publisher boot's live unbound API requests; dispatched calls are never resumed here. */
export async function findOwnPendingPublicationApiBatches(owner: ModelCapacityRequestIdentity['owner']): Promise<OwnPendingPublicationApiBatch[]> {
  if (currentReplayDb()) throw new Error('model_capacity_replay_unsupported');
  const checked = modelCapacityRequestIdentitySchema.shape.owner.parse(owner);
  const rows = await onPrimary(() => db.select().from(modelCapacityRequests).where(and(
    eq(modelCapacityRequests.ownerInstanceId, checked.instanceId), eq(modelCapacityRequests.ownerBootId, checked.bootId),
    eq(modelCapacityRequests.class, 'background'), eq(modelCapacityRequests.pool, 'reviewer'),
    eq(modelCapacityRequests.routeId, 'crawl-publish-classify'),
    sql`${modelCapacityRequests.provider} IN ('abcllm','local-direct')`,
    sql`${modelCapacityRequests.logicalWorkKey} LIKE 'bg:publication-classify:%' AND ${modelCapacityRequests.logicalMemberKeys} IS NOT NULL`,
    sql`((${modelCapacityRequests.state}='waiting' AND ${modelCapacityRequests.queueUntil}>clock_timestamp())
      OR (${modelCapacityRequests.state}='reserved' AND ${modelCapacityRequests.reservedUntil}>clock_timestamp()))`,
    sql`${modelCapacityRequests.dispatchBinding} IS NULL AND ${modelCapacityRequests.dispatchBindingHash} IS NULL
      AND ${modelCapacityRequests.dispatchedAt} IS NULL AND ${modelCapacityRequests.terminalEvidence} IS NULL
      AND ${modelCapacityRequests.terminalEvidenceHash} IS NULL AND ${modelCapacityRequests.settledAt} IS NULL`,
  )).orderBy(sql`CASE WHEN ${modelCapacityRequests.state}='reserved' THEN 0 ELSE 1 END`, asc(modelCapacityRequests.queueOrdinal)).limit(32));
  return rows.map(row => {
    const identity = modelCapacityRequestIdentitySchema.parse({ owner: checked, class: row.class, pool: row.pool,
      routeId: row.routeId, provider: row.provider, model: row.model, workKey: row.workKey });
    const keys = row.logicalMemberKeys;
    if (!isGatewayDispatchProvider(identity.provider) || !keys || keys.length < 1 || keys.length > 10
      || new Set(keys).size !== keys.length || keys.some((key, index) => !/^classify:[1-9][0-9]{0,15}$/.test(key)
        || !Number.isSafeInteger(Number(key.slice(9))) || index > 0 && keys[index - 1] >= key))
      throw new ModelCapacityDeferredError('ledger_mismatch');
    const logical = `bg:publication-classify:${reviewHash(keys)}`;
    if (row.logicalWorkKey !== logical || !new RegExp(`^${logical}:[a-f0-9]{64}$`).test(identity.workKey))
      throw new ModelCapacityDeferredError('ledger_mismatch');
    return Object.freeze({ request: Object.freeze({ ...identity, requestId: row.requestId }), state: row.state as 'waiting' | 'reserved',
      token: row.token, epoch: row.epoch, revision: row.revision, policyHash: row.policyHash,
      requestId: row.requestId, provider: identity.provider, model: identity.model, workKey: identity.workKey,
      logicalWorkKey: logical, memberKeys: Object.freeze([...keys]), candidateIds: Object.freeze(keys.map(key => Number(key.slice(9)))) });
  });
}

/** Cancel only this publisher's exact unstarted readback, including while draining/disabled.
 * This is abandonment, never physical end proof; a successor or any sent/bound row stays untouched. */
export async function cancelOwnPendingPublicationApiBatch(value: OwnPendingPublicationApiBatch,
  owner: ModelCapacityRequestIdentity['owner']): Promise<boolean> {
  const snapshot = structuredClone(value), checked = modelCapacityRequestSchema.parse(snapshot.request);
  const expectedOwner = modelCapacityRequestIdentitySchema.shape.owner.parse(owner), keys = snapshot.memberKeys;
  if (checked.owner.instanceId !== expectedOwner.instanceId || checked.owner.bootId !== expectedOwner.bootId
    || checked.class !== 'background' || checked.pool !== 'reviewer' || checked.routeId !== 'crawl-publish-classify'
    || !isGatewayDispatchProvider(checked.provider) || checked.requestId !== snapshot.requestId
    || checked.provider !== snapshot.provider || checked.model !== snapshot.model || checked.workKey !== snapshot.workKey
    || !['waiting', 'reserved'].includes(snapshot.state) || keys.length < 1 || keys.length > 10 || new Set(keys).size !== keys.length
    || keys.some((key, index) => !/^classify:[1-9][0-9]{0,15}$/.test(key) || !Number.isSafeInteger(Number(key.slice(9)))
      || index > 0 && keys[index - 1] >= key)) return false;
  const logical = `bg:publication-classify:${reviewHash(keys)}`;
  if (snapshot.logicalWorkKey !== logical || !new RegExp(`^${logical}:[a-f0-9]{64}$`).test(checked.workKey)) return false;
  return transaction(async tx => {
    const state = await control(tx);
    if (state.fenced) return false;
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, checked.requestId)).for('update');
    if (!row || row.state !== snapshot.state || row.ownerInstanceId !== expectedOwner.instanceId || row.ownerBootId !== expectedOwner.bootId
      || row.class !== checked.class || row.pool !== checked.pool || row.routeId !== checked.routeId
      || row.provider !== checked.provider || row.model !== checked.model || row.workKey !== checked.workKey
      || row.epoch !== snapshot.epoch || row.revision !== snapshot.revision || row.policyHash !== snapshot.policyHash || row.token !== snapshot.token
      || row.logicalWorkKey !== logical || !isDeepStrictEqual(row.logicalMemberKeys, keys)
      || row.dispatchBinding !== null || row.dispatchBindingHash !== null || row.dispatchedAt !== null
      || row.terminalEvidence !== null || row.terminalEvidenceHash !== null || row.settledAt !== null) return false;
    const [changed] = await tx.update(modelCapacityRequests).set({ state: 'withdrawn', updatedAt: sql`clock_timestamp()` })
      .where(and(eq(modelCapacityRequests.requestId, row.requestId), eq(modelCapacityRequests.state, row.state))).returning();
    if (!changed) return false;
    await event(tx, changed, row.state === 'waiting' ? 'wait_cancelled' : 'reservation_cancelled', row.state, 'withdrawn');
    return true;
  });
}
