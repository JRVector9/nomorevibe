import { z } from "zod";
import { itemOwnerSchema, type ItemOwner } from "@/lib/jobs/items/types";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import type { AgentReviewResult } from "./agent-review";
import { claimItemSecondReview, observeSecondReviewItemDispatch, renewSecondReviewOwnership, type SecondReviewItemReceipt } from "./second-review-ownership";
import { recordSecondReview, type SecondReviewWriteResult } from "./second-review";
import { dispatchSecondReviewTransport, secondReviewTransportTimeoutMs } from "./second-review-transport";

export type SecondReviewItemOutcome =
  | { state: "skipped"; reason: "stage_inactive" | "not_pending" | "input_changed" | "running" | "aborted" }
  | SecondReviewWriteResult;

/** Inactive single-item adapter. No registry or worker consumes this entrypoint. */
export async function executeSecondReviewItem(input: {
  secondReviewId: number; owner: ItemOwner; signal?: AbortSignal;
}): Promise<SecondReviewItemOutcome> {
  const { secondReviewId, owner: ownerValue, signal: callerSignal } = input;
  const id = z.number().int().positive().safe().parse(secondReviewId), owner = itemOwnerSchema.parse(ownerValue);
  if (callerSignal?.aborted) return { state: "skipped", reason: "aborted" };
  const claimed = await claimItemSecondReview(id, owner, STALE_LOCK_MS);
  if (claimed.kind === "skipped") return { state: "skipped", reason: claimed.reason };
  if (claimed.kind !== "claimed" || claimed.receipt.ownership.kind !== "item") throw new Error("invalid_second_review_item_claim");
  const receipt = claimed.receipt as SecondReviewItemReceipt;
  const { provider, model } = claimed.row;
  if (!provider || !model) throw new Error("invalid_second_review_reviewer");
  const cancelled = () => recordSecondReview({ receipt, result: { ok: false, error: "cancelled", provider, model } });
  const ownerLost = new AbortController();
  const signal = AbortSignal.any([ownerLost.signal, ...(callerSignal ? [callerSignal] : [])]);
  let stopping = false, cancelDelay: (() => void) | undefined, renewalFailure: { error: unknown } | undefined;
  const heartbeat = (async () => {
    while (!stopping) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15_000);
        cancelDelay = () => { clearTimeout(timer); resolve(); };
      });
      cancelDelay = undefined;
      if (stopping) return;
      try {
        if (!await renewSecondReviewOwnership(receipt, STALE_LOCK_MS)) { ownerLost.abort(); return; }
      } catch (error) {
        renewalFailure = { error };
        ownerLost.abort();
        return;
      }
    }
  })();
  let result: AgentReviewResult | undefined;
  try {
    const observed = await observeSecondReviewItemDispatch(receipt);
    if (observed.kind === "current" && !signal.aborted) {
      const { row, input: reviewInput } = observed;
      result = await dispatchSecondReviewTransport({ stage: "second", candidateId: row.candidateId,
        firstAttemptId: row.firstAttemptId, secondReviewId: row.id, generationKey: row.generationKey,
        vote: row.fallbackForId ?? row.id, provider, model }, reviewInput,
      { timeoutMs: secondReviewTransportTimeoutMs(provider), signal });
    }
  } finally {
    // Caller abort never stops renewal before the actual transport has settled.
    stopping = true;
    cancelDelay?.();
    await heartbeat;
  }
  if (renewalFailure) throw renewalFailure.error;
  if (!result || signal.aborted || !result.ok && result.error === "cancelled") return cancelled();
  return recordSecondReview({ receipt, result: result.ok
    ? { ok: true, decision: result.outcome.decision, confidence: result.outcome.confidence ?? null,
      reason: result.outcome.reason, model, provider }
    : { ok: false, error: result.error, detail: result.detail, model, provider } });
}
