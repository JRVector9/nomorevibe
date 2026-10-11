import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { products } from "@/lib/db/schema";
import { githubMakerAuthContexts, githubProductBindings, type GithubProductBinding } from "@/lib/db/github-binding-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { githubWebhookEvents } from "@/lib/db/github-webhook-schema";
import { githubRequest } from "@/lib/github/client";
import { parseGithubRepositoryResponse } from "@/lib/github/repositories";
import { getFeedbackInstallationToken, GithubInstallationError, verifyFeedbackInstallation } from "@/lib/domain/github-installations/credentials";
import { withinFeedbackDeadline, type FeedbackProviderOptions } from "@/lib/domain/feedback/github/deliver";
import { feedbackDatabaseWrite, feedbackSql } from "@/lib/domain/feedback/github/database";
import { cancelBindingFeedbackOutbox } from "@/lib/domain/feedback/github/outbox";
import { parseDeliveredIssue } from "@/lib/domain/feedback/github/issue-body";

type IssueTarget = { installationId: number; repositoryId: number; githubIssueId: number | null; githubIssueNumber: number | null };
type IssueRead = { state: "open" | "closed" | "deleted" | "unknown"; errorCode: string | null; retryAt: number | null; url?: string };

/** A missing issue is meaningful only after the exact public repository ID is read. */
export async function readLinkedGithubIssue(target: IssueTarget, options: FeedbackProviderOptions): Promise<IssueRead> {
  try {
    if (!target.githubIssueId || !target.githubIssueNumber) return { state: "unknown", errorCode: "github_issue_identity_missing", retryAt: null };
    const credential = await withinFeedbackDeadline(() => (options.token ?? getFeedbackInstallationToken)({ installationId: target.installationId, repositoryId: target.repositoryId }, options), options.deadlineAt, options.signal);
    const request = options.request ?? githubRequest<unknown>;
    const read = (path: string) => withinFeedbackDeadline(() => request({ path, token: credential.token, auth: "installation", timeoutMs: Math.max(1, Math.min(10_000, options.deadlineAt - Date.now())) }), options.deadlineAt, options.signal);
    const metadata = await read(`/repositories/${target.repositoryId}`);
    const repository = metadata.outcome === "confirmed_success" ? parseGithubRepositoryResponse(metadata.data, target.repositoryId) : null;
    if (!repository || repository.private) return { state: "unknown", errorCode: metadata.code ?? "github_reconcile_repository_unavailable", retryAt: metadata.retryAt };
    const result = await read(`/repos/${repository.fullName}/issues/${target.githubIssueNumber}`);
    if (result.outcome === "confirmed_rejection" && [404, 410].includes(result.status ?? 0)) return { state: "deleted", errorCode: "github_issue_unavailable", retryAt: null };
    const issue = result.outcome === "confirmed_success" ? parseDeliveredIssue(result.data, repository) : null;
    if (!issue || issue.id !== target.githubIssueId || issue.number !== target.githubIssueNumber) return { state: "unknown", errorCode: result.code ?? "github_issue_response_mismatch", retryAt: result.retryAt };
    return { state: issue.state, url: issue.url, errorCode: null, retryAt: null };
  } catch (error) {
    return { state: "unknown", errorCode: error instanceof GithubInstallationError ? error.providerCode ?? error.code : "github_reconcile_unavailable", retryAt: error instanceof GithubInstallationError ? error.retryAt : null };
  }
}

/** Delivered rows have their own read lease. Binding removal never hides an existing result. */
export async function reconcileLinkedGithubIssue(id: string, options: FeedbackProviderOptions): Promise<string> {
  const claim = await feedbackDatabaseWrite(options.lease, async tx => {
    const [row] = await feedbackSql(tx, options.deadlineAt, () => tx.select().from(githubIssueOutbox).where(and(eq(githubIssueOutbox.id, id), eq(githubIssueOutbox.state, "delivered"), lte(githubIssueOutbox.availableAt, sql`clock_timestamp()`),
      or(isNull(githubIssueOutbox.leaseExpiresAt), lte(githubIssueOutbox.leaseExpiresAt, sql`clock_timestamp()`)))).for("update", { skipLocked: true }));
    if (!row) return null;
    const [clock] = await feedbackSql(tx, options.deadlineAt, () => tx.execute<{ at: string }>(sql`select clock_timestamp() as at`));
    const [claimed] = await feedbackSql(tx, options.deadlineAt, () => tx.update(githubIssueOutbox).set({ leaseToken: randomUUID(), leaseExpiresAt: sql`clock_timestamp() + interval '45 seconds'` }).where(eq(githubIssueOutbox.id, id)).returning());
    return { row: claimed, startedAt: new Date(clock.at) };
  }, options.deadlineAt);
  if (!claim) return "skipped";
  const result = await readLinkedGithubIssue(claim.row, options);
  return feedbackDatabaseWrite(options.lease, async tx => {
    const [owned] = await feedbackSql(tx, options.deadlineAt, () => tx.select().from(githubIssueOutbox).where(and(eq(githubIssueOutbox.id, id), eq(githubIssueOutbox.state, "delivered"),
      eq(githubIssueOutbox.dispatchId, claim.row.dispatchId), eq(githubIssueOutbox.leaseToken, claim.row.leaseToken!), gt(githubIssueOutbox.leaseExpiresAt, sql`clock_timestamp()`))).for("update"));
    if (!owned) return "lease_lost";
    const [newEvent] = await feedbackSql(tx, options.deadlineAt, () => tx.select({ id: githubWebhookEvents.deliveryId }).from(githubWebhookEvents).where(and(eq(githubWebhookEvents.event, "issues"), eq(githubWebhookEvents.installationId, owned.installationId),
      eq(githubWebhookEvents.repositoryId, owned.repositoryId), eq(githubWebhookEvents.issueId, owned.githubIssueId!), gt(githubWebhookEvents.receivedAt, claim.startedAt))).limit(1));
    await feedbackSql(tx, options.deadlineAt, () => tx.update(githubIssueOutbox).set({ externalIssueState: result.state, lastErrorCode: result.errorCode,
      lastCheckedAt: newEvent ? null : new Date(), availableAt: new Date(result.errorCode === "github_rate_limited" ? Math.max(Date.now(), result.retryAt ?? Date.now() + 60_000) : Date.now()), updatedAt: new Date(), leaseToken: null, leaseExpiresAt: null, ...(result.url ? { githubIssueUrl: result.url } : {}) }).where(eq(githubIssueOutbox.id, id)));
    return result.state;
  }, options.deadlineAt);
}

async function loadCurrentBinding(productId: number, options: FeedbackProviderOptions): Promise<GithubProductBinding | null> {
  return feedbackDatabaseWrite(options.lease, async tx => {
    const [product] = await feedbackSql(tx, options.deadlineAt, () => tx.select().from(products).where(eq(products.id, productId)).for("update"));
    const [binding] = await feedbackSql(tx, options.deadlineAt, () => tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, productId)).for("update"));
    if (!binding?.enabled) return null;
    const reason = product?.status === "banned" ? "product_banned" : product?.repoUrl !== binding.productRepoUrl ? "product_repository_changed" : null;
    if (!reason) return binding.verificationRetryAt && binding.verificationRetryAt > new Date() ? null : binding;
    await feedbackSql(tx, options.deadlineAt, () => tx.update(githubProductBindings).set({ enabled: false, revision: binding.revision + 1, blockedReason: reason, updatedAt: new Date() }).where(eq(githubProductBindings.productId, productId)));
    await feedbackSql(tx, options.deadlineAt, () => cancelBindingFeedbackOutbox(tx, productId, reason));
    return null;
  }, options.deadlineAt);
}

/** A live result may update only the revision that was verified; it never enables a disabled binding. */
export async function reconcileGithubBinding(productId: number, options: FeedbackProviderOptions): Promise<string> {
  const binding = await loadCurrentBinding(productId, options);
  if (!binding) return "skipped";
  let repository: Awaited<ReturnType<typeof verifyFeedbackInstallation>>["repository"] | null = null;
  let errorCode: string | null = null, definite = false, retryAt: number | null = null;
  try { ({ repository } = await withinFeedbackDeadline(() => (options.verify ?? verifyFeedbackInstallation)(binding, options), options.deadlineAt, options.signal)); }
  catch (error) {
    errorCode = error instanceof GithubInstallationError ? error.providerCode ?? error.code : "github_installation_verification_unavailable";
    retryAt = error instanceof GithubInstallationError && error.providerCode === "github_rate_limited" ? Math.max(Date.now(), error.retryAt ?? Date.now() + 60_000) : null;
    definite = error instanceof GithubInstallationError && error.providerCode !== "github_rate_limited" && [400, 401, 403, 404, 409, 410, 422].includes(error.status);
  }
  return feedbackDatabaseWrite(options.lease, async tx => {
    const [product] = await feedbackSql(tx, options.deadlineAt, () => tx.select().from(products).where(eq(products.id, productId)).for("update"));
    const [current] = await feedbackSql(tx, options.deadlineAt, () => tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, productId)).for("update"));
    if (!current?.enabled || current.revision !== binding.revision || current.repositoryId !== binding.repositoryId || current.installationId !== binding.installationId) return "superseded";
    const invalid = product?.status === "banned" ? "product_banned" : product?.repoUrl !== current.productRepoUrl ? "product_repository_changed" : null;
    if (invalid || definite) {
      const reason = invalid ?? errorCode ?? "github_installation_unavailable";
      await feedbackSql(tx, options.deadlineAt, () => tx.update(githubProductBindings).set({ enabled: false, revision: current.revision + 1, blockedReason: reason, updatedAt: new Date() }).where(eq(githubProductBindings.productId, productId)));
      await feedbackSql(tx, options.deadlineAt, () => cancelBindingFeedbackOutbox(tx, productId, reason));
      return "disabled";
    }
    await feedbackSql(tx, options.deadlineAt, () => tx.update(githubProductBindings).set({ updatedAt: new Date(), verificationRetryAt: retryAt === null ? null : new Date(retryAt), ...(repository?.id === binding.repositoryId ? { lastVerifiedAt: new Date(), repositoryFullName: repository.fullName, repositoryUrl: repository.htmlUrl, blockedReason: null } : { blockedReason: errorCode ?? "github_installation_verification_unavailable" }) }).where(eq(githubProductBindings.productId, productId)));
    return repository?.id === binding.repositoryId ? "verified" : "unknown";
  }, options.deadlineAt);
}

/** The maintenance path cannot require flags or the credential encryption key to erase expired secrets. */
export async function cleanupExpiredMakerGithubAuthorizations(options: Pick<FeedbackProviderOptions, "deadlineAt" | "lease">): Promise<number> {
  return feedbackDatabaseWrite(options.lease, async tx => (await feedbackSql(tx, options.deadlineAt, () => tx.update(githubMakerAuthContexts).set({ state: "expired", encryptedUserToken: null, setupStateHash: null })
    .where(and(lte(githubMakerAuthContexts.expiresAt, sql`clock_timestamp()`), inArray(githubMakerAuthContexts.state, ["authorizing", "awaiting_setup", "verifying"]))).returning({ id: githubMakerAuthContexts.flowId }))).length, options.deadlineAt);
}

export async function dueGithubIntegrationTargets(options: Pick<FeedbackProviderOptions, "deadlineAt" | "lease">): Promise<{ kind: "binding" | "issue" | "uncertain"; id: string }[]> {
  return feedbackDatabaseWrite(options.lease, async tx => Array.from(await feedbackSql(tx, options.deadlineAt, () => tx.execute<{ kind: "binding" | "issue" | "uncertain"; id: string }>(sql`
    SELECT kind, id FROM (
      SELECT 'binding' AS kind, product_id::text AS id, updated_at AS due FROM github_product_bindings
        WHERE enabled AND (last_verified_at IS NULL OR last_verified_at <= now() - interval '15 minutes') AND (verification_retry_at IS NULL OR verification_retry_at <= now())
      UNION ALL SELECT 'issue', id::text, coalesce(last_checked_at, updated_at) FROM github_issue_outbox
        WHERE state = 'delivered' AND (last_checked_at IS NULL OR last_checked_at <= now() - interval '15 minutes')
          AND available_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      UNION ALL SELECT 'uncertain', id::text, available_at FROM github_issue_outbox
        WHERE state = 'uncertain' AND available_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ) targets ORDER BY due, kind, id LIMIT 20`))), options.deadlineAt);
}
