import "server-only";
import { and, asc, count, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { productFeedback, type ProductFeedback } from "@/lib/db/product-feedback-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import type { FeedbackReviewState, FeedbackView } from "./contract";

export type FeedbackTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Only DB work belongs in this hook; external requests must run after the transaction. */
export type FeedbackTransactionHook = (tx: FeedbackTransaction, feedback: ProductFeedback) => Promise<void>;

const selection = { feedback: productFeedback, slug: products.slug, productName: products.name, authorDisplayName: publicUsers.displayName,
  delivery: { state: githubIssueOutbox.state, issueId: githubIssueOutbox.githubIssueId, issueNumber: githubIssueOutbox.githubIssueNumber,
    issueUrl: githubIssueOutbox.githubIssueUrl, externalState: githubIssueOutbox.externalIssueState, errorCode: githubIssueOutbox.lastErrorCode } };
type SelectedFeedback = { feedback: ProductFeedback; slug: string; productName: string; authorDisplayName: string;
  delivery: { state: string; issueId: number | null; issueNumber: number | null; issueUrl: string | null; externalState: "open" | "closed" | "deleted" | "unknown" | null; errorCode: string | null } | null };

export function feedbackView(row: SelectedFeedback, privateReview = false): FeedbackView {
  const value = row.feedback;
  const delivery = row.delivery;
  // The dispatcher verifies identity. The read projection additionally rejects
  // unsafe/corrupt links and raw provider messages before exposing any result.
  const verified = delivery?.state === "delivered" && Number.isSafeInteger(delivery.issueId) && delivery.issueId! > 0
    && Number.isSafeInteger(delivery.issueNumber) && delivery.issueNumber! > 0;
  const issueUrl = verified && delivery?.issueUrl?.match(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/([1-9][0-9]*)$/);
  const githubIssueUrl = issueUrl && Number(issueUrl[1]) === delivery!.issueNumber ? delivery!.issueUrl : null;
  return { id: value.id, productId: value.productId, slug: row.slug, productName: row.productName,
    authorUserId: value.authorUserId, authorDisplayName: row.authorDisplayName, kind: value.kind, title: value.title, body: value.body,
    reviewState: value.reviewState, reviewReason: privateReview ? value.reviewReason : null,
    deliveryState: value.deliveryState, createdAt: value.createdAt.toISOString(), githubIssueUrl,
    externalIssueState: githubIssueUrl && ["open", "closed", "deleted", "unknown"].includes(delivery!.externalState ?? "") ? delivery!.externalState : null,
    lastErrorCode: delivery?.errorCode && /^(?:github|feedback)_[a-z0-9_]{1,100}$/.test(delivery.errorCode) ? delivery.errorCode : null };
}

function publicFeedbackQuery(slug: string, source: typeof db | FeedbackTransaction = db) {
  return source.select(selection).from(productFeedback).innerJoin(products, eq(productFeedback.productId, products.id))
    .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id))
    .leftJoin(githubIssueOutbox, eq(productFeedback.id, githubIssueOutbox.feedbackId))
    .where(publicFeedbackVisibility(slug)).orderBy(desc(productFeedback.createdAt), desc(productFeedback.id)).limit(50);
}

function publicFeedbackVisibility(slug: string) {
  return and(eq(products.slug, slug), ne(products.status, "banned"), eq(productFeedback.reviewState, "accepted"));
}

export function listProductFeedback(slug: string): Promise<FeedbackView[]> {
  return onPrimary(async () => (await publicFeedbackQuery(slug)).map((row) => feedbackView(row)));
}

export function listProductFeedbackWithTotal(slug: string): Promise<{ feedback: FeedbackView[]; total: number }> {
  return onPrimary(() => db.transaction(async (tx) => {
    const rows = await publicFeedbackQuery(slug, tx);
    const [summary] = await tx.select({ total: count() }).from(productFeedback)
      .innerJoin(products, eq(productFeedback.productId, products.id))
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id))
      .where(publicFeedbackVisibility(slug));
    return { feedback: rows.map((row) => feedbackView(row)), total: summary.total };
  }, { isolationLevel: "repeatable read", accessMode: "read only" }));
}

export function listMyFeedback(userId: number, slug?: string): Promise<FeedbackView[]> {
  return onPrimary(async () => {
    const rows = await db.select(selection).from(productFeedback).innerJoin(products, eq(productFeedback.productId, products.id))
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id))
      .leftJoin(githubIssueOutbox, eq(productFeedback.id, githubIssueOutbox.feedbackId))
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
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id))
      .leftJoin(githubIssueOutbox, eq(productFeedback.id, githubIssueOutbox.feedbackId)).where(and(eq(productFeedback.id, id), visibility)).limit(1);
    return row ? feedbackView(row, viewer.admin || viewer.userId === row.feedback.authorUserId) : null;
  });
}

export type FeedbackAdminFilter = { state?: FeedbackReviewState | "all"; q?: string; cursor?: string; limit?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function feedbackCursor(value?: string): { at: string; id: string } | null {
  if (!value || value.length > 200) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(at)
      || typeof id !== "string" || !UUID.test(id)) return null;
    const date = new Date(at);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== at.slice(0, 19)) return null;
    return { at, id };
  } catch { return null; }
}

/** The administrator list and inbox share this predicate, count and oldest-first preview. */
export function feedbackAdminQueue(input: FeedbackAdminFilter = {}): Promise<{ count: number; items: FeedbackView[]; nextCursor: string | null }> {
  const state = ["accepted", "held", "rejected", "all"].includes(input.state ?? "") ? input.state! : "held";
  const query = input.q?.trim().slice(0, 120);
  const pattern = query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : null;
  const predicate = and(state === "all" ? undefined : eq(productFeedback.reviewState, state), pattern ? or(
    ilike(products.slug, pattern), ilike(products.name, pattern), ilike(productFeedback.title, pattern),
    sql`${productFeedback.id}::text ilike ${pattern}`,
  ) : undefined);
  const cursor = feedbackCursor(input.cursor);
  const after = cursor ? sql`(${productFeedback.createdAt}, ${productFeedback.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined;
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(100, input.limit!)) : 50;
  return onPrimary(() => db.transaction(async (tx) => {
    const [summary] = await tx.select({ total: count() }).from(productFeedback)
      .innerJoin(products, eq(productFeedback.productId, products.id))
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id)).where(predicate);
    const rows = await tx.select({ ...selection,
      cursorAt: sql<string>`to_char(${productFeedback.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(productFeedback).innerJoin(products, eq(productFeedback.productId, products.id))
      .innerJoin(publicUsers, eq(productFeedback.authorUserId, publicUsers.id))
      .leftJoin(githubIssueOutbox, eq(productFeedback.id, githubIssueOutbox.feedbackId)).where(and(predicate, after))
      .orderBy(asc(productFeedback.createdAt), asc(productFeedback.id)).limit(limit + 1);
    const items = rows.slice(0, limit).map((row) => feedbackView(row, true));
    const last = rows[Math.min(rows.length, limit) - 1];
    return { count: summary.total, items, nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.cursorAt, last.feedback.id])).toString("base64url") : null };
  }, { isolationLevel: "repeatable read", accessMode: "read only" }));
}

export async function feedbackReviewQueue(): Promise<FeedbackView[]> {
  return (await feedbackAdminQueue({ state: "held", limit: 100 })).items;
}
