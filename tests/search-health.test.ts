import { describe, expect, it } from "vitest";
import { emptySearchHealth, searchHealthAlerts, readSearchHealth } from "@/lib/operations/search-health-model";

describe("search health alerts", () => {
  it("does not treat marked refreshes or recent missing profiles as corruption", () => {
    const counts = { ...emptySearchHealth(), total: 20, pendingGeneration: 4, mismatched: 4, missing: 1 };
    expect(searchHealthAlerts(counts)).toEqual([]);
  });
  it("reports unmarked hashes, keyword copies and exhausted retries independently", () => {
    const alerts = searchHealthAlerts({ ...emptySearchHealth(), unmarked: 1, copiesMismatched: 2, exhausted: 3 });
    expect(alerts.map(a => a.key)).toEqual(["hash", "copies", "exhausted"]);
    expect(alerts.every(a => a.tone === "critical")).toBe(true);
  });
  it("reports old missing profiles, waiting verifications and repeated failures", () => {
    expect(searchHealthAlerts({ ...emptySearchHealth(), oldMissing: 2, pendingVerification: 3,
      oldestVerificationMinutes: 61, repeatedFailures: 1 }).map(a => a.key))
      .toEqual(["missing", "repeated", "verification-wait"]);
  });
  it("warns only after generation progress has been absent for 30 minutes", () => {
    const c = { ...emptySearchHealth(), pendingGeneration: 4, generationIdleMinutes: 29 };
    expect(searchHealthAlerts(c)).toEqual([]);
    expect(searchHealthAlerts({ ...c, generationIdleMinutes: 30 }).map(a => a.key)).toEqual(["generation-stalled"]);
  });
  it("rejects missing, old, incomplete or nonfinite observations instead of showing healthy", () => {
    const now = Date.now();
    const observation = { observedAt: new Date(now).toISOString(), value: { events: [
      { event: "search_health.checked", counts: emptySearchHealth() },
    ] } };
    expect(readSearchHealth(observation, now)?.total).toBe(0);
    expect(readSearchHealth(undefined, now)).toBeNull();
    expect(readSearchHealth({ ...observation, observedAt: new Date(now - 46 * 60_000).toISOString() }, now)).toBeNull();
    expect(readSearchHealth({ ...observation, value: { events: [{ event: "search_health.checked", counts: { total: 1 } }] } }, now)).toBeNull();
    observation.value.events[0].counts.total = NaN;
    expect(readSearchHealth(observation, now)).toBeNull();
  });
});
