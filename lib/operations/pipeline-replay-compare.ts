import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { parseReplayArtifact, replayArtifactFromVerified, reportReplayArtifact, reportVerifiedReplayArtifact,
  type ReplayArtifact, type VerifiedReplayArtifact } from "./pipeline-replay-artifact";

/** Only these measured concurrency controls may vary; fallback and job ordering remain fixed. */
function conditions(artifact: ReplayArtifact) {
  const { manifest, initial } = artifact;
  const { concurrency, ...limits } = manifest.limits; void concurrency;
  return { mode: manifest.mode, cacheMode: manifest.cacheMode, referenceTime: manifest.referenceTime,
    inputPolicyHash: manifest.inputPolicyHash, comparisonPolicyHash: manifest.comparisonPolicyHash,
    comparisonStateHash: initial.comparisonStateHash, models: manifest.models, limits, runner: initial.runner,
    qualityDatasetHash: initial.quality?.datasetHash ?? null,
    inputs: manifest.inputs.map(({ readyAt, ...row }) => ({ ...row,
      readyOffsetMs: Date.parse(readyAt) - Date.parse(manifest.startedAt) }))
      .sort((a, b) => a.candidateId - b.candidateId || a.inputHash.localeCompare(b.inputHash)
        || a.sourceRevisionHash.localeCompare(b.sourceRevisionHash)) };
}
type Report = ReturnType<typeof reportReplayArtifact>;
function compare(before: ReplayArtifact, after: ReplayArtifact, baseline: Report, candidate: Report) {
  const reasons = new Set<string>();
  if (baseline.authenticity !== "verified" || candidate.authenticity !== "verified") reasons.add("artifact_provenance_unverified");
  if (before.manifest.mode === "fixtures" || after.manifest.mode === "fixtures") reasons.add("fixture_not_model_throughput");
  // This checkpoint has no admitted whole-attempt provider contract. JSON cannot supply one.
  if (baseline.budgetEvidence !== "verified" as string || candidate.budgetEvidence !== "verified" as string)
    reasons.add("provider_budget_unverified");
  if (reviewHash(conditions(before)) !== reviewHash(conditions(after))) reasons.add("conditions_mismatch");
  for (const report of [baseline, candidate]) {
    if (report.durationMs < 1_800_000) reasons.add("window_under_30_minutes");
    if (report.readiness !== "covered") reasons.add(report.readiness === "starved" ? "queue_starved" : "coverage_missing");
    if (!report.calls.completed) reasons.add("call_evidence_missing");
    if (!report.calls.classificationKnown) reasons.add("failure_classification_unknown");
    if (report.unconfirmedFinals) reasons.add("final_commit_unconfirmed");
    if (!report.latencyEvidenceComplete) reasons.add("latency_evidence_missing");
    if (!report.classificationComplete) reasons.add("initial_review_classification_unknown");
    if (report.calls.inputTokens === null || report.calls.outputTokens === null) reasons.add("token_usage_unknown");
    if (Object.values(report.recordedBudget).some(value => value === false)) reasons.add("recorded_budget_exceeded");
  }
  const ratio = baseline.finalPerHour > 0 ? candidate.finalPerHour / baseline.finalPerHour : null;
  const numericThresholds = { doubled: ratio === null ? null : ratio >= 2,
    latencyNotWorse: baseline.endToEndMs.p95 === null || candidate.endToEndMs.p95 === null ? null
      : candidate.endToEndMs.p95 <= baseline.endToEndMs.p95,
    technicalFailureWithinOnePoint: baseline.calls.technicalFailureRate === null || candidate.calls.technicalFailureRate === null ? null
      : candidate.calls.technicalFailureRate <= baseline.calls.technicalFailureRate + .01 };
  const quality = !baseline.quality.complete || !candidate.quality.complete
    || baseline.quality.datasetHash !== candidate.quality.datasetHash ? "incomplete" as const
    : candidate.quality.wrongApprovals <= baseline.quality.wrongApprovals
      && candidate.quality.wrongRejections <= baseline.quality.wrongRejections ? "passed" as const : "failed" as const;
  if (quality === "incomplete") reasons.add("quality_evidence_incomplete");
  if (Object.values(numericThresholds).some(value => value === null)) reasons.add("performance_samples_missing");
  const performance = reasons.size ? "incomplete" as const
    : Object.values(numericThresholds).every(Boolean) ? "passed" as const : "failed" as const;
  const overall = quality === "failed" || performance === "failed" ? "failed" as const
    : quality === "passed" && performance === "passed" ? "passed" as const : "incomplete" as const;
  return { baseline, candidate, ratio, numericThresholds, performance, quality, overall,
    budgetEvidence: "unverified" as const, reasons: [...reasons],
    concurrency: { baseline: before.manifest.limits.concurrency, candidate: after.manifest.limits.concurrency } };
}
/** Offline comparison always retains unverified provenance. */
export function compareReplayArtifacts(baseline: unknown, candidate: unknown) {
  const before = parseReplayArtifact(baseline), after = parseReplayArtifact(candidate);
  return compare(before, after, reportReplayArtifact(before), reportReplayArtifact(after));
}
export function compareVerifiedReplayRuns(baseline: unknown, candidate: unknown) {
  const before = replayArtifactFromVerified(baseline), after = replayArtifactFromVerified(candidate);
  return compare(before, after, reportVerifiedReplayArtifact(baseline as VerifiedReplayArtifact),
    reportVerifiedReplayArtifact(candidate as VerifiedReplayArtifact));
}
