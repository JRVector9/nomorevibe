import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { publicUsers } from "./public-user-schema";

export const githubStarOperations = pgTable("github_star_operations", {
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
  productId: integer("product_id").notNull(),
  productRepoUrl: varchar("product_repo_url", { length: 512 }).notNull(),
  state: varchar("state", { length: 24 }).$type<"starred" | "unstarred" | "unknown" | "needs_reconnect">().notNull().default("unknown"),
  revision: integer("revision").notNull().default(0),
  operationId: uuid("operation_id"),
  desiredStarred: boolean("desired_starred"),
  leaseOwner: uuid("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  reconcileAfter: timestamp("reconcile_after", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.userId, table.repositoryId] }), index("github_star_operations_product_idx").on(table.userId, table.productId), check("github_star_operations_state_check", sql`${table.state} in ('starred', 'unstarred', 'unknown', 'needs_reconnect')`), check("github_star_operations_revision_check", sql`${table.revision} >= 0`)]);

/** Retain each operation result so an older request ID cannot repeat a write. */
export const githubStarOperationReceipts = pgTable("github_star_operation_receipts", {
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  operationId: uuid("operation_id").notNull(),
  repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
  productId: integer("product_id").notNull(),
  starred: boolean("starred").notNull(),
  expectedRevision: integer("expected_revision").notNull(),
  response: jsonb("response").$type<{ state: "starred" | "unstarred" | "unknown" | "needs_reconnect"; revision: number; repositoryId: number; operationId: string; pending: boolean; productRepoUrl: string; retryAt?: number | null; uncertain?: boolean; failure?: { status: number; code: "star_rate_limited" | "star_write_rejected" } }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.operationId] }), index("github_star_operation_receipts_created_idx").on(table.createdAt)]);

export type GithubStarOperation = typeof githubStarOperations.$inferSelect;
