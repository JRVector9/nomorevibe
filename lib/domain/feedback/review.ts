import "server-only";
import { and, eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit, products } from "@/lib/db/schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { FeedbackError, type FeedbackReviewState } from "./contract";
import type { FeedbackTransactionHook } from "./repository";
import { enqueueFeedbackIssue } from "./github/enqueue";
import { notifyCommentReviewed } from "@/lib/me/notifications";

/** adminLogin must come from the existing administrator session, never a form field. */
export async function reviewFeedback(input: { id: string; expectedReviewState: FeedbackReviewState; decision: "accepted" | "rejected"; reason: string; adminLogin: string }, options: { onAccepted?: FeedbackTransactionHook } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)
    || !["accepted", "held", "rejected"].includes(input.expectedReviewState) || !["accepted", "rejected"].includes(input.decision)
    || input.expectedReviewState === input.decision || !input.reason.trim() || input.reason.length > 1000
    || !input.adminLogin.trim() || input.adminLogin.length > 120) throw new FeedbackError("feedback_invalid", 400);
  const reviewed = await onPrimary(() => db.transaction(async (tx) => {
    const [target] = await tx.select({ productId: productFeedback.productId }).from(productFeedback).where(eq(productFeedback.id, input.id));
    if (!target) throw new FeedbackError("feedback_not_found", 404);
    // Match dispatch/retransmit and binding invalidation: product → binding → outbox → feedback.
    const [product] = await tx.select({ status: products.status }).from(products).where(eq(products.id, target.productId)).for("share");
    await tx.select({ productId: githubProductBindings.productId }).from(githubProductBindings)
      .where(eq(githubProductBindings.productId, target.productId)).for("share");
    const [outbox] = await tx.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.feedbackId, input.id)).for("update");
    const [current] = await tx.select().from(productFeedback).where(eq(productFeedback.id, input.id)).for("update");
    if (!current || current.productId !== target.productId) throw new FeedbackError("feedback_not_found", 404);
    if (current.reviewState !== input.expectedReviewState) throw new FeedbackError("feedback_conflict", 409);
    if (!product || (input.decision === "accepted" && product.status === "banned")) throw new FeedbackError("feedback_not_found", 404);
    const cancelPending = input.decision === "rejected" && outbox && ["queued", "retry_wait"].includes(outbox.state);
    if (cancelPending) await tx.update(githubIssueOutbox).set({ state: "cancelled", lastErrorCode: "feedback_hidden",
      leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(githubIssueOutbox.id, outbox.id));
    const [feedback] = await tx.update(productFeedback).set({ reviewState: input.decision, reviewReason: input.reason.trim(),
      reviewedBy: input.adminLogin, reviewedAt: new Date(), ...(cancelPending ? { deliveryState: "cancelled" as const } : {}) })
      .where(and(eq(productFeedback.id, current.id), eq(productFeedback.reviewState, input.expectedReviewState))).returning();
    // Restoring site visibility never creates or retransmits an external dispatch.
    if (input.decision === "accepted" && current.reviewState === "held") {
      if (options.onAccepted) await options.onAccepted(tx, feedback);
      else await enqueueFeedbackIssue(tx, feedback);
    }
    await tx.insert(operationsAudit).values(await adminAuditRow(input.adminLogin, { action: "feedback.review", target: feedback.id,
      detail: { before: current.reviewState, decision: input.decision, reason: input.reason.trim(),
        externalDeliveryState: outbox?.state ?? "local_only", pendingDeliveryCancelled: Boolean(cancelPending) } }));
    const [reviewed] = await tx.select().from(productFeedback).where(eq(productFeedback.id, feedback.id));
    return reviewed;
  }));
  // 보류했던 글의 결과만 작성자 알림함에 — commit 뒤, 실패해도 심사는 끝난 것이다
  if (input.expectedReviewState === "held") await notifyCommentReviewed(reviewed, input.decision);
  return reviewed;
}
