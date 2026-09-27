import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { pendingPublishedReadmes, recordPublishedReadme } from "@/lib/crawl/repository";
import { fetchPublicReadme } from "@/lib/crawl/readme-refresh";

/** Rare recrawls only: two repositories per five-minute tick, never a bulk backfill. */
export async function refreshPublishedReadmes(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!ctx.lease) throw new Error("README refresh requires a job lease");
  const deadline = Date.now() + 20_000;
  let refreshed = 0, failed = 0, superseded = 0;
  for (const document of await pendingPublishedReadmes(2)) {
    if (!ctx.hasBudget() || ctx.signal?.aborted || deadline - Date.now() < 8_500) break;
    const result = await fetchPublicReadme(document.repo, ctx.signal);
    if (!ctx.hasBudget() || ctx.signal?.aborted) break;
    if (!await recordPublishedReadme(document, ctx.lease, result)) superseded++;
    else if (result.ok) refreshed++;
    else failed++;
  }
  ctx.log("readme_refresh.done", { refreshed, failed, superseded });
  return { done: true };
}
