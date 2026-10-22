import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { Ai2ModelDispatch, CliModelDispatch } from "@/lib/llm/capacity";
import type { PreparedAi2GatewayCall } from "./agent-review-gateway";
import type { SecondReviewModelReservationRequired, SecondReviewModelClaim, SecondReviewCliModelClaim } from "./second-review-ownership";
import type { PreparedReviewCliCall } from "./review-cli-call";
import { itemOwnerSchema, type ItemOwner } from "@/lib/jobs/items/types";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import type { AgentReviewResult } from "./agent-review";
import { claimConsumerItemSecondReview, claimItemSecondReview, observeSecondReviewItemDispatch, renewSecondReviewOwnership,
  SecondReviewCliModelReservationRequired, type SecondReviewItemReceipt } from "./second-review-ownership";
import { recordSecondReview, type SecondReviewWriteResult } from "./second-review";
import { dispatchSecondReviewTransport, secondReviewTransportTimeoutMs } from "./second-review-transport";

export type SecondReviewItemOutcome =
  | { state: "skipped"; reason: "stage_inactive" | "not_pending" | "input_changed" | "running" | "aborted" }
  | SecondReviewWriteResult;

/** item 소유권의 lease 길이(ttlMs)와 연장 간격(renewEveryMs). 만료 시각은 claim·연장 때 DB clock_timestamp()+ttlMs 로 정한다. */
export type SecondReviewItemLeaseTiming = { ttlMs: number; renewEveryMs: number };
/** 운영 값: 90초 lease 를 15초(lease 의 1/6)마다 연장한다. consumer·replay 를 포함한 운영 경로는 언제나 이 값이다. */
export const SECOND_REVIEW_ITEM_LEASE: Readonly<SecondReviewItemLeaseTiming> = Object.freeze({ ttlMs: STALE_LOCK_MS, renewEveryMs: 15_000 });
const leaseTimingSchema = z.object({ ttlMs: z.number().int().min(1).max(3_600_000).safe(), renewEveryMs: z.number().int().min(1).safe() }).strict()
  .refine(value => value.renewEveryMs < value.ttlMs, "renew_every_must_be_below_ttl");

export async function executeSecondReviewConsumerItem(input: {
  secondReviewId: number; owner: ItemOwner; signal?: AbortSignal;
  /** 새 claim·dispatch 만 막는 신호(replay 구간 끝). 이미 보낸 호출은 signal 이 끊기 전까지 끝까지 받는다 */
  stopClaims?: AbortSignal;
  /** provider 회로(PR06e)에 실제 호출 결과만 알린다. 호출이 없던 항목은 부르지 않는다 */
  onProviderResult?: (result: AgentReviewResult) => void;
}): Promise<SecondReviewItemOutcome> {
  return executeItem(input, 'consumer');
}

/** Inactive single-item adapter. No registry or worker consumes this entrypoint. */
export async function executeSecondReviewItem(input: {
  secondReviewId: number; owner: ItemOwner; signal?: AbortSignal;
  /**
   * 통합 시험만 짧게 준다(2026-10-22 사용자 결정: 90초 실시간 대기 대신 같은 claim·연장·만료 경로를 짧은 lease 로 돈다).
   * 생략하면 운영 값 SECOND_REVIEW_ITEM_LEASE 다. 이 adapter 는 모델 슬롯 경로를 타지 않아 claim·연장이 모두 이 값을 쓴다.
   */
  lease?: SecondReviewItemLeaseTiming;
}): Promise<SecondReviewItemOutcome> {
  return executeItem(input, 'compatibility');
}

async function executeItem(input: {
  secondReviewId: number; owner: ItemOwner; signal?: AbortSignal; stopClaims?: AbortSignal; onProviderResult?: (result: AgentReviewResult) => void;
  lease?: SecondReviewItemLeaseTiming;
}, purpose: 'consumer' | 'compatibility'): Promise<SecondReviewItemOutcome> {
  const { secondReviewId, owner: ownerValue, signal: callerSignal, stopClaims } = input;
  const id = z.number().int().positive().safe().parse(secondReviewId), owner = itemOwnerSchema.parse(ownerValue);
  // consumer 는 모델 슬롯 claim 이 운영 lease 를 직접 쓰므로 주입을 받지 않는다(호환 adapter 만 시험 값을 받는다).
  const { ttlMs, renewEveryMs } = purpose === 'compatibility' && input.lease !== undefined
    ? leaseTimingSchema.parse(input.lease) : SECOND_REVIEW_ITEM_LEASE;
  if (callerSignal?.aborted || stopClaims?.aborted) return { state: "skipped", reason: "aborted" };
  let claimed: SecondReviewModelClaim | SecondReviewCliModelClaim, capacity: typeof import("./second-review-model-capacity") | undefined;
  let dispatch: Ai2ModelDispatch | undefined, call: PreparedAi2GatewayCall | undefined;
  // CLI 표(05c-4): 고정 CLI 의도 class 만 CLI coordinator 로 간다. 슬롯 deferred 는 아래 기록 전에 던져진다.
  let cli: { capacity: typeof import("./review-cli-model-capacity"); call: PreparedReviewCliCall; dispatch: CliModelDispatch } | undefined;
  try { claimed = await (purpose === 'consumer' ? claimConsumerItemSecondReview : claimItemSecondReview)(id, owner, ttlMs); }
  catch (error) {
    if (!(error instanceof ModelCapacityDeferredError) || error.reason !== "reservation_required") throw error;
    if (error instanceof SecondReviewCliModelReservationRequired) {
      const cliCapacity = await import("./review-cli-model-capacity");
      const admitted = await cliCapacity.claimSecondReviewCliModelCapacity(error, callerSignal);
      claimed = admitted.claim;
      if (admitted.claim.dispatch) cli = { capacity: cliCapacity, call: admitted.call, dispatch: admitted.claim.dispatch };
    } else {
      capacity = await import("./second-review-model-capacity");
      // The coordinator requires the actual fixed intent instance, not this reason.
      const admitted = await capacity.claimSecondReviewModelCapacity(error as SecondReviewModelReservationRequired, callerSignal);
      claimed = admitted.claim; dispatch = admitted.claim.dispatch; call = admitted.call;
    }
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
        const timer = setTimeout(resolve, renewEveryMs);
        cancelDelay = () => { clearTimeout(timer); resolve(); };
      });
      cancelDelay = undefined;
      if (stopping) return;
      try {
        if (!await renewSecondReviewOwnership(receipt, ttlMs)) { ownerLost.abort(); return; }
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
    if (observed.kind === "current" && !signal.aborted && !stopClaims?.aborted) {
      const { row, input: reviewInput } = observed;
      if (dispatch) {
        if (!capacity || !call) throw new Error("ai2_model_dispatch_missing");
        const admitted = dispatch.binding;
        if (admitted.rowIdentityHash === receipt.rowIdentityHash && admitted.failureCount === row.failureCount
          && isDeepStrictEqual(admitted.review, receipt.binding) && admitted.review.inputHash === reviewInput.inputHash
          && admitted.review.sourceRevisionHash === reviewInput.sourceRevisionHash && admitted.inputPolicyHash === reviewInput.policyHash)
          result = await capacity.reviewSecondReviewModelCapacity(reviewInput, dispatch, call,
            { timeoutMs: secondReviewTransportTimeoutMs(provider), signal });
        else await capacity.abandonSecondReviewModelCapacity(dispatch, call);
      } else if (cli) {
        // gateway 와 같은 확인: 같은 원 행·실패 수·입력일 때만 실행하고, 아니면 spawn 없이 not_started 로 닫는다
        const admitted = cli.dispatch.binding;
        if (admitted.kind === "ai2_item_cli" && admitted.rowIdentityHash === receipt.rowIdentityHash && admitted.failureCount === row.failureCount
          && isDeepStrictEqual(admitted.review, receipt.binding) && admitted.review.inputHash === reviewInput.inputHash
          && admitted.review.sourceRevisionHash === reviewInput.sourceRevisionHash && admitted.inputPolicyHash === reviewInput.policyHash)
          result = await cli.capacity.reviewCliModelCapacity(reviewInput, cli.dispatch, cli.call, { signal });
        else await cli.capacity.abandonCliModelCapacity(cli.dispatch, cli.call);
      } else result = await dispatchSecondReviewTransport({ stage: "second", candidateId: row.candidateId,
        firstAttemptId: row.firstAttemptId, secondReviewId: row.id, generationKey: row.generationKey,
        vote: row.fallbackForId ?? row.id, provider, model }, reviewInput,
      { timeoutMs: secondReviewTransportTimeoutMs(provider), signal, itemReceipt: receipt });
    } else if (dispatch) {
      if (!capacity) throw new Error("ai2_model_dispatch_missing");
      await capacity.abandonSecondReviewModelCapacity(dispatch, call);
    } else if (cli) await cli.capacity.abandonCliModelCapacity(cli.dispatch, cli.call);
  } finally {
    // Caller abort never stops renewal before the actual transport has settled.
    stopping = true;
    cancelDelay?.();
    await heartbeat;
  }
  if (result) input.onProviderResult?.(result);
  if (renewalFailure) throw renewalFailure.error;
  if (!result || signal.aborted || !result.ok && result.error === "cancelled") return cancelled();
  return recordSecondReview({ receipt, result: result.ok
    ? { ok: true, decision: result.outcome.decision, confidence: result.outcome.confidence ?? null,
      reason: result.outcome.reason, model, provider }
    : { ok: false, error: result.error, detail: result.detail, model, provider } });
}
