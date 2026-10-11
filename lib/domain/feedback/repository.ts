import "server-only";
import { and, desc, eq, ne, or } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { productFeedback, type ProductFeedback } from "@/lib/db/product-feedback-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import type { FeedbackView } from "./contract";

export type FeedbackTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Only DB work belongs in this hook; external requests must run after the transaction. */
export type FeedbackTransactionHook = (tx: FeedbackTransaction, feedback: ProductFeedback) => Promise<void>;

const selection = { feedback: productFeedback, slug: products.slug, productName: products.name, authorDisplayName: publicUsers.displayName };
type SelectedFeedback = { feedback: ProductFeedback; slug: string; productName: string; authorDisplayName: string };

export function feedbackView(row: SelectedFeedback, privateReview = false): FeedbackView {
  const value = row.feedback;
  return { id: value.id, productId: value.productId, slug: row.slug, productName: row.productName,
    authorUserId: value.authorUserId, authorDisplayName: row.authorDisplayName, kind: value.kind, title: value.title, body: value.body,
    reviewState: value.reviewState, reviewReason: privateReview ? value.reviewReason : null,
    deliveryState: value.deliveryState, createdAt: value.createdAt.toISOString() };
}

export function listProductFeedback(slug: string): Promise<FeedbackView[]> {
  return onPrimary(async () => {
    const rows = await db.select(selection).from(productFeedback).innerJoin(products, eq(productFeedback.productId, products.id))
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id))
      .where(and(eq(products.slug, slug), ne(products.status, "banned"), eq(productFeedback.reviewState, "accepted")))
      .orderBy(desc(productFeedback.createdAt), desc(productFeedback.id)).limit(50);
    return rows.map((row) => feedbackView(row));
  });
}

export function listMyFeedback(userId: number, slug?: string): Promise<FeedbackView[]> {
  return onPrimary(async () => {
    const rows = await db.select(selection).from(productFeedback).innerJoin(products, eq(productFeedback.productId, products.id))
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id))
      .where(and(eq(productFeedback.authorUserId, userId), slug === undefined ? undefined : eq(products.slug, slug)))
      .orderBy(desc(productFeedback.createdAt), desc(productFeedback.id)).limit(100);
    return rows.map((row) => feedbackView(row, true));
  });
}

export function getFeedback(id: string, viewer: { userId?: number; admin?: boolean } = {}): Promise<FeedbackView | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return Promise.resolve(null);
  return onPrimary(async () => {
    const visibility = viewer.admin ? undefined : or(
      and(eq(productFeedback.reviewState, "accepted"), ne(products.status, "banned")),
      viewer.userId ? eq(productFeedback.authorUserId, viewer.userId) : undefined,
    );
    const [row] = await db.select(selection).from(productFeedback).innerJoin(products, eq(productFeedback.productId, products.id))
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id)).where(and(eq(productFeedback.id, id), visibility)).limit(1);
    return row ? feedbackView(row, viewer.admin || viewer.userId === row.feedback.authorUserId) : null;
  });
}

export function feedbackReviewQueue(): Promise<FeedbackView[]> {
  return onPrimary(async () => {
    const rows = await db.select(selection).from(productFeedback).innerJoin(products, eq(productFeedback.productId, products.id))
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id)).where(eq(productFeedback.reviewState, "held"))
      .orderBy(productFeedback.createdAt, productFeedback.id).limit(100);
    return rows.map((row) => feedbackView(row, true));
  });
}
