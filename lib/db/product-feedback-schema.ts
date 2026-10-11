import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { products } from "./schema";
import { publicUsers } from "./public-user-schema";
import type { FeedbackKind, FeedbackReviewState, IssueDeliveryState } from "@/lib/domain/feedback/contract";

export const productFeedback = pgTable("product_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  authorUserId: integer("author_user_id").notNull().references(() => publicUsers.id),
  requestId: uuid("request_id").notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  normalizedBodyHash: varchar("normalized_body_hash", { length: 64 }).notNull(),
  kind: varchar("kind", { length: 16 }).$type<FeedbackKind>().notNull(),
  title: varchar("title", { length: 120 }).notNull(),
  body: text("body").notNull(),
  serviceDisclosureConsent: boolean("service_disclosure_consent").notNull(),
  sendToGithub: boolean("send_to_github").notNull().default(false),
  githubDisclosureConsent: boolean("github_disclosure_consent").notNull().default(false),
  githubDeliveryEligible: boolean("github_delivery_eligible").notNull().default(false),
  reviewState: varchar("review_state", { length: 16 }).$type<FeedbackReviewState>().notNull(),
  reviewReason: varchar("review_reason", { length: 1000 }),
  reviewedBy: varchar("reviewed_by", { length: 120 }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  deliveryState: varchar("delivery_state", { length: 16 }).$type<IssueDeliveryState>().notNull().default("local_only"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("product_feedback_author_request_idx").on(table.authorUserId, table.requestId),
  index("product_feedback_public_idx").on(table.productId, table.createdAt).where(sql`${table.reviewState} = 'accepted'`),
  index("product_feedback_author_created_idx").on(table.authorUserId, table.createdAt),
  index("product_feedback_repeat_idx").on(table.authorUserId, table.productId, table.normalizedBodyHash, table.createdAt),
  check("product_feedback_kind_check", sql`${table.kind} in ('bug', 'feature', 'question')`),
  check("product_feedback_review_check", sql`${table.reviewState} in ('accepted', 'held', 'rejected')`),
  check("product_feedback_text_check", sql`char_length(btrim(${table.title})) >= 1 and char_length(${table.body}) <= 5000 and char_length(btrim(${table.body})) >= 1`),
  check("product_feedback_consent_check", sql`${table.serviceDisclosureConsent} and (not ${table.sendToGithub} or ${table.githubDisclosureConsent})`),
]);

export type ProductFeedback = typeof productFeedback.$inferSelect;
