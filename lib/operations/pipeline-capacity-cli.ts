import { ZodError } from "zod";

const fixedErrors = new Set([
  "artifact_size_limit", "invalid_artifact_json", "explicit_TEST_DATABASE_URL_required",
  "real_model_replay_unimplemented", "invalid_command",
  "usage: measure-pipeline-capacity report ARTIFACT | compare BASELINE CANDIDATE | replay-plan MANIFEST",
  "usage: export-pipeline-capacity TEMPLATE OUTPUT",
  "local_test_database_required", "database_override_rejected", "database_url_mismatch",
  "replica_database_rejected", "planned_token_budget_exceeded",
  "invalid_hash_input", "invalid_window", "duplicate_input", "generation_mismatch",
  "model_identity_mismatch", "duplicate_model", "source_mismatch", "conflicting_attempt",
  "invalid_generation_time", "call_mismatch", "conflicting_call", "quality_mismatch",
  "usage_total_overflow", "invalid_snapshot_candidates", "snapshot_policy_mismatch",
  "snapshot_model_mismatch", "snapshot_candidate_missing", "snapshot_row_limit",
  "usage: pipeline-capacity-live collect RUN_ID START END primary|replica OUTPUT | report ARTIFACT | compare BASELINE CANDIDATE | label ARTIFACT LABELS OUTPUT",
  "explicit_LIVE_CAPACITY_DATABASE_URL_required", "live_revision_unavailable", "live_window_invalid", "live_window_not_finished",
  "live_target_mismatch", "live_transaction_not_read_only", "live_write_detected", "live_row_limit",
  "live_first_reviewer_unpinned", "live_artifact_mismatch", "live_quality_mismatch", "live_quality_already_attached",
]);

/** Never expose artifact values, file paths, database messages or nested causes. */
export function formatCapacityCliError(error: unknown): string {
  if (error instanceof ZodError) return "invalid_capacity_artifact";
  return error instanceof Error && fixedErrors.has(error.message) ? error.message : "capacity_operation_failed";
}
