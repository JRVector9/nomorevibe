import { describe, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { createReviewInput, reviewHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { fullReviewPolicyHash } from "@/lib/operations/pipeline-capacity";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import * as transport from "@/lib/crawl/review-fixture-transport";
import type { AgentReviewResult } from "@/lib/crawl/agent-review";
import type { ReplayRun } from "@/lib/operations/pipeline-replay-ledger";
import type { ReviewFixtureCallback, ReviewFixtureLedger } from "@/lib/crawl/review-fixture-transport";

function input() {
  const now = new Date("2026-10-15T00:00:00Z");
  return createReviewInput({ id: 1, repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: { description: "Task tracker" },
      pageMeta: { title: "Demo", textSample: "A usable task tracker" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
const binding = { stage: "first" as const, candidateId: 1, firstAttemptId: 8, provider: "abcllm" as const, model: "fixture-model" };
const result: AgentReviewResult = { ok: true, outcome: { decision: "approve", reason: "The captured page describes a usable tracker.", evidenceIds: ["product"], confidence: 0.99 }, usage: {} };
const receipt = { inputTokens: 8, outputTokens: 2 };
const run = { runId: "fixture-run" } as ReplayRun;
function harness() {
  const events: string[] = [];
  const ledger = {
    fixtureMode: vi.fn<ReviewFixtureLedger["fixtureMode"]>(async () => { events.push("mode"); }),
    reserve: vi.fn<ReviewFixtureLedger["reserve"]>(async () => { events.push("reserved"); }),
    markDispatching: vi.fn<ReviewFixtureLedger["markDispatching"]>(async () => { events.push("dispatching"); }),
    markInFlight: vi.fn<ReviewFixtureLedger["markInFlight"]>(async () => { events.push("in_flight"); }),
    cancelBeforeDispatch: vi.fn<ReviewFixtureLedger["cancelBeforeDispatch"]>(async () => { events.push("cancelled"); }),
    settle: vi.fn<ReviewFixtureLedger["settle"]>(async () => { events.push("settled"); }),
    markIndeterminate: vi.fn<ReviewFixtureLedger["markIndeterminate"]>(async () => { events.push("indeterminate"); }),
  };
  const fixture = vi.fn<ReviewFixtureCallback>(async () => { events.push("fixture"); return { result, receipt }; });
  return { ledger, fixture, events, run, tokenUpperBound: 100, inputs: [{ candidateId: 1, input: input() }],
    fullReviewPolicyHash: fullReviewPolicyHash(DEFAULT_CRAWL_SETTINGS) };
}
function api() {
  expect(transport).toHaveProperty("withReviewFixtureTransport", expect.any(Function));
  expect(transport).toHaveProperty("dispatchReviewFixtureCall", expect.any(Function));
  return transport;
}
function latch<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("fixture model-call boundary", () => {
  it("reserves and settles explicit usage before returning an ordinary result to the writer", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness(), review = input();
    await withReviewFixtureTransport(h, async () => {
      expect(await dispatchReviewFixtureCall(binding, review, { timeoutMs: 20_000 })).toEqual(result);
      h.events.push("writer");
    });
    expect(h.events).toEqual(["mode", "reserved", "dispatching", "in_flight", "fixture", "settled", "writer"]);
    expect(h.ledger.settle).toHaveBeenCalledWith(run, expect.any(String), receipt, { ok: true, outcomeHash: reviewHash(result.ok ? result.outcome : null),
      decisionHash: result.ok ? reviewHash({ decision: result.outcome.decision, confidence: result.outcome.confidence ?? null, reason: result.outcome.reason }) : null });
    expect(h.ledger.reserve).toHaveBeenCalledWith(run, expect.objectContaining({ ...binding,
      inputHash: review.inputHash, sourceRevisionHash: review.sourceRevisionHash, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), tokenUpperBound: 100 }));
    const call = h.fixture.mock.calls[0][0];
    expect(call.input).toEqual(review);
    expect(call.request).toEqual(h.ledger.reserve.mock.calls[0][1]);
  });

  it("settles an unsuccessful response without a successful outcome proof", async () => {
    const h = harness();
    h.fixture.mockResolvedValueOnce({ result: { ok: false, error: "auth" }, receipt });
    await transport.withReviewFixtureTransport(h, () => transport.dispatchReviewFixtureCall(binding, input(), {}));
    expect(h.ledger.settle).toHaveBeenCalledWith(run, expect.any(String), receipt, { ok: false, outcomeHash: null, decisionHash: null });
  });

  it("dispatches no fixture or reservation when already aborted", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness(), controller = new AbortController();
    controller.abort();
    await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, input(), { signal: controller.signal }))).rejects.toThrow("replay_fixture_cancelled");
    expect(h.events).toEqual([]);
  });

  it("cancels a committed reservation when abort arrives during the ledger await", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness(), controller = new AbortController();
    h.ledger.reserve.mockImplementationOnce(async () => { h.events.push("reserved"); controller.abort(); });
    await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, input(), { signal: controller.signal }))).rejects.toThrow("replay_fixture_cancelled");
    expect(h.events).toEqual(["mode", "reserved", "cancelled"]);
    expect(h.fixture).not.toHaveBeenCalled();
  });

  it.each(["fixtureMode", "reserve", "markDispatching", "markInFlight"] as const)("never reaches fixture after %s fails", async step => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness();
    h.ledger[step].mockRejectedValueOnce(new Error("ledger_denied"));
    await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, input(), {}))).rejects.toThrow("ledger_denied");
    expect(h.fixture).not.toHaveBeenCalled();
  });

  it.each([null, { inputTokens: 99, outputTokens: 2 }, { inputTokens: -1, outputTokens: 2 }])("rejects invalid explicit usage %j without returning a writer result", async invalid => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness();
    h.fixture.mockResolvedValueOnce({ result, receipt: invalid });
    await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, input(), {}))).rejects.toThrow("replay_call_indeterminate");
    expect(h.ledger.markIndeterminate).toHaveBeenCalledTimes(1);
  });

  it("keeps thrown fixture and settlement failure indeterminate without retry", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api();
    for (const failure of ["fixture", "settle"] as const) {
      const h = harness();
      if (failure === "fixture") h.fixture.mockRejectedValueOnce(new Error("private_fixture_detail"));
      else h.ledger.settle.mockRejectedValueOnce(new Error("storage_down"));
      await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, input(), {}))).rejects.toThrow("replay_call_indeterminate");
      expect(h.fixture).toHaveBeenCalledTimes(1);
      expect(h.ledger.markIndeterminate).toHaveBeenCalledTimes(1);
    }
  });

  it("binds the actual second-review row, generation and original fallback slot", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness();
    const second = { ...binding, stage: "second" as const, secondReviewId: 90, generationKey: "d".repeat(64), vote: 83 };
    await withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(second, input(), {}));
    expect(h.ledger.reserve).toHaveBeenCalledWith(run, expect.objectContaining(second));
    const sampled = { ...second, firstAttemptId: null };
    await withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(sampled, input(), {}));
    expect(h.ledger.reserve).toHaveBeenLastCalledWith(run, expect.objectContaining(sampled));
  });

  it("binds exact request contents and refuses an input hash that hides changed evidence", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness(), review = input();
    await withReviewFixtureTransport(h, async () => {
      await dispatchReviewFixtureCall(binding, review, { timeoutMs: 20_000 });
      await dispatchReviewFixtureCall({ ...binding, model: "other-model" }, review, { timeoutMs: 20_000 });
    });
    const [first, second] = h.ledger.reserve.mock.calls.map(call => call[1]);
    expect(first.callId).not.toBe(second.callId);
    expect(first.requestHash).not.toBe(second.requestHash);
    const changed: ReviewInput = { ...review, snapshot: { ...review.snapshot, product: { ...review.snapshot.product, name: "Changed" } } };
    await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, changed, {}))).rejects.toThrow("replay_fixture_input_mismatch");
    expect(reviewHash(changed.snapshot)).not.toBe(reviewHash(review.snapshot));
    expect(h.fixture).toHaveBeenCalledTimes(2);
  });

  it("rejects changed evidence ids despite unchanged semantic and source hashes", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness(), review = input();
    review.snapshot.evidence = [{ id: "observation:1", observation: { kind: "instruction_file" } as ReviewInput["snapshot"]["evidence"][number]["observation"] }];
    review.inputHash = reviewHash({ snapshot: { ...review.snapshot, evidence: review.snapshot.evidence.map(item => item.observation) }, policyHash: review.policyHash });
    h.inputs = [{ candidateId: 1, input: review }];
    const changed = structuredClone(review); changed.snapshot.evidence[0].id = "observation:other";
    await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, changed, {}))).rejects.toThrow("replay_fixture_input_mismatch");
    expect(h.ledger.reserve).not.toHaveBeenCalled();
  });

  it("freezes the prepared input universe before the scope callback can mutate it", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness();
    await expect(withReviewFixtureTransport(h, async () => {
      h.inputs[0].input.snapshot.product.name = "Changed after admission";
      h.inputs[0].input.inputHash = reviewHash({ snapshot: { ...h.inputs[0].input.snapshot, evidence: [] }, policyHash: h.inputs[0].input.policyHash });
      return dispatchReviewFixtureCall(binding, h.inputs[0].input, {});
    })).rejects.toThrow("replay_fixture_input_mismatch");
    expect(h.fixture).not.toHaveBeenCalled();
  });

  it("rejects malformed stage bindings before charging the ledger", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness();
    for (const value of [{ ...binding, secondReviewId: 99 }, { ...binding, stage: "second" }, { ...binding, model: " fixture-model " }]) {
      await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(value as typeof binding, input(), {}))).rejects.toThrow("replay_fixture_binding_mismatch");
    }
    expect(h.ledger.reserve).not.toHaveBeenCalled();
  });

  it("returns undefined solely outside replay and rejects a replay without fixture scope", async () => {
    const { dispatchReviewFixtureCall } = api();
    expect(await dispatchReviewFixtureCall(binding, input(), {})).toBeUndefined();
    await expect(withReviewReplayContext({ referenceTime: new Date() }, () => dispatchReviewFixtureCall(binding, input(), {}))).rejects.toThrow("replay_fixture_transport_required");
  });

  it("revokes late descendants instead of letting them start after callback exit", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness(), ready = latch<void>();
    let late!: Promise<unknown>;
    await withReviewFixtureTransport(h, async () => {
      late = ready.promise.then(() => dispatchReviewFixtureCall(binding, input(), {}));
      void late.catch(() => {});
    });
    ready.resolve();
    await expect(late).rejects.toThrow("replay_fixture_scope_closed");
    expect(h.fixture).not.toHaveBeenCalled();
  });

  it("revokes and drains unawaited calls before returning from the scope", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness(), entered = latch<void>();
    h.fixture.mockImplementationOnce(async () => { entered.resolve(); return new Promise(() => {}); });
    let pending!: Promise<unknown>;
    await expect(withReviewFixtureTransport(h, async () => {
      pending = dispatchReviewFixtureCall(binding, input(), {});
      void pending.catch(() => {});
      await entered.promise;
    })).rejects.toThrow("replay_fixture_work_not_awaited");
    await expect(pending).rejects.toThrow("replay_fixture_scope_closed");
    expect(h.ledger.markIndeterminate).toHaveBeenCalledTimes(1);
  });

  it("blocks nested transports and raw adapters even without a semantic scope", async () => {
    const { withReviewFixtureTransport } = api(), h = harness();
    await withReviewFixtureTransport(h, async () => {
      expect(() => transport.assertLiveReviewAdapterAllowed()).toThrow("replay_raw_review_adapter_rejected");
      await expect(withReviewFixtureTransport(h, async () => {})).rejects.toThrow("replay_fixture_scope_conflict");
    });
  });

  it("bounds an unresponsive fixture by the exact per-call timeout", async () => {
    const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness(), stop = new AbortController();
    h.fixture.mockImplementationOnce(async () => new Promise(() => {}));
    const pending = withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, input(), { timeoutMs: 10, signal: stop.signal }));
    const observed = await Promise.race([pending.then(() => "returned", error => (error as Error).message),
      new Promise(resolve => setTimeout(() => resolve("still_in_flight"), 40))]);
    stop.abort(); await pending.catch(() => {});
    expect(observed).toBe("replay_call_indeterminate");
    expect(h.ledger.markIndeterminate).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle).not.toHaveBeenCalled();
  });

  it.each([{ ...result, ok: "not-a-boolean" }, { ok: false, error: "made_up_failure" }, { ...result, usage: { inputTokens: -1 } }])
    ("rejects malformed ordinary results before settlement %j", async malformed => {
      const { withReviewFixtureTransport, dispatchReviewFixtureCall } = api(), h = harness();
      h.fixture.mockResolvedValueOnce({ result: malformed as AgentReviewResult, receipt });
      await expect(withReviewFixtureTransport(h, () => dispatchReviewFixtureCall(binding, input(), {}))).rejects.toThrow("replay_call_indeterminate");
      expect(h.ledger.settle).not.toHaveBeenCalled();
      expect(h.ledger.markIndeterminate).toHaveBeenCalledTimes(1);
    });

  it("checks each handler settings read against the admitted exact policy", async () => {
    const { withReviewFixtureTransport } = api(), h = harness();
    expect(transport).toHaveProperty("assertReviewFixtureSettings", expect.any(Function));
    await withReviewFixtureTransport(h, async () => {
      expect(() => transport.assertReviewFixtureSettings(DEFAULT_CRAWL_SETTINGS)).not.toThrow();
      expect(() => transport.assertReviewFixtureSettings({ ...DEFAULT_CRAWL_SETTINGS,
        reviewMode: DEFAULT_CRAWL_SETTINGS.reviewMode === "off" ? "enforce" : "off" }))
        .toThrow("replay_fixture_settings_mismatch");
    });
  });
});
