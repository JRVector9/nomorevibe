import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import {
  currentEvidenceSettings,
  dueEvidenceProductSlugs,
  refreshProductEvidence,
  type EvidenceRefreshDependencies,
} from "@/lib/domain/evidence/refresh";

export type EvidenceRefreshCursor = { afterSlug?: string };
export type EvidenceRefreshCounts = {
  attempted: number;
  succeeded: number;
  failed: number;
  factsChanged: number;
  eventsInserted: number;
  mediaInserted: number;
};

export async function refreshProductEvidenceJob(
  ctx: JobContext<EvidenceRefreshCursor>,
  dependencies: EvidenceRefreshDependencies = {},
): Promise<JobOutcome<EvidenceRefreshCursor>> {
  const now = (dependencies.now ?? (() => new Date()))();
  const settings = await currentEvidenceSettings();
  const counts: EvidenceRefreshCounts = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    factsChanged: 0,
    eventsInserted: 0,
    mediaInserted: 0,
  };
  let afterSlug = ctx.cursor?.afterSlug;
  const sourceDependencies: EvidenceRefreshDependencies = {
    ...dependencies,
    log: (event, fields) => {
      dependencies.log?.(event, fields);
      ctx.log(event, fields);
    },
  };

  while (ctx.hasBudget()) {
    const slugs = await dueEvidenceProductSlugs({
      afterSlug,
      limit: settings.batchSize,
      now,
      settings,
    });
    if (slugs.length === 0) {
      ctx.log("evidence.refresh_batch", counts);
      return { done: true };
    }

    let completedPage = true;
    for (const slug of slugs) {
      if (!ctx.hasBudget()) {
        completedPage = false;
        break;
      }
      counts.attempted += 1;
      try {
        const result = await refreshProductEvidence(slug, {
          now,
          hasBudget: ctx.hasBudget,
          dependencies: sourceDependencies,
        });
        if (result.sourcesFailed > 0) counts.failed += 1;
        else if (result.complete) counts.succeeded += 1;
        counts.factsChanged += result.factsChanged;
        counts.eventsInserted += result.eventsInserted;
        counts.mediaInserted += result.mediaInserted;
        if (!result.complete) {
          completedPage = false;
          break;
        }
      } catch {
        counts.failed += 1;
      }
      afterSlug = slug;
      await ctx.save({ afterSlug });
    }
    if (!completedPage) break;
    if (slugs.length < settings.batchSize) {
      ctx.log("evidence.refresh_batch", counts);
      return { done: true };
    }
  }

  ctx.log("evidence.refresh_batch", counts);
  return { done: false, cursor: afterSlug ? { afterSlug } : ctx.cursor };
}
