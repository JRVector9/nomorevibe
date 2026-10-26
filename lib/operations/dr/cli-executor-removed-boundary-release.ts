import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import { modelCapacityRequests, operationsAudit } from "@/lib/db/schema";
import { releaseModelDispatchWithEvidence } from "@/lib/llm/capacity-repository";
import { cliExecutorPlanSchema, cliExecutorPlanHash } from "@/lib/llm/cli-executor-boundary-contract";
import { cliExecutorRemovedReceiptSchema } from "@/lib/llm/cli-executor-removed-boundary-contract";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { drTransactionMaybeDry } from "./repository";
import { identity, writerSiteActive } from "./epoch";

/** Manual trusted service-closure evidence. No native terminal, usage, process-group event or business success is created. */
export async function releaseCliExecutorRemovedBoundaryRequest(input: { plan: unknown; receipt: unknown; expectedPlanHash: string;
  operator: string; reference: string }, apply: boolean) {
  const plan = cliExecutorPlanSchema.parse(input.plan), receipt = cliExecutorRemovedReceiptSchema.parse(input.receipt);
  const planHash = cliExecutorPlanHash(plan), operator = identity(120).parse(input.operator), reference = identity(400).parse(input.reference);
  if (planHash !== input.expectedPlanHash || receipt.planHash !== planHash || reference !== plan.reviewReference)
    throw new Error("cli_executor_removed_boundary_plan_hash_mismatch");
  return drTransactionMaybeDry(apply, async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
    await tx.execute(sql`SET LOCAL transaction_timeout='10s'`);
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const result = await releaseModelDispatchWithEvidence(tx, plan.request.requestId, async candidate => modelDispatchReleaseEvidenceSchema.parse({
      version: 2, kind: "cli_executor_removed_boundary_exit", requestId: plan.request.requestId, owner: plan.request.owner, fromState: "dispatched",
      dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash, notBefore: receipt.observedAt,
      evaluatedAt: candidate.now, operator, reference, plan, receipt,
    }));
    if (result.kind !== "released") {
      const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, plan.request.requestId)).for("update");
      const old = row?.terminalEvidence;
      if (row?.state === "withdrawn" && old?.kind === "cli_executor_removed_boundary_exit" && isDeepStrictEqual(old.plan, plan)
        && isDeepStrictEqual(old.receipt, receipt) && old.operator === operator && old.reference === reference)
        return { kind: "already_released" as const, requestId: row.requestId };
      throw new Error("cli_executor_removed_boundary_request_conflict");
    }
    const [audit] = await tx.insert(operationsAudit).values(await adminAuditRow(operator, { action: "model-cli-executor-removed-boundary-release",
      target: plan.request.requestId, detail: { reason: reference, planHash, bindingHash: plan.request.bindingHash,
        previousState: "dispatched", state: "withdrawn", chargedTokensPreserved: plan.request.chargedTokens,
        physicalExecutorRemoved: true, exitCodeKnown: false, modelTerminal: false, usageKnown: false, businessResult: false } })).returning({ id: operationsAudit.id });
    return { kind: "released" as const, requestId: plan.request.requestId, auditId: audit.id };
  });
}
