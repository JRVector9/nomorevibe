import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import { modelCapacityRequests, operationsAudit } from "@/lib/db/schema";
import { releaseModelDispatchWithEvidence } from "@/lib/llm/capacity-repository";
import { cliExecutorIndeterminatePlanSchema, cliExecutorIndeterminatePlanHash, cliExecutorIndeterminateReceiptSchema } from "@/lib/llm/cli-executor-indeterminate-boundary-contract";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { drTransactionMaybeDry } from "./repository";
import { identity, writerSiteActive } from "./epoch";

/** Manual trusted service-closure evidence. No native terminal, usage, process-group event or business success is created. */
export async function releaseCliExecutorIndeterminateBoundaryRequest(input: { plan: unknown; receipt: unknown; expectedPlanHash: string;
  operator: string; reference: string }, apply: boolean) {
  const plan = cliExecutorIndeterminatePlanSchema.parse(input.plan), receipt = cliExecutorIndeterminateReceiptSchema.parse(input.receipt);
  const planHash = cliExecutorIndeterminatePlanHash(plan), operator = identity(120).parse(input.operator), reference = identity(400).parse(input.reference);
  if (planHash !== input.expectedPlanHash || receipt.planHash !== planHash || reference !== plan.reviewReference)
    throw new Error("cli_executor_indeterminate_boundary_plan_hash_mismatch");
  return drTransactionMaybeDry(apply, async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
    await tx.execute(sql`SET LOCAL transaction_timeout='10s'`);
    await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const result = await releaseModelDispatchWithEvidence(tx, plan.request.requestId, async candidate => modelDispatchReleaseEvidenceSchema.parse({
      version: 1, kind: "cli_executor_indeterminate_boundary_exit", requestId: plan.request.requestId, owner: plan.request.owner, fromState: "indeterminate",
      dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash, notBefore: receipt.observedAt,
      evaluatedAt: candidate.now, operator, reference, plan, receipt,
    }));
    if (result.kind !== "released") {
      const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, plan.request.requestId)).for("update");
      const old = row?.terminalEvidence;
      if (row?.state === "withdrawn" && old?.kind === "cli_executor_indeterminate_boundary_exit" && isDeepStrictEqual(old.plan, plan)
        && isDeepStrictEqual(old.receipt, receipt) && old.operator === operator && old.reference === reference)
        return { kind: "already_released" as const, requestId: row.requestId };
      throw new Error("cli_executor_indeterminate_boundary_request_conflict");
    }
    const [audit] = await tx.insert(operationsAudit).values(await adminAuditRow(operator, { action: "model-cli-executor-indeterminate-boundary-release",
      target: plan.request.requestId, detail: { reason: reference, planHash, bindingHash: plan.request.bindingHash, rowHash: plan.request.rowHash,
        previousState: "indeterminate", state: "withdrawn", chargedTokensPreserved: plan.request.chargedTokens,
        physicalExecutorEnded: true, exitCodeKnown: true, modelTerminal: false, usageKnown: false, businessResult: false } })).returning({ id: operationsAudit.id });
    return { kind: "released" as const, requestId: plan.request.requestId, auditId: audit.id };
  });
}
