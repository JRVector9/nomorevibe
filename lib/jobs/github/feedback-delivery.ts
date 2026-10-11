import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { githubFeedbackDeliveryEnabled } from "@/lib/domain/github-integration/flags";
import { deliverFeedbackIssue } from "@/lib/domain/feedback/github/deliver";
import { claimFeedbackOutbox, expireFeedbackDispatches } from "@/lib/domain/feedback/github/outbox";

/** The existing publisher role/job lease and each outbox lease guard one sequential dispatcher. */
export async function deliverGithubFeedback(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const deadlineAt = Date.now() + 20_000;
  const expired = await expireFeedbackDispatches(ctx.lease, deadlineAt);
  let processed = 0;
  if (githubFeedbackDeliveryEnabled()) {
    while (processed < 5 && ctx.hasBudget() && !ctx.signal?.aborted && Date.now() < deadlineAt) {
      const claim = await claimFeedbackOutbox(ctx.lease, deadlineAt);
      if (!claim) break;
      const state = await deliverFeedbackIssue(claim, { deadlineAt, lease: ctx.lease, signal: ctx.signal });
      ctx.log("github.feedback_delivery", { state });
      processed += 1;
    }
  }
  ctx.log("github.feedback_delivery_tick", { processed, expired });
  return { done: true, cursor: null };
}
