import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewInput } from "@/lib/crawl/agent-review-contract";
import type { SecondReview } from "@/lib/db/schema";
import type { SecondReviewItemReceipt } from "@/lib/crawl/second-review-ownership";
import { executeSecondReviewItem } from "@/lib/crawl/second-review-item-lifecycle";

const mocks = vi.hoisted(() => ({ claim: vi.fn(), observe: vi.fn(), renew: vi.fn(), record: vi.fn(), dispatch: vi.fn(), timeout: vi.fn() }));
vi.mock("@/lib/crawl/second-review-ownership", () => ({
  claimItemSecondReview: mocks.claim, observeSecondReviewItemDispatch: mocks.observe, renewSecondReviewOwnership: mocks.renew,
}));
vi.mock("@/lib/crawl/second-review", () => ({ recordSecondReview: mocks.record }));
vi.mock("@/lib/crawl/second-review-transport", () => ({
  dispatchSecondReviewTransport: mocks.dispatch, secondReviewTransportTimeoutMs: mocks.timeout,
}));

const owner = () => ({ instanceId: "item-worker", bootId: "f70bfcce-92d0-4ed8-a5db-bfd092d17950" });
// Unit orchestration fixtures only. The independent DB suite uses real receipts.
const row = { id: 41, candidateId: 11, firstAttemptId: 31, generationKey: "generation", fallbackForId: null,
  provider: "abcllm", model: "second-model" } as SecondReview;
const input = { inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64) } as ReviewInput;
const observedInput = { ...input, policyHash: "c".repeat(64) } as ReviewInput;
const receipt = { binding: { secondReviewId: row.id }, ownership: { kind: "item" } } as SecondReviewItemReceipt;
const successful = { ok: true, outcome: { decision: "approve", confidence: 0.94, reason: "A task application" } };
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.claim.mockResolvedValue({ kind: "claimed", row, input, receipt });
  mocks.observe.mockResolvedValue({ kind: "current", row, input: observedInput });
  mocks.renew.mockResolvedValue({ observedLeaseUntil: new Date() });
  mocks.timeout.mockReturnValue(60_000);
  mocks.dispatch.mockResolvedValue(successful);
  mocks.record.mockResolvedValue({ state: "recorded" });
});

afterEach(() => { vi.useRealTimers(); });

it("does not claim or dispatch a pre-aborted item", async () => {
  const abort = new AbortController(); abort.abort();
  expect(await executeSecondReviewItem({ secondReviewId: 41, owner: owner(), signal: abort.signal }))
    .toEqual({ state: "skipped", reason: "aborted" });
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])("rejects invalid item id %s before claiming", async secondReviewId => {
  await expect(executeSecondReviewItem({ secondReviewId, owner: owner() })).rejects.toThrow();
  expect(mocks.claim).not.toHaveBeenCalled();
});

it("strictly validates and snapshots the owner before awaiting the claim", async () => {
  await expect(executeSecondReviewItem({ secondReviewId: 41, owner: { ...owner(), bootId: "bad" } })).rejects.toThrow();
  await expect(executeSecondReviewItem({ secondReviewId: 41, owner: { ...owner(), extra: true } as ReturnType<typeof owner> })).rejects.toThrow();
  const claimed = gate<unknown>(), caller = owner();
  mocks.claim.mockReturnValueOnce(claimed.promise);
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: caller });
  expect(mocks.claim).toHaveBeenCalledWith(41, owner(), 90_000);
  expect(mocks.claim.mock.calls[0][1]).not.toBe(caller);
  caller.instanceId = "changed-after-entry";
  expect(mocks.claim.mock.calls[0][1]).toEqual(owner());
  claimed.resolve({ kind: "skipped", reason: "running" });
  await work;
});

it.each(["stage_inactive", "not_pending", "input_changed", "running"] as const)("preserves actual claim skip %s", async reason => {
  mocks.claim.mockResolvedValue({ kind: "skipped", reason });
  expect(await executeSecondReviewItem({ secondReviewId: 41, owner: owner() })).toEqual({ state: "skipped", reason });
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});

it.each(["admitted", "wrong-owner"])("rejects unexpected %s claim authority", async kind => {
  mocks.claim.mockResolvedValue({ kind: kind === "admitted" ? kind : "claimed", row, input,
    receipt: kind === "admitted" ? receipt : { ...receipt, ownership: { kind: "legacy" } } });
  await expect(executeSecondReviewItem({ secondReviewId: 41, owner: owner() })).rejects.toThrow("invalid_second_review_item_claim");
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});

it.each(["stage_inactive", "not_pending", "input_changed"] as const)("settles only its original receipt after observer stop %s", async reason => {
  mocks.observe.mockResolvedValue({ kind: "stopped", reason });
  mocks.record.mockResolvedValue({ state: "cancelled" });
  expect(await executeSecondReviewItem({ secondReviewId: 41, owner: owner() })).toEqual({ state: "cancelled" });
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ receipt,
    result: { ok: false, error: "cancelled", provider: row.provider, model: row.model } });
});

it("observes again before dispatch and preserves the exact original receipt and actual input", async () => {
  expect(await executeSecondReviewItem({ secondReviewId: 41, owner: owner() })).toEqual({ state: "recorded" });
  expect(mocks.observe).toHaveBeenCalledExactlyOnceWith(receipt);
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({ stage: "second", candidateId: 11, firstAttemptId: 31,
    secondReviewId: 41, generationKey: "generation", vote: 41, provider: "abcllm", model: "second-model" },
  observedInput, { timeoutMs: 60_000, signal: expect.any(AbortSignal), itemReceipt: receipt });
  expect(mocks.record.mock.calls[0][0].receipt).toBe(receipt);
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ receipt,
    result: { ok: true, decision: "approve", confidence: 0.94, reason: "A task application", provider: row.provider, model: row.model } });
});

it("preserves nullable published first id and the fallback root slot", async () => {
  const published = { ...row, id: 42, firstAttemptId: null, fallbackForId: 41, provider: "grok-cli", model: "grok-model" };
  mocks.claim.mockResolvedValue({ kind: "claimed", row: published, input, receipt });
  mocks.observe.mockResolvedValue({ kind: "current", row: published, input });
  mocks.timeout.mockReturnValue(90_000);
  await executeSecondReviewItem({ secondReviewId: 42, owner: owner() });
  expect(mocks.timeout).toHaveBeenCalledExactlyOnceWith("grok-cli");
  expect(mocks.dispatch.mock.calls[0][0]).toMatchObject({ firstAttemptId: null, vote: 41, secondReviewId: 42, provider: "grok-cli", model: "grok-model" });
});

it("rechecks cancellation after an awaited observer without dispatching", async () => {
  const observed = gate<unknown>(), abort = new AbortController();
  mocks.observe.mockReturnValueOnce(observed.promise);
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner(), signal: abort.signal });
  await vi.waitFor(() => expect(mocks.observe).toHaveBeenCalledOnce());
  abort.abort();
  observed.resolve({ kind: "current", row, input });
  await work;
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.record.mock.calls[0][0].result.error).toBe("cancelled");
});

it("awaits the actual transport after abort before the single cancelled writer", async () => {
  const transport = gate<typeof successful>(), abort = new AbortController();
  mocks.dispatch.mockReturnValueOnce(transport.promise);
  let finished = false;
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner(), signal: abort.signal }).finally(() => { finished = true; });
  await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
  abort.abort();
  expect(mocks.dispatch.mock.calls[0][2].signal.aborted).toBe(true);
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(mocks.record).not.toHaveBeenCalled();
  transport.resolve(successful);
  await work;
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ receipt,
    result: { ok: false, error: "cancelled", provider: row.provider, model: row.model } });
});

it("passes structured failures and detail through the existing writer", async () => {
  mocks.dispatch.mockResolvedValue({ ok: false, error: "gateway_error", detail: "upstream detail" });
  await executeSecondReviewItem({ secondReviewId: 41, owner: owner() });
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ receipt,
    result: { ok: false, error: "gateway_error", detail: "upstream detail", model: row.model, provider: row.provider } });
});

it("uses the cancelled writer for a structured adapter cancellation", async () => {
  mocks.dispatch.mockResolvedValue({ ok: false, error: "cancelled" });
  await executeSecondReviewItem({ secondReviewId: 41, owner: owner() });
  expect(mocks.record.mock.calls[0][0].result).toEqual({ ok: false, error: "cancelled", model: row.model, provider: row.provider });
});

it.each([{ state: "recorded" }, { state: "not_pending" }, { state: "cancelled" },
  { state: "input_changed", reason: "context_invalid" }, { state: "input_changed", reason: "binding_changed" }])("preserves writer outcome $state $reason", async result => {
  mocks.record.mockResolvedValue(result);
  expect(await executeSecondReviewItem({ secondReviewId: 41, owner: owner() })).toBe(result);
  expect(mocks.record).toHaveBeenCalledTimes(1);
});

it("preserves an unexpected transport rejection and never synthesizes a failure or release", async () => {
  const error = new Error("unexpected transport failure");
  mocks.dispatch.mockRejectedValue(error);
  await expect(executeSecondReviewItem({ secondReviewId: 41, owner: owner() })).rejects.toBe(error);
  expect(mocks.record).not.toHaveBeenCalled();
});

it("preserves observer and writer errors without a second cleanup writer", async () => {
  const observation = new Error("item_lease_lost");
  mocks.observe.mockRejectedValueOnce(observation);
  await expect(executeSecondReviewItem({ secondReviewId: 41, owner: owner() })).rejects.toBe(observation);
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
  const write = new Error("outbox failure");
  mocks.record.mockRejectedValueOnce(write);
  await expect(executeSecondReviewItem({ secondReviewId: 41, owner: owner() })).rejects.toBe(write);
  expect(mocks.record).toHaveBeenCalledTimes(1);
});

async function transportStarted() {
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dispatch).toHaveBeenCalledOnce();
}

it("renews the original owner every completed 15-second delay without overlapping or catching up", async () => {
  vi.useFakeTimers();
  const transport = gate<typeof successful>(), renewal = gate<unknown>();
  mocks.dispatch.mockReturnValueOnce(transport.promise);
  mocks.renew.mockReturnValueOnce(renewal.promise);
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner() });
  try {
    await transportStarted();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(receipt, 90_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    expect(mocks.record).not.toHaveBeenCalled();
    renewal.resolve({ differentObservedExpiry: true });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.renew).toHaveBeenCalledTimes(2);
  } finally {
    transport.resolve(successful); renewal.resolve({}); await work;
  }
  expect(mocks.record.mock.calls[0][0].receipt).toBe(receipt);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.renew).toHaveBeenCalledTimes(2);
});

it("keeps renewing after caller abort until the actual transport settles", async () => {
  vi.useFakeTimers();
  const transport = gate<typeof successful>(), abort = new AbortController();
  mocks.dispatch.mockReturnValueOnce(transport.promise);
  let finished = false;
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner(), signal: abort.signal }).finally(() => { finished = true; });
  try {
    await transportStarted(); abort.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.renew).toHaveBeenCalledTimes(2);
    expect(finished).toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  } finally { transport.resolve(successful); await work; }
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ receipt,
    result: { ok: false, error: "cancelled", provider: row.provider, model: row.model } });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.renew).toHaveBeenCalledTimes(2);
});

it("stops scheduling and awaits the current renewal before entering the result writer", async () => {
  vi.useFakeTimers();
  const transport = gate<typeof successful>(), renewal = gate<unknown>();
  mocks.dispatch.mockReturnValueOnce(transport.promise);
  mocks.renew.mockReturnValueOnce(renewal.promise);
  let finished = false;
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner() }).finally(() => { finished = true; });
  try {
    await transportStarted();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.renew).toHaveBeenCalledOnce();
    transport.resolve(successful);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(finished).toBe(false);
  } finally { transport.resolve(successful); renewal.resolve({}); await work; }
  expect(mocks.record).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.renew).toHaveBeenCalledTimes(1);
});

it("aborts on renewal loss but waits for transport and preserves the original writer CAS rejection", async () => {
  vi.useFakeTimers();
  const transport = gate<typeof successful>(), lost = new Error("item_lease_lost");
  mocks.dispatch.mockReturnValueOnce(transport.promise);
  mocks.renew.mockResolvedValue(null);
  mocks.record.mockRejectedValue(lost);
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner() });
  void work.catch(() => undefined);
  try {
    await transportStarted();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.dispatch.mock.calls[0][2].signal.aborted).toBe(true);
    expect(mocks.record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(mocks.renew).toHaveBeenCalledTimes(1);
  } finally { transport.resolve(successful); await expect(work).rejects.toBe(lost); }
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ receipt,
    result: { ok: false, error: "cancelled", provider: row.provider, model: row.model } });
});

it.each([false, true])("preserves unexpected renewal failure after drain with transport-rejection priority %s", async transportRejects => {
  vi.useFakeTimers();
  const transport = gate<typeof successful>(), renewalError = new Error("unexpected renew"), transportError = new Error("unexpected transport");
  mocks.dispatch.mockReturnValueOnce(transport.promise);
  mocks.renew.mockRejectedValue(renewalError);
  let finished = false;
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner() }).finally(() => { finished = true; });
  void work.catch(() => undefined);
  try {
    await transportStarted();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.dispatch.mock.calls[0][2].signal.aborted).toBe(true);
    expect(finished).toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  } finally {
    if (transportRejects) transport.reject(transportError); else transport.resolve(successful);
    await expect(work).rejects.toBe(transportRejects ? transportError : renewalError);
  }
  expect(mocks.record).not.toHaveBeenCalled();
});

it("drains an already-running renewal after transport rejects without replacing its exception", async () => {
  vi.useFakeTimers();
  const transport = gate<typeof successful>(), renewal = gate<unknown>(), error = new Error("transport first");
  mocks.dispatch.mockReturnValueOnce(transport.promise);
  mocks.renew.mockReturnValueOnce(renewal.promise);
  let finished = false;
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner() }).finally(() => { finished = true; });
  void work.catch(() => undefined);
  try {
    await transportStarted(); await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.renew).toHaveBeenCalledOnce();
    transport.reject(error); await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  } finally { transport.reject(error); renewal.resolve({}); await expect(work).rejects.toBe(error); }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.renew).toHaveBeenCalledTimes(1);
  expect(mocks.record).not.toHaveBeenCalled();
});

it("never renews after a writer rejection and does not issue a cleanup write", async () => {
  vi.useFakeTimers();
  const transport = gate<typeof successful>(), error = new Error("outbox rollback");
  mocks.dispatch.mockReturnValueOnce(transport.promise);
  mocks.record.mockRejectedValue(error);
  const work = executeSecondReviewItem({ secondReviewId: 41, owner: owner() });
  void work.catch(() => undefined);
  try {
    await transportStarted(); await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.renew).toHaveBeenCalledOnce();
  } finally { transport.resolve(successful); await expect(work).rejects.toBe(error); }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.renew).toHaveBeenCalledTimes(1);
  expect(mocks.record).toHaveBeenCalledTimes(1);
});
