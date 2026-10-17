import { beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * F2 결함 1·3 coordinator 경계(mock). 실제 장부 권한은 tests/integration/gateway-not-started-ledger.test.ts 가 증명한다.
 * - 1: fetch 전 포기(not_started 증인)는 indeterminate 대신 not_started 정산으로 간다. 증인이 없으면 지금처럼 local_abort.
 * - 3: 물리 종료 정산 TX 가 실패하면 행을 dispatched 로 두지 않고 indeterminate(commit_unknown) 표시를 시도한다(실패는 삼킴).
 */
const mocks = vi.hoisted(() => ({ unknown: vi.fn(), reconcileAi1: vi.fn(), reconcileItem: vi.fn(), reconcileAi2: vi.fn(),
  reconcileUnsent: vi.fn(), native: vi.fn(), item: vi.fn(), ai2: vi.fn(), settle: vi.fn(), settleItem: vi.fn(), settleAi2: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", () => ({ markModelDispatchIndeterminate: mocks.unknown,
  reconcileAi1GatewayTerminal: mocks.reconcileAi1, reconcileAi1ItemGatewayTerminal: mocks.reconcileItem,
  reconcileAi2GatewayTerminal: mocks.reconcileAi2, reconcileGatewayNotStarted: mocks.reconcileUnsent }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ reviewWithReservedAi1Gateway: mocks.native, reviewWithReservedAi1ItemGateway: mocks.item,
  reviewWithReservedAi2Gateway: mocks.ai2, settleAi1GatewayNotStarted: mocks.settle, settleAi1ItemGatewayNotStarted: mocks.settleItem,
  settleAi2GatewayNotStarted: mocks.settleAi2 }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));
import { abandonAgentReviewItemModelCapacity, abandonAgentReviewModelCapacity, reviewAgentReviewItemModelCapacity,
  reviewAgentReviewModelCapacity } from "@/lib/crawl/agent-review-model-capacity";
import { abandonSecondReviewModelCapacity, reviewSecondReviewModelCapacity } from "@/lib/crawl/second-review-model-capacity";
import { ai1DispatchBindingHash, ai1ItemDispatchBindingHash, ai2DispatchBindingHash, type Ai1ItemModelDispatch,
  type Ai1ModelDispatch, type Ai2ModelDispatch } from "@/lib/llm/capacity";
import { itemBindingHash, type Ai1ItemBinding, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import type { ReviewInput } from "@/lib/crawl/agent-review-contract";

const hash = "a".repeat(64), model = "Exact Model";
const handle = () => ({ requestId: randomUUID(), owner: { instanceId: "f2-coordinator", bootId: randomUUID() }, token: randomUUID(),
  epoch: 1, revision: 1, policyHash: "f".repeat(64) });
function ai1(): Ai1ModelDispatch {
  const binding = { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", candidateId: 1, attemptId: 1,
    inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: "p", rulesVersion: "r", provider: "abcllm" as const,
    model, routeId: "crawl-agent-review" as const, stageEpoch: 1, wireHash: hash, servingContractHash: hash, totalTokenBound: 8192,
    chargedTokens: 8192, job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
  return { ...handle(), binding, bindingHash: ai1DispatchBindingHash(binding) } as Ai1ModelDispatch;
}
function item(): Ai1ItemModelDispatch {
  const base = handle();
  const review: Ai1ItemBinding = { stage: "ai1", candidateId: 1, inputHash: hash, sourceRevisionHash: hash, policyHash: hash,
    promptVersion: "p", rulesVersion: "r", reviewer: { provider: "abcllm", model } };
  const binding = { kind: "ai1_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", attemptId: 2, review,
    item: { workKey: "ai1:1", owner: base.owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1, bindingHash: itemBindingHash(review) },
    routeId: "crawl-agent-review" as const, provider: "abcllm" as const, model, wireHash: hash, servingContractHash: hash,
    totalTokenBound: 8192, chargedTokens: 8192 };
  return { ...base, binding, bindingHash: ai1ItemDispatchBindingHash(binding) } as Ai1ItemModelDispatch;
}
function ai2(): Ai2ModelDispatch {
  const base = handle();
  const review: Ai2ItemBinding = { stage: "ai2", candidateId: 1, secondReviewId: 3, vote: 3, fallbackForId: null, inputHash: hash,
    sourceRevisionHash: hash, policyHash: hash, generationKey: hash, source: { kind: "first_attempt", firstAttemptId: 2 },
    promptVersion: "p", rulesVersion: "r", reviewer: { provider: "abcllm", model } };
  const binding = { kind: "ai2_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai2:1:3", review, rowIdentityHash: hash,
    failureCount: 0, inputPolicyHash: hash, item: { workKey: "ai2:3", owner: base.owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1,
      bindingHash: itemBindingHash(review) }, provider: "abcllm" as const, model, routeId: "second-review" as const, wireHash: hash,
    servingContractHash: hash, totalTokenBound: 8192, chargedTokens: 8192 };
  return { ...base, binding, bindingHash: ai2DispatchBindingHash(binding) } as Ai2ModelDispatch;
}
const input = {} as ReviewInput, call = Object.freeze({ boundary: "prepared-opaque" }) as never;
const witness = Object.freeze({ kind: "gateway_not_started" }), terminal = Object.freeze({ boundary: "native-terminal" });
beforeEach(() => { vi.resetAllMocks(); mocks.unknown.mockResolvedValue(true); mocks.reconcileUnsent.mockResolvedValue({ kind: "settled" }); });

const lanes = [
  { name: "AI1", dispatch: ai1, review: () => reviewAgentReviewModelCapacity, native: mocks.native, reconcile: mocks.reconcileAi1 },
  { name: "AI1 item", dispatch: item, review: () => reviewAgentReviewItemModelCapacity, native: mocks.item, reconcile: mocks.reconcileItem },
  { name: "AI2", dispatch: ai2, review: () => reviewSecondReviewModelCapacity, native: mocks.ai2, reconcile: mocks.reconcileAi2 },
] as const;

it.each(lanes)("$name: a pre-fetch not_started witness settles the dispatch instead of marking it indeterminate", async lane => {
  const dispatch = lane.dispatch(), result = { ok: false, error: "cancelled" };
  lane.native.mockResolvedValue({ result, terminal: null, notStarted: witness });
  expect(await (lane.review() as (...args: unknown[]) => Promise<unknown>)(input, dispatch, call, { signal: AbortSignal.abort() })).toBe(result);
  expect(mocks.reconcileUnsent).toHaveBeenCalledExactlyOnceWith(witness);
  expect(mocks.unknown).not.toHaveBeenCalled(); expect(lane.reconcile).not.toHaveBeenCalled();
});

it.each(lanes)("$name: a failed physical settlement marks commit_unknown, keeps the original errors and swallows a mark failure", async lane => {
  const review = lane.review() as (...args: unknown[]) => Promise<unknown>;
  const settlementError = (pending: Promise<unknown>) => pending.then(() => null, (value: AggregateError) => value);
  const dispatch = lane.dispatch(), failed = { ok: false, error: "invalid_output" }, cleanup = new Error("settlement write failed");
  lane.native.mockResolvedValue({ result: failed, terminal }); lane.reconcile.mockRejectedValue(cleanup);
  const error = await settlementError(review(input, dispatch, call, {}));
  expect(error).toBeInstanceOf(AggregateError); expect(error?.errors).toEqual([failed, cleanup]);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "commit_unknown");
  // 성공 결과의 정산 실패도 같은 표시를 하고 원 정산 오류를 그대로 던진다. 표시까지 실패하면 남기고 삼킨다
  vi.clearAllMocks(); mocks.unknown.mockRejectedValue(new Error("mark failed"));
  lane.native.mockResolvedValue({ result: { ok: true, outcome: {}, usage: {} }, terminal }); lane.reconcile.mockRejectedValue(cleanup);
  await expect(review(input, dispatch, call, {})).rejects.toBe(cleanup);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "commit_unknown");
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("model_capacity.unsettled_mark_failed", { requestId: dispatch.requestId, error: "mark failed" });
  // not_started 정산이 실패해도 같다
  vi.clearAllMocks(); mocks.unknown.mockResolvedValue(true);
  lane.native.mockResolvedValue({ result: failed, terminal: null, notStarted: witness }); mocks.reconcileUnsent.mockRejectedValue(cleanup);
  expect((await settlementError(review(input, dispatch, call, {})))?.errors).toEqual([failed, cleanup]);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "commit_unknown");
});

it.each(lanes)("$name: no witness and no terminal keeps the original unknown marking", async lane => {
  const dispatch = lane.dispatch(), result = { ok: false, error: "timeout" };
  lane.native.mockResolvedValue({ result, terminal: null });
  expect(await (lane.review() as (...args: unknown[]) => Promise<unknown>)(input, dispatch, call, {})).toBe(result);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "transport_unknown"); expect(mocks.reconcileUnsent).not.toHaveBeenCalled();
});

const abandons = [
  { name: "AI1", dispatch: ai1, abandon: abandonAgentReviewModelCapacity as (d: never, c?: never) => Promise<boolean>, settle: mocks.settle },
  { name: "AI1 item", dispatch: item, abandon: abandonAgentReviewItemModelCapacity as (d: never, c?: never) => Promise<boolean>, settle: mocks.settleItem },
  { name: "AI2", dispatch: ai2, abandon: abandonSecondReviewModelCapacity as (d: never, c?: never) => Promise<boolean>, settle: mocks.settleAi2 },
] as const;

it.each(abandons)("$name: abandon with an unused preparation settles not_started; without proof it keeps local_abort", async lane => {
  const dispatch = lane.dispatch() as never;
  lane.settle.mockReturnValue(witness);
  expect(await lane.abandon(dispatch, call)).toBe(true);
  expect(lane.settle).toHaveBeenCalledExactlyOnceWith(call, dispatch);
  expect(mocks.reconcileUnsent).toHaveBeenCalledExactlyOnceWith(witness); expect(mocks.unknown).not.toHaveBeenCalled();
  for (const settle of [() => lane.settle.mockReturnValue(null), () => lane.settle.mockImplementation(() => { throw new Error("call_mismatch"); })]) {
    vi.clearAllMocks(); mocks.unknown.mockResolvedValue(true); settle();
    expect(await lane.abandon(dispatch, call)).toBe(true);
    expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "local_abort"); expect(mocks.reconcileUnsent).not.toHaveBeenCalled();
  }
  vi.clearAllMocks(); mocks.unknown.mockResolvedValue(true);
  expect(await lane.abandon(dispatch)).toBe(true);
  expect(lane.settle).not.toHaveBeenCalled(); expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "local_abort");
});

it.each(abandons)("$name: a failed not_started settlement on abandon marks commit_unknown and rethrows", async lane => {
  const dispatch = lane.dispatch() as never, cleanup = new Error("not started write failed");
  lane.settle.mockReturnValue(witness); mocks.reconcileUnsent.mockRejectedValue(cleanup);
  await expect(lane.abandon(dispatch, call)).rejects.toBe(cleanup);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "commit_unknown");
});
