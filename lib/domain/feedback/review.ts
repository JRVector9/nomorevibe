import "server-only";
import { eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit, products } from "@/lib/db/schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { FeedbackError } from "./contract";
import type { FeedbackTransactionHook } from "./repository";
import { enqueueFeedbackIssue } from "./github/enqueue";

/** adminLogin must come from the existing administrator session, never a form field. */
export function reviewFeedback(input: { id: string; decision: "accepted" | "rejected"; reason: string; adminLogin: string }, options: { onAccepted?: FeedbackTransactionHook } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)
    || !["accepted", "rejected"].includes(input.decision) || !input.reason.trim() || input.reason.length > 1000
    || !input.adminLogin.trim() || input.adminLogin.length > 120) throw new FeedbackError("feedback_invalid", 400);
  return onPrimary(() => db.transaction(async (tx) => {
    const [target] = await tx.select({ productId: productFeedback.productId }).from(productFeedback).where(eq(productFeedback.id, input.id));
    if (!target) throw new FeedbackError("feedback_not_found", 404);
    // Match binding invalidation: product before feedback, including approval hooks.
    const [product] = await tx.select({ status: products.status }).from(products).where(eq(products.id, target.productId)).for("share");
    const [current] = await tx.select().from(productFeedback).where(eq(productFeedback.id, input.id)).for("update");
    if (!current || current.productId !== target.productId) throw new FeedbackError("feedback_not_found", 404);
    if (current.reviewState !== "held") throw new FeedbackError("feedback_conflict", 409);
    if (!product || (input.decision === "accepted" && product.status === "banned")) throw new FeedbackError("feedback_not_found", 404);
    const [feedback] = await tx.update(productFeedback).set({ reviewState: input.decision, reviewReason: input.reason.trim(),
      reviewedBy: input.adminLogin, reviewedAt: new Date() }).where(eq(productFeedback.id, current.id)).returning();
    if (input.decision === "accepted") {
      if (options.onAccepted) await options.onAccepted(tx, feedback);
      else await enqueueFeedbackIssue(tx, feedback);
    }
    await tx.insert(operationsAudit).values(await adminAuditRow(input.adminLogin, { action: "feedback.review", target: feedback.id,
      detail: { before: current.reviewState, decision: input.decision, reason: input.reason.trim() } }));
    const [reviewed] = await tx.select().from(productFeedback).where(eq(productFeedback.id, feedback.id));
    return reviewed;
  }));
}
