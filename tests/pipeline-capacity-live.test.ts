import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { attachLiveCapacityLabels, compareLiveCapacityRuns, judgeLiveCapacity, liveLabelDatasetHash, parseLiveCapacityArtifact,
  reportLiveCapacityWindow, type LiveCapacityArtifact, type LiveCapacityReport } from "@/lib/operations/pipeline-capacity-live";

const hash = "a".repeat(64), other = "b".repeat(64), WINDOW = 1_800_000;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 17) + ms).toISOString();
const identity = (model: string) => ({ provider: "abcllm" as const, model, canonicalModel: model });
function artifact(duration = WINDOW): LiveCapacityArtifact {
  return { version: 1, scope: "live_window", runId: "live-a", revision: "9e13341", schema: { appliedMigrations: 82, absentTables: [] },
    window: { startedAt: at(0), endedAt: at(duration), durationMs: duration, collectedAt: at(duration + 60_000), collectedAfterEndMs: 60_000 },
    database: { target: "primary", inRecovery: false, readOnly: true, isolation: "repeatable read", replicaCaughtUp: null, writeXidAssigned: false },
    identity: { promptVersion: "p1", rulesVersion: "r1", inputPolicyHash: hash, comparisonPolicyHash: hash, fullReviewPolicyHash: hash,
      reviewMode: "enforce", secondGateRequired: true, concurrency: 2, settingsUpdatedMs: -3_600_000,
      models: { first: identity("first"), second: [identity("second")], fallbacks: [identity("backup")] } },
    stageModes: [{ stage: "ai1", mode: "legacy", epoch: 1, changedSinceStart: false }],
    modelCapacity: { mode: "disabled", changedSinceStart: false },
    attempts: [], votes: [], candidates: [], ai2Calls: { chains: 0, calls: 0, failed: 0, unattributedChains: 0 },
    readiness: { witnesses: 3, sampleCandidateIds: [900, 901, 902] },
    safety: { duplicatePublications: 0, humanDecisionOverrides: "unverified", leaseViolations: "unverified" },
    budget: { status: "unverified" }, quality: null };
}
type Options = { attemptId?: number; decision?: "approve" | "reject"; completedMs?: number; gateMs?: number | null; latency?: number; reReview?: boolean };
/** completedMs 에 AI1이 끝나고 gateMs 에 필수 AI2 칸이 승인된 자동 세대 하나. */
function add(value: LiveCapacityArtifact, candidateId: number, options: Options = {}) {
  const id = options.attemptId ?? candidateId * 10, decision = options.decision ?? "approve";
  const completedMs = options.completedMs ?? 1_000_000, gateMs = options.gateMs === undefined ? completedMs + 1_000 : options.gateMs;
  const finalMs = decision === "approve" && gateMs !== null ? gateMs : completedMs;
  if (!value.candidates.some(row => row.id === candidateId)) value.candidates.push({ id: candidateId,
    state: decision === "approve" ? "approved" : "rejected", decidedBy: "auto", appliedAttemptId: id });
  value.attempts.push({ id, candidateId, inputHash: hash, state: "succeeded", failure: null, provider: "abcllm", model: "first",
    policyHash: hash, promptVersion: "p1", rulesVersion: "r1", reusedFromAttemptId: null, decision, reReview: options.reReview ?? false,
    readyMs: finalMs - (options.latency ?? 10_000), startedMs: completedMs - 1_000, completedMs, inputTokens: 100, outputTokens: 10 });
  if (decision === "approve" && gateMs !== null) value.votes.push({ id: id * 10, firstAttemptId: id, status: "agreed",
    settledElsewhere: false, fallback: false, provider: "abcllm", model: "second", slotProvider: "abcllm", slotModel: "second",
    secondDecision: "approve", reviewedMs: gateMs });
  return value.attempts.at(-1)!;
}
function windowWith(finals: number, options: { duration?: number; latency?: number; ai2Calls?: number; ai2Failed?: number } = {}) {
  const value = artifact(options.duration);
  for (let id = 1; id <= finals; id++) add(value, id, { latency: options.latency });
  value.ai2Calls = { chains: options.ai2Calls ?? 0, calls: options.ai2Calls ?? 0, failed: options.ai2Failed ?? 0, unattributedChains: 0 };
  return value;
}
/** PR01b-9: 검증된 budget은 수치를 함께 실어야 한다. 최종 하나당 호출 3·토큰 3,000, 같은 선언 한도로 맞춘다(기준선과 같은 단가). */
const verified = (report: LiveCapacityReport): LiveCapacityReport => ({ ...report, budgetEvidence: "verified",
  budget: { status: "verified", source: "model_capacity_ledger", calls: 3 * report.finals.newCandidates, chargedTokens: 3_000 * report.finals.newCandidates,
    reportedCalls: 3 * report.finals.newCandidates, boundCalls: 0, concurrency: { limit: 4, peak: 2 } },
  safety: { ...report.safety, humanDecisionOverrides: { status: "verified", count: 0 }, leaseViolations: { status: "verified", count: 0 } } });
function labeled(value: LiveCapacityArtifact, wrong = 0) {
  return attachLiveCapacityLabels(value, value.attempts.filter(row => row.decision === "approve" || row.decision === "reject")
    .map((row, index) => ({ candidateId: row.candidateId, inputHash: row.inputHash,
      expected: index < wrong ? (row.decision === "approve" ? "reject" : "approve") : row.decision! as "approve" | "reject" })));
}
const judge = (before: LiveCapacityArtifact, after: LiveCapacityArtifact) =>
  judgeLiveCapacity(verified(reportLiveCapacityWindow(labeled(before))), verified(reportLiveCapacityWindow(labeled(after))));

describe("live window report", () => {
  it("counts one final per candidate despite duplicate votes, fallback chains and repeated generations", () => {
    const value = artifact();
    value.identity.models.second.push(identity("second-b"));
    const first = add(value, 1, { gateMs: 1_002_000 });
    value.votes.push({ ...value.votes[0], id: 11, reviewedMs: 1_005_000 },
      { ...value.votes[0], id: 12, model: "backup", slotModel: "second-b", fallback: true, reviewedMs: 1_003_000 },
      { ...value.votes[0], id: 13, slotModel: "second-b", reviewedMs: 1_009_000 });
    add(value, 1, { attemptId: 20, completedMs: 1_500_000 });
    value.votes.push({ ...value.votes.at(-1)!, id: 21, slotModel: "second-b" });
    const report = reportLiveCapacityWindow(value);
    expect(report.finals).toMatchObject({ newCandidates: 1, repeatGenerations: 1, approvals: 1 });
    // 칸마다 가장 이른 승인, 모든 칸 중 가장 늦은 시각이 최종이다.
    expect(report.latencyMs.ai2Gate).toMatchObject({ samples: 1, p95: 1_003_000 - first.completedMs! });
    expect(report.calls.ai1).toMatchObject({ calls: 2, failed: 0 });
  });
  it("finalizes rejections at AI1 completion and approvals only after every required AI2 slot", () => {
    const value = artifact();
    add(value, 1, { decision: "reject", completedMs: 600_000 });
    add(value, 2, { gateMs: null });
    add(value, 3, { gateMs: WINDOW + 1, latency: 900_000 });
    add(value, 4);
    value.votes.push({ ...value.votes.at(-1)!, id: 41, status: "pending", secondDecision: null, reviewedMs: null });
    const report = reportLiveCapacityWindow(value);
    expect(report.finals).toMatchObject({ newCandidates: 1, rejections: 1, approvals: 0 });
    expect(report.exclusions).toMatchObject({ pendingAtEnd: 3, humanHandoff: 0 });
    expect(report.latencyMs.endToEnd.p95).toBe(10_000);
  });
  it("separates AI2 dissent and held candidates as human handoffs", () => {
    const value = artifact();
    add(value, 1, { gateMs: null });
    value.votes.push({ id: 99, firstAttemptId: 10, status: "needs_human", settledElsewhere: false, fallback: false, provider: "abcllm",
      model: "second", slotProvider: "abcllm", slotModel: "second", secondDecision: "reject", reviewedMs: 1_001_000 });
    add(value, 2, { gateMs: null });
    value.candidates[1].state = "needs_review";
    add(value, 3).decision = "needs_review";
    expect(reportLiveCapacityWindow(value)).toMatchObject({ finals: { newCandidates: 0 }, exclusions: { humanHandoff: 3 } });
  });
  it("accepts gate rows closed after publication only for the applied automatic publication", () => {
    const value = artifact();
    add(value, 1);
    Object.assign(value.votes[0], { status: "resolved", settledElsewhere: true });
    expect(reportLiveCapacityWindow(value).finals.newCandidates).toBe(0);
    value.candidates[0].state = "published";
    expect(reportLiveCapacityWindow(value).finals.newCandidates).toBe(1);
    value.candidates[0].decidedBy = "admin";
    expect(reportLiveCapacityWindow(value).finals.newCandidates).toBe(0);
  });
  it("lets a fallback fill its root slot only while it is still a configured fallback", () => {
    const value = artifact();
    add(value, 1);
    Object.assign(value.votes[0], { fallback: true, model: "backup" });
    expect(reportLiveCapacityWindow(value).finals.newCandidates).toBe(1);
    value.identity.models.fallbacks = [];
    expect(reportLiveCapacityWindow(value).finals.newCandidates).toBe(0);
  });
  it.each([
    ["rules", { provider: "rules" }], ["reuse", { reusedFromAttemptId: 5 }], ["stale", { policyHash: other }],
    ["stale", { promptVersion: "p0" }], ["stale", { model: "other" }], ["superseded", { state: "superseded" }],
  ] as const)("excludes %s generations (%j)", (reason, patch) => {
    const value = artifact();
    Object.assign(add(value, 1), patch);
    const report = reportLiveCapacityWindow(value);
    expect(report.finals.newCandidates).toBe(0);
    expect(report.exclusions[reason]).toBe(1);
  });
  it("counts technical failures but not cancellations and accepts model aliases", () => {
    const value = artifact();
    add(value, 1).model = "[MLX] first";
    Object.assign(add(value, 2), { state: "failed", failure: "technical", decision: null });
    Object.assign(add(value, 3), { state: "failed", failure: "cancelled", decision: null });
    value.ai2Calls = { chains: 3, calls: 4, failed: 1, unattributedChains: 2 };
    const report = reportLiveCapacityWindow(value);
    expect(report.finals.newCandidates).toBe(1);
    expect(report.calls).toMatchObject({ ai1: { calls: 2, failed: 1, cancelled: 1 }, total: 6, failed: 2 });
  });
  it("separates re-review finals and window boundaries", () => {
    const value = artifact();
    add(value, 1, { reReview: true });
    add(value, 2, { completedMs: -5_000, gateMs: 100 });
    add(value, 3, { completedMs: -5_000, gateMs: 0 });
    add(value, 4, { decision: "reject", completedMs: WINDOW });
    add(value, 5, { decision: "reject", completedMs: WINDOW + 1 });
    expect(reportLiveCapacityWindow(value).finals).toMatchObject({ newCandidates: 2, reReviewCandidates: 1 });
  });
  it.each([
    ["settings_changed_since_window_start", (value: LiveCapacityArtifact) => { value.identity.settingsUpdatedMs = 1; }],
    ["stage_mode_changed_since_window_start", (value: LiveCapacityArtifact) => { value.stageModes[0].changedSinceStart = true; }],
    ["model_capacity_changed_since_window_start", (value: LiveCapacityArtifact) => { value.modelCapacity!.changedSinceStart = true; }],
    ["replica_not_caught_up", (value: LiveCapacityArtifact) => { value.database = { ...value.database, target: "replica", inRecovery: true, replicaCaughtUp: false }; }],
    ["readiness_unproven", (value: LiveCapacityArtifact) => { value.readiness = { witnesses: 0, sampleCandidateIds: [] }; }],
    ["review_mode_not_enforce", (value: LiveCapacityArtifact) => { value.identity.reviewMode = "observe"; }],
    ["clock_anomaly", (value: LiveCapacityArtifact) => { value.attempts[0].readyMs = value.attempts[0].startedMs + 1; }],
  ])("reports %s as an evidence issue", (issue, mutate) => {
    const value = windowWith(1); mutate(value);
    expect(reportLiveCapacityWindow(value).evidenceIssues).toEqual([issue]);
  });
});

describe("live window judgement", () => {
  it("passes only when every measured condition and every evidence slot is verified", () => {
    const result = judge(windowWith(10, { ai2Calls: 90 }), windowWith(20, { ai2Calls: 80 }));
    expect(result).toMatchObject({ status: "passed", performance: "passed", quality: "passed", safety: "passed",
      budgetEvidence: "verified", ratio: 2, reasons: [] });
  });
  it("keeps artifacts incomplete while budget and safety evidence are unverified, yet computes every threshold", () => {
    const result = compareLiveCapacityRuns(labeled(windowWith(10, { ai2Calls: 90 })), labeled(windowWith(20, { ai2Calls: 80 })));
    expect(result).toMatchObject({ status: "incomplete", performance: "passed", quality: "passed", safety: "incomplete",
      budgetEvidence: "unverified", numericThresholds: { doubled: true, latencyNotWorse: true, technicalFailureWithinOnePoint: true } });
    expect(result.reasons.sort()).toEqual(["budget_evidence_unverified", "human_decision_override_unverified", "lease_violation_unverified"]);
    expect(compareLiveCapacityRuns(windowWith(10), windowWith(20)).reasons).toContain("quality_unverified");
  });
  it.each([[20, "passed"], [19, "failed"]] as const)("treats exactly 2.0x as the throughput boundary (%i finals → %s)", (finals, status) => {
    expect(judge(windowWith(10, { ai2Calls: 90 }), windowWith(finals, { ai2Calls: 80 })).status).toBe(status);
  });
  it("normalizes throughput by each SQL-measured window length", () => {
    const longer = { duration: 2 * WINDOW, ai2Calls: 60 };
    expect(judge(windowWith(10, { ai2Calls: 90 }), windowWith(40, longer)).numericThresholds.doubled).toBe(true);
    expect(judge(windowWith(10, { ai2Calls: 90 }), windowWith(39, longer))).toMatchObject({ status: "failed", reasons: ["throughput_below_2x"] });
  });
  it.each([[10_000, "passed"], [10_001, "failed"]] as const)("rejects any p95 regression (%i ms → %s)", (latency, status) => {
    const result = judge(windowWith(10, { ai2Calls: 90 }), windowWith(20, { ai2Calls: 80, latency }));
    expect(result.status).toBe(status);
    if (status === "failed") expect(result.reasons).toEqual(["latency_p95_worse"]);
  });
  it.each([
    [{ ai2Calls: 90, ai2Failed: 0 }, { ai2Calls: 80, ai2Failed: 1 }, true],
    [{ ai2Calls: 90, ai2Failed: 0 }, { ai2Calls: 80, ai2Failed: 2 }, false],
    [{ ai2Calls: 90, ai2Failed: 1 }, { ai2Calls: 180, ai2Failed: 4 }, true],
    [{ ai2Calls: 90, ai2Failed: 1 }, { ai2Calls: 180, ai2Failed: 5 }, false],
  ])("allows at most the baseline technical failure rate plus one point (%j → %j)", (before, after, within) => {
    const result = judge(windowWith(10, before), windowWith(20, after));
    expect(result.numericThresholds.technicalFailureWithinOnePoint).toBe(within);
    expect(result.status).toBe(within ? "passed" : "failed");
  });
  it.each([[WINDOW, "passed"], [WINDOW - 1, "incomplete"]] as const)("requires a window of at least 30 minutes (%i ms → %s)", (duration, status) => {
    const short = windowWith(20, { duration, ai2Calls: 80 });
    const result = judge(windowWith(10, { ai2Calls: 90 }), short);
    expect(result.status).toBe(status);
    if (status === "incomplete") expect(result).toMatchObject({ performance: "incomplete", reasons: ["window_under_30_minutes"] });
  });
  it("never certifies a window whose ready queue was not proven non-empty", () => {
    const after = windowWith(40, { ai2Calls: 80 }); after.readiness = { witnesses: 0, sampleCandidateIds: [] };
    expect(judge(windowWith(10, { ai2Calls: 90 }), after)).toMatchObject({ status: "incomplete", performance: "incomplete",
      numericThresholds: { doubled: true }, reasons: ["readiness_unproven"] });
  });
  it.each([
    (value: LiveCapacityArtifact) => { value.identity.models.first = identity("other"); for (const row of value.attempts) row.model = "other"; },
    (value: LiveCapacityArtifact) => { value.identity.promptVersion = "p2"; for (const row of value.attempts) row.promptVersion = "p2"; },
    (value: LiveCapacityArtifact) => { value.identity.comparisonPolicyHash = other; },
    (value: LiveCapacityArtifact) => { value.identity.models.second = [identity("second"), identity("second-b")]; },
  ])("does not compare mismatched model/policy/input identity #%#", mutate => {
    const after = windowWith(20, { ai2Calls: 80 }); mutate(after);
    expect(judge(windowWith(10, { ai2Calls: 90 }), after)).toMatchObject({ status: "incomplete", reasons: expect.arrayContaining(["conditions_mismatch"]) });
  });
  it("allows the experiment variables: concurrency, stage mode, capacity mode and gateway aliases", () => {
    const after = windowWith(20, { ai2Calls: 80 });
    after.identity.concurrency = 4; after.identity.fullReviewPolicyHash = other;
    after.stageModes = [{ stage: "ai1", mode: "items", epoch: 2, changedSinceStart: false }];
    after.modelCapacity = { mode: "open", changedSinceStart: false };
    after.identity.models.first = { provider: "abcllm", model: "[MLX] first", canonicalModel: "first" };
    expect(judge(windowWith(10, { ai2Calls: 90 }), after)).toMatchObject({ status: "passed", concurrency: { baseline: 2, candidate: 4 } });
  });
  it("fails quality regressions and safety violations even when other evidence is incomplete", () => {
    const before = reportLiveCapacityWindow(labeled(windowWith(10, { ai2Calls: 90 })));
    const worse = reportLiveCapacityWindow(labeled(windowWith(20, { ai2Calls: 80 }), 1));
    expect(judgeLiveCapacity(before, worse)).toMatchObject({ status: "failed", quality: "failed" });
    expect(judgeLiveCapacity(before, worse).reasons).toContain("wrong_decisions_increased");
    const duplicated = windowWith(20, { ai2Calls: 80 }); duplicated.safety.duplicatePublications = 1;
    expect(compareLiveCapacityRuns(windowWith(10), duplicated)).toMatchObject({ status: "failed", safety: "failed" });
    // 같은 비율의 오판은 증가가 아니다(표본 크기가 달라도 교차곱으로 비교).
    expect(judgeLiveCapacity(verified(reportLiveCapacityWindow(labeled(windowWith(10, { ai2Calls: 90 }), 1))),
      verified(reportLiveCapacityWindow(labeled(windowWith(20, { ai2Calls: 80 }), 2)))).quality).toBe("passed");
  });
  it("reports a baseline without finals as incomplete rather than infinite speedup", () => {
    expect(judgeLiveCapacity(verified(reportLiveCapacityWindow(windowWith(0, { ai2Calls: 90 }))),
      verified(reportLiveCapacityWindow(windowWith(20, { ai2Calls: 80 }))))).toMatchObject({ status: "incomplete",
      ratio: null, numericThresholds: { doubled: null } });
  });
});

describe("live artifact validation", () => {
  it("accepts a 0076 production schema as fixed legacy/disabled without changing judgement identity", () => {
    const before = windowWith(10, { ai2Calls: 90 });
    before.schema = { appliedMigrations: 77, absentTables: ["pipeline_stage_modes", "pipeline_item_leases", "model_capacity_control"] };
    before.stageModes = (["ai1", "ai2", "fetch"] as const).map(stage => ({ stage, mode: "legacy" as const, epoch: 1, changedSinceStart: false }));
    before.modelCapacity = { mode: "disabled", changedSinceStart: false };
    expect(reportLiveCapacityWindow(before)).toMatchObject({ evidenceIssues: [], schema: { appliedMigrations: 77 } });
    const after = windowWith(20, { ai2Calls: 80 });
    after.stageModes = [{ stage: "ai1", mode: "items", epoch: 2, changedSinceStart: false }];
    expect(judge(before, after)).toMatchObject({ status: "passed", reasons: [] });
  });
  it.each([
    (value: LiveCapacityArtifact) => { value.stageModes = [{ stage: "ai1", mode: "items", epoch: 1, changedSinceStart: false }]; },
    (value: LiveCapacityArtifact) => { value.stageModes = []; },
    (value: LiveCapacityArtifact) => { value.modelCapacity = { mode: "open", changedSinceStart: false }; },
    (value: LiveCapacityArtifact) => { value.modelCapacity = null; },
    (value: LiveCapacityArtifact) => { value.schema.absentTables = ["pipeline_item_leases", "pipeline_item_leases"]; },
  ])("rejects modes that an absent table could not have produced #%#", mutate => {
    const value = windowWith(1);
    value.schema.absentTables = ["pipeline_stage_modes", "pipeline_item_leases", "model_capacity_control"];
    value.stageModes = (["ai1", "ai2", "fetch"] as const).map(stage => ({ stage, mode: "legacy" as const, epoch: 1, changedSinceStart: false }));
    expect(() => parseLiveCapacityArtifact(value)).not.toThrow();
    mutate(value);
    expect(() => parseLiveCapacityArtifact(value)).toThrow("live_artifact_mismatch");
  });
  it.each([
    (value: LiveCapacityArtifact) => { value.window.durationMs = WINDOW - 1; },
    (value: LiveCapacityArtifact) => { value.window.collectedAt = at(WINDOW - 1); },
    (value: LiveCapacityArtifact) => { value.database.inRecovery = true; },
    (value: LiveCapacityArtifact) => { value.votes[0].firstAttemptId = 999; },
    (value: LiveCapacityArtifact) => { value.attempts[0].state = "failed"; },
    (value: LiveCapacityArtifact) => { value.attempts[0].completedMs = null; },
    (value: LiveCapacityArtifact) => { value.candidates = []; },
    (value: LiveCapacityArtifact) => { value.identity.models.first.canonicalModel = "wrong"; },
    (value: LiveCapacityArtifact) => { value.attempts.push({ ...value.attempts[0] }); },
    (value: LiveCapacityArtifact) => { (value.budget as { status: string }).status = "verified"; },
    (value: LiveCapacityArtifact) => { (value.safety as { leaseViolations: unknown }).leaseViolations = 0; },
    (value: LiveCapacityArtifact) => { Object.assign(value, { verified: true }); },
    (value: LiveCapacityArtifact) => { value.window.startedAt = "2026-10-17T00:00:00+09:00"; },
  ])("rejects inconsistent or forged artifact #%#", mutate => {
    const value = windowWith(1); mutate(value);
    expect(() => parseLiveCapacityArtifact(value)).toThrow();
  });
  it("binds labels to their dataset hash and refuses to replace an attached sample", () => {
    const value = labeled(windowWith(2));
    expect(value.quality!.datasetHash).toBe(liveLabelDatasetHash([...value.quality!.labels].reverse()));
    expect(() => attachLiveCapacityLabels(value, value.quality!.labels)).toThrow("live_quality_already_attached");
    expect(() => parseLiveCapacityArtifact({ ...value, quality: { ...value.quality!, datasetHash: other } })).toThrow("live_quality_mismatch");
    expect(reportLiveCapacityWindow(attachLiveCapacityLabels(windowWith(2), [{ candidateId: 99, inputHash: hash, expected: "approve" }])).quality)
      .toMatchObject({ complete: false, evaluated: 0, expected: 1 });
  });
});

it("runs the offline live CLI commands with fixed diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nomorevibe-capacity-live-"));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/pipeline-capacity-live.ts", ...args],
      { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" } });
    const before = join(directory, "before.json"), after = join(directory, "after.json"), labels = join(directory, "labels.json");
    await writeFile(before, JSON.stringify(windowWith(10, { ai2Calls: 90 })));
    await writeFile(after, JSON.stringify(windowWith(20, { ai2Calls: 80 })));
    const report = run("report", before);
    expect(report.status, report.stderr).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ scope: "live_window", finals: { newCandidates: 10 } });
    const compare = run("compare", before, after);
    expect(compare.status, compare.stderr).toBe(0);
    expect(JSON.parse(compare.stdout)).toMatchObject({ status: "incomplete", numericThresholds: { doubled: true } });
    await writeFile(labels, JSON.stringify([{ candidateId: 1, inputHash: hash, expected: "approve" }]));
    const output = join(directory, "labeled.json");
    expect(run("label", before, labels, output).status).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).quality.labels).toHaveLength(1);
    expect(run("label", before, labels, output).stderr.trim()).toBe("capacity_operation_failed");
    expect(run("collect", "run", at(0), at(WINDOW), "primary", join(directory, "x.json")).stderr.trim())
      .toBe("explicit_LIVE_CAPACITY_DATABASE_URL_required");
    expect(run("collect", "run", at(0), at(WINDOW), "standby", join(directory, "x.json")).stderr.trim()).toMatch(/^usage: pipeline-capacity-live/);
    expect(run("compare", before).status).toBe(1);
    await writeFile(after, "{}");
    expect(run("compare", before, after).stderr.trim()).toBe("invalid_capacity_artifact");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
