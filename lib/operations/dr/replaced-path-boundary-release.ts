import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import { modelCapacityRequests, operationsAudit } from "@/lib/db/schema";
import { releaseModelDispatchWithEvidence } from "@/lib/llm/capacity-repository";
import { replacedPathPlanSchema, replacedPathPlanHash, replacedPathReceiptSchema, replacedPathRequiredHops,
  type ReplacedPathPlan } from "@/lib/llm/replaced-path-boundary-contract";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { drTransactionMaybeDry } from "./repository";
import { identity, writerSiteActive } from "./epoch";

const MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`, US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
type PlanRow = { request_id: string; owner_instance_id: string; owner_boot_id: string; state: string; token_hash: string | null;
  epoch: number; revision: number; policy_hash: string; binding_hash: string | null; dispatch_at: string | null; dispatch_exact: boolean | null;
  provider_budget_id: string; group_id: string; serving_contract_hash: string | null; row_hash: string; route_id: string; provider: string; model: string;
  terminal_null: boolean; settled_null: boolean };

/** READ ONLY: the exact ledger row, the current DRAIN pin and the writer, as the DB trigger re-reads them at release. */
export async function readReplacedPathPlan(input: { requestId: string; reviewReference: string }): Promise<ReplacedPathPlan> {
  const reviewReference = identity(400).parse(input.reviewReference);
  return drTransactionMaybeDry(false, async tx => {
    await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [control] = await tx.execute<{ mode: string; epoch: number; revision: number; policy_hash: string; updated_at: string; created_at: string }>(sql.raw(
      `SELECT mode, epoch, revision, policy_hash, to_char(updated_at AT TIME ZONE 'UTC',${US}) updated_at, to_char(clock_timestamp() AT TIME ZONE 'UTC',${MS}) created_at
       FROM model_capacity_control WHERE id=1`));
    const [fence] = await tx.execute<{ state: string; lineage_id: string; writer_epoch: number }>(sql`SELECT state, lineage_id::text, writer_epoch::int FROM dr_writer_fence WHERE id=1`);
    const [row] = await tx.execute<PlanRow>(sql`SELECT r.request_id::text, r.owner_instance_id, r.owner_boot_id::text, r.state,
        encode(sha256(convert_to(r.token::text,'UTF8')),'hex') token_hash, r.epoch, r.revision, r.policy_hash, r.dispatch_binding_hash binding_hash,
        to_char(r.dispatched_at AT TIME ZONE 'UTC',${sql.raw(MS)}) dispatch_at,
        to_char(r.dispatched_at AT TIME ZONE 'UTC',${sql.raw(MS)})::timestamptz = r.dispatched_at dispatch_exact,
        r.provider_budget_id, r.group_id, r.dispatch_binding->>'servingContractHash' serving_contract_hash,
        encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') row_hash, r.route_id, r.provider, r.model,
        r.terminal_evidence IS NULL terminal_null, r.settled_at IS NULL settled_null
      FROM model_capacity_requests r WHERE r.request_id=${input.requestId}::uuid`);
    if (!control || control.mode !== "draining") throw new Error("replaced_path_requires_draining");
    if (!fence || fence.state !== "active") throw new Error("replaced_path_writer_fenced");
    if (!row || row.state !== "indeterminate" || !row.terminal_null || !row.settled_null || !row.token_hash || !row.binding_hash
      || !row.dispatch_at || row.dispatch_exact !== true || !row.serving_contract_hash) throw new Error("replaced_path_request_not_releasable");
    if (!replacedPathRequiredHops(row.owner_instance_id, row.provider_budget_id)) throw new Error("replaced_path_topology_unregistered");
    return replacedPathPlanSchema.parse({ version: 1, kind: "replaced_path_boundary_plan", createdAt: control.created_at, reviewReference,
      request: { requestId: row.request_id, owner: { instanceId: row.owner_instance_id, bootId: row.owner_boot_id }, state: "indeterminate",
        tokenHash: row.token_hash, epoch: Number(row.epoch), revision: Number(row.revision), policyHash: row.policy_hash, bindingHash: row.binding_hash,
        dispatchAt: row.dispatch_at, providerBudgetId: row.provider_budget_id, groupId: row.group_id, servingContractHash: row.serving_contract_hash,
        rowHash: row.row_hash, routeId: row.route_id, provider: row.provider, model: row.model },
      control: { mode: "draining", epoch: Number(control.epoch), revision: Number(control.revision), policyHash: control.policy_hash, updatedAt: control.updated_at },
      writer: { lineageId: fence.lineage_id, writerEpoch: Number(fence.writer_epoch) } });
  });
}

/** Manual trusted path-replacement evidence. No native terminal, usage, process-group event or business success is created. */
export async function releaseReplacedPathBoundaryRequest(input: { plan: unknown; receipt: unknown; expectedPlanHash: string;
  operator: string; reference: string }, apply: boolean) {
  const plan = replacedPathPlanSchema.parse(input.plan), receipt = replacedPathReceiptSchema.parse(input.receipt);
  const planHash = replacedPathPlanHash(plan), operator = identity(120).parse(input.operator), reference = identity(400).parse(input.reference);
  if (planHash !== input.expectedPlanHash || receipt.planHash !== planHash || reference !== plan.reviewReference)
    throw new Error("replaced_path_boundary_plan_hash_mismatch");
  return drTransactionMaybeDry(apply, async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
    await tx.execute(sql`SET LOCAL transaction_timeout='10s'`);
    await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const result = await releaseModelDispatchWithEvidence(tx, plan.request.requestId, async candidate => modelDispatchReleaseEvidenceSchema.parse({
      version: 1, kind: "replaced_path_boundary_exit", requestId: plan.request.requestId, owner: plan.request.owner, fromState: "indeterminate",
      dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash, notBefore: receipt.observedAt,
      evaluatedAt: candidate.now, operator, reference, plan, receipt,
    }));
    if (result.kind !== "released") {
      const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, plan.request.requestId)).for("update");
      const old = row?.terminalEvidence;
      if (row?.state === "withdrawn" && old?.kind === "replaced_path_boundary_exit" && isDeepStrictEqual(old.plan, plan)
        && isDeepStrictEqual(old.receipt, receipt) && old.operator === operator && old.reference === reference)
        return { kind: "already_released" as const, requestId: row.requestId };
      throw new Error("replaced_path_boundary_request_conflict");
    }
    const [audit] = await tx.insert(operationsAudit).values(await adminAuditRow(operator, { action: "model-replaced-path-boundary-release",
      target: plan.request.requestId, detail: { reason: reference, planHash, bindingHash: plan.request.bindingHash, rowHash: plan.request.rowHash,
        providerBudgetId: plan.request.providerBudgetId, hops: receipt.hops.map(hop => `${hop.role}:${hop.host}:${hop.service}`),
        previousState: "indeterminate", state: "withdrawn", pathReplaced: true, modelTerminal: false, usageKnown: false, businessResult: false } }))
      .returning({ id: operationsAudit.id });
    return { kind: "released" as const, requestId: plan.request.requestId, auditId: audit.id };
  });
}
