import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { llmAssistWorks, modelCapacityRequests } from "@/lib/db/schema";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { claimAssistWork, deferAssistClaim } from "@/lib/domain/llm-assist/repository";
import { prepareAssistInput, recoverAbandonedAssistClaims } from "@/lib/domain/llm-assist/claim-lifecycle";
import { completeAssistClaim } from "@/lib/domain/llm-assist/complete";
import { assistBackendDrains, assistBackendKey, type AssistBackendDrain } from "@/lib/domain/llm-assist/config";
import { assistCapacityInput } from "@/lib/domain/llm-assist/model-input";
import { buildAssistModelRequest, parseAssistModelResponse } from "@/lib/domain/llm-assist/model-request";
import { assistCandidateSchema, assistCandidateSubject } from "@/lib/domain/llm-assist/work";
import type { AssistInput } from "@/lib/domain/llm-assist/contracts";
import { collectRepoMoveInput, checkRepoMoveBeforeApply } from "@/lib/domain/products/repo-move-evidence";
import { collectUptimeAssist } from "@/lib/domain/products/uptime-delist-review";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { withLocalModelCapacity } from "@/lib/llm/local-model-capacity";
import { collectIntroRecheckInput, runIntroCorrectionStage } from "@/lib/domain/products/intro-assist-runtime";
import { completeAssistIntroCorrection } from "@/lib/domain/llm-assist/intro-complete";
import { collectActionAuditInput, AuditDispatchBudgetExceededError } from "@/lib/domain/llm-assist/audit-runtime";

const TICK_MS = 100_000;
/** backend별 drain은 동시에 시작하고 각 결과를 즉시 기록한다. 느린 M1·DeepSeek를 GPU의 앞에 두지 않는다. */
export async function reviewLlmAssist(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  return runAssistLane(ctx, "regular");
}
export async function reviewLlmAssistAudit(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  return runAssistLane(ctx, "audit");
}
async function runAssistLane(ctx: JobContext<null>, lane: "regular" | "audit"): Promise<JobOutcome<null>> {
  if (!ctx.lease) throw new Error("assist_job_lease_required");
  if (ctx.lease.name !== (lane === "audit" ? "product-llm-assist-audit-review" : "product-llm-assist-review")) throw new Error("assist_job_lease_mismatch");
  const lease = ctx.lease, startedAt = Date.now(), role = roleLeaseFromEnv("reviewer", process.env);
  const backends = assistBackendDrains(process.env, lane);
  if (!backends.length) { ctx.log("assist.disabled", {}); return { done: true }; }
  if (!role) return { done: true, degraded: { code: "owner_unavailable", detail: "보강 소비자의 reviewer lease가 없습니다" } };
  const owner = { instanceId: role.instanceId, bootId: role.bootId };
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  await recoverAbandonedAssistClaims(lease);
  const drain = async (backend: AssistBackendDrain) => {
    const counts = { claimed: 0, recorded: 0, applied: 0, deferred: 0, human: 0, indeterminate: 0 };
    const apiKey = assistBackendKey(backend.backendId);
    if (!apiKey) { ctx.log("assist.backend_key_missing", { backendId: backend.backendId }); return counts; }
    for (let index = 0; index < backend.maxClaims && ctx.hasBudget() && !ctx.signal?.aborted && remaining() > 15_000; index++) {
      const claim = await claimAssistWork({ lease, owner, backendId: backend.backendId, tasks: backend.tasks, backendFamily: backend.contract.modelFamily });
      if (!claim) break;
      counts.claimed++;
      let stage: "collection" | "model" = "collection";
      let factualRequestId: string | null = null;
      try {
        const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(Math.max(1, Math.min(90_000, remaining() - 1000)))]);
        const candidate = assistCandidateSchema.parse(claim.work.source), subject = assistCandidateSubject(candidate);
        let input: AssistInput;
        if (candidate.kind === "uptime") input = await collectUptimeAssist(candidate, signal);
        else if (candidate.kind === "intro_recheck") input = await collectIntroRecheckInput(candidate, signal);
        else if (candidate.kind === "decision_audit" || candidate.kind === "semantic_exception") {
          const collected = await collectActionAuditInput(candidate, { signal });
          if (collected.kind !== "ready") {
            await deferAssistClaim(claim, collected.kind, collected.reason); counts.deferred++; continue;
          }
          input = collected.input;
        }
        else if (candidate.kind === "repo_move") {
          const collected = await collectRepoMoveInput(candidate, { signal });
          if (collected.kind !== "ready") {
            await deferAssistClaim(claim, collected.kind, collected.reason); counts.deferred++; continue;
          }
          input = collected.input;
        } else throw new Error("unsupported_assist_candidate");
        if (!input.sources.some(source => source.completeness === "complete" && source.text.trim())) {
          await deferAssistClaim(claim, "waiting_evidence", "collection_incomplete"); counts.deferred++; continue;
        }
        if (!await prepareAssistInput(claim, input)) {
          await deferAssistClaim(claim, "obsolete", "control_or_input_changed"); counts.deferred++; continue;
        }
        if (!ctx.hasBudget() || signal.aborted || remaining() < 5000) {
          await deferAssistClaim(claim, "waiting_capacity", "tick_budget", { nextAttemptAt: new Date(Date.now() + 60_000) });
          counts.deferred++; break;
        }
        const request = buildAssistModelRequest(input, backend.contract);
        stage = "model";
        const response = await withLocalModelCapacity({ target: { kind: "assist", purpose: "assist_review", workId: claim.work.id,
          workRevision: claim.work.revision, claimToken: claim.token, task: claim.work.task, subjectId: subject.id, backendId: backend.backendId },
          input: assistCapacityInput(claim.work, input), lease, promptVersion: input.promptVersion, allowLegacy: false }, fetchModel =>
          fetchModel(backend.contract.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: request.wire, signal }));
        const raw = await response.text();
        let value: unknown;
        try { value = JSON.parse(raw); } catch { value = null; }
        const parsed = parseAssistModelResponse(input, value);
        if (!parsed.ok) {
          await deferAssistClaim(claim, "human", parsed.error, { consumesAttempt: true }); counts.human++; continue;
        }
        const freshRepoChecks = candidate.kind === "repo_move" && ["update_repo_candidate", "delist_candidate"].includes(parsed.outcome.action.proposal)
          ? await checkRepoMoveBeforeApply(candidate, { signal }) : undefined;
        const saved = await completeAssistClaim(claim, input, parsed.outcome, backend.contract, createHash("sha256").update(raw).digest("hex"), freshRepoChecks);
        if (saved.recorded) counts.recorded++;
        if (saved.applied) counts.applied++;
        if (saved.correctionRequired && saved.resultId && candidate.kind === "intro_recheck") {
          const [factsWork] = await db.select({ capacityRequestId: llmAssistWorks.capacityRequestId }).from(llmAssistWorks).where(eq(llmAssistWorks.id, claim.work.id));
          factualRequestId = factsWork?.capacityRequestId ?? null;
          const correction = await runIntroCorrectionStage({ candidate, input, factualResultId: saved.resultId, factual: parsed.outcome,
            workId: claim.work.id, contract: backend.contract }, async plan => {
            const response = await withLocalModelCapacity({ target: { kind: "assist", purpose: "intro_correction", workId: claim.work.id,
              workRevision: claim.work.revision, claimToken: claim.token, task: "intro_recheck", subjectId: subject.id, backendId: backend.backendId },
              input: plan.capacityInput, lease, promptVersion: plan.promptVersion, allowLegacy: false }, fetchModel =>
              fetchModel(backend.contract.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: plan.wire, signal }));
            const [current] = await db.select({ capacityRequestId: llmAssistWorks.capacityRequestId }).from(llmAssistWorks).where(eq(llmAssistWorks.id, claim.work.id));
            if (!current?.capacityRequestId || current.capacityRequestId === factualRequestId) throw new Error("intro_correction_dispatch_missing");
            return { response, capacityRequestId: current.capacityRequestId };
          });
          if (!correction.ok) {
            await deferAssistClaim(claim, "human", correction.error, { consumesAttempt: true }); counts.human++; continue;
          }
          const applied = await completeAssistIntroCorrection(claim, candidate, input, parsed.outcome, correction);
          if (applied.applied) counts.applied++;
        }
      } catch (error) {
        const [work] = await db.select().from(llmAssistWorks).where(eq(llmAssistWorks.id, claim.work.id));
        if (!work || work.state !== "claimed") continue;
        if (error instanceof AuditDispatchBudgetExceededError) {
          await deferAssistClaim(claim, "obsolete", "audit_weekly_budget_exhausted"); counts.deferred++; break;
        } else if (work.capacityRequestId) {
          const [capacity] = await db.select({ state: modelCapacityRequests.state }).from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, work.capacityRequestId));
          if (capacity?.state === "settled") {
            const capacityWait = error instanceof ModelCapacityDeferredError;
            await deferAssistClaim(claim, capacityWait ? "waiting_capacity" : "waiting_evidence", capacityWait ? `capacity_${error.reason}` : "post_model_validation_failed",
              { consumesAttempt: work.capacityRequestId !== factualRequestId, nextAttemptAt: new Date(Date.now() + 60_000) }); counts.deferred++;
          } else { await deferAssistClaim(claim, "indeterminate", "model_or_commit_unknown"); counts.indeterminate++; }
        } else if (error instanceof ModelCapacityDeferredError) {
          await deferAssistClaim(claim, "waiting_capacity", `capacity_${error.reason}`, { nextAttemptAt: new Date(Date.now() + 60_000) }); counts.deferred++;
          break;
        } else {
          await deferAssistClaim(claim, stage === "collection" ? "waiting_evidence" : "human",
            stage === "collection" ? "collection_failed" : "request_invalid", { consumesAttempt: false }); counts.deferred++;
        }
      }
    }
    ctx.log("assist.backend_done", { backendId: backend.backendId, ...counts });
    return counts;
  };
  const results = await Promise.allSettled(backends.map(drain));
  if (results.some(result => result.status === "rejected")) throw new Error("assist_backend_drain_failed");
  return { done: false };
}
