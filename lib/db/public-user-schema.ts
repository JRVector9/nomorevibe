import { check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const publicUsers = pgTable("public_users", {
  id: serial("id").primaryKey(),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const publicIdentities = pgTable("public_identities", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 32 }).notNull(),
  subject: text("subject").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("public_identities_provider_subject_idx").on(table.provider, table.subject), index("public_identities_user_idx").on(table.userId)]);

export const publicSessions = pgTable("public_sessions", {
  tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [index("public_sessions_user_idx").on(table.userId), index("public_sessions_expiry_idx").on(table.expiresAt), check("public_sessions_hash_check", sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`)]);

export const emailLoginChallenges = pgTable("email_login_challenges", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  browserNonceHash: varchar("browser_nonce_hash", { length: 64 }).notNull(),
  returnTo: text("return_to").notNull().default("/"),
  attempts: integer("attempts").notNull().default(0),
  deliveryState: varchar("delivery_state", { length: 16 }).$type<"pending" | "accepted" | "rejected" | "unknown">().notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [index("email_login_challenges_email_idx").on(table.email, table.createdAt), index("email_login_challenges_expiry_idx").on(table.expiresAt), check("email_login_challenges_attempts_check", sql`${table.attempts} >= 0 and ${table.attempts} <= 5`), check("email_login_challenges_code_hash_check", sql`${table.codeHash} ~ '^[a-f0-9]{64}$'`)]);

export type PublicUser = Pick<typeof publicUsers.$inferSelect, "id" | "displayName">;
