import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { llmAssistResults, llmAssistWorks, modelCapacityRequests } from "@/lib/db/schema";
import { assertJobLeaseAtWallTime, withJobLeaseWrite } from "@/lib/jobs/control";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { lockProductGeneration } from "@/lib/domain/products/generation";
import { applyUptimeAssist } from "@/lib/domain/products/uptime-delist-review";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { assistInputHash, validateAssistOutcome, type AssistInput, type AssistOutcome } from "./contracts";
import { assistPromptHash } from "./prompts";
import { lockAssistClaim, type AssistWorkClaim } from "./repository";
import { assistCandidateSubject } from "./work";
import { applyRepoMoveResult, lockRepoMoveCandidate, type FreshRepoMoveChecks } from "@/lib/domain/products/repo-move-reviews";
import { decideRepositoryMove } from "@/lib/domain/products/repo-move-review";
import { lockProductRepository } from "@/lib/domain/products/repository-identity";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** 원격 종료는 native 원장, 업무 조치는 현재 도메인 guard로 각각 증명한다. */
export async function completeAssistClaim(claim: AssistWorkClaim, input: AssistInput, outcome: AssistOutcome,
  contract: LocalModelServingContract, responseHash: string, freshRepoChecks?: FreshRepoMoveChecks): Promise<{ recorded: boolean; applied: boolean }> {
  const validated = validateAssistOutcome(input, outcome);
  if (!validated.ok) throw new Error(validated.error);
  return withJobLeaseWrite(claim.lease, async tx => {
    await lockPipelineInputStages(tx);
    const candidate = claim.work.source, subject = assistCandidateSubject(candidate);
    if (candidate.kind === "repo_move") {
      if (input.task === "repo") {
        const decision = decideRepositoryMove(candidate, input, validated.outcome);
        if (decision.kind === "update_repo_candidate") await lockProductRepository(tx, decision.url);
      }
      await lockRepoMoveCandidate(tx, candidate);
    }
    else if (!await lockProductGeneration(tx, subject.id, subject.slug)) return { recorded: false, applied: false };
    const work = await lockAssistClaim(tx, claim);
    if (!work?.capacityRequestId || work.inputHash !== assistInputHash(input)) return { recorded: false, applied: false };
    const [capacity] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, work.capacityRequestId)).for("share");
    const binding: unknown = capacity?.dispatchBinding, terminal: unknown = capacity?.terminalEvidence;
    if (!capacity || capacity.state !== "settled" || !capacity.terminalEvidenceHash || !object(binding) || !object(terminal)
      || binding.kind !== "local_model_direct" || !object(binding.target) || binding.target.kind !== "assist"
      || binding.target.workId !== work.id || binding.target.workRevision !== work.revision || binding.target.claimToken !== claim.token
      || binding.inputHash !== work.inputHash || binding.sourceRevisionHash !== work.sourceHash || binding.backendId !== contract.backendId
      || binding.servingContractHash !== localModelContractHash(contract) || terminal.kind !== "local_model_terminal"
      || terminal.responseHash !== responseHash) throw new Error("assist_native_terminal_required");
    const resultId = randomUUID();
    const [result] = await tx.insert(llmAssistResults).values({ id: resultId, workId: work.id, workRevision: work.revision,
      capacityRequestId: work.capacityRequestId, backendId: contract.backendId, modelFamily: contract.modelFamily,
      contractHash: localModelContractHash(contract), inputHash: work.inputHash, promptHash: assistPromptHash(input.task),
      responseHash, input, outcome: validated.outcome }).onConflictDoNothing({ target: llmAssistResults.capacityRequestId }).returning({ id: llmAssistResults.id });
    if (!result) return { recorded: false, applied: false };
    let applied = work.task === "uptime" && await applyUptimeAssist(tx, claim, input, validated.outcome, resultId);
    let domainState: "human" | "obsolete" | null = null;
    if (candidate.kind === "repo_move" && input.task === "repo" && freshRepoChecks) {
      const repoResult = await applyRepoMoveResult(tx, candidate, input, validated.outcome, { resultId, workId: work.id }, freshRepoChecks);
      applied = repoResult === "updated" || repoResult === "delisted";
      if (["human", "protected", "daily_limit"].includes(repoResult)) domainState = "human";
      if (repoResult === "stale") domainState = "obsolete";
    }
    if (applied) await tx.update(llmAssistResults).set({ applied: true }).where(eq(llmAssistResults.id, resultId));
    const proposal = validated.outcome.action.proposal;
    const state = domainState ?? (proposal === "collect_evidence" ? "waiting_evidence" : ["human_review", "independent_review"].includes(proposal) ? "human" : "done");
    await tx.update(llmAssistWorks).set({ state, revision: work.revision + 1, attempts: work.attempts + 1,
      claimToken: null, claimJob: null, claimJobToken: null, claimRequestedVersion: null, ownerInstanceId: null, ownerBootId: null,
      lastError: null, updatedAt: sql`clock_timestamp()` }).where(and(eq(llmAssistWorks.id, work.id), eq(llmAssistWorks.revision, work.revision)));
    await assertJobLeaseAtWallTime(tx, claim.lease);
    return { recorded: true, applied: Boolean(applied) };
  });
}
