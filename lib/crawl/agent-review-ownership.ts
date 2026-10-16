import { isDeepStrictEqual } from "node:util";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { pipelineItemLeases, type CrawlReviewAttempt } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, JobLeaseLostError, type JobLease } from "@/lib/jobs/control";
import { assertItemLease, readItemStage, releaseItemLease, type ItemStageGuard } from "@/lib/jobs/items/repository";
import { itemBindingHash, itemWorkKey, parseItemBinding, type Ai1ItemBinding, type ItemLease } from "@/lib/jobs/items/types";
import { recordLeaseViolation } from "@/lib/operations/pipeline-evidence-ledger";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewInput } from "./agent-review-contract";

export type Ai1ReviewOrigin = "fresh" | "direct_reuse" | "semantic_reuse";
export type Ai1ItemLease = ItemLease & { stage: "ai1"; binding: Ai1ItemBinding };
export type Ai1ReviewReceipt = Readonly<{
  attemptId: number;
  origin: Ai1ReviewOrigin;
  ownership: { kind: "legacy"; stageEpoch: number; job: JobLease } | { kind: "item"; lease: Ai1ItemLease };
}>;

export function agentReviewBinding(candidateId: number, input: ReviewInput,
  reviewer: { provider: string; model: string }): Ai1ItemBinding {
  const binding = parseItemBinding({ stage: "ai1", candidateId, inputHash: input.inputHash,
    sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, reviewer });
  if (binding.stage !== "ai1") throw new Error("invalid_agent_review_binding");
  return binding;
}

/** Logical ownership covers changed inputs and reviewers as well as the original binding. */
export function liveAgentReviewItem(candidateId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM ${pipelineItemLeases} ai1_item
    WHERE ai1_item.stage = 'ai1' AND ai1_item.work_key = 'ai1:' || (${candidateId})::text
      AND ai1_item.token IS NOT NULL AND ai1_item.lease_until > clock_timestamp())`;
}

/** All domain rows must already be locked before acquiring the logical item row. */
export async function hasLiveAgentReviewItem(tx: ProductTransaction, candidateId: number): Promise<boolean> {
  const where = and(eq(pipelineItemLeases.stage, "ai1"), eq(pipelineItemLeases.workKey, `ai1:${candidateId}`));
  await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases).where(where).for("update");
  const [live] = await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases)
    .where(and(where, sql`${pipelineItemLeases.token} IS NOT NULL AND ${pipelineItemLeases.leaseUntil} > clock_timestamp()`));
  return Boolean(live);
}

export async function assertAgentReviewJob(tx: ProductTransaction, lease: JobLease): Promise<void> {
  if (lease.name !== "crawl-agent-review") throw new JobLeaseLostError();
  await assertJobLeaseAtWallTime(tx, lease);
}

/** Validate original attempt identity even when the current source or human decision changed. */
export async function assertAgentReviewOwnership(tx: ProductTransaction, guard: ItemStageGuard,
  receipt: Ai1ReviewReceipt, attempt: CrawlReviewAttempt, input: ReviewInput): Promise<void> {
  if (!receipt || !Number.isSafeInteger(receipt.attemptId) || receipt.attemptId < 1
    || receipt.attemptId !== attempt.id || attempt.kind !== "automatic" || !attempt.provider || !attempt.model || !receipt.ownership
    || !["fresh", "direct_reuse", "semantic_reuse"].includes(receipt.origin)
    || attempt.inputHash !== input.inputHash || attempt.sourceRevisionHash !== input.sourceRevisionHash
    || attempt.policyHash !== input.policyHash || attempt.promptVersion !== REVIEW_PROMPT_VERSION
    || attempt.rulesVersion !== REVIEW_RULES_VERSION || !isDeepStrictEqual(attempt.snapshot, input.snapshot)
    || !isDeepStrictEqual(attempt.source, input.source)
    || attempt.validUntil.getTime() !== input.validUntil.getTime()
    || receipt.origin === "fresh" && attempt.reusedFromAttemptId !== null
    || receipt.origin === "semantic_reuse" && attempt.reusedFromAttemptId === null
    || receipt.origin === "direct_reuse" && attempt.state !== "succeeded") throw new Error("invalid_agent_review_receipt");
  const state = await readItemStage(tx, guard);
  if (state.stage !== "ai1") throw new Error("invalid_agent_review_stage_guard");
  if (receipt.ownership.kind === "legacy") {
    if (!Number.isSafeInteger(receipt.ownership.stageEpoch) || receipt.ownership.stageEpoch < 1
      || state.epoch !== receipt.ownership.stageEpoch || !(state.mode === "legacy"
        || state.mode === "draining" && state.drainingFrom === "legacy")
      || receipt.ownership.job.name !== "crawl-agent-review"
      || await hasLiveAgentReviewItem(tx, attempt.candidateId)) throw new Error("agent_review_ownership_lost");
    if (receipt.origin !== "direct_reuse" && attempt.leaseToken !== receipt.ownership.job.token)
      throw new Error("agent_review_ownership_lost");
    return;
  }
  if (receipt.ownership.kind !== "item") throw new Error("invalid_agent_review_receipt");
  const lease = receipt.ownership.lease;
  const binding = agentReviewBinding(attempt.candidateId, input, { provider: attempt.provider, model: attempt.model });
  if (lease.stage !== "ai1" || lease.workKey !== itemWorkKey(binding)
    || lease.bindingHash !== itemBindingHash(binding) || !isDeepStrictEqual(lease.binding, binding)
    || receipt.origin !== "direct_reuse" && attempt.leaseToken !== lease.token) throw new Error("invalid_agent_review_receipt");
  await assertItemLease(tx, guard, lease);
}

/** Call only after external work has settled and all downstream job waits ended. */
export async function finishAgentReviewOwnership(tx: ProductTransaction, guard: ItemStageGuard,
  receipt: Ai1ReviewReceipt): Promise<void> {
  const { ownership } = receipt;
  await recordLeaseViolation(tx, { stage: "ai1", firstAttemptId: receipt.attemptId }, ownership.kind === "item"
    ? { kind: "item", stage: "ai1", workKey: ownership.lease.workKey, token: ownership.lease.token }
    : { kind: "job", name: ownership.job.name, token: ownership.job.token });
  if (receipt.ownership.kind === "item") await releaseItemLease(tx, guard, receipt.ownership.lease);
  else await assertAgentReviewJob(tx, receipt.ownership.job);
}
