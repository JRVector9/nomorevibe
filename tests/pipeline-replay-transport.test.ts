import { expect, it, vi } from "vitest";
import { runFixtureReplayCall, type FixtureReplayLedger } from "@/lib/operations/pipeline-replay-transport";

function harness(mode = "fixtures") {
  const events: string[] = [];
  const ledger = {
    fixtureMode: vi.fn(async () => { events.push("mode"); if (mode !== "fixtures") throw new Error("unsupported_provider_budget"); }),
    reserve: vi.fn(async () => { events.push("reserve_commit"); }),
    markDispatching: vi.fn(async () => { events.push("dispatching_commit"); }),
    markInFlight: vi.fn(async () => { events.push("in_flight_commit"); }),
    settle: vi.fn(async () => { events.push("settle_commit"); }),
    markIndeterminate: vi.fn(async () => { events.push("indeterminate_commit"); }),
  } as unknown as FixtureReplayLedger;
  return { ledger, events };
}
const run = {} as Parameters<FixtureReplayLedger["reserve"]>[0];
const request = { callId: "call-1" } as Parameters<FixtureReplayLedger["reserve"]>[1];
it("commits the entire reservation and dispatch state before the one fixture callback", async () => {
  const { ledger, events } = harness();
  const callback = vi.fn(async () => { events.push("callback"); return { inputTokens: 8, outputTokens: 2 }; });
  await runFixtureReplayCall(ledger, run, request, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(events).toEqual(["mode", "reserve_commit", "dispatching_commit", "in_flight_commit", "callback", "settle_commit"]);
});
it("rejects actual models without reservation or callback regardless of caller request", async () => {
  const { ledger, events } = harness("model-replay"), callback = vi.fn();
  await expect(runFixtureReplayCall(ledger, run, request, callback)).rejects.toThrow("unsupported_provider_budget");
  expect(events).toEqual(["mode"]); expect(callback).not.toHaveBeenCalled();
});
it.each(["reserve", "markDispatching", "markInFlight"] as const)("never sends after %s fails", async method => {
  const { ledger } = harness(), callback = vi.fn();
  vi.mocked(ledger[method]).mockRejectedValueOnce(new Error("denied"));
  await expect(runFixtureReplayCall(ledger, run, request, callback)).rejects.toThrow("denied");
  expect(callback).not.toHaveBeenCalled();
});
it("records a thrown callback as indeterminate, with no retry or receipt replacement", async () => {
  const { ledger, events } = harness(), callback = vi.fn(async () => { throw new Error("private-provider-text"); });
  await expect(runFixtureReplayCall(ledger, run, request, callback)).rejects.toThrow("replay_call_indeterminate");
  expect(callback).toHaveBeenCalledTimes(1); expect(events.at(-1)).toBe("indeterminate_commit");
  expect(ledger.settle).not.toHaveBeenCalled();
});
it("keeps settlement failures uncertain instead of retrying transport", async () => {
  const { ledger } = harness(), callback = vi.fn(async () => ({ inputTokens: 1, outputTokens: 2 }));
  vi.mocked(ledger.settle).mockRejectedValueOnce(new Error("storage_failure"));
  await expect(runFixtureReplayCall(ledger, run, request, callback)).rejects.toThrow("replay_call_indeterminate");
  expect(callback).toHaveBeenCalledTimes(1); expect(ledger.markIndeterminate).toHaveBeenCalledTimes(1);
});
