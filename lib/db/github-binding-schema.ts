import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { products } from "./schema";
import { publicUsers } from "./public-user-schema";
import { githubAuthFlows } from "./github-user-schema";

export const githubProductBindings = pgTable("github_product_bindings", {
  productId: integer("product_id").primaryKey().references(() => products.id, { onDelete: "cascade" }),
  repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
  repositoryFullName: varchar("repository_full_name", { length: 140 }).notNull(),
  repositoryUrl: text("repository_url").notNull(),
  productRepoUrl: text("product_repo_url").notNull(),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  consentedByUserId: integer("consented_by_user_id").notNull().references(() => publicUsers.id),
  revision: integer("revision").notNull().default(1),
  enabled: boolean("enabled").notNull().default(false),
  blockedReason: varchar("blocked_reason", { length: 80 }),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  verificationRetryAt: timestamp("verification_retry_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("github_product_bindings_installation_idx").on(table.installationId),
  check("github_product_bindings_ids_check", sql`${table.repositoryId} > 0 AND ${table.repositoryId} <= 9007199254740991 AND ${table.installationId} > 0 AND ${table.installationId} <= 9007199254740991 AND ${table.revision} > 0`)]);

/** Holds only hashed edit authorization and a short-lived encrypted Feedback OAuth token. */
export const githubMakerAuthContexts = pgTable("github_maker_auth_contexts", {
  flowId: uuid("flow_id").primaryKey().references(() => githubAuthFlows.id, { onDelete: "cascade" }),
  actorUserId: integer("actor_user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
  productRepoUrl: text("product_repo_url").notNull(),
  editTokenHash: varchar("edit_token_hash", { length: 64 }).notNull(),
  expectedRevision: integer("expected_revision").notNull(),
  browserNonceHash: varchar("browser_nonce_hash", { length: 64 }).notNull(),
  sessionTokenHash: varchar("session_token_hash", { length: 64 }).notNull(),
  setupStateHash: varchar("setup_state_hash", { length: 64 }).unique(),
  encryptedUserToken: text("encrypted_user_token"),
  githubUserId: bigint("github_user_id", { mode: "number" }),
  state: varchar("state", { length: 20 }).$type<"authorizing" | "awaiting_setup" | "verifying" | "completed" | "failed" | "expired">().notNull().default("authorizing"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("github_maker_auth_contexts_expiry_idx").on(table.expiresAt),
  check("github_maker_auth_contexts_user_id_check", sql`${table.githubUserId} IS NULL OR ${table.githubUserId} BETWEEN 1 AND 9007199254740991`),
  check("github_maker_auth_contexts_id_check", sql`${table.repositoryId} > 0 AND ${table.repositoryId} <= 9007199254740991 AND ${table.expectedRevision} >= 0`),
  check("github_maker_auth_contexts_state_check", sql`${table.state} IN ('authorizing', 'awaiting_setup', 'verifying', 'completed', 'failed', 'expired')`)]);

export type GithubProductBinding = typeof githubProductBindings.$inferSelect;
