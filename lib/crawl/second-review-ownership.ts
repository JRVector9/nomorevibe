import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { pipelineItemLeases, secondReviews, type SecondReview } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, JobLeaseLostError, type JobLease } from "@/lib/jobs/control";
import { assertItemLease, claimItemLease, readItemStage, releaseItemLease, renewItemLease, type ItemStageGuard } from "@/lib/jobs/items/repository";
import { itemBindingHash, itemBindingSchema, itemOwnerSchema, itemWorkKey, type ItemLease, type ItemOwner } from "@/lib/jobs/items/types";
import { assertReplayJobAdmission, assertReplayItemExecutionAllowed, registerReplayItemFinalAuthority, registerReplayItemRelease, reserveReplayItemCall } from "@/lib/operations/pipeline-replay-execution";
import type { ReplayCallRequest } from "@/lib/operations/pipeline-replay-ledger";
import { recordReplaySecondReviewTransition } from "@/lib/operations/pipeline-replay-final";
import { recordLeaseViolation } from "@/lib/operations/pipeline-evidence-ledger";
import { reviewHash, reviewPolicyHash, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "./agent-review-contract";
import type { ReviewInput } from "./agent-review-contract";
import { firstReviewer } from "./agent-review";
import { parseItemBinding, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { lockSecondReviewDomain, secondReviewGeneration, type SecondReviewDomainContext } from "./second-review-input";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import type { CrawlSettings } from "./settings-schema";
import { lockModelCapacityCallerControl, lockAi2ItemModelCapacityDispatch, finishAi2ItemModelCapacityDispatch,
  lockCliModelCapacityDispatch, finishCliModelCapacityDispatch } from "@/lib/llm/capacity-repository";
import { modelCapacityReservationSchema, modelCapacityRequestIdentitySchema, type ModelCapacityReservation, type ModelCapacityRequestIdentity, type Ai2ModelDispatch,
  type CliModelDispatch } from "@/lib/llm/capacity";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { resolveAi2GatewayServingContract, ai2GatewayServingContractHash } from "./second-review-serving-contract";
import type { PreparedAi2GatewayCall } from "./agent-review-gateway";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { isReviewCliProvider, reviewCliCallRefSchema, reviewCliContractMatches, reviewCliServingContract } from "./review-cli-call";

export type Ai2ItemLease = ItemLease & { stage: "ai2"; binding: Ai2ItemBinding };
export type SecondReviewReceipt = Readonly<{
  binding: Ai2ItemBinding;
  /** Consistency of the original row, not a nonce or dispatch attestation. */
  rowIdentityHash: string;
  ownership: { kind: "legacy"; stageEpoch: number; job: JobLease } | { kind: "item"; lease: Ai2ItemLease };
}>;
export type SecondReviewClaim =
  | { kind: "admitted" | "claimed"; row: SecondReview; input: ReviewInput; receipt: SecondReviewReceipt }
  | { kind: "skipped"; reason: "stage_inactive" | "not_pending" | "input_changed" | "running" };
export type SecondReviewItemReceipt = SecondReviewReceipt & { ownership: { kind: "item"; lease: Ai2ItemLease } };
type ItemReceipt = SecondReviewItemReceipt;
export type SecondReviewItemDispatchObservation =
  | { kind: "current"; row: SecondReview; input: ReviewInput }
  | { kind: "stopped"; reason: "stage_inactive" | "not_pending" | "input_changed" };

export type SecondReviewModelIntent = Readonly<{ binding: Ai2ItemBinding; rowIdentityHash: string;
  failureCount: number; input: ReviewInput; owner: ItemOwner }>;
export type SecondReviewModelClaim = SecondReviewClaim & { dispatch?: Ai2ModelDispatch };
/** A rolled-back request for re-admission, never item or provider authority. */
export class SecondReviewModelReservationRequired extends ModelCapacityDeferredError {
  readonly intent: SecondReviewModelIntent;
  constructor(value: SecondReviewModelIntent) {
    super("reservation_required");
    this.intent = snapshotModelIntent(value);
  }
}
/** CLI 표(05c-4)의 같은 되감은 요청. gateway 의도와 다른 고정 class 라 서로의 coordinator 로 넘어가지 않는다. */
export class SecondReviewCliModelReservationRequired extends ModelCapacityDeferredError {
  readonly intent: SecondReviewModelIntent;
  constructor(value: SecondReviewModelIntent) {
    super("reservation_required");
    this.intent = snapshotModelIntent(value, "cli");
  }
}
function snapshotModelIntent(value: SecondReviewModelIntent, transport: "gateway" | "cli" = "gateway"): SecondReviewModelIntent {
  const snapshot = structuredClone(value);
  const checked = z.object({ binding: itemBindingSchema, rowIdentityHash: z.string().regex(/^[a-f0-9]{64}$/),
    failureCount: z.number().int().nonnegative().safe(), owner: itemOwnerSchema,
    input: z.object({ snapshot: z.custom<ReviewInput["snapshot"]>(v => v !== null && typeof v === "object" && !Array.isArray(v)),
      source: z.custom<ReviewInput["source"]>(v => v !== null && typeof v === "object" && !Array.isArray(v)),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/), policyHash: z.string().regex(/^[a-f0-9]{64}$/),
      sourceRevisionHash: z.string().regex(/^[a-f0-9]{64}$/), validUntil: z.date() }).strict(),
  }).strict().parse(snapshot);
  if (checked.binding.stage !== "ai2" || (transport === "cli" ? !isReviewCliProvider(checked.binding.reviewer.provider)
    : checked.binding.reviewer.provider !== "abcllm")
    || checked.binding.inputHash !== checked.input.inputHash
    || checked.binding.sourceRevisionHash !== checked.input.sourceRevisionHash)
    throw new Error("invalid_second_review_model_intent");
  // Native preparation binds the full input JSON, including factory key order.
  // Validation above does not transform values; preserve that original wire identity.
  checked.input = snapshot.input;
  const freeze = (v: object): void => { Object.values(v).forEach(child => { if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child); }); Object.freeze(v); };
  freeze(checked);
  return checked as SecondReviewModelIntent;
}

type ModelReservation = { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity;
  call: PreparedAi2GatewayCall; expected: SecondReviewModelIntent };
type CliModelReservation = { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity;
  call: z.infer<typeof reviewCliCallRefSchema>; expected: SecondReviewModelIntent };
export type SecondReviewCliModelClaim = SecondReviewClaim & { dispatch?: CliModelDispatch };
const isCliReservation = (value: ModelReservation | CliModelReservation): value is CliModelReservation =>
  (value.call as { kind?: unknown }).kind === "prepared_cli";

/** One outer TX owns the control UPDATE prefix, fresh item and dispatch event. */
export async function claimSecondReviewItemWithModelReservation(input: ModelReservation & {
  secondReviewId: number; owner: ItemOwner;
}): Promise<SecondReviewModelClaim> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const id = positive.parse(input.secondReviewId), owner = itemOwnerSchema.parse(input.owner);
  const expected = snapshotModelIntent(input.expected), reservation = modelCapacityReservationSchema.parse(input.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(input.identity);
  const call = z.object({ kind: z.literal("prepared"), wireHash: sha, servingContractHash: sha,
    totalTokenBound: positive, model: z.string().min(1).max(160), inputHash: sha }).strict().parse(input.call);
  if (expected.binding.secondReviewId !== id || !isDeepStrictEqual(expected.owner, owner)
    || !isDeepStrictEqual(reservation.owner, owner) || !isDeepStrictEqual(identity.owner, owner))
    throw new Error("invalid_second_review_model_intent");
  try { return await claimReview(id, { kind: "item", owner, ttlMs: STALE_LOCK_MS, purpose: "consumer" },
    { reservation, identity, call, expected }); }
  catch (error) {
    if (error instanceof Error && error.message === "ai2_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
}

/** CLI 표(05c-4)의 고정 consumer 재진입. 한 바깥 TX 가 CLI 잠금 prefix·새 item·dispatch event 를 함께 가진다. */
export async function claimSecondReviewItemWithCliModelReservation(input: CliModelReservation & {
  secondReviewId: number; owner: ItemOwner;
}): Promise<SecondReviewCliModelClaim> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const id = positive.parse(input.secondReviewId), owner = itemOwnerSchema.parse(input.owner);
  const expected = snapshotModelIntent(input.expected, "cli"), reservation = modelCapacityReservationSchema.parse(input.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(input.identity), call = reviewCliCallRefSchema.parse(input.call);
  if (expected.binding.secondReviewId !== id || !isDeepStrictEqual(expected.owner, owner)
    || !isDeepStrictEqual(reservation.owner, owner) || !isDeepStrictEqual(identity.owner, owner))
    throw new Error("invalid_second_review_model_intent");
  try { return await claimReview(id, { kind: "item", owner, ttlMs: STALE_LOCK_MS, purpose: "consumer" },
    { reservation, identity, call, expected }); }
  catch (error) {
    if (error instanceof Error && error.message === "cli_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
}

const positive = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const leaseSchema = z.object({ stage: z.literal("ai2"), workKey: z.string().min(1).max(80),
  binding: itemBindingSchema, bindingHash: sha, owner: itemOwnerSchema, token: z.uuid(),
  stageEpoch: positive, itemEpoch: positive, leaseUntil: z.date() }).strict();
const receiptSchema = z.object({ binding: itemBindingSchema, rowIdentityHash: sha,
  ownership: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("legacy"), stageEpoch: positive, job: z.object({
      name: z.literal("second-review"), token: z.string().min(1).max(160), requestedVersion: z.number().int().nonnegative().safe(),
    }).strict() }).strict(),
    z.object({ kind: z.literal("item"), lease: leaseSchema }).strict(),
  ]) }).strict();

function validateReceipt(receipt: SecondReviewReceipt): void {
  receiptSchema.parse(receipt);
  if (receipt.binding.stage !== "ai2") throw new Error("invalid_second_review_receipt");
  if (receipt.ownership.kind === "item") {
    const lease = receipt.ownership.lease;
    if (!isDeepStrictEqual(lease.binding, receipt.binding) || lease.bindingHash !== itemBindingHash(receipt.binding)
      || lease.workKey !== itemWorkKey(receipt.binding)) throw new Error("invalid_second_review_receipt");
  }
}

function rowIdentityHash(row: SecondReview): string {
  return reviewHash({ id: row.id, candidateId: row.candidateId, repo: row.repo, publishedSlug: row.publishedSlug,
    trigger: row.trigger, signals: row.signals, firstDecision: row.firstDecision, firstConfidence: row.firstConfidence,
    firstModel: row.firstModel, firstAttemptId: row.firstAttemptId, generationKey: row.generationKey,
    inputHash: row.inputHash, provider: row.provider, model: row.model, fallbackForId: row.fallbackForId });
}

function assertOriginalRow(receipt: SecondReviewReceipt, row: SecondReview): void {
  validateReceipt(receipt);
  if (!row) throw new Error("invalid_second_review_receipt");
  const binding = receipt.binding;
  if (receipt.rowIdentityHash !== rowIdentityHash(row) || binding.secondReviewId !== row.id
    || binding.candidateId !== row.candidateId || binding.generationKey !== row.generationKey
    || secondReviewGeneration(row.firstAttemptId, binding, row.trigger) !== row.generationKey
    || binding.fallbackForId !== row.fallbackForId || binding.vote !== (row.fallbackForId ?? row.id)
    || binding.reviewer.provider !== row.provider || binding.reviewer.model !== row.model
    || (binding.source.kind === "published" ? binding.source.slug !== row.publishedSlug || row.firstAttemptId !== null
      : row.publishedSlug !== null || binding.source.firstAttemptId !== row.firstAttemptId || binding.inputHash !== row.inputHash)) {
    throw new Error("invalid_second_review_receipt");
  }
}

function rejectItemReplay(): void {
  if (currentReplayDb()) assertReplayItemExecutionAllowed();
}

async function assertSecondReviewJob(tx: ProductTransaction, job: JobLease): Promise<void> {
  if (job.name !== "second-review") throw new JobLeaseLostError();
  await assertJobLeaseAtWallTime(tx, job);
}

async function ai2Stage(tx: ProductTransaction, guard: ItemStageGuard) {
  const stage = await readItemStage(tx, guard);
  if (stage.stage !== "ai2") throw new Error("invalid_second_review_stage_guard");
  return stage;
}

/** Domain/root rows precede this phase. A locked sibling is busy even if its
 * expiry cannot be observed yet; claims never wait behind an item-row owner. */
async function chainIsBusy(tx: ProductTransaction, row: SecondReview): Promise<boolean> {
  const vote = row.fallbackForId ?? row.id;
  const chain = await tx.select({ id: secondReviews.id }).from(secondReviews)
    .where(or(eq(secondReviews.id, row.id), eq(secondReviews.id, vote), eq(secondReviews.fallbackForId, vote)));
  const keys = [...new Set(chain.map(item => `ai2:${item.id}`))].sort();
  const where = and(eq(pipelineItemLeases.stage, "ai2"), inArray(pipelineItemLeases.workKey, keys));
  const locked = await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases)
    .where(where).orderBy(pipelineItemLeases.workKey).for("update", { skipLocked: true });
  const existing = await tx.select({ workKey: pipelineItemLeases.workKey,
    live: sql<boolean>`${pipelineItemLeases.token} IS NOT NULL AND ${pipelineItemLeases.leaseUntil} > clock_timestamp()` })
    .from(pipelineItemLeases).where(where);
  return existing.some(item => item.live || !locked.some(held => held.workKey === item.workKey));
}

/** This validates original identity and persisted ownership only. The result
 * writer must separately validate its locked CURRENT domain/composite policy.
 * In particular, rowIdentityHash is not proof that admission/transport ran. */
export async function assertSecondReviewOwnership(tx: ProductTransaction, guard: ItemStageGuard,
  receipt: SecondReviewReceipt, lockedRow: SecondReview): Promise<void> {
  if (receipt?.ownership?.kind === "item") rejectItemReplay();
  assertOriginalRow(receipt, lockedRow);
  const [actual] = await tx.select().from(secondReviews).where(eq(secondReviews.id, lockedRow.id));
  if (!actual || rowIdentityHash(actual) !== rowIdentityHash(lockedRow)) throw new Error("invalid_second_review_receipt");
  const stage = await ai2Stage(tx, guard);
  if (receipt.ownership.kind === "legacy") {
    if (stage.epoch !== receipt.ownership.stageEpoch || !(stage.mode === "legacy"
      || stage.mode === "draining" && stage.drainingFrom === "legacy") || await chainIsBusy(tx, actual)) {
      throw new Error("second_review_ownership_lost");
    }
    return; // Job row/DB wall time follow every result/outbox wait in finish.
  }
  await assertItemLease(tx, guard, receipt.ownership.lease);
  const [persisted] = await tx.select({ binding: pipelineItemLeases.binding }).from(pipelineItemLeases)
    .where(and(eq(pipelineItemLeases.stage, "ai2"), eq(pipelineItemLeases.workKey, receipt.ownership.lease.workKey)));
  if (!persisted || !isDeepStrictEqual(persisted.binding, receipt.binding)) throw new Error("invalid_second_review_receipt");
  await registerReplayItemFinalAuthority(tx, receipt.ownership.lease);
}

/** Only after external work has settled and all writes/outbox waits ended.
 * Release rechecks the SAME already-locked item against DB wall time. */
export async function finishSecondReviewOwnership(tx: ProductTransaction, guard: ItemStageGuard,
  receipt: SecondReviewReceipt): Promise<void> {
  if (receipt?.ownership?.kind === "item") rejectItemReplay();
  validateReceipt(receipt);
  const { ownership, binding } = receipt;
  await recordLeaseViolation(tx, { stage: "ai2", candidateId: binding.candidateId, secondReviewId: binding.secondReviewId },
    ownership.kind === "item" ? { kind: "item", stage: "ai2", workKey: ownership.lease.workKey, token: ownership.lease.token }
      : { kind: "job", name: ownership.job.name, token: ownership.job.token });
  const stage = await ai2Stage(tx, guard);
  if (receipt.ownership.kind === "item") {
    await registerReplayItemFinalAuthority(tx, receipt.ownership.lease);
    await releaseItemLease(tx, guard, receipt.ownership.lease);
    await registerReplayItemRelease(tx, receipt.ownership.lease); return;
  }
  if (stage.epoch !== receipt.ownership.stageEpoch || !(stage.mode === "legacy"
    || stage.mode === "draining" && stage.drainingFrom === "legacy")) throw new Error("second_review_ownership_lost");
  await assertSecondReviewJob(tx, receipt.ownership.job);
}

export async function canStartLegacySecondReview(job: JobLease): Promise<boolean> {
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx), stage = await ai2Stage(tx, stages.ai2);
    if (stage.mode !== "legacy") return false;
    await assertSecondReviewJob(tx, job);
    return true;
  });
}

/** Legacy admission is an observation under the job mutex, not a durable row claim. */
export function admitLegacySecondReview(id: number, job: JobLease): Promise<SecondReviewClaim> {
  return claimReview(id, { kind: "legacy", job });
}

/** Inactive adapter: never connected to registry/scheduler or B5 item execution. */
export async function claimItemSecondReview(id: number, owner: ItemOwner, ttlMs: number): Promise<SecondReviewClaim> {
  rejectItemReplay();
  itemOwnerSchema.parse(owner);
  z.number().int().min(1).max(3_600_000).safe().parse(ttlMs);
  return claimReview(id, { kind: "item", owner, ttlMs });
}

/** Ordinary consumer only: the compatibility/replay entry cannot waive its cap. */
export function claimConsumerItemSecondReview(id: number, owner: ItemOwner, ttlMs: number): Promise<SecondReviewClaim> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const identity = itemOwnerSchema.parse(owner), ttl = z.number().int().min(1).max(3_600_000).safe().parse(ttlMs);
  return claimReview(id, { kind: "item", owner: identity, ttlMs: ttl, purpose: "consumer" });
}

type ClaimAuthority = { kind: "legacy"; job: JobLease } | { kind: "item"; owner: ItemOwner; ttlMs: number; purpose?: "consumer" };
function claimReview(id: number, authority: ClaimAuthority, reserved: CliModelReservation): Promise<SecondReviewCliModelClaim>;
function claimReview(id: number, authority: ClaimAuthority, reserved?: ModelReservation): Promise<SecondReviewModelClaim>;
async function claimReview(id: number, authority: ClaimAuthority,
  reserved?: ModelReservation | CliModelReservation): Promise<SecondReviewClaim & { dispatch?: Ai2ModelDispatch | CliModelDispatch }> {
  positive.parse(id);
  return onPrimary(() => db.transaction(async tx => {
    // Only an active verified replay scope preserves its fixed fixture grants.
    // Ordinary fresh admission takes the real control before S3/domain locks.
    const cli = reserved && isCliReservation(reserved) ? reserved : null;
    const target = reserved ? { candidateId: reserved.expected.binding.candidateId, vote: reserved.expected.binding.vote } : null;
    // CLI 는 gateway 와 같은 표 키(ai2:<후보>:<vote>)다 — 장부가 transport·예비모델을 넘어 한 표에 활성 호출 하나만 둔다
    const dispatchLock = reserved && !cli ? await lockAi2ItemModelCapacityDispatch(tx, { reservation: reserved.reservation,
      identity: reserved.identity, target: target! }) : null;
    const cliLock = cli ? await lockCliModelCapacityDispatch(tx, { reservation: cli.reservation, identity: cli.identity,
      target: { kind: "ai2", ...target! } }) : null;
    if (reserved && !dispatchLock && !cliLock) throw new ModelCapacityDeferredError("reservation_lost");
    const capacity = dispatchLock ? dispatchLock.control : cliLock ? cliLock.control : currentReplayDb() ? null : await lockModelCapacityCallerControl(tx);
    const stages = await lockPipelineInputStages(tx), stage = await ai2Stage(tx, stages.ai2);
    if (stage.mode !== (authority.kind === "legacy" ? "legacy" : "items")
      || authority.kind === "item" && stage.writerContractVersion < 1) return { kind: "skipped", reason: "stage_inactive" };
    if (currentReplayDb()) {
      if (authority.kind === "item") await assertReplayJobAdmission(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(1485803, 3)`);
    }
    const [original] = await tx.select().from(secondReviews).where(eq(secondReviews.id, id));
    const context = await lockSecondReviewDomain(tx, id);
    const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, id));
    const skipped = async (reason: "not_pending" | "input_changed" | "running"): Promise<SecondReviewClaim> => {
      if (authority.kind === "legacy") await assertSecondReviewJob(tx, authority.job);
      return { kind: "skipped", reason };
    };
    if (!row || row.status !== "pending") return skipped("not_pending");
    if (!original || rowIdentityHash(original) !== rowIdentityHash(row)) return skipped("input_changed");
    if (await chainIsBusy(tx, row)) return skipped("running");
    if (!context) {
      if (authority.kind === "legacy") {
        await tx.update(secondReviews).set({ status: "resolved", resolution: "superseded", resolvedAt: new Date() })
          .where(and(eq(secondReviews.id, row.id), eq(secondReviews.status, "pending")));
        await assertSecondReviewJob(tx, authority.job);
        await recordReplaySecondReviewTransition(tx, { kind: "superseded", secondReviewIds: [row.id] });
        await assertSecondReviewJob(tx, authority.job);
      }
      return { kind: "skipped", reason: "input_changed" };
    }
    const binding = secondReviewBinding(context);
    if (reserved) {
      if (authority.kind !== "item" || !isDeepStrictEqual(binding, reserved.expected.binding)
        || rowIdentityHash(row) !== reserved.expected.rowIdentityHash || row.failureCount !== reserved.expected.failureCount
        || !isDeepStrictEqual(context.input, reserved.expected.input)
        || !isDeepStrictEqual(authority.owner, reserved.expected.owner)) return skipped("input_changed");
      if (cli) {
        const contract = reviewCliServingContract("second-review", binding.reviewer.provider, binding.reviewer.model);
        if (!contract || cli.call.routeId !== "second-review" || cli.call.provider !== binding.reviewer.provider
          || cli.call.model !== binding.reviewer.model || cli.call.inputHash !== context.input.inputHash || !reviewCliContractMatches(cli.call, contract))
          throw new ModelCapacityDeferredError("provider_contract_unavailable");
      } else {
        const gateway = reserved as ModelReservation, serving = resolveAi2GatewayServingContract(binding.reviewer.model);
        if (!serving || serving.model !== binding.reviewer.model || gateway.call.model !== binding.reviewer.model
          || gateway.call.inputHash !== context.input.inputHash
          || gateway.call.servingContractHash !== ai2GatewayServingContractHash(serving)
          || gateway.call.totalTokenBound !== serving.totalTokenBound)
          throw new ModelCapacityDeferredError("provider_contract_unavailable");
      }
    }
    let ownership: SecondReviewReceipt["ownership"];
    if (authority.kind === "legacy") {
      ownership = { kind: "legacy", stageEpoch: stage.epoch, job: authority.job };
      await assertSecondReviewJob(tx, authority.job);
    } else {
      const lease = await claimItemLease(tx, stages.ai2, binding, authority.owner, authority.ttlMs);
      if (!lease) return { kind: "skipped", reason: "running" };
      await assertItemLease(tx, stages.ai2, lease);
      await registerReplayItemFinalAuthority(tx, lease);
      ownership = { kind: "item", lease: lease as Ai2ItemLease };
    }
    if (authority.kind === "item" && authority.purpose === "consumer" && capacity?.mode === "disabled") {
      throw new ModelCapacityDeferredError("disabled");
    }
    if (capacity && capacity.mode !== "disabled") {
      if (capacity.mode === "draining") throw new ModelCapacityDeferredError("draining");
      const route = capacity.policy?.routes.find(route => route.routeId === "second-review"
        && route.provider === binding.reviewer.provider && route.model === binding.reviewer.model);
      if (!route) throw new ModelCapacityDeferredError("unmapped");
      if (!reserved) {
        if (authority.kind === "item" && authority.purpose === "consumer" && binding.reviewer.provider === "abcllm")
          throw new SecondReviewModelReservationRequired({ binding, rowIdentityHash: rowIdentityHash(row),
            failureCount: row.failureCount, input: context.input, owner: authority.owner });
        // CLI 표는 계약이 있을 때만 slot 으로 간다. 운영 resolver 는 null 이라 지금은 그대로 미룬다(05c-1 과 같은 결과).
        if (authority.kind === "item" && authority.purpose === "consumer"
          && reviewCliServingContract("second-review", binding.reviewer.provider, binding.reviewer.model))
          throw new SecondReviewCliModelReservationRequired({ binding, rowIdentityHash: rowIdentityHash(row),
            failureCount: row.failureCount, input: context.input, owner: authority.owner });
        throw new ModelCapacityDeferredError("provider_contract_unavailable");
      }
    }
    let dispatch: Ai2ModelDispatch | CliModelDispatch | undefined;
    if (cli) {
      if (!cliLock || ownership.kind !== "item") throw new Error("invalid_second_review_model_claim");
      const lease = ownership.lease;
      await assertItemLease(tx, stages.ai2, lease);
      dispatch = await finishCliModelCapacityDispatch(tx, cliLock, { kind: "ai2_item_cli", version: 1,
        logicalWorkKey: `ai2:${binding.candidateId}:${binding.vote}`, review: binding,
        rowIdentityHash: rowIdentityHash(row), failureCount: row.failureCount, inputPolicyHash: context.input.policyHash,
        item: { workKey: lease.workKey, owner: lease.owner, token: lease.token, stageEpoch: lease.stageEpoch,
          itemEpoch: lease.itemEpoch, bindingHash: lease.bindingHash },
        routeId: "second-review", provider: cli.call.provider, model: cli.call.model, transport: cli.call.transport,
        totalTokenBound: cli.call.totalTokenBound, chargedTokens: cli.call.totalTokenBound });
      // Every dispatch/event wait precedes this last check of the original item.
      await assertItemLease(tx, stages.ai2, lease);
    } else if (reserved && !isCliReservation(reserved)) {
      if (!dispatchLock || ownership.kind !== "item") throw new Error("invalid_second_review_model_claim");
      const lease = ownership.lease;
      await assertItemLease(tx, stages.ai2, lease);
      dispatch = await finishAi2ItemModelCapacityDispatch(tx, dispatchLock, { kind: "ai2_item_gateway", version: 1,
        logicalWorkKey: `ai2:${binding.candidateId}:${binding.vote}`, review: binding,
        rowIdentityHash: rowIdentityHash(row), failureCount: row.failureCount, inputPolicyHash: context.input.policyHash,
        item: { workKey: lease.workKey, owner: lease.owner, token: lease.token, stageEpoch: lease.stageEpoch,
          itemEpoch: lease.itemEpoch, bindingHash: lease.bindingHash },
        routeId: "second-review", provider: "abcllm", model: reserved.call.model, wireHash: reserved.call.wireHash,
        servingContractHash: reserved.call.servingContractHash, totalTokenBound: reserved.call.totalTokenBound,
        chargedTokens: reserved.call.totalTokenBound });
      // Every dispatch/event wait precedes this last check of the original item.
      await assertItemLease(tx, stages.ai2, lease);
    }
    return { kind: authority.kind === "legacy" ? "admitted" : "claimed", row, input: context.input,
      receipt: { binding, rowIdentityHash: rowIdentityHash(row), ownership }, ...(dispatch ? { dispatch } : {}) };
  }));
}

export async function renewSecondReviewOwnership(receipt: ItemReceipt, ttlMs: number): Promise<Ai2ItemLease | null> {
  rejectItemReplay();
  validateReceipt(receipt);
  if (receipt.ownership.kind !== "item") throw new Error("invalid_second_review_receipt");
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    await lockSecondReviewDomain(tx, receipt.binding.secondReviewId);
    const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, receipt.binding.secondReviewId));
    if (!row) return null;
    assertOriginalRow(receipt, row);
    const lease = await renewItemLease(tx, stages.ai2, receipt.ownership.lease, ttlMs);
    if (!lease) return null;
    if (!isDeepStrictEqual(lease.binding, receipt.binding)) throw new Error("invalid_second_review_receipt");
    await registerReplayItemFinalAuthority(tx, lease);
    return lease as Ai2ItemLease;
  });
}

/** A fresh observation before dispatch, not a durable external-call permit. */
export async function observeSecondReviewItemDispatch(receipt: SecondReviewItemReceipt): Promise<SecondReviewItemDispatchObservation> {
  rejectItemReplay();
  validateReceipt(receipt);
  if (receipt.ownership.kind !== "item") throw new Error("invalid_second_review_receipt");
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx), stage = await ai2Stage(tx, stages.ai2);
    const current = await lockSecondReviewDomain(tx, receipt.binding.secondReviewId);
    const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, receipt.binding.secondReviewId));
    if (!row) throw new Error("invalid_second_review_receipt");
    await assertSecondReviewOwnership(tx, stages.ai2, receipt, row);
    if (stage.mode !== "items" || stage.writerContractVersion < 1) return { kind: "stopped", reason: "stage_inactive" };
    if (row.status !== "pending") return { kind: "stopped", reason: "not_pending" };
    if (!current || !isDeepStrictEqual(secondReviewBinding(current), receipt.binding)) return { kind: "stopped", reason: "input_changed" };
    return { kind: "current", row, input: current.input };
  });
}

export function secondReviewPolicyHash(settings: CrawlSettings): string {
  return reviewHash({ version: "second-review-policy-v1", inputPolicyHash: reviewPolicyHash(settings),
    enabled: settings.enabled, reviewMode: settings.reviewMode, firstReview: firstReviewer(settings),
    secondReview: settings.secondReview, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION });
}

export function secondReviewBinding(ctx: SecondReviewDomainContext): Ai2ItemBinding {
  const { row, input } = ctx;
  const binding = parseItemBinding({ stage: "ai2", secondReviewId: row.id, candidateId: row.candidateId,
    source: row.publishedSlug ? { kind: "published", slug: row.publishedSlug, productId: ctx.publishedProductId }
      : { kind: "first_attempt", firstAttemptId: row.firstAttemptId },
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: secondReviewPolicyHash(ctx.settings),
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    reviewer: { provider: row.provider, model: row.model }, generationKey: row.generationKey,
    vote: row.fallbackForId ?? row.id, fallbackForId: row.fallbackForId });
  if (binding.stage !== "ai2") throw new Error("invalid_second_review_binding");
  return binding;
}

/** Replay call admission reuses the current domain and actual persisted owner.
 * The private execution ticket, not this receipt value, authorizes the ledger. */
export async function reserveSecondReviewItemReplayCall(receipt: SecondReviewItemReceipt, request: ReplayCallRequest): Promise<void> {
  assertReplayItemExecutionAllowed();
  validateReceipt(receipt);
  await db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const current = await lockSecondReviewDomain(tx, receipt.binding.secondReviewId);
    const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, receipt.binding.secondReviewId));
    if (!row || row.status !== "pending" || !current || !isDeepStrictEqual(secondReviewBinding(current), receipt.binding))
      throw new Error("replay_item_call_binding_mismatch");
    await assertSecondReviewOwnership(tx, stages.ai2, receipt, row);
    await reserveReplayItemCall(tx, receipt.ownership.lease, request);
  });
}
