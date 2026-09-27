import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { collectSearchHealth } from "@/lib/domain/products/search-health";
import { searchHealthAlerts } from "@/lib/operations/search-health-model";

/** The runner persists this completed audit atomically with the successful owned job tick. */
export type SearchHealthCursor = { generationIdleSince: number | null };
export async function auditSearchHealth(ctx: JobContext<SearchHealthCursor>): Promise<JobOutcome<SearchHealthCursor>> {
  const counts = await collectSearchHealth(() => ctx.hasBudget() && !ctx.signal?.aborted);
  const now = Date.now();
  const previous = ctx.cursor?.generationIdleSince;
  const generationIdleSince = counts.pendingGeneration > 0 && counts.generatedRecent === 0
    ? typeof previous === "number" && Number.isFinite(previous) && previous <= now ? previous : now : null;
  counts.generationIdleMinutes = generationIdleSince === null ? 0 : (now - generationIdleSince) / 60_000;
  ctx.log("search_health.checked", counts);
  for (const alert of searchHealthAlerts(counts)) ctx.log(`search_health.alert.${alert.key}`, { count: alert.count });
  return { done: true, cursor: { generationIdleSince } };
}
