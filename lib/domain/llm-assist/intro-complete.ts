import { and, eq, sql } from "drizzle-orm";
import { llmAssistResults, llmAssistWorks } from "@/lib/db/schema";
import { assertJobLeaseAtWallTime, withJobLeaseWrite } from "@/lib/jobs/control";
import { completeIntroCorrectionStage, type IntroCorrectionStageSuccess } from "@/lib/domain/products/intro-assist-runtime";
import type { IntroRecheckCandidate } from "@/lib/domain/products/intro-assist";
import type { AssistInput, AssistOutcome } from "./contracts";
import type { AssistWorkClaim } from "./repository";

export function completeAssistIntroCorrection(claim: AssistWorkClaim, candidate: IntroRecheckCandidate, input: AssistInput,
  factual: AssistOutcome, result: IntroCorrectionStageSuccess) {
  return withJobLeaseWrite(claim.lease, async tx => {
    const completed = await completeIntroCorrectionStage(tx, { workId: claim.work.id, revision: claim.work.revision,
      claimToken: claim.token, lease: claim.lease }, candidate, input, factual, result);
    if (!completed.recorded) return completed;
    if (completed.applied) await tx.update(llmAssistResults).set({ applied: true }).where(eq(llmAssistResults.id, result.record.factualResultId));
    await tx.update(llmAssistWorks).set({ state: completed.applied ? "done" : "human", revision: claim.work.revision + 1,
      attempts: sql`${llmAssistWorks.attempts}+1`, claimToken: null, claimJob: null, claimJobToken: null,
      claimRequestedVersion: null, ownerInstanceId: null, ownerBootId: null, lastError: null, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(llmAssistWorks.id, claim.work.id), eq(llmAssistWorks.revision, claim.work.revision), eq(llmAssistWorks.claimToken, claim.token)));
    await assertJobLeaseAtWallTime(tx, claim.lease);
    return completed;
  });
}
