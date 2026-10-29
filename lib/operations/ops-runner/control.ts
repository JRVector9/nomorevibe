import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { adminAuditRow } from "../admin-log";
import { writerSiteActive } from "../dr/epoch";
import { currentModelEnv } from "../model-env";
import { runPipelineControl } from "../pipeline-control-repository";
import type { OpsState } from "./contract";

export type CapacityPin = { mode: "open" | "draining" | "disabled"; epoch: number; revision: number; policyHash: string; updatedAt: string };
export async function capacityPin(): Promise<CapacityPin> {
  const [row] = await onPrimary(() => db.execute<CapacityPin>(sql`SELECT mode,epoch::float8,revision::float8,policy_hash AS "policyHash",
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt" FROM model_capacity_control WHERE id=1`));
  if (!row) throw new Error("ops_runner_control_missing");
  return row;
}
export async function controlOpsAdmission(state: OpsState, to: "open" | "draining", expected: CapacityPin, reconcile = false) {
  return onPrimary(async () => {
    const key = `${state.id}:${to}`;
    const [committed] = await db.execute<{ detail: { after: CapacityPin } }>(sql`SELECT detail FROM operations_audit
      WHERE action='ops-runner-control' AND target=${key} ORDER BY id DESC LIMIT 1`);
    if (committed) {
      const current = await capacityPin();
      return { ok: isDeepStrictEqual(current, committed.detail.after), code: "control_changed_after_commit" };
    }
    if (reconcile) return { ok: false, code: "control_not_committed_reprepare_required" };
    const current = await capacityPin();
    if (!isDeepStrictEqual(current, expected)) return { ok: false, code: "capacity_pin_changed" };
    // Couple the controller's official audit/CAS transition with our acknowledgement in the SAME TX.
    const result = await runPipelineControl(db, { name: "capacity mode", area: "capacity", execute: true, json: true,
      allowDeferredRoutes: false, allowStalledStage: false,
      options: { to, fromMode: expected.mode, expectEpoch: expected.epoch, expectRevision: expected.revision,
        operator: state.actor, reason: `ops-runner:${state.id} ${state.reason}` } }, undefined, await currentModelEnv(), {
      beforeApply: async tx => {
        const [locked] = await tx.execute<CapacityPin>(sql`SELECT mode,epoch::float8,revision::float8,policy_hash AS "policyHash",
          to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt" FROM model_capacity_control WHERE id=1`);
        if (!isDeepStrictEqual(locked, expected)) throw new Error("ops_runner_capacity_pin_changed");
      },
      afterApply: async tx => {
        const [after] = await tx.execute<CapacityPin>(sql`SELECT mode,epoch::float8,revision::float8,policy_hash AS "policyHash",
          to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt" FROM model_capacity_control WHERE id=1`);
        await tx.insert(operationsAudit).values(await adminAuditRow(state.actor, { action: "ops-runner-control", target: key, detail: { after } }));
      },
    });
    return { ok: result.executed, code: result.executed ? undefined : "pipeline_control_rejected" };
  });
}
/** Keep the runner's OWN drain for the next declared procedure instead of OPEN. No capacity mutation:
 * the exact pin the runner committed must still be current, and the decision is journaled in the same TX. */
export async function handOffOpsDrain(state: OpsState, drained: CapacityPin) {
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const key = `${state.id}:handoff`;
    const [locked] = await tx.execute<CapacityPin>(sql`SELECT mode,epoch::float8,revision::float8,policy_hash AS "policyHash",
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt" FROM model_capacity_control WHERE id=1 FOR UPDATE`);
    if (!locked) throw new Error("ops_runner_control_missing");
    const [own] = await tx.execute<{ detail: { after: CapacityPin } }>(sql`SELECT detail FROM operations_audit
      WHERE action='ops-runner-control' AND target=${`${state.id}:draining`} ORDER BY id DESC LIMIT 1`);
    // Only a drain this job committed itself may be handed over, and only while nobody has changed it since.
    if (!own || !isDeepStrictEqual(own.detail.after, drained)) return { ok: false, code: "handoff_drain_not_owned" };
    if (locked.mode !== "draining" || !isDeepStrictEqual(locked, drained)) return { ok: false, code: "handoff_drain_changed" };
    const [committed] = await tx.execute(sql`SELECT id FROM operations_audit WHERE action='ops-runner-control' AND target=${key} LIMIT 1`);
    if (!committed) await tx.insert(operationsAudit).values(await adminAuditRow(state.actor, { action: "ops-runner-control", target: key,
      detail: { after: locked, handoff: "draining", reason: state.reason } }));
    return { ok: true };
  }));
}
export async function assertOpsQuiescent(expected: CapacityPin, targetId: string, affectedGroups?: string[]) {
  const current = await capacityPin();
  if (!isDeepStrictEqual(current, expected) || current.mode !== "draining") throw new Error("ops_runner_drain_lost");
  const [row] = await onPrimary(() => db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM model_capacity_requests
    WHERE request_id::text <> ${targetId} AND (state IN ('reserved','dispatched')
      OR state='indeterminate' ${affectedGroups?.length ? sql`AND group_id IN (${sql.join(affectedGroups.map(group => sql`${group}`), sql`, `)})` : sql``})`));
  // Other normal calls must drain. Unrelated unknown groups may remain occupied; no mutation/release of them.
  // With no reviewed group scope, conservatively require every other unknown to be absent.
  if (row.count) throw new Error("ops_runner_other_requests_active");
}

export async function readOpsRequest(targetId: string): Promise<unknown> {
  const [row] = await onPrimary(() => db.execute<{ request: unknown }>(sql`SELECT jsonb_build_object(
    'requestId',request_id::text,'owner',jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),
    'state',state,'tokenHash',encode(sha256(convert_to(token::text,'UTF8')),'hex'),'epoch',epoch,'revision',revision,'policyHash',policy_hash,
    'bindingHash',dispatch_binding_hash,'dispatchAt',to_char(dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'providerBudgetId',provider_budget_id,'groupId',group_id,'servingContractHash',dispatch_binding->>'servingContractHash') AS request
    FROM model_capacity_requests WHERE request_id=${targetId}::uuid AND state='indeterminate'`));
  if (!row) throw new Error("ops_runner_request_changed");
  return row.request;
}
