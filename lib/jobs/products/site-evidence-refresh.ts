import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { JobBatchBlockedError } from "@/lib/jobs/batch-repository";
import { executeCanonicalEvidenceSource } from "@/lib/domain/evidence/source-claims";
import { SourceJobSchema } from "@/lib/domain/evidence/source-contract";

/** Canonical documentation only; the product consumer retains all-required completion. */
export async function refreshSiteEvidenceJob(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const roleLease = roleLeaseFromEnv("site-evidence", process.env);
  if (!roleLease || roleLease.batchVersion !== 1 || !ctx.lease || ctx.lease.name !== "product-site-evidence-refresh") {
    throw new Error("evidence_source_owner_required");
  }
  const job = SourceJobSchema.parse({ ...ctx.lease });
  const deadlineAt = Math.min(ctx.deadlineAt ?? Infinity, Date.now() + 25_000);
  const counts = { attempted: 0, succeeded: 0, failed: 0, factsChanged: 0 };
  let idle = false;
  try {
    for (let turn = 0; turn < 4 && ctx.hasBudget() && !ctx.signal?.aborted && Date.now() < deadlineAt; turn++) {
      const result = await executeCanonicalEvidenceSource({ owner: { instanceId: roleLease.instanceId, bootId: roleLease.bootId },
        roleLease, job, signal: ctx.signal, deadlineAt });
      if (result.state === "idle") { idle = true; break; }
      if (result.state === "recorded" || result.state === "failed") {
        counts.attempted++;
        counts.factsChanged += result.factsChanged;
        if (result.state === "failed") counts.failed++;
        else if (result.factsChanged > 0) counts.succeeded++;
      }
    }
  } catch (error) {
    if (error instanceof JobBatchBlockedError) return { done: false, deferred: "stage_blocked" };
    throw error;
  }
  ctx.log("evidence.site_refresh_batch", counts);
  return { done: idle };
}
