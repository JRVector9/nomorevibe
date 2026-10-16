import { describe, expect, it } from "vitest";
import { compareLiveCapacityRuns, judgeLiveCapacity, parseLiveCapacityArtifact, reportLiveCapacityWindow,
  type LiveCapacityArtifact } from "@/lib/operations/pipeline-capacity-live";
import { ownershipLostCode } from "@/lib/operations/pipeline-evidence-ledger";
import { JobLeaseLostError } from "@/lib/jobs/lease";

const hash = "a".repeat(64), WINDOW = 1_800_000;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 17) + ms).toISOString();
const identity = (model: string) => ({ provider: "abcllm" as const, model, canonicalModel: model });
/** 구간 안에서 AI1 승인 + 필수 AI2 승인으로 끝난 후보 finals개. ledger를 주면 0097 장부가 구간을 덮은 수집본이다. */
function liveWindow(finals: number, ledger?: { startedMs?: number; overrides?: number; leaseViolations?: number; ai2Calls?: number }) {
  const value: LiveCapacityArtifact = { version: 1, scope: "live_window", runId: "ledger", revision: "9e13341",
    schema: { appliedMigrations: 97, absentTables: [] },
    window: { startedAt: at(0), endedAt: at(WINDOW), durationMs: WINDOW, collectedAt: at(WINDOW + 60_000), collectedAfterEndMs: 60_000 },
    database: { target: "primary", inRecovery: false, readOnly: true, isolation: "repeatable read", replicaCaughtUp: null, writeXidAssigned: false },
    identity: { promptVersion: "p1", rulesVersion: "r1", inputPolicyHash: hash, comparisonPolicyHash: hash, fullReviewPolicyHash: hash,
      reviewMode: "enforce", secondGateRequired: true, concurrency: 2, settingsUpdatedMs: -3_600_000,
      models: { first: identity("first"), second: [identity("second")], fallbacks: [] } },
    stageModes: [{ stage: "ai1", mode: "legacy", epoch: 1, changedSinceStart: false }],
    modelCapacity: { mode: "disabled", changedSinceStart: false },
    attempts: [], votes: [], candidates: [], ai2Calls: { chains: 0, calls: 0, failed: 0, unattributedChains: 0 },
    readiness: { witnesses: 1, sampleCandidateIds: [900] },
    safety: { duplicatePublications: 0, humanDecisionOverrides: "unverified", leaseViolations: "unverified" },
    budget: { status: "unverified" }, quality: null };
  for (let id = 1; id <= finals; id++) {
    value.candidates.push({ id, state: "approved", decidedBy: "auto", appliedAttemptId: id * 10 });
    value.attempts.push({ id: id * 10, candidateId: id, inputHash: hash, state: "succeeded", failure: null, provider: "abcllm",
      model: "first", policyHash: hash, promptVersion: "p1", rulesVersion: "r1", reusedFromAttemptId: null, decision: "approve",
      reReview: false, readyMs: 990_000, startedMs: 999_000, completedMs: 1_000_000, inputTokens: 1, outputTokens: 1 });
    value.votes.push({ id: id * 100, firstAttemptId: id * 10, status: "agreed", settledElsewhere: false, fallback: false,
      provider: "abcllm", model: "second", slotProvider: "abcllm", slotModel: "second", secondDecision: "approve", reviewedMs: 1_001_000 });
  }
  value.ai2Calls = { chains: finals, calls: ledger?.ai2Calls ?? finals, failed: 0, unattributedChains: 0 };
  if (ledger) {
    value.ledger = { startedAt: at(ledger.startedMs ?? -60_000), humanDecisionRefusals: 2, lateWritesRefused: 1 };
    value.safety = { duplicatePublications: 0, humanDecisionOverrides: ledger.overrides ?? 0, leaseViolations: ledger.leaseViolations ?? 0 };
  }
  return value;
}

describe("evidence ledger in live artifacts", () => {
  it("turns ledger-covered human-decision and lease slots into verified counts with refusals reported separately", () => {
    const report = reportLiveCapacityWindow(liveWindow(1, { overrides: 0, leaseViolations: 3 }));
    expect(report.safety).toEqual({ duplicatePublications: { status: "verified", count: 0 },
      humanDecisionOverrides: { status: "verified", count: 0 }, leaseViolations: { status: "verified", count: 3 } });
    expect(report.ledger).toEqual({ startedAt: at(-60_000), humanDecisionRefusals: 2, lateWritesRefused: 1 });
    expect(report.budgetEvidence).toBe("unverified");
  });
  it("keeps both slots unverified and the ledger empty for artifacts without ledger coverage", () => {
    const report = reportLiveCapacityWindow(liveWindow(1));
    expect(report.safety.humanDecisionOverrides).toEqual({ status: "unverified" });
    expect(report.safety.leaseViolations).toEqual({ status: "unverified" });
    expect(report.ledger).toBeNull();
    expect(reportLiveCapacityWindow({ ...liveWindow(1), ledger: null }).ledger).toBeNull();
  });
  it("accepts a recorder marker exactly at the window start", () => {
    expect(() => parseLiveCapacityArtifact(liveWindow(1, { startedMs: 0 }))).not.toThrow();
  });
  it.each([
    ["counts without a ledger", (value: LiveCapacityArtifact) => { value.safety.leaseViolations = 0; }],
    ["a ledger with an unverified slot", (value: LiveCapacityArtifact) => {
      value.ledger = { startedAt: at(-1), humanDecisionRefusals: 0, lateWritesRefused: 0 }; value.safety.humanDecisionOverrides = 0; }],
    ["a recorder marker after the window start", (value: LiveCapacityArtifact) => {
      value.ledger = { startedAt: at(1), humanDecisionRefusals: 0, lateWritesRefused: 0 };
      value.safety = { duplicatePublications: 0, humanDecisionOverrides: 0, leaseViolations: 0 }; }],
    ["unattributed AI2 chains under ledger coverage", (value: LiveCapacityArtifact) => {
      value.ledger = { startedAt: at(-1), humanDecisionRefusals: 0, lateWritesRefused: 0 };
      value.safety = { duplicatePublications: 0, humanDecisionOverrides: 0, leaseViolations: 0 };
      value.ai2Calls = { ...value.ai2Calls, unattributedChains: 1 }; }],
    ["a negative count", (value: LiveCapacityArtifact) => {
      value.ledger = { startedAt: at(-1), humanDecisionRefusals: 0, lateWritesRefused: 0 };
      value.safety = { duplicatePublications: 0, humanDecisionOverrides: -1, leaseViolations: 0 }; }],
  ])("rejects %s", (_name, mutate) => {
    const value = liveWindow(1); mutate(value);
    expect(() => parseLiveCapacityArtifact(value)).toThrow();
  });
});

describe("evidence ledger in the judgement", () => {
  it("passes safety when both windows are covered with zero violations, leaving only budget evidence missing", () => {
    const result = compareLiveCapacityRuns(liveWindow(10, {}), liveWindow(20, {}));
    expect(result).toMatchObject({ safety: "passed", performance: "passed", status: "incomplete", budgetEvidence: "unverified" });
    expect(result.reasons).not.toContain("human_decision_override_unverified");
    expect(result.reasons).not.toContain("lease_violation_unverified");
    expect(result.reasons).toContain("budget_evidence_unverified");
  });
  it.each([
    [{ overrides: 1 }, "human_decision_override_detected"],
    [{ leaseViolations: 2 }, "lease_violation_detected"],
  ])("fails a covered candidate window with recorded violations (%j)", (counts, reason) => {
    const result = compareLiveCapacityRuns(liveWindow(10, {}), liveWindow(20, counts));
    expect(result).toMatchObject({ status: "failed", safety: "failed" });
    expect(result.reasons).toContain(reason);
  });
  it("keeps a candidate window recorded before the marker incomplete", () => {
    const result = judgeLiveCapacity(reportLiveCapacityWindow(liveWindow(10, {})), reportLiveCapacityWindow(liveWindow(20)));
    expect(result.safety).toBe("incomplete");
    expect(result.reasons).toEqual(expect.arrayContaining(["human_decision_override_unverified", "lease_violation_unverified"]));
  });
});

describe("late write refusal classification", () => {
  it.each([
    [new Error("item_lease_lost"), "item_lease_lost"], [new JobLeaseLostError(), "job_lease_lost"],
    [new Error("agent_review_ownership_lost"), "agent_review_ownership_lost"],
    [new Error("second_review_ownership_lost"), "second_review_ownership_lost"],
    [new Error("invalid_agent_review_receipt"), null], [new Error("review_approval_changed"), null], ["item_lease_lost", null], [null, null],
  ])("classifies %s as %s", (error, code) => {
    expect(ownershipLostCode(error)).toBe(code);
  });
});
