import { and, eq, gte, or, sql } from "drizzle-orm";
import { githubWebhookEvents } from "@/lib/db/github-webhook-schema";
import { isGithubNumericId } from "@/lib/github/repositories";
import { feedbackSql } from "@/lib/domain/feedback/github/database";
import type { FeedbackTransaction } from "@/lib/domain/feedback/repository";

/** Always take this lock before product/binding/outbox locks, including the first binding. */
export async function lockGithubFeedbackInstallation(tx: FeedbackTransaction, installationId: number, deadlineAt?: number): Promise<void> {
  if (!isGithubNumericId(installationId)) throw new Error("github_installation_invalid");
  await feedbackSql(tx, deadlineAt, () => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'nmv-feedback-installation:' + installationId}, 0))`));
}

/** Call while holding the installation lock; a new explicit consent flow may verify restored access. */
export async function hasGithubInstallationRevocation(tx: FeedbackTransaction, input: { installationId: number; repositoryId: number; verifiedAfter: Date }, deadlineAt?: number): Promise<boolean> {
  const [event] = await feedbackSql(tx, deadlineAt, () => tx.select({ id: githubWebhookEvents.deliveryId }).from(githubWebhookEvents).where(and(
    eq(githubWebhookEvents.app, "feedback"), eq(githubWebhookEvents.installationId, input.installationId), gte(githubWebhookEvents.receivedAt, input.verifiedAfter),
    or(and(eq(githubWebhookEvents.event, "installation"), or(sql`${githubWebhookEvents.action} in ('deleted','suspend')`, eq(githubWebhookEvents.suspended, true),
      sql`${githubWebhookEvents.issuesPermission} IS NOT NULL AND ${githubWebhookEvents.issuesPermission} <> 'write'`, sql`${githubWebhookEvents.repositorySelection} IS NOT NULL AND ${githubWebhookEvents.repositorySelection} <> 'selected'`)),
    and(eq(githubWebhookEvents.event, "installation_repositories"), eq(githubWebhookEvents.action, "removed"), sql`${githubWebhookEvents.removedRepositoryIds} @> ${JSON.stringify([input.repositoryId])}::jsonb`)))).limit(1));
  return !!event;
}
