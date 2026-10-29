import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { adminAuditRow } from "../admin-log";
import { readWriterFence, writerSiteActive } from "../dr/epoch";
import { opsCommandSchema, initialOpsState, opsHoldsBoundary, type OpsState } from "./contract";

// Append-only operations_audit is the durable queue/journal. No mutable business row or TTL cleanup.
export async function readModelOpsStates(): Promise<OpsState[]> {
  return onPrimary(async () => Array.from(await db.execute<{ detail: OpsState; id: number }>(sql`
    SELECT detail,id FROM (SELECT DISTINCT ON (target) target,detail,id FROM operations_audit
    WHERE action = 'ops-runner-state' ORDER BY target,id DESC) latest ORDER BY id DESC LIMIT 30`)).map(row => ({ ...row.detail, auditId: row.id })));
}
export async function readModelOpsState(id: string): Promise<OpsState | null> {
  const target = z.uuid().parse(id);
  return onPrimary(async () => {
    const [row] = await db.execute<{ detail: OpsState; id: number }>(sql`SELECT detail,id FROM operations_audit
      WHERE action='ops-runner-state' AND target=${target} ORDER BY id DESC LIMIT 1`);
    return row ? { ...row.detail, auditId: row.id } : null;
  });
}
/** origin "cli": the operator-shell intake (scripts/ops/admin-models-ops-submit.ts). Same lock, serialization, checks and
 * append-only row as the web button; only the actor kind is left empty because no web login authenticated it. */
export async function submitModelOpsCommand(raw: unknown, actor: string, origin: "web" | "cli" = "web"): Promise<OpsState> {
  const command = opsCommandSchema.parse(raw);
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7219401)`);
    const states = Array.from(await tx.execute<{ detail: OpsState }>(sql`
      SELECT DISTINCT ON (target) detail, target FROM operations_audit
      WHERE action = 'ops-runner-state' ORDER BY target,id DESC`)).map(row => row.detail);
    const existing = states.find(state => state.id === command.id);
    if (existing) {
      if (existing.actor !== actor || existing.action !== command.action || existing.targetId !== command.targetId || existing.reason !== command.reason)
        throw new Error("ops_runner_id_conflict");
      return existing;
    }
    // Physical boundaries overlap across models. Serialize all commands, including admission OPEN.
    if (states.some(opsHoldsBoundary)) throw new Error("ops_runner_unfinished_operation");
    if (command.action === "request-release") {
      const [row] = await tx.execute(sql`SELECT request_id FROM model_capacity_requests WHERE request_id=${command.targetId}::uuid AND state='indeterminate'`);
      if (!row) throw new Error("ops_runner_request_not_indeterminate");
    } else if (command.action === "model-restart") {
      const { readModelRegistry } = await import("@/lib/llm/model-registry");
      if (!readModelRegistry().models.some(row => row.key === command.targetId)) throw new Error("ops_runner_model_not_registered");
    }
    const state = initialOpsState(command, actor);
    const row = await adminAuditRow(actor, { action: "ops-runner-state", target: state.id, detail: { ...state } });
    await tx.insert(operationsAudit).values(origin === "cli" ? { ...row, actorKind: null } : row);
    return state;
  }));
}
export type OpsSubmissionPreview = { blocked: string[]; existing: OpsState | null;
  request: { state: string; routeId: string; groupId: string; providerBudgetId: string; ownerInstanceId: string | null } | null };
/** READ ONLY dry-run of submitModelOpsCommand: the same refusals, no lock and no write. */
export async function previewModelOpsCommand(raw: unknown, actor: string): Promise<OpsSubmissionPreview> {
  const command = opsCommandSchema.parse(raw);
  return onPrimary(() => db.transaction(async tx => {
    const blocked: string[] = [];
    // A READ ONLY TX cannot take the FOR SHARE fence lock (25006). The unlocked read is enough here: --execute re-checks under the lock.
    if ((await readWriterFence(tx)).state !== "active") blocked.push("dr_writer_site_fenced");
    const states = Array.from(await tx.execute<{ detail: OpsState }>(sql`
      SELECT DISTINCT ON (target) detail, target FROM operations_audit
      WHERE action = 'ops-runner-state' ORDER BY target,id DESC`)).map(row => row.detail);
    const existing = states.find(state => state.id === command.id) ?? null;
    if (existing && (existing.actor !== actor || existing.action !== command.action || existing.targetId !== command.targetId || existing.reason !== command.reason))
      blocked.push("ops_runner_id_conflict");
    if (!existing && states.some(opsHoldsBoundary)) blocked.push("ops_runner_unfinished_operation");
    let request: OpsSubmissionPreview["request"] = null;
    if (command.action === "request-release") {
      const [row] = await tx.execute<NonNullable<OpsSubmissionPreview["request"]>>(sql`SELECT state, route_id AS "routeId", group_id AS "groupId",
        provider_budget_id AS "providerBudgetId", owner_instance_id AS "ownerInstanceId" FROM model_capacity_requests WHERE request_id=${command.targetId}::uuid`);
      request = row ?? null;
      if (!existing && request?.state !== "indeterminate") blocked.push("ops_runner_request_not_indeterminate");
    }
    return { blocked, existing, request };
  }, { accessMode: "read only" }));
}
export async function saveModelOpsState(state: OpsState): Promise<void> {
  await onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    await tx.insert(operationsAudit).values(await adminAuditRow(state.actor, { action: "ops-runner-state", target: state.id,
      detail: { ...state }, ok: !["blocked", "manual"].includes(state.status), error: state.code }));
  }));
}
