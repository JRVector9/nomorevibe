import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { adminAuditRow } from "../admin-log";
import { readWriterFence, writerSiteActive } from "../dr/epoch";
import { opsCancellable, opsCancelSchema, opsCommandSchema, initialOpsState, opsHoldsBoundary, type OpsState } from "./contract";

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

/**
 * 시작 전 취소 — 운영 실행기가 아직 잡지 않은 접수만(opsCancellable). 접수 잠금(7219401)을 잡고, 실행기 세션 잠금(7219402)을
 * 같은 TX 안에서 잡을 수 있을 때만(실행기가 돌고 있지 않을 때만) 닫는다 — 실행기는 그 잠금을 쥔 채 상태를 읽고 단계를 돈다.
 * 새 줄은 같은 append-only 장부(ops-runner-state)에 취소한 사람 이름으로 남는다. 원래 요청자(detail.actor)는 그대로다.
 */
export async function cancelModelOpsCommand(raw: unknown, actor: string): Promise<OpsState> {
  const { id, reason } = opsCancelSchema.parse(raw);
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7219401)`);
    const [lock] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(7219402) AS locked`);
    if (!lock?.locked) throw new Error("ops_runner_running");
    const [row] = await tx.execute<{ detail: OpsState }>(sql`SELECT detail FROM operations_audit
      WHERE action='ops-runner-state' AND target=${id} ORDER BY id DESC LIMIT 1`);
    if (!row) throw new Error("ops_runner_job_missing");
    if (!opsCancellable(row.detail)) throw new Error("ops_runner_not_cancellable");
    const state: OpsState = { ...row.detail, status: "cancelled", code: "operator_cancelled", cancelledBy: actor, cancelReason: reason };
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: "ops-runner-state", target: id, detail: { ...state } }));
    return state;
  }));
}
