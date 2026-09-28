import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { refreshRanking } from "@/lib/domain/ranking/refresh";

export async function refreshRankings(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const result = await refreshRanking(new Date(), ctx.lease);
  ctx.log("ranking.refreshed", result);
  return { done: true };
}
