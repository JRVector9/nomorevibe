import { assistHash } from "@/lib/domain/llm-assist/contracts";
import { actionAuditPeriod, readActionAuditPolicy, selectActionAuditSample, type ActionAuditCandidate } from "@/lib/domain/products/automated-action-audit";
import { enqueueFrozenActionAudit, freezeActionAuditPeriod, loadAutomatedDecision, loadAutomatedDecisions,
  readActionAuditProduct } from "@/lib/domain/products/automated-action-audit-repository";
import { assertJobLeaseAtWallTime, withJobLeaseWrite } from "@/lib/jobs/control";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { enqueueSemanticExceptionForResult } from "@/lib/domain/llm-assist/audit-runtime";

/** 주간 표본 producer뿐이다. 모델 호출은 별도 backend drain으로 넘겨 Qwen 정상 처리를 기다리게 하지 않는다. */
export async function auditAutomatedActions(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const config = readActionAuditPolicy();
  if (!config.enabled) { ctx.log("action_audit.disabled", {}); return { done: true }; }
  if (!ctx.lease || ctx.lease.name !== "product-automated-action-audit") throw new Error("action_audit_job_lease_required");
  const at = new Date(), periodStart = actionAuditPeriod(at), seedHash = assistHash(config.seed), lease = ctx.lease;
  const summary = await withJobLeaseWrite(lease, async tx => {
    const decisions = await loadAutomatedDecisions(tx, { after: new Date(at.getTime() - config.policy.lookbackDays * 86400000),
      before: at, limit: config.policy.maxCandidates });
    const sample = selectActionAuditSample(decisions, periodStart, config.seed, config.policy, at);
    const frozen = await freezeActionAuditPeriod(tx, { periodStart, seedHash, policy: config.policy, selected: sample.selected,
      skippedUnknownFamily: sample.skippedUnknownFamily, candidatesClipped: sample.candidatesClipped || decisions.length === config.policy.maxCandidates });
    let queued = 0, duplicates = 0, obsolete = 0, semanticQueued = 0, semanticBudgetExhausted = 0;
    for (const decision of decisions) {
      if (ctx.signal?.aborted || !ctx.hasBudget()) break;
      if (decision.outcome.action.proposal !== "independent_review" || decision.outcome.evidence_quality.status !== "sufficient") continue;
      const result = await enqueueSemanticExceptionForResult(tx, decision.resultId, "semantic_conflict");
      if (result === "queued") semanticQueued++;
      if (result === "budget_exhausted") { semanticBudgetExhausted++; break; }
    }
    for (const resultId of frozen.selectedResultIds ?? []) {
      if (ctx.signal?.aborted || !ctx.hasBudget()) break;
      const decision = await loadAutomatedDecision(tx, resultId);
      const product = decision && await readActionAuditProduct(tx, decision.productId);
      if (!decision || !product) { obsolete++; continue; }
      const candidate: ActionAuditCandidate = { kind: "decision_audit", product, decision, periodStart, selectedAt: at.toISOString(), seedHash, conflict: null };
      const result = await enqueueFrozenActionAudit(tx, candidate);
      if (result?.created) queued++; else if (result) duplicates++; else obsolete++;
    }
    await assertJobLeaseAtWallTime(tx, lease);
    return { periodStart, selected: frozen.selectedResultIds?.length ?? 0, queued, duplicates, obsolete, semanticQueued, semanticBudgetExhausted };
  });
  ctx.log("action_audit.enqueued", summary);
  return { done: true };
}
