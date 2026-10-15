import type postgres from "postgres";
import { z } from "zod";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { parseCapacityManifest, type CapacityManifest } from "./pipeline-capacity";
import { applyReplayChanges, ReplayReadinessProjectionSchema, type ReplayReadinessProjection } from "./pipeline-replay-readiness";
import { canonicalReplayItemState, ReplayItemStateSchema, type ReplayItemState } from "./pipeline-replay-item-state";

export type ReplayCombinedState = {
  kind: "pipeline-replay-combined-state"; version: 1;
  domain: ReplayReadinessProjection; items: ReplayItemState;
};
const combinedStateSchema = z.object({ kind: z.literal("pipeline-replay-combined-state"), version: z.literal(1),
  domain: ReplayReadinessProjectionSchema, items: ReplayItemStateSchema }).strict();

/** One read snapshot only; this issues no readiness, freshness or execution authority. */
export async function captureReplayCombinedState(tx: postgres.TransactionSql, manifest: CapacityManifest):
  Promise<{ state: ReplayCombinedState; stateHash: string }> {
  const checked = parseCapacityManifest(manifest);
  const rows = await tx`
    SELECT jsonb_build_object(
      'kind', 'pipeline-replay-combined-state',
      'version', 1,
      'domain', jsonb_build_object(
        'version', 1,
        'referenceTime', ${checked.referenceTime}::text,
        'universe', COALESCE((SELECT jsonb_agg(to_jsonb(frozen_row)) FROM (
          SELECT candidate_id AS "candidateId", input_hash AS "inputHash",
            source_revision_hash AS "sourceRevisionHash", frozen_input->>'policyHash' AS "policyHash",
            frozen_input AS "frozenInput", frozen_hash AS "frozenHash"
          FROM pipeline_replay.capacity_inputs WHERE run_id = ${checked.runId}
        ) frozen_row), '[]'::jsonb),
        'tables', jsonb_build_object(
          'crawl_settings', COALESCE((SELECT jsonb_agg(to_jsonb(settings_row)) FROM public.crawl_settings settings_row), '[]'::jsonb),
          'crawl_candidates', COALESCE((SELECT jsonb_agg(to_jsonb(candidate_row)) FROM public.crawl_candidates candidate_row), '[]'::jsonb),
          'crawl_documents', COALESCE((SELECT jsonb_agg(to_jsonb(document_row)) FROM public.crawl_documents document_row), '[]'::jsonb),
          'crawl_review_attempts', COALESCE((SELECT jsonb_agg(to_jsonb(attempt_row)) FROM public.crawl_review_attempts attempt_row), '[]'::jsonb),
          'second_reviews', COALESCE((SELECT jsonb_agg(to_jsonb(second_row)) FROM public.second_reviews second_row), '[]'::jsonb),
          'agent_repository_scans', COALESCE((SELECT jsonb_agg(to_jsonb(scan_row)) FROM public.agent_repository_scans scan_row), '[]'::jsonb),
          'agent_repository_observations', COALESCE((SELECT jsonb_agg(to_jsonb(observation_row)) FROM public.agent_repository_observations observation_row), '[]'::jsonb),
          'products', COALESCE((SELECT jsonb_agg(to_jsonb(product_row)) FROM public.products product_row), '[]'::jsonb),
          'crawl_frontier', COALESCE((SELECT jsonb_agg(to_jsonb(frontier_row)) FROM public.crawl_frontier frontier_row), '[]'::jsonb),
          'jobs', COALESCE((SELECT jsonb_agg(to_jsonb(job_row)) FROM public.jobs job_row), '[]'::jsonb),
          'operations_observations', COALESCE((SELECT jsonb_agg(to_jsonb(operation_row)) FROM public.operations_observations operation_row), '[]'::jsonb),
          'capacity_calls', COALESCE((SELECT jsonb_agg(to_jsonb(call_row)) FROM pipeline_replay.capacity_calls call_row
            WHERE run_id = ${checked.runId}), '[]'::jsonb)
        )
      ),
      'items', jsonb_build_object(
        'kind', 'pipeline-replay-item-state',
        'version', 1,
        'tables', jsonb_build_object(
          'pipeline_stage_modes', COALESCE((SELECT jsonb_agg(to_jsonb(stage_row)) FROM public.pipeline_stage_modes stage_row), '[]'::jsonb),
          'pipeline_item_leases', COALESCE((SELECT jsonb_agg(to_jsonb(item_row)) FROM public.pipeline_item_leases item_row), '[]'::jsonb)
        )
      )
    ) AS state
  `;
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("invalid_replay_combined_capture_result");
  const state = combinedStateSchema.parse(rows[0].state);
  const inputKey = (input: { candidateId: number; inputHash: string; sourceRevisionHash: string }) =>
    JSON.stringify([input.candidateId, input.inputHash, input.sourceRevisionHash]);
  const inputs = new Set(checked.inputs.map(inputKey)), captured = new Set(state.domain.universe.map(inputKey));
  if (state.domain.referenceTime !== checked.referenceTime || state.domain.universe.length !== inputs.size
    || captured.size !== inputs.size || state.domain.universe.some(input => !inputs.has(inputKey(input))
      || input.policyHash !== checked.inputPolicyHash)) throw new Error("replay_combined_capture_universe_mismatch");
  state.domain = applyReplayChanges(state.domain, []);
  state.items = canonicalReplayItemState(state.items);
  return { state, stateHash: reviewHash(state) };
}
