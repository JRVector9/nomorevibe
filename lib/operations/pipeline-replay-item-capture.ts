import type postgres from "postgres";
import { canonicalReplayItemState, replayItemStateHash, type ReplayItemState } from "./pipeline-replay-item-state";

/** One statement snapshot of all raw stage/item rows; no execution authority. */
export async function captureReplayItemState(tx: postgres.TransactionSql):
  Promise<{ state: ReplayItemState; stateHash: string }> {
  const rows = await tx`
    SELECT jsonb_build_object(
      'kind', 'pipeline-replay-item-state',
      'version', 1,
      'tables', jsonb_build_object(
        'pipeline_stage_modes', COALESCE(
          (SELECT jsonb_agg(to_jsonb(stage_row)) FROM public.pipeline_stage_modes stage_row),
          '[]'::jsonb
        ),
        'pipeline_item_leases', COALESCE(
          (SELECT jsonb_agg(to_jsonb(item_row)) FROM public.pipeline_item_leases item_row),
          '[]'::jsonb
        )
      )
    ) AS state
  `;
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("invalid_replay_item_capture_result");
  const state = canonicalReplayItemState(rows[0].state);
  return { state, stateHash: replayItemStateHash(state) };
}
