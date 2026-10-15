import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { compareCapacityRuns, comparisonReviewPolicyHash, fullReviewPolicyHash, parseCapacityArtifact, reportCapacityRun,
  validateReplayPlan, type CapacityArtifact } from "@/lib/operations/pipeline-capacity";

const hash = "a".repeat(64);
const at = (ms: number) => new Date(Date.UTC(2026, 9, 15) + ms).toISOString();
const localUrl = "postgres://test:test@127.0.0.1:55435/nomorevibe_test";
function artifact(): CapacityArtifact {
  return {
    manifest: { version: 1, runId: "run-a", revision: "8020dca", mode: "fixtures", cacheMode: "cold",
      referenceTime: at(0), startedAt: at(0), endedAt: at(1_800_000), inputPolicyHash: hash,
      fullReviewPolicyHash: hash, comparisonPolicyHash: hash, initialStateHash: hash,
      models: { first: { provider: "abcllm", model: "first", canonicalModel: "first" },
        second: [{ provider: "abcllm", model: "second", canonicalModel: "second" }], fallbacks: [] },
      inputs: [{ candidateId: 1, inputHash: hash, sourceRevisionHash: hash, readyAt: at(0), stratum: "new", reReview: false }],
      limits: { maxCalls: 100, maxTokens: 1_000_000, maxDurationMs: 1_800_000, concurrency: 4, perCallTokenUpperBound: 10_000 } },
    source: { kind: "fixture", scope: "as_of_snapshot_only", runId: "run-a", exportedAt: at(1_800_000), fullReviewPolicyHash: hash },
    generations: [{ candidateId: 1, firstAttemptId: 10, inputHash: hash, sourceRevisionHash: hash,
      policyHash: hash, provider: "abcllm", model: "first", kind: "automatic", state: "succeeded",
      reusedFromAttemptId: null, decision: "approve", startedAt: at(0), completedAt: at(1_000), validUntil: at(86_400_000),
      candidateState: "approved", decidedBy: "auto", appliedAttemptId: 10, currentInputMatched: true,
      secondGateRequired: true, secondGateSatisfied: false, secondGateCompletedAt: null }],
    readiness: [{ from: at(0), until: at(1_800_000), ready: 5 }], calls: [], quality: null,
  };
}
function final(): CapacityArtifact {
  const value = artifact();
  Object.assign(value.generations[0], { secondGateSatisfied: true, secondGateCompletedAt: at(5_000) });
  return value;
}
function call(): CapacityArtifact["calls"][number] {
  return { callId: "call-1", stage: "first", candidateId: 1, firstAttemptId: 10, inputHash: hash,
    sourceRevisionHash: hash, provider: "abcllm", model: "first", startedAt: at(1), endedAt: at(500),
    ok: true, error: null, inputTokens: 200, outputTokens: 20 };
}
function labels(value: CapacityArtifact, expected: "approve" | "reject") {
  const labels = [{ candidateId: 1, inputHash: hash, expected }];
  const canonicalLabels = `[${labels.map(item => `{"candidateId":${item.candidateId},"expected":"${item.expected}","inputHash":"${item.inputHash}"}`).join(",")}]`;
  value.quality = { datasetHash: createHash("sha256").update(canonicalLabels).digest("hex"), labels };
}
it("counts an approval only after its required AI2 gate and uses the last durable time", () => {
  expect(reportCapacityRun(artifact()).finalCandidates).toBe(0);
  expect(reportCapacityRun(final())).toMatchObject({ finalCandidates: 1, finalGenerations: 1,
    evidence: "as_of_snapshot_only", authenticity: "unverified", endToEndMs: { p95: 5_000 } });
});
it("counts an applied model rejection without optional AI2 and deduplicates retry generations", () => {
  const value = final();
  Object.assign(value.generations[0], { decision: "reject", candidateState: "rejected", secondGateRequired: false,
    secondGateSatisfied: false, secondGateCompletedAt: null });
  value.generations.push({ ...value.generations[0] }, { ...value.generations[0], firstAttemptId: 11, appliedAttemptId: 11 });
  expect(reportCapacityRun(value)).toMatchObject({ finalCandidates: 1, finalGenerations: 1, repeatGenerations: 0,
    endToEndMs: { p95: 1_000 } });
});
it.each([
  ["rules", { provider: "rules" }], ["reuse", { reusedFromAttemptId: 9 }],
  ["human", { decidedBy: "admin" }], ["human", { decidedBy: null }],
  ["human", { appliedAttemptId: null }], ["human", { candidateState: "needs_review" }],
  ["partial", { state: "running", completedAt: null, secondGateSatisfied: false, secondGateCompletedAt: null }], ["partial", { state: "failed" }],
  ["partial", { decision: "needs_review" }], ["stale", { currentInputMatched: false }],
  ["stale", { policyHash: "b".repeat(64) }], ["stale", { model: "wrong" }],
  ["stale", { validUntil: at(4_000) }], ["outsideWindow", { completedAt: at(1_800_001), secondGateCompletedAt: at(1_800_002) }],
] as const)("excludes %s rows (%j)", (reason, patch) => {
  const value = final();
  Object.assign(value.generations[0], patch);
  expect(reportCapacityRun(value).finalCandidates).toBe(0);
  expect(reportCapacityRun(value).exclusions[reason]).toBe(1);
});
it("reports re-review generations separately from new candidate capacity", () => {
  const value = final();
  value.manifest.inputs[0].reReview = true;
  expect(reportCapacityRun(value)).toMatchObject({ finalCandidates: 0, finalGenerations: 1,
    repeatGenerations: 0, reReviewGenerations: 1, exclusions: { reReview: 1 } });
});
it("separates mixed new finals, extra generations and explicit re-review generations", () => {
  const value = final();
  value.manifest.inputs.push({ ...value.manifest.inputs[0], candidateId: 2, reReview: true });
  value.generations.push({ ...value.generations[0], candidateId: 2, firstAttemptId: 20, appliedAttemptId: 20 });
  expect(reportCapacityRun(value)).toMatchObject({ finalCandidates: 1, finalGenerations: 2,
    repeatGenerations: 0, reReviewGenerations: 1 });
  value.manifest.inputs.push({ ...value.manifest.inputs[0], sourceRevisionHash: "b".repeat(64) });
  value.generations.push({ ...value.generations[0], sourceRevisionHash: "b".repeat(64), firstAttemptId: 11, appliedAttemptId: 11 });
  expect(reportCapacityRun(value)).toMatchObject({ finalCandidates: 1, finalGenerations: 3,
    repeatGenerations: 1, reReviewGenerations: 1 });
});
it("caps one candidate per window while retaining distinct source generations", () => {
  const value = final();
  value.manifest.inputs.push({ ...value.manifest.inputs[0], sourceRevisionHash: "b".repeat(64) });
  value.generations.push({ ...value.generations[0], firstAttemptId: 11, appliedAttemptId: 11,
    sourceRevisionHash: "b".repeat(64), secondGateCompletedAt: at(6_000) });
  expect(reportCapacityRun(value)).toMatchObject({ finalCandidates: 1, finalGenerations: 2, repeatGenerations: 1 });
});
it.each([
  (value: CapacityArtifact) => { value.source.runId = "other"; },
  (value: CapacityArtifact) => { value.source.fullReviewPolicyHash = "b".repeat(64); },
  (value: CapacityArtifact) => { value.source.exportedAt = at(1_000); },
  (value: CapacityArtifact) => { value.manifest.inputs.push({ ...value.manifest.inputs[0] }); },
  (value: CapacityArtifact) => { value.generations.push({ ...value.generations[0], decision: "reject" }); },
  (value: CapacityArtifact) => { value.generations[0].candidateId = 99; },
  (value: CapacityArtifact) => { value.generations[0].completedAt = at(-1); },
  (value: CapacityArtifact) => { value.generations[0].secondGateCompletedAt = at(500); },
  (value: CapacityArtifact) => { value.manifest.models.first.canonicalModel = "wrong"; },
  (value: CapacityArtifact) => { value.manifest.models.second.push({ provider: "claude-cli", model: "[MLX] second", canonicalModel: "second" }); },
])( "rejects inconsistent artifact #%#", mutate => {
  const value = final(); mutate(value);
  expect(() => parseCapacityArtifact(value)).toThrow();
});
it("rejects malformed records and forged verification flags instead of silently dropping them", () => {
  expect(() => parseCapacityArtifact({ ...final(), verified: true })).toThrow();
  expect(() => parseCapacityArtifact({ ...final(), calls: [{ callId: "broken" }] })).toThrow();
  const value = final(); value.manifest.limits.maxTokens = Infinity;
  expect(() => parseCapacityArtifact(value)).toThrow();
});
it("counts calls once, preserves missing usage and rejects unmatched generation identities", () => {
  const value = final(); value.calls = [call(), call()];
  expect(reportCapacityRun(value).calls).toMatchObject({ completed: 1, failed: 0, inputTokens: 200, outputTokens: 20 });
  value.calls[1] = { ...call(), callId: "call-2", endedAt: null, ok: null, inputTokens: null, outputTokens: null };
  expect(reportCapacityRun(value).calls).toMatchObject({ unmatched: 1, inputTokens: null, outputTokens: null });
  value.calls[1].firstAttemptId = 99;
  expect(() => parseCapacityArtifact(value)).toThrow("call_mismatch");
});
it("rejects conflicting call IDs and failed calls without an error", () => {
  const value = final(); value.calls = [call(), { ...call(), ok: false, error: "timeout" }];
  expect(() => parseCapacityArtifact(value)).toThrow("conflicting_call");
  value.calls = [{ ...call(), ok: false }];
  expect(() => parseCapacityArtifact(value)).toThrow("call_mismatch");
});
it("reports recorded budget violations separately from enforcement proof", () => {
  const value = final(); value.manifest.limits.maxCalls = 1;
  value.calls = [call(), { ...call(), callId: "call-2" }];
  expect(reportCapacityRun(value).recordedBudget).toMatchObject({ callsWithinLimit: false, tokensWithinLimit: true });
  expect(compareCapacityRuns(value, value).reasons).toContain("recorded_budget_exceeded");
  value.manifest.limits.maxCalls = 100;
  value.calls[1].inputTokens = 1_000_000;
  expect(reportCapacityRun(value).recordedBudget).toMatchObject({ tokensWithinLimit: false, perCallTokensWithinLimit: false });
  expect(reportCapacityRun(value).budgetEvidence).toBe("unverified");
});
it("rejects token-sum overflow and keeps cancellations out of the technical failure denominator", () => {
  const value = final();
  value.calls = [call(), { ...call(), callId: "cancel", ok: false, error: "cancelled" }];
  expect(reportCapacityRun(value).calls).toMatchObject({ completed: 2, failed: 0, cancelled: 1 });
  value.calls = [{ ...call(), inputTokens: Number.MAX_SAFE_INTEGER }, { ...call(), callId: "overflow", inputTokens: 1 }];
  expect(() => reportCapacityRun(value)).toThrow("usage_total_overflow");
});
it.each([
  [[], "missing"],
  [[{ from: at(1), until: at(1_800_000), ready: 2 }], "missing"],
  [[{ from: at(0), until: at(1_800_000), ready: 0 }], "starved"],
  [[{ from: at(0), until: at(1_000), ready: 2 }, { from: at(500), until: at(1_800_000), ready: 2 }], "missing"],
] as const)("identifies readiness evidence as %s", (intervals, status) => {
  const value = final(); value.readiness = intervals.map(row => ({ ...row }));
  expect(reportCapacityRun(value).readiness).toBe(status);
  expect(compareCapacityRuns(value, value).reasons).toContain(status === "starved" ? "queue_starved" : "readiness_missing");
});
it("hashes complete settings independent of object-key order and includes nested AI2 settings", () => {
  const settings = structuredClone(DEFAULT_CRAWL_SETTINGS);
  expect(fullReviewPolicyHash(settings)).toBe(fullReviewPolicyHash(Object.fromEntries(Object.entries(settings).reverse()) as typeof settings));
  settings.secondReview.agreeAt = .123;
  expect(fullReviewPolicyHash(settings)).not.toBe(fullReviewPolicyHash(DEFAULT_CRAWL_SETTINGS));
});
it("separates exact DB settings binding from the approved concurrency experiment", () => {
  const beforeSettings = structuredClone(DEFAULT_CRAWL_SETTINGS), afterSettings = structuredClone(DEFAULT_CRAWL_SETTINGS);
  beforeSettings.reviewConcurrency = 2; afterSettings.reviewConcurrency = 4;
  expect(fullReviewPolicyHash(beforeSettings)).not.toBe(fullReviewPolicyHash(afterSettings));
  expect(comparisonReviewPolicyHash(beforeSettings)).toBe(comparisonReviewPolicyHash(afterSettings));
  const before = final(), after = final();
  for (const [value, settings] of [[before, beforeSettings], [after, afterSettings]] as const) {
    value.manifest.fullReviewPolicyHash = fullReviewPolicyHash(settings);
    value.source.fullReviewPolicyHash = value.manifest.fullReviewPolicyHash;
    value.manifest.comparisonPolicyHash = comparisonReviewPolicyHash(settings);
    value.manifest.limits.concurrency = settings.reviewConcurrency;
  }
  expect(compareCapacityRuns(before, after).reasons).not.toContain("conditions_mismatch");
  afterSettings.secondReview.agreeAt = .123;
  expect(comparisonReviewPolicyHash(beforeSettings)).not.toBe(comparisonReviewPolicyHash(afterSettings));
  afterSettings.secondReview.agreeAt = beforeSettings.secondReview.agreeAt;
  afterSettings.firstReview = { provider: "abcllm", model: "different" };
  expect(comparisonReviewPolicyHash(beforeSettings)).not.toBe(comparisonReviewPolicyHash(afterSettings));
  afterSettings.firstReview = beforeSettings.firstReview;
  afterSettings.secondReview.voters[0].model = "different-second";
  expect(comparisonReviewPolicyHash(beforeSettings)).not.toBe(comparisonReviewPolicyHash(afterSettings));
  after.manifest.comparisonPolicyHash = comparisonReviewPolicyHash(afterSettings);
  expect(compareCapacityRuns(before, after).reasons).toContain("conditions_mismatch");
});
it("derives wrong approvals/rejections from pinned labels independently of throughput", () => {
  const value = final(); labels(value, "approve");
  expect(reportCapacityRun(value).quality).toMatchObject({ status: "passed", wrongApprovals: 0, wrongRejections: 0 });
  labels(value, "reject");
  expect(reportCapacityRun(value).quality).toMatchObject({ status: "failed", wrongApprovals: 1 });
  Object.assign(value.generations[0], { decision: "reject", candidateState: "rejected" }); labels(value, "approve");
  expect(reportCapacityRun(value).quality).toMatchObject({ status: "failed", wrongRejections: 1 });
  value.quality!.datasetHash = hash;
  expect(() => parseCapacityArtifact(value)).toThrow("quality_mismatch");
});
it("checks a pinned quality subset independently of a larger throughput sample", () => {
  const before = final(), after = final();
  for (const value of [before, after]) {
    value.manifest.inputs.push({ ...value.manifest.inputs[0], candidateId: 2 });
    labels(value, "approve");
  }
  after.generations.push({ ...after.generations[0], candidateId: 2, firstAttemptId: 20, appliedAttemptId: 20 });
  expect(compareCapacityRuns(before, after)).toMatchObject({ ratio: 2, quality: "passed" });
  Object.assign(after.generations[0], { decision: "reject", candidateState: "rejected" });
  expect(compareCapacityRuns(before, after)).toMatchObject({ ratio: 2, quality: "failed", overall: "failed" });
  expect(reportCapacityRun(after).quality).toMatchObject({ evaluated: 1, expected: 1 });
});
it("does not infer full quality coverage when labeled inputs have unfinished work", () => {
  const value = artifact(); labels(value, "approve");
  expect(reportCapacityRun(value).quality.status).toBe("incomplete");
});
it("never authenticates offline rows or labels fixture numbers as verified capacity", () => {
  const value = final();
  expect(compareCapacityRuns(value, value)).toMatchObject({ ratio: 1, performance: "incomplete", overall: "incomplete", budgetEvidence: "unverified" });
  value.manifest.mode = "model-replay"; value.source.kind = "local-postgres";
  expect(compareCapacityRuns(value, value).reasons).toContain("model_replay_unverified");
});
it("allows changed concurrency and recognized model aliases while pinning budgets", () => {
  const before = final(), after = final();
  before.manifest.limits.concurrency = 2;
  after.manifest.models.first.model = "[MLX] first";
  expect(compareCapacityRuns(before, after)).toMatchObject({ concurrency: { baseline: 2, candidate: 4 } });
  expect(compareCapacityRuns(before, after).reasons).not.toContain("conditions_mismatch");
  after.manifest.limits.maxCalls = 101;
  expect(compareCapacityRuns(before, after).reasons).toContain("conditions_mismatch");
});
it.each([
  (value: CapacityArtifact) => { value.manifest.cacheMode = "warm"; },
  (value: CapacityArtifact) => { value.manifest.initialStateHash = "b".repeat(64); },
  (value: CapacityArtifact) => { value.manifest.referenceTime = at(1); },
  (value: CapacityArtifact) => { value.manifest.inputs[0].stratum = "retry"; },
  (value: CapacityArtifact) => { value.manifest.models.first = { provider: "abcllm", model: "changed", canonicalModel: "changed" }; },
])( "rejects a mismatched comparison condition #%#", mutate => {
  const before = final(), after = final(); mutate(after);
  expect(compareCapacityRuns(before, after).reasons).toContain("conditions_mismatch");
});
it("exposes short windows and missing call evidence without certifying a result", () => {
  const value = final(); value.manifest.endedAt = at(60_000); value.readiness[0].until = at(60_000);
  expect(compareCapacityRuns(value, value).reasons).toEqual(expect.arrayContaining(["window_under_30_minutes", "call_evidence_missing"]));
});
it("validates local replay configuration while blocking model execution", () => {
  expect(validateReplayPlan(final().manifest, localUrl, {})).toMatchObject({ configurationValid: true,
    executionSupported: false, budgetEvidence: "unverified", reason: "real_model_replay_unimplemented" });
});
it.each(["postgres://a:b@remote/nomorevibe_test", "postgres://a:b@localhost/production",
  `${localUrl}?host=remote`, `${localUrl}#host`, "not-a-url"])("rejects unsafe replay DB %s", url => {
  expect(() => validateReplayPlan(final().manifest, url, {})).toThrow("local_test_database_required");
});
it("rejects host overrides, inconsistent URLs and exceeded or invalid reservation bounds", () => {
  expect(() => validateReplayPlan(final().manifest, localUrl, { PGHOST: "remote" })).toThrow("database_override_rejected");
  expect(() => validateReplayPlan(final().manifest, localUrl, { DATABASE_URL: "other" })).toThrow("database_url_mismatch");
  const value = final(); value.manifest.limits.maxTokens--;
  expect(() => validateReplayPlan(value.manifest, localUrl, {})).toThrow("planned_token_budget_exceeded");
  value.manifest.limits.maxCalls = 0;
  expect(() => validateReplayPlan(value.manifest, localUrl, {})).toThrow();
});
it("rejects replica DB configuration and whitespace-normalized identities", () => {
  expect(() => validateReplayPlan(final().manifest, localUrl, { READ_DATABASE_URL: "other" })).toThrow("replica_database_rejected");
  const value = final(); value.manifest.runId = " run-a ";
  expect(() => parseCapacityArtifact(value)).toThrow();
});
it("runs offline CLI commands and rejects replay without executing models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nomorevibe-capacity-"));
  try {
    const path = join(directory, "run.json"); await writeFile(path, JSON.stringify(final()));
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/measure-pipeline-capacity.ts", ...args], { encoding: "utf8" });
    const report = run("report", path);
    expect(report.status, report.stderr).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ evidence: "as_of_snapshot_only", finalCandidates: 1 });
    const compare = run("compare", path, path);
    expect(compare.status, compare.stderr).toBe(0);
    expect(JSON.parse(compare.stdout).overall).toBe("incomplete");
    expect(run("replay", path).stderr).toContain("real_model_replay_unimplemented");
    expect(run("bad", path).status).toBe(1);
    await writeFile(path, "{}"); expect(run("report", path).status).toBe(1);
    await writeFile(path, "private-evidence-sample");
    const malformed = run("report", path);
    expect(malformed.stderr.trim()).toBe("invalid_artifact_json");
    const latency = spawnSync(process.execPath, ["--import", "tsx", "scripts/report-review-latency.ts", path], { encoding: "utf8" });
    expect(latency.status, latency.stderr).toBe(0);
    expect(JSON.parse(latency.stdout)).toMatchObject({ evidence: "best_effort_model_call_telemetry", authoritativeFinalThroughput: null, productionSpeedup: null });
    const manifestPath = join(directory, "manifest.json"); await writeFile(manifestPath, JSON.stringify(final().manifest));
    const admission = spawnSync(process.execPath, ["--import", "tsx", "scripts/measure-pipeline-capacity.ts", "replay-plan", manifestPath],
      { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, TEST_DATABASE_URL: localUrl } });
    expect(admission.status, admission.stderr).toBe(0);
    expect(JSON.parse(admission.stdout)).toMatchObject({ executionSupported: false, budgetEvidence: "unverified" });
    const oversized = await open(path, "w");
    try { await oversized.truncate(64 * 1024 * 1024 + 1); } finally { await oversized.close(); }
    expect(run("report", path).stderr.trim()).toBe("artifact_size_limit");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it.each([
  "postgres://fixture:fixture@production.invalid,127.0.0.1@localhost/nomorevibe_test",
  "postgres://fixture:fixture@production.invalid%2c127.0.0.1@localhost/nomorevibe_test",
  "postgres://fixture:fixture@production.invalid%2C127.0.0.1@127.0.0.1/nomorevibe_test",
])("rejects postgres.js first-at-sign/multihost ambiguity: %s", async url => {
  const { assertLocalTestDatabase } = await import("../scripts/test-database");
  expect(() => validateReplayPlan(artifact().manifest, url, {})).toThrow("local_test_database_required");
  expect(() => assertLocalTestDatabase(url)).toThrow("local_test_database_required");
});
