import "server-only";
import { readModelRegistry } from "@/lib/llm/model-registry";
import { findModelDefinition, modelStageId } from "./admin-models-view";
import { buildModelThroughput, type ModelCompletion } from "./admin-models-throughput";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { buildAdminModelsObservation, unavailableAdminModels, type AdminModelsObservation } from "./admin-models-observation";
import { readModelCapacityDeviceStates } from "@/lib/llm/capacity-devices-repository";

/** Read-only primary snapshot. Expired reservations and historical unknowns remain visible and occupied. */
export async function readAdminModelsObservation(): Promise<AdminModelsObservation> {
  try {
    return await withDbDeadline(Date.now() + 4000, () => onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const [control] = await tx.execute<{ observedAt: string; mode: "open" | "draining" | "disabled";
        epoch: number; revision: number; policy: unknown; policyHash: string | null; updatedAt: string }>(sql`
        SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
          mode, epoch::float8, revision::float8, policy, policy_hash AS "policyHash",
          to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
        FROM model_capacity_control WHERE id = 1`);
      if (!control) return unavailableAdminModels();
      const metrics = await tx.execute(sql`
        WITH measured AS (
          SELECT r.*, CASE
            WHEN state <> 'settled' THEN NULL
            WHEN terminal_evidence->'outcome'->>'ok' IN ('true','false') THEN (terminal_evidence->'outcome'->>'ok')::boolean
            WHEN terminal_evidence->>'finishReason' IS NOT NULL THEN terminal_evidence->>'finishReason' IN ('stop','tool_calls','function_call')
            WHEN terminal_evidence->'process'->>'exitCode' IS NOT NULL THEN terminal_evidence->'process'->>'exitCode' = '0'
            ELSE NULL END AS response_ok
          FROM model_capacity_requests r
          WHERE (state='settled' AND settled_at >= transaction_timestamp()-interval '24 hours' AND settled_at <= transaction_timestamp())
            OR (state='withdrawn' AND updated_at >= transaction_timestamp()-interval '24 hours' AND updated_at <= transaction_timestamp())
            OR state IN ('waiting','reserved','dispatched','indeterminate')
        ) SELECT route_id AS "routeId", provider, model, group_id AS "groupId", provider_budget_id AS "providerBudgetId",
          count(*) FILTER (WHERE response_ok AND settled_at >= transaction_timestamp()-interval '1 hour')::int AS "succeeded1h",
          count(*) FILTER (WHERE NOT response_ok AND settled_at >= transaction_timestamp()-interval '1 hour')::int AS "failed1h",
          count(*) FILTER (WHERE state='withdrawn' AND updated_at >= transaction_timestamp()-interval '1 hour')::int AS "withdrawn1h",
          count(*) FILTER (WHERE state='settled' AND response_ok IS NULL AND settled_at >= transaction_timestamp()-interval '1 hour')::int AS "unclassified1h",
          count(*) FILTER (WHERE state='waiting')::int AS waiting,
          count(*) FILTER (WHERE state='reserved')::int AS reserved,
          count(*) FILTER (WHERE state='dispatched')::int AS dispatched,
          count(*) FILTER (WHERE state='indeterminate')::int AS indeterminate,
          to_char(max(settled_at) FILTER (WHERE response_ok) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSuccessAt"
        FROM measured GROUP BY route_id,provider,model,group_id,provider_budget_id
        ORDER BY route_id,provider,model,group_id,provider_budget_id LIMIT 1001`);
      // A truncated aggregate cannot support honest occupancy totals.
      if (metrics.length > 1000) return unavailableAdminModels();
      const requests = await tx.execute(sql`
        SELECT r.request_id::text AS "requestId", r.route_id AS "routeId", r.provider, r.model,
          r.group_id AS "groupId", r.provider_budget_id AS "providerBudgetId", r.state,
          r.owner_instance_id AS "ownerInstanceId",
          to_char(r.queued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "queuedAt",
          to_char(coalesce((SELECT max(e.created_at) FROM model_capacity_events e
            WHERE e.request_id=r.request_id AND e.to_state=r.state AND e.from_state IS DISTINCT FROM e.to_state),r.queued_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "stateSince",
          to_char(r.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchedAt",
          to_char(r.reserved_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reservedUntil",
          EXISTS(SELECT 1 FROM model_capacity_events e WHERE e.request_id=r.request_id AND e.kind='dispatch_local_ended') AS "localEndRecorded"
        FROM model_capacity_requests r WHERE r.state IN ('waiting','reserved','dispatched','indeterminate')
        ORDER BY CASE WHEN r.state='indeterminate' THEN 0 ELSE 1 END,r.queue_ordinal LIMIT 101`);
      const completions = await tx.execute<ModelCompletion>(sql`
        SELECT route_id AS "routeId", provider, model, state,
          to_char(queued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "queuedAt",
          to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "settledAt",
          CASE WHEN terminal_evidence->'outcome'->>'ok' IN ('true','false') THEN (terminal_evidence->'outcome'->>'ok')::boolean
            WHEN terminal_evidence->>'finishReason' IS NOT NULL THEN terminal_evidence->>'finishReason' IN ('stop','tool_calls','function_call')
            WHEN terminal_evidence->'process'->>'exitCode' IS NOT NULL THEN terminal_evidence->'process'->>'exitCode' = '0'
            ELSE NULL END AS "responseOk"
        FROM model_capacity_requests
        WHERE state='settled' AND settled_at >= transaction_timestamp()-interval '24 hours' AND settled_at <= transaction_timestamp()
        ORDER BY settled_at DESC LIMIT 50001`);
      // Never render a partial sample as a complete rate or percentile.
      if (completions.length > 50000) return unavailableAdminModels();
      // 장비별 한도·점유·빌려 쓰기(PR 1b) — 같은 읽기 전용 스냅숏 안에서 읽는다. 못 읽으면 null(한도 미확인; 0 이나 정책값으로 꾸미지 않는다).
      const devices = await readModelCapacityDeviceStates(tx).catch(() => null);
      const registry = readModelRegistry();
      return { ...buildAdminModelsObservation({ observedAt: control.observedAt, control, metrics: Array.from(metrics), requests: Array.from(requests), devices }),
        throughput: buildModelThroughput(Array.from(completions, row => ({ ...row, routeId: modelStageId(row.routeId), model: findModelDefinition(row, registry.models)?.key ?? row.model })), control.observedAt) };
    }, { accessMode: "read only", isolationLevel: "repeatable read" })));
  } catch { return unavailableAdminModels(); }
}
