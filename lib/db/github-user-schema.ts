import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { publicUsers } from "./public-user-schema";

export const githubUserConnections = pgTable("github_user_connections", {
  userId: integer("user_id").primaryKey().references(() => publicUsers.id, { onDelete: "cascade" }),
  githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
  githubLogin: varchar("github_login", { length: 100 }).notNull(),
  state: varchar("state", { length: 24 }).$type<"active" | "needs_reconnect" | "revoked">().notNull(),
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
  refreshLeaseOwner: uuid("refresh_lease_owner"),
  refreshLeaseExpiresAt: timestamp("refresh_lease_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("github_user_connections_github_id_idx").on(table.githubUserId), check("github_user_connections_state_check", sql`${table.state} in ('active', 'needs_reconnect', 'revoked')`), check("github_user_connections_revision_check", sql`${table.revision} > 0`)]);

export const githubAuthFlows = pgTable("github_auth_flows", {
  id: uuid("id").primaryKey(),
  purpose: varchar("purpose", { length: 16 }).$type<"star" | "maker">().notNull(),
  actorUserId: integer("actor_user_id").references(() => publicUsers.id, { onDelete: "cascade" }),
  // Maker contexts own the product FK and installation details in migration 0070.
  productId: integer("product_id"),
  stateHash: varchar("state_hash", { length: 64 }).notNull(),
  browserNonceHash: varchar("browser_nonce_hash", { length: 64 }).notNull(),
  encryptedPkceVerifier: text("encrypted_pkce_verifier").notNull(),
  returnTo: text("return_to").notNull().default("/"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [uniqueIndex("github_auth_flows_state_idx").on(table.stateHash), index("github_auth_flows_expiry_idx").on(table.expiresAt), check("github_auth_flows_purpose_check", sql`${table.purpose} in ('star', 'maker') and (${table.purpose} <> 'maker' or (${table.actorUserId} is not null and ${table.productId} is not null))`)]);

export type GithubUserConnection = typeof githubUserConnections.$inferSelect;
