import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { modelCapacityRequests, operationsAudit } from "@/lib/db/schema";
import { releaseModelDispatchWithEvidence } from "@/lib/llm/capacity-repository";
import { providerBoundaryPlanSchema, providerBoundaryPlanHash, providerBoundaryReceiptSchema } from "@/lib/llm/provider-boundary-contract";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { drTransactionMaybeDry } from "./repository";
import { identity, writerSiteActive } from "./epoch";

/** Manual privileged operator path. Reviewed physical observations, never an inference from idle/TTL or a native model terminal. */
export async function releaseProviderBoundaryRequest(input: { plan: unknown; receipt: unknown; expectedPlanHash: string;
  operator: string; reference: string }, apply: boolean) {
  const plan = providerBoundaryPlanSchema.parse(input.plan), receipt = providerBoundaryReceiptSchema.parse(input.receipt);
  const planHash = providerBoundaryPlanHash(plan), operator = identity(120).parse(input.operator), reference = identity(400).parse(input.reference);
  if (planHash !== input.expectedPlanHash || receipt.planHash !== planHash) throw new Error("provider_boundary_plan_hash_mismatch");
  return drTransactionMaybeDry(apply, async tx => {
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const result = await releaseModelDispatchWithEvidence(tx, plan.request.requestId, async candidate => modelDispatchReleaseEvidenceSchema.parse({
      version: 1, kind: "provider_boundary_exit", requestId: plan.request.requestId, owner: plan.request.owner, fromState: "indeterminate",
      dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash, notBefore: receipt.provider.observedAt,
      evaluatedAt: candidate.now, operator, reference, plan, receipt,
    }));
    if (result.kind !== "released") {
      const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, plan.request.requestId)).for("update");
      const old = row?.terminalEvidence;
      if (row?.state === "withdrawn" && old?.kind === "provider_boundary_exit" && isDeepStrictEqual(old.plan, plan)
        && isDeepStrictEqual(old.receipt, receipt) && old.operator === operator && old.reference === reference)
        return { kind: "already_released" as const, requestId: row.requestId };
      throw new Error("provider_boundary_request_conflict");
    }
    const [audit] = await tx.insert(operationsAudit).values(await adminAuditRow(operator, { action: "model-provider-boundary-release",
      target: plan.request.requestId, detail: { reason: reference, planHash, providerBudgetId: plan.request.providerBudgetId,
        bindingHash: plan.request.bindingHash, previousState: "indeterminate", state: "withdrawn", physicalCompletionOnly: true,
        modelTerminal: false, usageKnown: false, businessResult: false } })).returning({ id: operationsAudit.id });
    return { kind: "released" as const, requestId: plan.request.requestId, auditId: audit.id };
  });
}
