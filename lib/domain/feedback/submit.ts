import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products, rateLimits } from "@/lib/db/schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { FeedbackError, feedbackFingerprint, initialFeedbackReview, normalizedFeedbackBodyHash, validateFeedbackWrite } from "./contract";
import type { FeedbackTransaction, FeedbackTransactionHook } from "./repository";
import { githubFeedbackDeliveryEnabled } from "@/lib/domain/github-integration/flags";
import { enqueueFeedbackIssue } from "./github/enqueue";

async function consumeQuota(tx: FeedbackTransaction, key: string, limit: number, seconds: number) {
  const window = sql.raw(`interval '${seconds} seconds'`);
  const [row] = await tx.insert(rateLimits).values({ key, count: 1, resetAt: sql`now() + ${window}` }).onConflictDoUpdate({
    target: rateLimits.key,
    set: {
      count: sql`case when ${rateLimits.resetAt} <= now() then 1 else ${rateLimits.count} + 1 end`,
      resetAt: sql`case when ${rateLimits.resetAt} <= now() then now() + ${window} else ${rateLimits.resetAt} end`,
    },
  }).returning({ count: rateLimits.count });
  if (!row || row.count > limit) throw new FeedbackError("feedback_rate_limited", 429);
}

/** The author is supplied only after the route validates its public session. */
export function submitFeedback(slug: string, authorUserId: number, raw: unknown, options: { onAccepted?: FeedbackTransactionHook } = {}) {
  const input = validateFeedbackWrite(raw);
  if (!Number.isSafeInteger(authorUserId) || authorUserId <= 0) throw new FeedbackError("feedback_invalid", 400);
  return onPrimary(() => db.transaction(async (tx) => {
    // Across replicas, replay, repeat moderation and quota share one author lock.
    await tx.execute(sql`select pg_advisory_xact_lock(6970, ${authorUserId})`);
    const [product] = await tx.select({ id: products.id, status: products.status }).from(products).where(eq(products.slug, slug)).for("share");
    if (!product || product.status === "banned") throw new FeedbackError("feedback_not_found", 404);
    const requestHash = feedbackFingerprint(product.id, input);
    const [existing] = await tx.select().from(productFeedback).where(and(eq(productFeedback.authorUserId, authorUserId), eq(productFeedback.requestId, input.requestId)));
    if (existing) {
      if (existing.requestHash !== requestHash) throw new FeedbackError("feedback_conflict", 409);
      return { feedback: existing, replayed: true };
    }
    await consumeQuota(tx, `feedback:hour:${authorUserId}`, 5, 3600);
    await consumeQuota(tx, `feedback:day:${authorUserId}`, 20, 86_400);
    const normalizedBodyHash = normalizedFeedbackBodyHash(input.body);
    const [repeat] = await tx.select({ id: productFeedback.id }).from(productFeedback).where(and(
      eq(productFeedback.authorUserId, authorUserId), eq(productFeedback.productId, product.id),
      eq(productFeedback.normalizedBodyHash, normalizedBodyHash), gte(productFeedback.createdAt, sql`now() - interval '24 hours'`),
    )).limit(1);
    const review = initialFeedbackReview(input.body, Boolean(repeat), input.title);
    const [feedback] = await tx.insert(productFeedback).values({ ...input, productId: product.id, authorUserId, requestHash, normalizedBodyHash,
      reviewState: review.state, reviewReason: review.reason, deliveryState: "local_only", githubDeliveryEligible: githubFeedbackDeliveryEnabled() }).returning();
    if (feedback.reviewState === "accepted") {
      if (options.onAccepted) await options.onAccepted(tx, feedback);
      else await enqueueFeedbackIssue(tx, feedback);
    }
    const [current] = await tx.select().from(productFeedback).where(eq(productFeedback.id, feedback.id));
    return { feedback: current, replayed: false };
  }));
}
