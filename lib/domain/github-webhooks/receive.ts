import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { products } from "@/lib/db/schema";
import { githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { githubUserConnections } from "@/lib/db/github-user-schema";
import { githubWebhookEvents } from "@/lib/db/github-webhook-schema";
import { requestJob } from "@/lib/jobs/control";
import { cancelBindingFeedbackOutbox } from "@/lib/domain/feedback/github/outbox";
import { feedbackDatabaseWrite, feedbackSql } from "@/lib/domain/feedback/github/database";
import type { FeedbackTransaction } from "@/lib/domain/feedback/repository";
import { GithubWebhookError, readGithubWebhook, type GithubWebhookApp, type GithubWebhookEnvelope } from "./verify";
import { lockGithubFeedbackInstallation } from "./lifecycle";

function revocationReason(event: GithubWebhookEnvelope): string | null {
  if (event.event === "installation_repositories" && event.action === "removed") return "github_repository_removed";
  if (event.event !== "installation") return null;
  if (event.action === "deleted") return "github_installation_deleted";
  if (event.action === "suspend" || event.suspended === true) return "github_installation_suspended";
  if (event.issuesPermission !== null && event.issuesPermission !== "write") return "github_installation_permission_removed";
  if (event.repositorySelection !== null && event.repositorySelection !== "selected") return "github_installation_selection_required";
  return null;
}

async function applyRevocation(tx: FeedbackTransaction, event: GithubWebhookEnvelope, deadlineAt: number) {
  if (event.event === "github_app_authorization") {
    if (event.app === "star") {
      await feedbackSql(tx, deadlineAt, () => tx.update(githubUserConnections).set({ state: "needs_reconnect", encryptedAccessToken: null, encryptedRefreshToken: null, accessExpiresAt: null, refreshExpiresAt: null, refreshLeaseOwner: null, refreshLeaseExpiresAt: null, revision: sql`${githubUserConnections.revision} + 1`, updatedAt: sql`clock_timestamp()` }).where(and(eq(githubUserConnections.githubUserId, event.githubUserId!), eq(githubUserConnections.state, "active"))));
    } else {
      // Older contexts did not record a GitHub user ID; conservatively discard those temporary credentials.
      await feedbackSql(tx, deadlineAt, () => tx.execute(sql`UPDATE github_maker_auth_contexts SET state = 'failed', encrypted_user_token = NULL, setup_state_hash = NULL
        WHERE (github_user_id = ${event.githubUserId} OR github_user_id IS NULL) AND state IN ('authorizing','awaiting_setup','verifying')`));
    }
    return;
  }
  if (event.app !== "feedback" || !event.installationId) return;
  const reason = revocationReason(event);
  const target = and(eq(githubProductBindings.installationId, event.installationId), eq(githubProductBindings.enabled, true),
    event.event === "installation_repositories" && event.action === "removed" ? inArray(githubProductBindings.repositoryId, event.removedRepositoryIds) : undefined);
  if (reason) {
    const candidates = await feedbackSql(tx, deadlineAt, () => tx.select({ productId: githubProductBindings.productId }).from(githubProductBindings).where(target));
    if (!candidates.length) return;
    const ids = candidates.map(row => row.productId);
    await feedbackSql(tx, deadlineAt, () => tx.select({ id: products.id }).from(products).where(inArray(products.id, ids)).orderBy(products.id).for("update"));
    const bindings = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubProductBindings).where(and(target, inArray(githubProductBindings.productId, ids))).orderBy(githubProductBindings.productId).for("update"));
    for (const binding of bindings) {
      await feedbackSql(tx, deadlineAt, () => tx.update(githubProductBindings).set({ enabled: false, revision: binding.revision + 1, blockedReason: reason, updatedAt: sql`clock_timestamp()` }).where(eq(githubProductBindings.productId, binding.productId)));
      await feedbackSql(tx, deadlineAt, () => cancelBindingFeedbackOutbox(tx, binding.productId, reason));
    }
  } else if (event.event === "installation" || event.event === "installation_repositories") {
    await feedbackSql(tx, deadlineAt, () => tx.update(githubProductBindings).set({ lastVerifiedAt: null }).where(target));
  } else if (event.event === "issues") {
    await feedbackSql(tx, deadlineAt, () => tx.update(githubIssueOutbox).set({ lastCheckedAt: null }).where(and(eq(githubIssueOutbox.installationId, event.installationId!), eq(githubIssueOutbox.repositoryId, event.repositoryId!), eq(githubIssueOutbox.githubIssueId, event.issueId!), eq(githubIssueOutbox.githubIssueNumber, event.issueNumber!))));
  }
}

/** Receipt, immediate revocation and the maintenance signal share one short primary transaction. */
export async function receiveGithubWebhook(request: Request, app: GithubWebhookApp): Promise<{ duplicate: boolean; ignored: boolean }> {
  const deadlineAt = Date.now() + 9_000;
  const event = await readGithubWebhook(request, app);
  if (!event) return { duplicate: false, ignored: true };
  return feedbackDatabaseWrite(undefined, async tx => {
    const inserted = await feedbackSql(tx, deadlineAt, () => tx.insert(githubWebhookEvents).values(event).onConflictDoNothing().returning({ id: githubWebhookEvents.deliveryId }));
    if (!inserted.length) {
      const [existing] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.deliveryId, event.deliveryId)));
      if (!existing || existing.app !== event.app || existing.payloadHash !== event.payloadHash || existing.event !== event.event) throw new GithubWebhookError(409, "github_webhook_delivery_conflict");
      return { duplicate: true, ignored: false };
    }
    if (event.app === "feedback" && event.installationId && ["installation", "installation_repositories"].includes(event.event)) await lockGithubFeedbackInstallation(tx, event.installationId, deadlineAt);
    await applyRevocation(tx, event, deadlineAt);
    await feedbackSql(tx, deadlineAt, () => requestJob("github-integration-reconcile", tx));
    return { duplicate: false, ignored: false };
  }, deadlineAt);
}
