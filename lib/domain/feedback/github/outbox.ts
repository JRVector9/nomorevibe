import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { products, rateLimits } from "@/lib/db/schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubIssueOutbox, type GithubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { githubFeedbackDeliveryEnabled } from "@/lib/domain/github-integration/flags";
import type { GithubRepository } from "@/lib/github/repositories";
import type { JobLease } from "@/lib/jobs/control";
import { feedbackFingerprint } from "../contract";
import type { FeedbackTransaction } from "../repository";
import { feedbackPayloadHash, type DeliveredIssue } from "./issue-body";
import { feedbackDatabaseWrite as feedbackOutboxWrite, feedbackSql } from "./database";
export { feedbackOutboxWrite };

export type FeedbackOutboxClaim = GithubIssueOutbox & { leaseToken: string; leaseExpiresAt: Date };
export type FeedbackDeliveryResolution = { state: "delivered" | "retry_wait" | "uncertain" | "blocked" | "cancelled";
  errorCode: string | null; retryAt: number | null; issue?: DeliveredIssue };
export const claimOwnership = (claim: FeedbackOutboxClaim) => and(eq(githubIssueOutbox.id, claim.id), eq(githubIssueOutbox.leaseToken, claim.leaseToken),
  sql`${githubIssueOutbox.leaseExpiresAt} > now()`);

async function storeResolution(tx: FeedbackTransaction, row: GithubIssueOutbox, result: FeedbackDeliveryResolution, deadlineAt?: number) {
  await feedbackSql(tx, deadlineAt, () => tx.update(githubIssueOutbox).set({ state: result.state, leaseToken: null, leaseExpiresAt: null, lastErrorCode: result.errorCode,
    availableAt: new Date(result.retryAt ?? Date.now() + (result.state === "uncertain" ? 30_000 : 0)), updatedAt: new Date(),
    ...(result.issue ? { githubIssueId: result.issue.id, githubIssueNumber: result.issue.number, githubIssueUrl: result.issue.url,
      externalIssueState: result.issue.state, lastCheckedAt: new Date(), completedAt: new Date() } : {}) }).where(eq(githubIssueOutbox.id, row.id)));
  await feedbackSql(tx, deadlineAt, () => tx.update(productFeedback).set({ deliveryState: result.state }).where(eq(productFeedback.id, row.feedbackId)));
}

/** Claims only requests known not to be in flight. Expired sending requests are never recycled. */
export function claimFeedbackOutbox(lease?: JobLease, deadlineAt?: number): Promise<FeedbackOutboxClaim | null> {
  if (!githubFeedbackDeliveryEnabled()) return Promise.resolve(null);
  return feedbackOutboxWrite(lease, async (tx) => {
    const [row] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIssueOutbox).where(and(inArray(githubIssueOutbox.state, ["queued", "retry_wait"]),
      lte(githubIssueOutbox.availableAt, sql`now()`), or(isNull(githubIssueOutbox.leaseExpiresAt), lte(githubIssueOutbox.leaseExpiresAt, sql`now()`))))
      .orderBy(githubIssueOutbox.availableAt, githubIssueOutbox.id).for("update", { skipLocked: true }).limit(1));
    if (!row) return null;
    const [claimed] = await feedbackSql(tx, deadlineAt, () => tx.update(githubIssueOutbox).set({ leaseToken: randomUUID(), leaseExpiresAt: sql`now() + interval '45 seconds'`, updatedAt: new Date() })
      .where(eq(githubIssueOutbox.id, row.id)).returning());
    return claimed as FeedbackOutboxClaim;
  }, deadlineAt);
}

/** The short commit stamps sending BEFORE issue HTTP starts and reserves its daily allowance. */
export function beginFeedbackDispatch(claim: FeedbackOutboxClaim, repository: GithubRepository, lease?: JobLease, deadlineAt?: number): Promise<GithubIssueOutbox | null> {
  return feedbackOutboxWrite(lease, async (tx) => {
    // Binding invalidation uses product → binding → outbox → feedback as well.
    const [product] = await feedbackSql(tx, deadlineAt, () => tx.select({ status: products.status, repoUrl: products.repoUrl }).from(products).where(eq(products.id, claim.productId)).for("share"));
    const [binding] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, claim.productId)).for("share"));
    const [row] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIssueOutbox).where(claimOwnership(claim)).for("update"));
    if (!row || !["queued", "retry_wait"].includes(row.state)) return null;
    if (!githubFeedbackDeliveryEnabled()) {
      await feedbackSql(tx, deadlineAt, () => tx.update(githubIssueOutbox).set({ leaseToken: null, leaseExpiresAt: null }).where(eq(githubIssueOutbox.id, row.id)));
      return null;
    }
    const [feedback] = await feedbackSql(tx, deadlineAt, () => tx.select().from(productFeedback).where(eq(productFeedback.id, row.feedbackId)).for("share"));
    const invalid = !binding?.enabled || binding.revision !== row.bindingRevision || binding.repositoryId !== row.repositoryId || binding.installationId !== row.installationId
      || !product || product.status === "banned" || product.repoUrl !== binding.productRepoUrl || repository.id !== row.repositoryId
      || repository.private || repository.archived || !repository.hasIssues || !feedback || !feedback.githubDeliveryEligible
      || feedback.reviewState !== "accepted" || !feedback.sendToGithub || !feedback.serviceDisclosureConsent || !feedback.githubDisclosureConsent
      || feedback.requestHash !== row.feedbackRequestHash || feedbackFingerprint(row.productId, feedback) !== row.feedbackRequestHash
      || feedbackPayloadHash({ title: row.payloadTitle, body: row.payloadBody }) !== row.payloadHash;
    if (invalid) { await storeResolution(tx, row, { state: "blocked", errorCode: "feedback_target_changed", retryAt: null }, deadlineAt); return null; }
    const key = `github-issue:day:${row.repositoryId}`;
    const [allowance] = await feedbackSql(tx, deadlineAt, () => tx.insert(rateLimits).values({ key, count: 1, resetAt: sql`now() + interval '1 day'` }).onConflictDoUpdate({
      target: rateLimits.key, set: {
        count: sql`case when ${rateLimits.resetAt} <= now() then 1 else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${rateLimits.resetAt} <= now() then now() + interval '1 day' else ${rateLimits.resetAt} end`,
      }, setWhere: or(lte(rateLimits.resetAt, sql`now()`), sql`${rateLimits.count} < 20`),
    }).returning({ resetAt: rateLimits.resetAt }));
    if (!allowance) {
      const [bucket] = await feedbackSql(tx, deadlineAt, () => tx.select().from(rateLimits).where(eq(rateLimits.key, key)));
      await storeResolution(tx, row, { state: "retry_wait", errorCode: "repository_daily_limit", retryAt: bucket.resetAt.getTime() }, deadlineAt);
      return null;
    }
    const [started] = await feedbackSql(tx, deadlineAt, () => tx.update(githubIssueOutbox).set({ state: "sending", attemptId: randomUUID(), attempts: row.attempts + 1,
      dispatchedAt: new Date(), repositoryFullName: repository.fullName, repositoryUrl: repository.htmlUrl, lastErrorCode: null, updatedAt: new Date() })
      .where(eq(githubIssueOutbox.id, row.id)).returning());
    await feedbackSql(tx, deadlineAt, () => tx.update(productFeedback).set({ deliveryState: "sending" }).where(eq(productFeedback.id, row.feedbackId)));
    return started;
  }, deadlineAt);
}

/** A late HTTP completion cannot overwrite an expired/transferred lease or changed dispatch. */
export function completeFeedbackDispatch(claim: FeedbackOutboxClaim, result: FeedbackDeliveryResolution, lease?: JobLease, deadlineAt?: number): Promise<boolean> {
  return feedbackOutboxWrite(lease, async (tx) => {
    const [row] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIssueOutbox).where(and(claimOwnership(claim), eq(githubIssueOutbox.dispatchId, claim.dispatchId),
      inArray(githubIssueOutbox.state, ["queued", "retry_wait", "sending"]))).for("update"));
    if (!row) return false;
    await storeResolution(tx, row, result, deadlineAt);
    return true;
  }, deadlineAt);
}

export function expireFeedbackDispatches(lease?: JobLease, deadlineAt?: number): Promise<number> {
  return feedbackOutboxWrite(lease, async (tx) => {
    const rows = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubIssueOutbox).where(and(eq(githubIssueOutbox.state, "sending"), lte(githubIssueOutbox.leaseExpiresAt, sql`now()`)))
      .for("update", { skipLocked: true }).limit(5));
    for (const row of rows) await storeResolution(tx, row, { state: "uncertain", errorCode: "dispatch_lease_expired", retryAt: null }, deadlineAt);
    return rows.length;
  }, deadlineAt);
}

/** Call in the binding disable transaction. Sent/uncertain rows still need their external result read. */
export async function cancelBindingFeedbackOutbox(tx: FeedbackTransaction, productId: number, reason: string): Promise<number> {
  const rows = await tx.update(githubIssueOutbox).set({ state: "cancelled", lastErrorCode: reason.slice(0, 100), leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(githubIssueOutbox.productId, productId), inArray(githubIssueOutbox.state, ["queued", "retry_wait"]))).returning({ feedbackId: githubIssueOutbox.feedbackId });
  if (rows.length) await tx.update(productFeedback).set({ deliveryState: "cancelled" }).where(inArray(productFeedback.id, rows.map((row) => row.feedbackId)));
  return rows.length;
}

export function getDispatchBinding(claim: FeedbackOutboxClaim, lease?: JobLease, deadlineAt?: number) {
  return feedbackOutboxWrite(lease, async (tx) => {
    const [binding] = await feedbackSql(tx, deadlineAt, () => tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, claim.productId)));
    return binding?.enabled && binding.revision === claim.bindingRevision && binding.repositoryId === claim.repositoryId && binding.installationId === claim.installationId ? binding : null;
  }, deadlineAt);
}
