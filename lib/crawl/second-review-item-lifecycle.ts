import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { Ai2ModelDispatch } from "@/lib/llm/capacity";
import type { PreparedAi2GatewayCall } from "./agent-review-gateway";
import type { SecondReviewModelReservationRequired, SecondReviewModelClaim } from "./second-review-ownership";
import { itemOwnerSchema, type ItemOwner } from "@/lib/jobs/items/types";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import type { AgentReviewResult } from "./agent-review";
import { claimConsumerItemSecondReview, claimItemSecondReview, observeSecondReviewItemDispatch, renewSecondReviewOwnership, type SecondReviewItemReceipt } from "./second-review-ownership";
import { recordSecondReview, type SecondReviewWriteResult } from "./second-review";
import { dispatchSecondReviewTransport, secondReviewTransportTimeoutMs } from "./second-review-transport";

export type SecondReviewItemOutcome =
  | { state: "skipped"; reason: "stage_inactive" | "not_pending" | "input_changed" | "running" | "aborted" }
  | SecondReviewWriteResult;

export async function executeSecondReviewConsumerItem(input: {
  secondReviewId: number; owner: ItemOwner; signal?: AbortSignal;
}): Promise<SecondReviewItemOutcome> {
  return executeItem(input, 'consumer');
}

/** Inactive single-item adapter. No registry or worker consumes this entrypoint. */
export async function executeSecondReviewItem(input: {
  secondReviewId: number; owner: ItemOwner; signal?: AbortSignal;
}): Promise<SecondReviewItemOutcome> {
  return executeItem(input, 'compatibility');
}

async function executeItem(input: {
  secondReviewId: number; owner: ItemOwner; signal?: AbortSignal;
}, purpose: 'consumer' | 'compatibility'): Promise<SecondReviewItemOutcome> {
  const { secondReviewId, owner: ownerValue, signal: callerSignal } = input;
  const id = z.number().int().positive().safe().parse(secondReviewId), owner = itemOwnerSchema.parse(ownerValue);
  if (callerSignal?.aborted) return { state: "skipped", reason: "aborted" };
  let claimed: SecondReviewModelClaim, capacity: typeof import("./second-review-model-capacity") | undefined;
  let dispatch: Ai2ModelDispatch | undefined, call: PreparedAi2GatewayCall | undefined;
  try { claimed = await (purpose === 'consumer' ? claimConsumerItemSecondReview : claimItemSecondReview)(id, owner, STALE_LOCK_MS); }
  catch (error) {
    if (!(error instanceof ModelCapacityDeferredError) || error.reason !== "reservation_required") throw error;
    capacity = await import("./second-review-model-capacity");
    // The coordinator requires the actual fixed intent instance, not this reason.
    const admitted = await capacity.claimSecondReviewModelCapacity(error as SecondReviewModelReservationRequired, callerSignal);
    claimed = admitted.claim; dispatch = claimed.dispatch; call = admitted.call;
  }
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
      if (dispatch) {
        if (!capacity || !call) throw new Error("ai2_model_dispatch_missing");
        const admitted = dispatch.binding;
        if (admitted.rowIdentityHash === receipt.rowIdentityHash && admitted.failureCount === row.failureCount
          && isDeepStrictEqual(admitted.review, receipt.binding) && admitted.review.inputHash === reviewInput.inputHash
          && admitted.review.sourceRevisionHash === reviewInput.sourceRevisionHash && admitted.inputPolicyHash === reviewInput.policyHash)
          result = await capacity.reviewSecondReviewModelCapacity(reviewInput, dispatch, call,
            { timeoutMs: secondReviewTransportTimeoutMs(provider), signal });
        else await capacity.abandonSecondReviewModelCapacity(dispatch);
      } else result = await dispatchSecondReviewTransport({ stage: "second", candidateId: row.candidateId,
        firstAttemptId: row.firstAttemptId, secondReviewId: row.id, generationKey: row.generationKey,
        vote: row.fallbackForId ?? row.id, provider, model }, reviewInput,
      { timeoutMs: secondReviewTransportTimeoutMs(provider), signal, itemReceipt: receipt });
    } else if (dispatch) {
      if (!capacity) throw new Error("ai2_model_dispatch_missing");
      await capacity.abandonSecondReviewModelCapacity(dispatch);
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
