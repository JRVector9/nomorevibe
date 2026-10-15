import type { ReplayLedger, ReplayCallRequest, ReplayRun, ReplayReceipt } from "./pipeline-replay-ledger";

export type FixtureReplayLedger = Pick<ReplayLedger, "fixtureMode" | "reserve" | "markDispatching" | "markInFlight" | "settle" | "markIndeterminate">;

/** Local callback harness only. No provider/network implementation, retry, or credentials. */
export async function runFixtureReplayCall(ledger: FixtureReplayLedger, run: ReplayRun, request: ReplayCallRequest,
  callback: () => Promise<ReplayReceipt>): Promise<void> {
  await ledger.fixtureMode(run);
  await ledger.reserve(run, request);
  await ledger.markDispatching(run, request.callId);
  await ledger.markInFlight(run, request.callId);
  try {
    const receipt = await callback();
    await ledger.settle(run, request.callId, receipt);
  } catch {
    // Keep the committed charge even if recording uncertainty itself fails.
    await ledger.markIndeterminate(run, request.callId).catch(() => {});
    throw new Error("replay_call_indeterminate");
  }
}
