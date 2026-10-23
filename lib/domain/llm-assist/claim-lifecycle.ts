import { and, eq, sql } from "drizzle-orm";
import { llmAssistWorks, modelCapacityRequests } from "@/lib/db/schema";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { assistInputHash, assistInputSchema, type AssistInput } from "./contracts";
import { assistOriginActive, lockAssistClaim, readAssistControl, type AssistWorkClaim } from "./repository";

export async function prepareAssistInput(claim: AssistWorkClaim, value: AssistInput): Promise<boolean> {
  const input = assistInputSchema.parse(value);
  return withJobLeaseWrite(claim.lease, async tx => {
    const work = await lockAssistClaim(tx, claim);
    if (!work || work.capacityRequestId || !await assistOriginActive(tx, work.originJob)) return false;
    const control = await readAssistControl(work.task, tx);
    if (!control.dispatchEnabled || control.mode === "off" || control.revision !== work.controlRevision
      || work.policyVersion !== input.policyVersion || work.promptVersion !== input.promptVersion) return false;
    const [row] = await tx.update(llmAssistWorks).set({ input, inputHash: assistInputHash(input), updatedAt: sql`clock_timestamp()` })
      .where(and(eq(llmAssistWorks.id, work.id), eq(llmAssistWorks.revision, work.revision))).returning({ id: llmAssistWorks.id });
    return Boolean(row);
  });
}

/** 죽은 로컬 claim은 원격 종료가 아니다. 기존 native 원장의 settled/withdrawn만 재진입을 허용한다. */
export async function recoverAbandonedAssistClaims(lease: JobLease): Promise<number> {
  return withJobLeaseWrite(lease, async tx => {
    const abandoned = await tx.execute<{ id: string }>(sql`select w.id from llm_assist_work w
      where w.state='claimed' and not exists(select 1 from jobs j where j.name=w.claim_job and j.lease_token=w.claim_job_token
        and j.locked_at >= clock_timestamp()-${STALE_LOCK_MS}*interval '1 millisecond')
      order by w.updated_at for update of w skip locked limit 20`);
    for (const row of abandoned) {
      const [work] = await tx.select().from(llmAssistWorks).where(eq(llmAssistWorks.id, row.id));
      if (!work) continue;
      const [capacity] = work.capacityRequestId ? await tx.select().from(modelCapacityRequests)
        .where(eq(modelCapacityRequests.requestId, work.capacityRequestId)).for("share") : [];
      const unknown = Boolean(work.capacityRequestId && (!capacity || !["settled", "withdrawn"].includes(capacity.state)));
      const attempts = work.attempts + (capacity?.state === "settled" ? 1 : 0);
      await tx.update(llmAssistWorks).set({ state: unknown ? "indeterminate" : attempts >= 3 ? "human" : "queued",
        revision: work.revision + 1, lastError: unknown ? "abandoned_remote_unknown" : "abandoned_local_claim", attempts,
        ...(unknown ? {} : { claimToken: null, claimJob: null, claimJobToken: null, claimRequestedVersion: null,
          ownerInstanceId: null, ownerBootId: null, backendId: null, capacityRequestId: null, input: null, inputHash: null }),
        updatedAt: sql`clock_timestamp()` }).where(eq(llmAssistWorks.id, work.id));
    }
    return abandoned.length;
  });
}
