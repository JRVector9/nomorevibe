import { inArray, isNull, sql } from "drizzle-orm";
import { githubWebhookEvents } from "@/lib/db/github-webhook-schema";
import { feedbackDatabaseWrite, feedbackSql } from "@/lib/domain/feedback/github/database";
import type { JobLease } from "@/lib/jobs/control";

/** Targets were marked due during receipt; payload order never replaces authoritative GitHub reads. */
export async function processGithubWebhookEvents(options: { limit?: number; lease?: JobLease; deadlineAt?: number } = {}): Promise<number> {
  return feedbackDatabaseWrite(options.lease, async tx => {
    const rows = await feedbackSql(tx, options.deadlineAt, () => tx.select({ id: githubWebhookEvents.deliveryId }).from(githubWebhookEvents).where(isNull(githubWebhookEvents.processedAt)).orderBy(githubWebhookEvents.receivedAt, githubWebhookEvents.deliveryId).for("update", { skipLocked: true }).limit(Math.max(1, Math.min(20, options.limit ?? 20))));
    if (!rows.length) return 0;
    await feedbackSql(tx, options.deadlineAt, () => tx.update(githubWebhookEvents).set({ processedAt: sql`clock_timestamp()` }).where(inArray(githubWebhookEvents.deliveryId, rows.map(row => row.id))));
    return rows.length;
  }, options.deadlineAt);
}
