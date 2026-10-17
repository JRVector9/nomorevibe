import { describe, expect, it } from "vitest";
import { budgetEvidenceSchema, judgeBudget, ledgerBudgetEvidence, meterBudgetEvidence, replayLedgerBudget, slotPeaks, unattributedAi2Calls,
  type BudgetEvidence, type LedgerBudgetInput, type SlotEvent } from "@/lib/operations/pipeline-capacity-budget";
import { attachLiveCapacityLabels, compareLiveCapacityRuns, parseLiveCapacityArtifact, type LiveCapacityArtifact } from "@/lib/operations/pipeline-capacity-live";

const policy = { version: 1, globalLimit: 4, providerLimits: { gateway: 4 }, groupLimits: { engine: 4 }, poolLimits: { reviewer: 2, text: 2 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: "first", providerBudgetId: "gateway", groupId: "engine" },
    { routeId: "second-review", provider: "abcllm", model: "second", providerBudgetId: "gateway", groupId: "engine" }] };
const slot = (id: number, requestId: string, kind: "reserved" | "exit", inWindow = true, pool = "reviewer"): SlotEvent =>
  ({ id, requestId, kind, inWindow, providerBudgetId: "gateway", groupId: "engine", pool, current: true });
const usage = (total: number) => ({ inputTokens: total - 10, outputTokens: 10, totalTokens: total });
/** 장부가 구간을 덮고, 호출 3(실제 usage 2·C 1)과 AI2 호출 기록 1이 모두 귀속되며 심사 슬롯 점유가 최대 2인 구간. */
function ledger(): LedgerBudgetInput {
  return { capacity: { state: "present", mode: "open", changedSinceStart: false, policy },
    calls: [{ bound: 8_000, usage: usage(1_200) }, { bound: 8_000, usage: null }, { bound: 6_000, usage: usage(900) }],
    unattributedAi1: 0,
    ai2: { records: [{ id: 5, secondReviewId: 70, failed: false, inWindow: true, failures: 0 }], dispatched: [{ secondReviewId: 70, failureCount: 0 }] },
    slots: [slot(10, "a", "reserved"), slot(20, "b", "reserved"), slot(30, "a", "exit"), slot(40, "c", "reserved"), slot(50, "b", "exit"), slot(60, "c", "exit")] };
}
const issues = (value: BudgetEvidence) => value.status === "unverified" && "issues" in value ? value.issues : null;

describe("ledger budget evidence", () => {
  it("verifies only a fully attributed window and charges actual upstream usage or the whole bound C per call", () => {
    expect(ledgerBudgetEvidence(ledger())).toEqual({ status: "verified", source: "model_capacity_ledger", calls: 3,
      chargedTokens: 1_200 + 8_000 + 900, reportedCalls: 2, boundCalls: 1, concurrency: { limit: 2, peak: 2 } });
  });
  it.each([
    ["one AI1 call outside the ledger", (value: LedgerBudgetInput) => { value.unattributedAi1 = 1; }, ["unattributed_ai1_calls"]],
    ["one AI2 call record outside the ledger", (value: LedgerBudgetInput) => { value.ai2!.dispatched = []; }, ["unattributed_ai2_calls"]],
    ["AI2 call records not covered by the 0097 marker", (value: LedgerBudgetInput) => { value.ai2 = null; }, ["ai2_call_records_unverified"]],
    ["a call without its bound C", (value: LedgerBudgetInput) => { value.calls!.push({ bound: null, usage: usage(10) }); }, ["token_bound_missing"]],
    ["a non-integer bound C", (value: LedgerBudgetInput) => { value.calls![1].bound = "8000"; }, ["token_bound_missing"]],
    ["one moment above the reviewer slot limit", (value: LedgerBudgetInput) => { value.slots!.push(slot(21, "d", "reserved"), slot(22, "d", "exit")); },
      ["concurrency_limit_exceeded"]],
    ["a slot granted under another policy generation", (value: LedgerBudgetInput) => { value.slots![3].current = false; }, ["capacity_policy_changed"]],
    ["an exit without its reservation", (value: LedgerBudgetInput) => { value.slots!.push(slot(90, "z", "exit")); }, ["ledger_inconsistent"]],
    ["too many ledger rows", (value: LedgerBudgetInput) => { value.calls = null; }, ["ledger_row_limit"]],
    ["a control change since the window start", (value: LedgerBudgetInput) => { value.capacity.changedSinceStart = true; },
      ["model_capacity_changed_since_window_start"]],
    ["an invalid stored policy", (value: LedgerBudgetInput) => { value.capacity.policy = { version: 1 }; }, ["capacity_policy_invalid"]],
  ] as const)("stays unverified with %s", (_name, mutate, expected) => {
    const value = ledger(); mutate(value);
    expect(ledgerBudgetEvidence(value)).toEqual({ status: "unverified", source: "model_capacity_ledger", issues: expected });
  });
  it.each([["absent", "model_capacity_absent"], ["unreadable", "model_capacity_unreadable"]] as const)("needs a readable ledger (%s)", (state, issue) => {
    expect(issues(ledgerBudgetEvidence({ ...ledger(), capacity: { ...ledger().capacity, state } }))).toEqual([issue]);
  });
  it.each(["disabled", "draining"])("needs the open model slot mode throughout (%s)", mode => {
    expect(issues(ledgerBudgetEvidence({ ...ledger(), capacity: { ...ledger().capacity, mode } }))).toEqual(["model_capacity_not_open"]);
  });
  it("never counts a contradicting usage record below its whole bound C", () => {
    const value = ledger();
    value.calls = [{ bound: 8_000, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 111 } },
      { bound: 8_000, usage: usage(8_001) }, { bound: 8_000, usage: { inputTokens: 1.5, outputTokens: 0, totalTokens: 1.5 } }];
    expect(ledgerBudgetEvidence(value)).toMatchObject({ status: "verified", chargedTokens: 24_000, reportedCalls: 0, boundCalls: 3 });
  });
  it("collects every independent issue in one fixed order", () => {
    const value = ledger(); value.unattributedAi1 = 2; value.ai2 = null; value.capacity.changedSinceStart = true; value.calls!.push({ bound: 0, usage: null });
    expect(issues(ledgerBudgetEvidence(value))).toEqual(["model_capacity_changed_since_window_start", "unattributed_ai1_calls",
      "ai2_call_records_unverified", "token_bound_missing"]);
  });
});

describe("slot occupancy sweep", () => {
  it("counts reservations active at the window start and every later moment in ledger order", () => {
    const events = [slot(1, "a", "reserved", false), slot(2, "b", "reserved", false), slot(3, "a", "exit"), slot(4, "c", "reserved"),
      slot(5, "d", "reserved", true, "text")];
    expect(slotPeaks(events)).toEqual({ global: 3, "provider:gateway": 3, "group:engine": 3, "pool:reviewer": 2, "pool:text": 1 });
    // 구간 안 사건이 없어도 시작 시점의 점유가 구간 내내 남는다.
    expect(slotPeaks([slot(1, "a", "reserved", false), slot(2, "b", "reserved", false)])).toMatchObject({ "pool:reviewer": 2 });
    expect(slotPeaks([])).toEqual({});
  });
  it("orders by ledger id rather than input order and rejects duplicated transitions", () => {
    expect(slotPeaks([slot(3, "a", "exit"), slot(1, "a", "reserved")])).toMatchObject({ "pool:reviewer": 1 });
    expect(slotPeaks([slot(1, "a", "reserved"), slot(2, "a", "reserved")])).toBeNull();
    expect(slotPeaks([slot(1, "a", "reserved"), slot(2, "a", "exit"), slot(3, "a", "exit")])).toBeNull();
  });
});

describe("AI2 call attribution", () => {
  it("binds each recorded AI2 call to the ledger dispatch with the same review row and failure count", () => {
    // 70: 실패 0 → 실패 1 → 성공(실패 수 2). 80: 구간 안 실패 뒤 구간 밖에서 또 실패해 지금 실패 수가 2다.
    const records = [{ id: 5, secondReviewId: 70, failed: true, inWindow: true, failures: 2 }, { id: 6, secondReviewId: 70, failed: true, inWindow: true, failures: 2 },
      { id: 7, secondReviewId: 70, failed: false, inWindow: true, failures: 2 }, { id: 8, secondReviewId: 80, failed: true, inWindow: true, failures: 2 },
      { id: 9, secondReviewId: 80, failed: true, inWindow: false, failures: 2 }];
    const dispatched = [{ secondReviewId: 70, failureCount: 0 }, { secondReviewId: 70, failureCount: 1 }, { secondReviewId: 70, failureCount: 2 },
      { secondReviewId: 80, failureCount: 0 }];
    expect(unattributedAi2Calls(records, dispatched)).toBe(0);
    expect(unattributedAi2Calls(records, dispatched.filter(row => !(row.secondReviewId === 70 && row.failureCount === 1)))).toBe(1);
    // 구간 밖 기록(9)은 세지 않지만 앞선 기록의 실패 수를 정한다.
    expect(unattributedAi2Calls(records, [...dispatched.slice(0, 3), { secondReviewId: 80, failureCount: 1 }])).toBe(1);
    // 지워진 표(실패 수 모름)는 맞출 수 없으므로 장부 밖으로 센다.
    expect(unattributedAi2Calls([{ id: 1, secondReviewId: 90, failed: false, inWindow: true, failures: null }], [{ secondReviewId: 90, failureCount: 0 }])).toBe(1);
  });
});

const meter = { calls: 10, maxInFlight: 3, reportedCalls: 10, reportedTokens: 12_400, declared: 4, callsAtStop: 10, recordedCalls: 10 };
describe("replay meter budget evidence", () => {
  it("verifies a legacy replay only when every forwarded call reported upstream usage within a declared concurrency", () => {
    expect(meterBudgetEvidence(meter)).toEqual({ status: "verified", source: "replay_meter", calls: 10, chargedTokens: 12_400,
      reportedCalls: 10, boundCalls: 0, concurrency: { limit: 4, peak: 3 } });
  });
  it.each([
    ["usage missing on one call (no proven C)", { reportedCalls: 9 }, ["usage_unreported_without_bound"]],
    ["no declared common budget", { declared: null }, ["concurrency_limit_undeclared"]],
    ["one moment above the declared budget", { maxInFlight: 5 }, ["concurrency_limit_exceeded"]],
    ["a call forwarded after the window stop", { callsAtStop: 9 }, ["replay_calls_after_stop"]],
    ["a recorded call the meter never forwarded", { recordedCalls: 11 }, ["recorded_calls_exceed_meter"]],
    ["an old result without budget fields", { callsAtStop: null, reportedCalls: undefined, reportedTokens: undefined }, ["replay_budget_unrecorded"]],
  ] as const)("stays unverified with %s", (_name, patch, expected) => {
    expect(meterBudgetEvidence({ ...meter, ...patch })).toEqual({ status: "unverified", source: "replay_meter", issues: expected });
  });
  it("keeps the ledger evidence for item replays and cross-checks the meter", () => {
    const verified = ledgerBudgetEvidence(ledger());
    expect(replayLedgerBudget(verified, { calls: 3, maxInFlight: 2 }, 3)).toEqual(verified);
    expect(issues(replayLedgerBudget(verified, { calls: 4, maxInFlight: 2 }, 4))).toEqual(["meter_calls_outside_ledger"]);
    expect(issues(replayLedgerBudget(verified, { calls: 3, maxInFlight: 3 }, 3))).toEqual(["concurrency_limit_exceeded"]);
    expect(issues(replayLedgerBudget(verified, { calls: 3, maxInFlight: 2 }, 2))).toEqual(["replay_calls_after_stop"]);
    expect(issues(replayLedgerBudget({ status: "unverified" }, { calls: 3, maxInFlight: 2 }, null))).toEqual(["budget_evidence_absent", "replay_budget_unrecorded"]);
    expect(issues(replayLedgerBudget({ status: "unverified", source: "model_capacity_ledger", issues: ["model_capacity_not_open"] },
      { calls: 3, maxInFlight: 2 }, 3))).toEqual(["model_capacity_not_open"]);
  });
});

const verifiedBudget = (calls: number, chargedTokens: number, limit = 4): BudgetEvidence =>
  ({ status: "verified", source: "model_capacity_ledger", calls, chargedTokens, reportedCalls: calls, boundCalls: 0, concurrency: { limit, peak: 1 } });
describe("budget judgement", () => {
  it("passes with zero tolerance when per-final calls and tokens are each no worse than the baseline", () => {
    const result = judgeBudget({ budget: verifiedBudget(30, 30_000), finals: 10 }, { budget: verifiedBudget(60, 60_000), finals: 20 }, true);
    expect(result).toEqual({ status: "passed", reasons: [], ratios: { callsPerFinal: 1, tokensPerFinal: 1 },
      baseline: { calls: 30, chargedTokens: 30_000, finals: 10, limit: 4, callsPerFinal: 3, tokensPerFinal: 3_000 },
      candidate: { calls: 60, chargedTokens: 60_000, finals: 20, limit: 4, callsPerFinal: 3, tokensPerFinal: 3_000 } });
  });
  it.each([
    ["one more call", verifiedBudget(61, 60_000), "budget_calls_per_final_exceeded"],
    ["one more charged token", verifiedBudget(60, 60_001), "budget_tokens_per_final_exceeded"],
    ["a larger declared slot budget", verifiedBudget(60, 60_000, 5), "budget_limit_exceeds_baseline"],
  ] as const)("fails with %s per final and still records the ratios", (_name, candidate, reason) => {
    const result = judgeBudget({ budget: verifiedBudget(30, 30_000), finals: 10 }, { budget: candidate, finals: 20 }, true);
    expect(result).toMatchObject({ status: "failed", reasons: [reason] });
    expect(result.ratios.callsPerFinal).not.toBeNull();
    // 비교 조건이 다르면 같은 수치도 판정하지 않는다.
    expect(judgeBudget({ budget: verifiedBudget(30, 30_000), finals: 10 }, { budget: candidate, finals: 20 }, false).status).toBe("incomplete");
  });
  it("compares token products exactly beyond float precision", () => {
    // 후보 9,000,000,000,000,002×기준 최종 2 = 18,000,000,000,000,004 > 기준 6,000,000,000,000,001×후보 최종 3 = 18,000,000,000,000,003.
    // float으로는 둘 다 18,000,000,000,000,004가 되어 같다고 잘못 통과한다.
    const result = judgeBudget({ budget: verifiedBudget(2, 6_000_000_000_000_001), finals: 2 }, { budget: verifiedBudget(1, 9_000_000_000_000_002), finals: 3 }, true);
    expect(result.reasons).toEqual(["budget_tokens_per_final_exceeded"]);
  });
  it("stays incomplete without verified evidence or finals on either side", () => {
    expect(judgeBudget({ budget: { status: "unverified" }, finals: 10 }, { budget: verifiedBudget(60, 60_000), finals: 20 }, true))
      .toMatchObject({ status: "incomplete", reasons: ["budget_evidence_unverified"], baseline: null });
    expect(judgeBudget({ budget: verifiedBudget(0, 0), finals: 0 }, { budget: verifiedBudget(60, 60_000), finals: 20 }, true))
      .toMatchObject({ status: "incomplete", reasons: ["budget_per_final_unavailable"], ratios: { callsPerFinal: null } });
  });
});

const WINDOW = 1_800_000, hash = "a".repeat(64);
const at = (ms: number) => new Date(Date.UTC(2026, 9, 17) + ms).toISOString();
const model = (name: string) => ({ provider: "abcllm" as const, model: name, canonicalModel: name });
/** 장부가 구간을 덮은 열린 모델 슬롯 구간. finals건 모두 AI1 거절로 최종이 되고, 최종 하나당 호출 1·토큰 1,000을 쓴다. */
function window(finals: number, stage: "legacy" | "items"): LiveCapacityArtifact {
  const attempts = Array.from({ length: finals }, (_, index) => ({ id: index + 1, candidateId: index + 1, inputHash: hash, state: "succeeded" as const,
    failure: null, provider: "abcllm", model: "first", policyHash: hash, promptVersion: "p1", rulesVersion: "r1", reusedFromAttemptId: null,
    decision: "reject" as const, reReview: false, readyMs: 1_000 + index * 1_000, startedMs: 2_000 + index * 1_000, completedMs: 3_000 + index * 1_000,
    inputTokens: 990, outputTokens: 10 }));
  return { version: 1, scope: "live_window", runId: `live-${stage}`, revision: "9e13341", schema: { appliedMigrations: 97, absentTables: [] },
    window: { startedAt: at(0), endedAt: at(WINDOW), durationMs: WINDOW, collectedAt: at(WINDOW + 60_000), collectedAfterEndMs: 60_000 },
    database: { target: "primary", inRecovery: false, readOnly: true, isolation: "repeatable read", replicaCaughtUp: null, writeXidAssigned: false },
    identity: { promptVersion: "p1", rulesVersion: "r1", inputPolicyHash: hash, comparisonPolicyHash: hash, fullReviewPolicyHash: hash,
      reviewMode: "enforce", secondGateRequired: true, concurrency: stage === "items" ? 4 : 2, settingsUpdatedMs: -3_600_000,
      models: { first: model("first"), second: [model("second")], fallbacks: [] } },
    stageModes: (["ai1", "ai2", "fetch"] as const).map(name => ({ stage: name, mode: stage === "items" && name !== "fetch" ? "items" as const : "legacy" as const,
      epoch: 1, changedSinceStart: false })),
    modelCapacity: { mode: "open", changedSinceStart: false },
    attempts, votes: [], candidates: attempts.map(row => ({ id: row.candidateId, state: "rejected" as const, decidedBy: "auto" as const, appliedAttemptId: row.id })),
    ai2Calls: { chains: 0, calls: 0, failed: 0, unattributedChains: 0 }, readiness: { witnesses: 3, sampleCandidateIds: [] },
    ledger: { startedAt: at(-3_600_000), humanDecisionRefusals: 0, lateWritesRefused: 0 },
    safety: { duplicatePublications: 0, humanDecisionOverrides: 0, leaseViolations: 0 },
    budget: { status: "verified", source: "model_capacity_ledger", calls: finals, chargedTokens: 1_000 * finals, reportedCalls: finals, boundCalls: 0,
      concurrency: { limit: 4, peak: 2 } }, quality: null };
}
const labeled = (value: LiveCapacityArtifact) => attachLiveCapacityLabels(value,
  value.attempts.map(row => ({ candidateId: row.candidateId, inputHash: row.inputHash, expected: "reject" as const })));

describe("live judgement from collected artifacts", () => {
  it("can pass end to end once budget, safety, quality and readiness are all proven", () => {
    const result = compareLiveCapacityRuns(labeled(window(10, "legacy")), labeled(window(20, "items")));
    expect(result).toMatchObject({ status: "passed", performance: "passed", quality: "passed", safety: "passed", budgetEvidence: "verified",
      budget: { status: "passed", ratios: { callsPerFinal: 1, tokensPerFinal: 1 } }, reasons: [] });
  });
  it.each([
    ["candidate budget evidence", (value: LiveCapacityArtifact) => { value.budget = { status: "unverified", source: "model_capacity_ledger",
      issues: ["unattributed_ai1_calls"] }; }, "budget_evidence_unverified"],
    ["the 0097 ledger (safety and AI2 attribution)", (value: LiveCapacityArtifact) => { value.ledger = null;
      value.safety = { ...value.safety, humanDecisionOverrides: "unverified", leaseViolations: "unverified" }; value.budget = { status: "unverified" }; },
      "lease_violation_unverified"],
    ["the quality sample", (value: LiveCapacityArtifact) => { value.quality = null; }, "quality_unverified"],
    ["the readiness witness", (value: LiveCapacityArtifact) => { value.readiness = { witnesses: 0, sampleCandidateIds: [] }; }, "readiness_unproven"],
  ] as const)("is incomplete when only %s is missing", (_name, mutate, reason) => {
    const after = labeled(window(20, "items")); mutate(after);
    const result = compareLiveCapacityRuns(labeled(window(10, "legacy")), after);
    expect(result.status).toBe("incomplete");
    expect(result.reasons).toContain(reason);
  });
  it("fails a candidate that spends one more call per final than the baseline", () => {
    const after = labeled(window(20, "items"));
    after.budget = { status: "verified", source: "model_capacity_ledger", calls: 21, chargedTokens: 20_000, reportedCalls: 21, boundCalls: 0,
      concurrency: { limit: 4, peak: 2 } };
    expect(compareLiveCapacityRuns(labeled(window(10, "legacy")), after)).toMatchObject({ status: "failed", budget: { status: "failed" },
      reasons: ["budget_calls_per_final_exceeded"] });
  });
  it("rejects verified budget evidence the artifact itself contradicts", () => {
    const value = window(2, "items");
    expect(() => parseLiveCapacityArtifact(value)).not.toThrow();
    expect(budgetEvidenceSchema.safeParse({ status: "verified" }).success).toBe(false);
    for (const mutate of [
      (copy: LiveCapacityArtifact) => { copy.modelCapacity = { mode: "open", changedSinceStart: true }; },
      (copy: LiveCapacityArtifact) => { copy.modelCapacity = { mode: "disabled", changedSinceStart: false }; },
      (copy: LiveCapacityArtifact) => { copy.ledger = null; copy.safety = { ...copy.safety, humanDecisionOverrides: "unverified", leaseViolations: "unverified" }; },
      (copy: LiveCapacityArtifact) => { copy.budget = { ...copy.budget, reportedCalls: 1 } as LiveCapacityArtifact["budget"]; },
      (copy: LiveCapacityArtifact) => { copy.budget = { ...copy.budget, concurrency: { limit: 1, peak: 2 } } as LiveCapacityArtifact["budget"]; },
      (copy: LiveCapacityArtifact) => { copy.budget = { ...copy.budget, source: "replay_meter" } as LiveCapacityArtifact["budget"]; },
      (copy: LiveCapacityArtifact) => { copy.budget = { status: "unverified", source: "model_capacity_ledger", issues: [] } as unknown as LiveCapacityArtifact["budget"]; },
    ]) {
      const copy = structuredClone(value); mutate(copy);
      expect(() => parseLiveCapacityArtifact(copy)).toThrow();
    }
  });
});
