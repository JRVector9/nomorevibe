import "server-only";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { products } from "@/lib/db/schema";
import { githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubIssueOutbox, type GithubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { githubIntegrationActions } from "@/lib/db/github-webhook-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { feedbackFingerprint } from "@/lib/domain/feedback/contract";
import { githubFeedbackDeliveryEnabled, productFeedbackEnabled } from "@/lib/domain/github-integration/flags";
import { feedbackIssueMarker, feedbackPayloadHash } from "@/lib/domain/feedback/github/issue-body";
import { feedbackDatabaseWrite, feedbackSql } from "@/lib/domain/feedback/github/database";
import { withinFeedbackDeadline, type FeedbackProviderOptions } from "@/lib/domain/feedback/github/deliver";
import { verifyFeedbackInstallation } from "@/lib/domain/github-installations/credentials";
import { requestJob } from "@/lib/jobs/control";
import type { FeedbackTransaction } from "@/lib/domain/feedback/repository";
import { GithubWebhookError } from "./verify";
import { hasGithubInstallationRevocation, lockGithubFeedbackInstallation } from "./lifecycle";

type RecoveryInput = { requestId: string; outboxId: string; expectedDispatchId: string; adminLogin: string; reason: string };
type RetransmitInput = RecoveryInput & { expectedBindingRevision: number; expectedPayloadHash: string; duplicateRiskAcknowledged: boolean };
type AdminOptions = Partial<Pick<FeedbackProviderOptions, "verify" | "deadlineAt" | "signal">>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const conflict = () => new GithubWebhookError(409, "github_recovery_conflict");
function validate(input: RecoveryInput) {
  if (!UUID.test(input.requestId) || !UUID.test(input.outboxId) || !UUID.test(input.expectedDispatchId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(input.adminLogin)
    || !input.reason.trim() || input.reason.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.reason)) throw new GithubWebhookError(400, "github_recovery_invalid");
}
async function duplicate(tx: FeedbackTransaction, input: RecoveryInput, action: "requery" | "retransmit", deadlineAt: number) {
  const [audit] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIntegrationActions).where(eq(githubIntegrationActions.requestId, input.requestId)));
  if (!audit) return false;
  if (audit.outboxId !== input.outboxId || audit.previousDispatchId !== input.expectedDispatchId || audit.action !== action || audit.adminLogin !== input.adminLogin || audit.reason !== input.reason
    || (action === "retransmit" && (audit.payloadHash !== (input as RetransmitInput).expectedPayloadHash || !audit.duplicateRiskAcknowledged))) throw conflict();
  return true;
}
async function audit(tx: FeedbackTransaction, input: RecoveryInput, action: "requery" | "retransmit", row: GithubIssueOutbox, deadlineAt: number) {
  const inserted = await feedbackSql(tx, deadlineAt, () => tx.insert(githubIntegrationActions).values({ requestId: input.requestId, outboxId: row.id, action, previousDispatchId: row.dispatchId, previousState: row.state,
    repositoryId: row.repositoryId, installationId: row.installationId, bindingRevision: row.bindingRevision, payloadHash: row.payloadHash, adminLogin: input.adminLogin, reason: input.reason,
    duplicateRiskAcknowledged: action === "retransmit" }).onConflictDoNothing().returning({ id: githubIntegrationActions.requestId }));
  if (!inserted.length) throw conflict();
}

/** A read request never changes an unknown dispatch into a retry. */
export async function requestGithubIntegrationRequery(input: RecoveryInput, options: AdminOptions = {}): Promise<{ duplicate: boolean }> {
  validate(input); const deadlineAt = options.deadlineAt ?? Date.now() + 12_000;
  return feedbackDatabaseWrite(undefined, async tx => {
    if (await duplicate(tx, input, "requery", deadlineAt)) return { duplicate: true };
    const [snapshot] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, input.outboxId)));
    if (!snapshot) throw conflict();
    await feedbackSql(tx, deadlineAt, () => tx.select({ id: products.id }).from(products).where(eq(products.id, snapshot.productId)).for("update"));
    await feedbackSql(tx, deadlineAt, () => tx.select({ id: githubProductBindings.productId }).from(githubProductBindings).where(eq(githubProductBindings.productId, snapshot.productId)).for("update"));
    const [row] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, input.outboxId)).for("update"));
    if (await duplicate(tx, input, "requery", deadlineAt)) return { duplicate: true };
    if (!row || row.dispatchId !== input.expectedDispatchId) throw conflict();
    await audit(tx, input, "requery", row, deadlineAt);
    await feedbackSql(tx, deadlineAt, () => tx.update(githubIssueOutbox).set({ lastCheckedAt: null, availableAt: sql`greatest(clock_timestamp(), ${githubIssueOutbox.availableAt})`, updatedAt: new Date() }).where(eq(githubIssueOutbox.id, row.id)));
    await feedbackSql(tx, deadlineAt, () => tx.update(githubProductBindings).set({ lastVerifiedAt: null }).where(eq(githubProductBindings.productId, row.productId)));
    await feedbackSql(tx, deadlineAt, () => requestJob("github-integration-reconcile", tx));
    return { duplicate: false };
  }, deadlineAt);
}

/** Only an explicit audited administrator request may create a new dispatch after uncertainty. */
export async function requestGithubIntegrationRetransmit(input: RetransmitInput, options: AdminOptions = {}): Promise<{ duplicate: boolean }> {
  validate(input);
  if (input.duplicateRiskAcknowledged !== true || !Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision < 1 || !/^[a-f0-9]{64}$/.test(input.expectedPayloadHash)) throw new GithubWebhookError(400, "github_recovery_acknowledgement_required");
  const deadlineAt = options.deadlineAt ?? Date.now() + 20_000;
  const snapshot = await feedbackDatabaseWrite(undefined, async tx => {
    if (await duplicate(tx, input, "retransmit", deadlineAt)) return null;
    const [row] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, input.outboxId)));
    if (!row) throw conflict();
    const [binding] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, row.productId)));
    if (!binding?.enabled || binding.repositoryId !== row.repositoryId || binding.revision !== input.expectedBindingRevision || row.dispatchId !== input.expectedDispatchId || row.payloadHash !== input.expectedPayloadHash
      || (binding.verificationRetryAt && binding.verificationRetryAt > new Date()) || (row.lastErrorCode === "github_rate_limited" && row.availableAt > new Date())) throw conflict();
    const [clock] = await feedbackSql(tx, deadlineAt, () => tx.execute<{ at: string }>(sql`select clock_timestamp() as at`));
    return { row, binding, preflightStartedAt: new Date(clock.at) };
  }, deadlineAt);
  if (!snapshot) return { duplicate: true };
  if (!githubFeedbackDeliveryEnabled() || !productFeedbackEnabled()) throw new GithubWebhookError(403, "github_feedback_disabled");
  const httpDeadlineAt = deadlineAt - 6_000;
  const verified = await withinFeedbackDeadline(() => (options.verify ?? verifyFeedbackInstallation)(snapshot.binding, { deadlineAt: httpDeadlineAt, signal: options.signal }), httpDeadlineAt, options.signal);
  if (verified.repository.id !== snapshot.row.repositoryId || verified.repository.private || verified.repository.archived || !verified.repository.hasIssues) throw conflict();
  return feedbackDatabaseWrite(undefined, async tx => {
    await lockGithubFeedbackInstallation(tx, snapshot.binding.installationId, deadlineAt);
    const [product] = await feedbackSql(tx, deadlineAt, () => tx.select().from(products).where(eq(products.id, snapshot.row.productId)).for("update"));
    const [binding] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, snapshot.row.productId)).for("update"));
    const [row] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, input.outboxId)).for("update"));
    if (await duplicate(tx, input, "retransmit", deadlineAt)) return { duplicate: true };
    const [feedback] = await feedbackSql(tx, deadlineAt, () => tx.select().from(productFeedback).where(eq(productFeedback.id, snapshot.row.feedbackId)).for("update"));
    if (!githubFeedbackDeliveryEnabled() || !productFeedbackEnabled() || !product || product.status === "banned" || !binding?.enabled || product.repoUrl !== binding.productRepoUrl
      || binding.revision !== snapshot.binding.revision || binding.revision !== input.expectedBindingRevision || binding.repositoryId !== snapshot.row.repositoryId || binding.installationId !== snapshot.binding.installationId
      || !row || !["uncertain", "blocked", "cancelled"].includes(row.state) || row.dispatchId !== input.expectedDispatchId || row.payloadHash !== input.expectedPayloadHash
      || (row.leaseExpiresAt && row.leaseExpiresAt > new Date()) || !feedback || feedback.reviewState !== "accepted" || !feedback.githubDeliveryEligible || !feedback.serviceDisclosureConsent || !feedback.sendToGithub || !feedback.githubDisclosureConsent
      || feedback.requestHash !== row.feedbackRequestHash || feedbackFingerprint(feedback.productId, feedback) !== row.feedbackRequestHash || feedbackPayloadHash({ title: row.payloadTitle, body: row.payloadBody }) !== row.payloadHash) throw conflict();
    const oldMarker = feedbackIssueMarker(row.feedbackId, row.dispatchId);
    if (!row.payloadBody.endsWith(oldMarker)) throw conflict();
    if (await hasGithubInstallationRevocation(tx, { installationId: binding.installationId, repositoryId: binding.repositoryId, verifiedAfter: snapshot.preflightStartedAt }, deadlineAt)) throw conflict();
    const dispatchId = randomUUID(), payloadBody = row.payloadBody.slice(0, -oldMarker.length) + feedbackIssueMarker(row.feedbackId, dispatchId);
    await audit(tx, input, "retransmit", row, deadlineAt);
    await feedbackSql(tx, deadlineAt, () => tx.update(githubIssueOutbox).set({ dispatchId, state: "queued", payloadBody, payloadHash: feedbackPayloadHash({ title: row.payloadTitle, body: payloadBody }),
      installationId: binding.installationId, bindingRevision: binding.revision, repositoryFullName: verified.repository.fullName, repositoryUrl: verified.repository.htmlUrl,
      leaseToken: null, leaseExpiresAt: null, attemptId: null, attempts: 0, dispatchedAt: null, availableAt: new Date(), lastErrorCode: null, githubIssueId: null, githubIssueNumber: null, githubIssueUrl: null,
      externalIssueState: "unknown", lastCheckedAt: null, reconcilePage: 1, reconcileMatches: [], completedAt: null, updatedAt: new Date() }).where(eq(githubIssueOutbox.id, row.id)));
    await feedbackSql(tx, deadlineAt, () => tx.update(productFeedback).set({ deliveryState: "queued" }).where(eq(productFeedback.id, feedback.id)));
    await feedbackSql(tx, deadlineAt, () => requestJob("github-feedback-delivery", tx));
    return { duplicate: false };
  }, deadlineAt);
}

export async function githubIntegrationAdminRows() {
  const deadlineAt = Date.now() + 9_000;
  return feedbackDatabaseWrite(undefined, tx => feedbackSql(tx, deadlineAt, () => tx.select({ id: githubIssueOutbox.id, feedbackId: githubIssueOutbox.feedbackId, state: githubIssueOutbox.state, dispatchId: githubIssueOutbox.dispatchId,
    payloadHash: githubIssueOutbox.payloadHash, repositoryId: githubIssueOutbox.repositoryId, repositoryFullName: githubIssueOutbox.repositoryFullName, repositoryUrl: githubIssueOutbox.repositoryUrl,
    installationId: githubIssueOutbox.installationId, bindingRevision: githubIssueOutbox.bindingRevision, currentBindingRevision: githubProductBindings.revision, bindingEnabled: githubProductBindings.enabled,
    lastErrorCode: githubIssueOutbox.lastErrorCode, lastCheckedAt: githubIssueOutbox.lastCheckedAt, externalIssueState: githubIssueOutbox.externalIssueState, githubIssueUrl: githubIssueOutbox.githubIssueUrl,
    productName: products.name, productSlug: products.slug, createdAt: githubIssueOutbox.createdAt }).from(githubIssueOutbox).innerJoin(products, eq(products.id, githubIssueOutbox.productId))
    .leftJoin(githubProductBindings, eq(githubProductBindings.productId, githubIssueOutbox.productId)).where(inArray(githubIssueOutbox.state, ["queued", "retry_wait", "uncertain", "blocked", "cancelled", "sending", "delivered"])).orderBy(sql`${githubIssueOutbox.updatedAt} DESC`).limit(100)), deadlineAt);
}
