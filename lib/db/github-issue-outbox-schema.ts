import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { productFeedback } from "./product-feedback-schema";
import { products } from "./schema";
import type { IssueDeliveryState } from "@/lib/domain/feedback/contract";
import type { DeliveredIssue } from "@/lib/domain/feedback/github/issue-body";

export const githubIssueOutbox = pgTable("github_issue_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedbackId: uuid("feedback_id").notNull().references(() => productFeedback.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
  repositoryFullName: varchar("repository_full_name", { length: 160 }).notNull(),
  repositoryUrl: text("repository_url").notNull(),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  bindingRevision: integer("binding_revision").notNull(),
  feedbackRequestHash: varchar("feedback_request_hash", { length: 64 }).notNull(),
  payloadTitle: varchar("payload_title", { length: 120 }).notNull(),
  payloadBody: text("payload_body").notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  dispatchId: uuid("dispatch_id").notNull(),
  state: varchar("state", { length: 16 }).$type<Exclude<IssueDeliveryState, "local_only">>().notNull().default("queued"),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attemptId: uuid("attempt_id"),
  attempts: integer("attempts").notNull().default(0),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  githubIssueId: bigint("github_issue_id", { mode: "number" }),
  githubIssueNumber: integer("github_issue_number"),
  githubIssueUrl: text("github_issue_url"),
  externalIssueState: varchar("external_issue_state", { length: 16 }).$type<"open" | "closed" | "deleted" | "unknown">().notNull().default("unknown"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  reconcilePage: integer("reconcile_page").notNull().default(1),
  reconcileMatches: jsonb("reconcile_matches").$type<DeliveredIssue[]>().notNull().default([]),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("github_issue_outbox_feedback_idx").on(table.feedbackId),
  index("github_issue_outbox_due_idx").on(table.state, table.availableAt),
  index("github_issue_outbox_target_idx").on(table.repositoryId, table.createdAt),
  check("github_issue_outbox_state_check", sql`${table.state} in ('queued','sending','delivered','retry_wait','uncertain','blocked','cancelled')`),
  check("github_issue_outbox_target_check", sql`${table.repositoryId} between 1 and 9007199254740991 and ${table.installationId} between 1 and 9007199254740991 and ${table.bindingRevision} >= 1`),
]);

export type GithubIssueOutbox = typeof githubIssueOutbox.$inferSelect;
