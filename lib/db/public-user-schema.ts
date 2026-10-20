import { check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const publicUsers = pgTable("public_users", {
  id: serial("id").primaryKey(),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** 닉네임을 마지막으로 바꾼 때 — 30일에 한 번(마이페이지 계정 탭) */
  displayNameChangedAt: timestamp("display_name_changed_at", { withTimezone: true }),
  /** 탈퇴 표시 — 댓글 작성자 FK 때문에 행은 남기고 이름·신원·세션을 지운다 */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const publicIdentities = pgTable("public_identities", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 32 }).notNull(),
  subject: text("subject").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  /** 표시용(GitHub login 등). 이메일은 subject 가 곧 주소 */
  providerLogin: varchar("provider_login", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (table) => [uniqueIndex("public_identities_provider_subject_idx").on(table.provider, table.subject), index("public_identities_user_idx").on(table.userId)]);

export const publicSessions = pgTable("public_sessions", {
  tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  provider: varchar("provider", { length: 32 }),
  /** "Mac · Chrome" 같은 짧은 이름. User-Agent 원문은 저장하지 않는다 */
  deviceLabel: varchar("device_label", { length: 40 }),
  /** 하루 한 번만 갱신 */
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
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
