import type { CapacityManifest } from "./pipeline-capacity";
import type { ReplayReadinessProjection } from "./pipeline-replay-readiness";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash } from "@/lib/crawl/agent-review-contract";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { sameReviewModel } from "@/lib/crawl/review-model-identity";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";

export type ReplayInitialReviewKind = { candidateId: number; kind: "new" | "reReview" | "unknown"; reason: string };
type Row = ReplayReadinessProjection["tables"]["crawl_candidates"][number];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** The caller's manifest flag never establishes whether a candidate was completed before the run. */
export function classifyReplayInitialCandidates(projection: ReplayReadinessProjection,
  manifest: Pick<CapacityManifest, "inputs">): ReplayInitialReviewKind[] {
  const settings = mergeWithDefaults(projection.tables.crawl_settings.find(row => row.id === 1)?.values);
  return [...new Set(manifest.inputs.map(row => row.candidateId))].map(candidateId => {
    const result = (kind: ReplayInitialReviewKind["kind"], reason: string) => ({ candidateId, kind, reason });
    const candidate = projection.tables.crawl_candidates.find(row => row.id === candidateId);
    if (!candidate) return result("unknown", "candidate_missing");
    if (candidate.state === "published" || typeof candidate.published_slug === "string" && candidate.published_slug.length > 0)
      return result("reReview", "previously_published");
    if (candidate.decided_by !== "auto") return result("unknown", "nonautomatic_candidate");
    const successes = projection.tables.crawl_review_attempts.filter(row => row.candidate_id === candidateId && row.state === "succeeded");
    const appliedId = object(candidate.signals).agentReviewAttemptId;
    if (!successes.length && appliedId === undefined) return result("new", "no_prior_completion");
    const first = successes.find(row => row.id === appliedId), outcome = object(first?.outcome);
    if (!first || first.kind !== "automatic" || first.actor !== null || first.reused_from_attempt_id !== null
      || !["abcllm", "claude-cli", "grok-cli"].includes(String(first.provider)) || first.completed_at === null
      || first.prompt_version !== REVIEW_PROMPT_VERSION || first.rules_version !== REVIEW_RULES_VERSION)
      return result("unknown", "prior_application_unproven");
    const snapshot = object(first.snapshot), evidence = snapshot.evidence;
    if (!Array.isArray(evidence) || reviewHash(first.source) !== first.source_revision_hash
      || reviewHash({ snapshot: { ...snapshot, evidence: evidence.map(item => object(item).observation) }, policyHash: first.policy_hash }) !== first.input_hash)
      return result("unknown", "prior_input_unproven");
    if (outcome.decision === "reject") return result("reReview", "previously_applied_rejection");
    if (outcome.decision !== "approve") return result("unknown", "prior_decision_nonterminal");
    // A current applied approval is already terminal when this captured policy has no AI2 gate.
    if (settings.reviewMode === "enforce" && !settings.secondReview.enabled)
      return result("reReview", "previously_applied_approval");
    if (!settings.enabled || settings.reviewMode !== "enforce" || !settings.secondReview.enabled)
      return result("unknown", "prior_policy_unproven");
    const slots = settings.secondReview.voters.filter(slot => !sameReviewModel(slot.model, String(first.model)));
    const rows = projection.tables.second_reviews.filter(row => row.first_attempt_id === first.id && row.trigger === "ai_approved");
    const generation = secondReviewGeneration(Number(first.id), { inputHash: String(first.input_hash), sourceRevisionHash: String(first.source_revision_hash) }, "ai_approved");
    const basic = (row: Row) => row.candidate_id === candidateId && row.repo === candidate.repo && row.input_hash === first.input_hash
      && row.generation_key === generation && row.first_model === first.model && row.first_decision === "approve"
      && (row.first_confidence ?? null) === (outcome.confidence ?? null) && row.published_slug === null && row.resolved_by === null;
    const rootFor = (row: Row) => row.fallback_for_id === null ? row : rows.find(root => root.id === row.fallback_for_id);
    const valid = (row: Row) => {
      const root = rootFor(row);
      if (!basic(row) || !root || !basic(root) || root.fallback_for_id !== null
        || !slots.some(slot => slot.provider === root.provider && sameReviewModel(slot.model, String(root.model)))) return false;
      return row.fallback_for_id === null || root.status === "resolved" && root.resolution === "fallback"
        && (settings.secondReview.fallbacks ?? []).some(slot => slot.provider === row.provider && sameReviewModel(slot.model, String(row.model)));
    };
    if (!slots.length || !rows.length || !rows.every(valid)) return result("unknown", "prior_gate_unproven");
    const completed = !rows.some(row => ["pending", "failed", "needs_human"].includes(String(row.status)))
      && slots.every(slot => rows.some(row => {
        const root = rootFor(row)!;
        return row.status === "agreed" && row.second_decision === "approve" && row.reviewed_at !== null
          && slot.provider === root.provider && sameReviewModel(slot.model, String(root.model));
      }));
    if (completed) return result("reReview", "previously_completed_gate");
    // An apparently first pending gate may have been added after an earlier gate
    // policy already completed. The snapshot cannot prove that negative history.
    return result("unknown", "prior_completion_unproven");
  });
}
export function assertReplayInitialReviewKinds(projection: ReplayReadinessProjection, manifest: Pick<CapacityManifest, "inputs">) {
  const classifications = classifyReplayInitialCandidates(projection, manifest);
  if (classifications.some(row => row.kind !== "unknown"
    && manifest.inputs.some(input => input.candidateId === row.candidateId && input.reReview !== (row.kind === "reReview"))))
    throw new Error("replay_review_kind_mismatch");
  return classifications;
}
