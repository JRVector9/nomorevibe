import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { products } from "@/lib/db/schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { productFeedback, type ProductFeedback } from "@/lib/db/product-feedback-schema";
import { githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { githubFeedbackDeliveryEnabled } from "@/lib/domain/github-integration/flags";
import { requestJob } from "@/lib/jobs/control";
import type { FeedbackTransaction } from "../repository";
import { buildFeedbackIssuePayload, feedbackPayloadHash } from "./issue-body";

/** Called in the feedback insert/approval transaction. No provider requests occur here. */
export async function enqueueFeedbackIssue(tx: FeedbackTransaction, submitted: ProductFeedback) {
  if (!githubFeedbackDeliveryEnabled()) return null;
  const [feedback] = await tx.select().from(productFeedback).where(eq(productFeedback.id, submitted.id)).for("update");
  if (!feedback || !feedback.githubDeliveryEligible || feedback.reviewState !== "accepted" || !feedback.sendToGithub
    || !feedback.serviceDisclosureConsent || !feedback.githubDisclosureConsent) return null;
  // The caller already holds feedback. Freeze a snapshot without reversing the
  // invalidation lock order; dispatch rechecks the current binding revision.
  const [binding] = await tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, feedback.productId));
  const [product] = await tx.select({ status: products.status, repoUrl: products.repoUrl }).from(products).where(eq(products.id, feedback.productId)).for("share");
  if (!binding?.enabled || !product || product.status === "banned" || product.repoUrl !== binding.productRepoUrl) return null;
  const [existing] = await tx.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.feedbackId, feedback.id));
  if (existing) return existing;
  const [author] = await tx.select({ displayName: publicUsers.displayName }).from(publicUsers).where(eq(publicUsers.id, feedback.authorUserId));
  const dispatchId = randomUUID();
  const payload = buildFeedbackIssuePayload(feedback, author.displayName, process.env.NEXT_PUBLIC_SITE_URL ?? "", dispatchId);
  const [outbox] = await tx.insert(githubIssueOutbox).values({ feedbackId: feedback.id, productId: feedback.productId,
    repositoryId: binding.repositoryId, repositoryFullName: binding.repositoryFullName, repositoryUrl: binding.repositoryUrl,
    installationId: binding.installationId, bindingRevision: binding.revision, feedbackRequestHash: feedback.requestHash,
    payloadTitle: payload.title, payloadBody: payload.body, payloadHash: feedbackPayloadHash(payload), dispatchId, state: "queued" }).returning();
  await tx.update(productFeedback).set({ deliveryState: "queued" }).where(eq(productFeedback.id, feedback.id));
  await requestJob("github-feedback-delivery", tx);
  return outbox;
}
