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
import { reviewHash, reviewPolicyHash, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "./agent-review-contract";
import type { ReviewInput } from "./agent-review-contract";
import { firstReviewer } from "./agent-review";
import { parseItemBinding, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { lockSecondReviewDomain, secondReviewGeneration, type SecondReviewDomainContext } from "./second-review-input";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import type { CrawlSettings } from "./settings-schema";
import { lockModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";

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

async function claimReview(id: number, authority: { kind: "legacy"; job: JobLease }
  | { kind: "item"; owner: ItemOwner; ttlMs: number }): Promise<SecondReviewClaim> {
  positive.parse(id);
  return onPrimary(() => db.transaction(async tx => {
    // Only an active verified replay scope preserves its fixed fixture grants.
    // Ordinary fresh admission takes the real control before S3/domain locks.
    const capacity = currentReplayDb() ? null : await lockModelCapacityCallerControl(tx);
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
    if (capacity && capacity.mode !== "disabled") {
      if (capacity.mode === "draining") throw new ModelCapacityDeferredError("draining");
      const route = capacity.policy?.routes.find(route => route.routeId === "second-review"
        && route.provider === binding.reviewer.provider && route.model === binding.reviewer.model);
      if (!route) throw new ModelCapacityDeferredError("unmapped");
      // No adapter yet proves provider termination. Roll back the whole claim,
      // including any item token/epoch issued above; existing receipts still settle.
      throw new ModelCapacityDeferredError("provider_contract_unavailable");
    }
    return { kind: authority.kind === "legacy" ? "admitted" : "claimed", row, input: context.input,
      receipt: { binding, rowIdentityHash: rowIdentityHash(row), ownership } };
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
