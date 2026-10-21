import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { products } from "./schema";
import { publicIdentities, publicUsers } from "./public-user-schema";
import type {
  EmailMode, FollowTarget, MakerMethod, MakerReplyTarget, MakerRole, NotificationKind, ReactionCommentState, ReactionSource, ReactionVerdict,
} from "@/lib/me/contract";
import type { Locale } from "@/lib/i18n/locales";

/** 마이페이지 표 — drizzle/0108_mypage.sql 과 같은 모양. 값 목록은 lib/me/contract.ts */

export const userSavedProducts = pgTable("user_saved_products", {
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  source: varchar("source", { length: 8 }).$type<"web" | "merge">().notNull().default("web"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.productId] }),
  index("user_saved_products_user_created_idx").on(table.userId, table.createdAt.desc()),
  /** 0109 — 제품 삭제 cascade·제품별 저장 수 */
  index("user_saved_products_product_idx").on(table.productId),
  check("user_saved_products_source_check", sql`${table.source} in ('web', 'merge')`),
]);

export const productReactions = pgTable("product_reactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  /** productVisitorHash(slug, nmv_visitor) — 로그인하지 않은 평가의 열쇠 */
  visitorHash: varchar("visitor_hash", { length: 64 }),
  userId: integer("user_id").references(() => publicUsers.id, { onDelete: "set null" }),
  verdict: varchar("verdict", { length: 8 }).$type<ReactionVerdict>().notNull(),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  /** 7일 안 /go 기록과 맞으면 true */
  triedVerified: boolean("tried_verified").notNull().default(false),
  comment: varchar("comment", { length: 140 }),
  commentState: varchar("comment_state", { length: 16 }).$type<ReactionCommentState>(),
  commentReason: varchar("comment_reason", { length: 40 }),
  rankingExcluded: boolean("ranking_excluded").notNull().default(false),
  source: varchar("source", { length: 16 }).$type<ReactionSource>().notNull(),
  device: varchar("device", { length: 8 }).$type<"phone" | "desktop">(),
  locale: varchar("locale", { length: 8 }).notNull(),
  changesToday: smallint("changes_today").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("product_reactions_visitor_idx").on(table.productId, table.visitorHash).where(sql`${table.visitorHash} is not null`),
  uniqueIndex("product_reactions_user_idx").on(table.productId, table.userId).where(sql`${table.userId} is not null`),
  index("product_reactions_product_idx").on(table.productId, table.updatedAt.desc()),
  index("product_reactions_user_updated_idx").on(table.userId, table.updatedAt.desc()).where(sql`${table.userId} is not null`),
  index("product_reactions_held_idx").on(table.createdAt).where(sql`${table.commentState} = 'held'`),
  check("product_reactions_verdict_check", sql`${table.verdict} in ('good', 'meh', 'bad')`),
  check("product_reactions_tags_check", sql`cardinality(${table.tags}) <= 4`),
  check("product_reactions_comment_state_check", sql`${table.commentState} is null or ${table.commentState} in ('accepted', 'held', 'rejected')`),
  check("product_reactions_comment_check", sql`(${table.comment} is null) = (${table.commentState} is null)`),
  check("product_reactions_source_check", sql`${table.source} in ('panel', 'return', 'sheet', 'me')`),
  check("product_reactions_device_check", sql`${table.device} is null or ${table.device} in ('phone', 'desktop')`),
  check("product_reactions_owner_check", sql`${table.visitorHash} is not null or ${table.userId} is not null`),
  check("product_reactions_visitor_hash_check", sql`${table.visitorHash} is null or ${table.visitorHash} ~ '^[a-f0-9]{64}$'`),
]);

export const userFollows = pgTable("user_follows", {
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  targetType: varchar("target_type", { length: 12 }).$type<FollowTarget>().notNull(),
  /** 제품 id · GitHub 주인 숫자 id · 분야 slug (모두 글자로) */
  targetKey: varchar("target_key", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.targetType, table.targetKey] }),
  index("user_follows_target_idx").on(table.targetType, table.targetKey),
  index("user_follows_user_created_idx").on(table.userId, table.createdAt.desc()),
  check("user_follows_target_type_check", sql`${table.targetType} in ('product', 'maker', 'category')`),
  check("user_follows_target_key_check", sql`char_length(${table.targetKey}) between 1 and 120`),
]);

export const notifications = pgTable("notifications", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 24 }).$type<NotificationKind>().notNull(),
  productId: integer("product_id").references(() => products.id, { onDelete: "cascade" }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  dedupeKey: varchar("dedupe_key", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("notifications_user_dedupe_idx").on(table.userId, table.dedupeKey),
  index("notifications_user_created_idx").on(table.userId, table.createdAt.desc()),
  index("notifications_unread_idx").on(table.userId, table.createdAt.desc()).where(sql`${table.readAt} is null`),
  index("notifications_created_idx").on(table.createdAt),
  /** 0109 — 제품 삭제 cascade */
  index("notifications_product_idx").on(table.productId),
  check("notifications_kind_check", sql`${table.kind} in ('maker_reply', 'followed_release', 'followed_delisted', 'maker_new_project', 'category_new', 'comment_reviewed', 'new_listing_mine', 'inbox_new')`),
  check("notifications_payload_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
]);

export const notificationSettings = pgTable("notification_settings", {
  userId: integer("user_id").primaryKey().references(() => publicUsers.id, { onDelete: "cascade" }),
  emailIdentityId: integer("email_identity_id").references(() => publicIdentities.id, { onDelete: "set null" }),
  makerReply: varchar("maker_reply", { length: 8 }).$type<EmailMode>().notNull().default("instant"),
  followedProject: varchar("followed_project", { length: 8 }).$type<EmailMode>().notNull().default("weekly"),
  followedMaker: varchar("followed_maker", { length: 8 }).$type<EmailMode>().notNull().default("off"),
  followedCategory: varchar("followed_category", { length: 8 }).$type<Exclude<EmailMode, "instant">>().notNull().default("weekly"),
  newListingMine: varchar("new_listing_mine", { length: 8 }).$type<Exclude<EmailMode, "weekly">>().notNull().default("instant"),
  /** 0=일요일 … 6=토요일, KST */
  digestWeekday: smallint("digest_weekday").notNull().default(1),
  digestHour: smallint("digest_hour").notNull().default(9),
  /** 광고성 소식 동의 시각. null 이면 보내지 않는다 */
  newsOptInAt: timestamp("news_opt_in_at", { withTimezone: true }),
  /** 메일 글의 언어 — 설정을 저장한 화면의 언어 */
  locale: varchar("locale", { length: 8 }).$type<Locale>().notNull().default("ko"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("notification_settings_mode_check", sql`${table.makerReply} in ('instant', 'weekly', 'off') and ${table.followedProject} in ('instant', 'weekly', 'off')
    and ${table.followedMaker} in ('instant', 'weekly', 'off') and ${table.followedCategory} in ('weekly', 'off')
    and ${table.newListingMine} in ('instant', 'off')`),
  check("notification_settings_digest_check", sql`${table.digestWeekday} between 0 and 6 and ${table.digestHour} between 0 and 23`),
  check("notification_settings_locale_check", sql`${table.locale} in ('ko', 'en', 'zh-Hans', 'zh-Hant')`),
]);

export const emailOutbox = pgTable("email_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: integer("user_id").references(() => publicUsers.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 24 }).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 120 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  state: varchar("state", { length: 12 }).$type<"pending" | "accepted" | "rejected" | "unknown" | "skipped">().notNull().default("pending"),
  attempts: smallint("attempts").notNull().default(0),
  lastError: varchar("last_error", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("email_outbox_dedupe_idx").on(table.dedupeKey),
  index("email_outbox_pending_idx").on(table.nextAttemptAt).where(sql`${table.state} = 'pending'`),
  /** 0109 — 계정 삭제 */
  index("email_outbox_user_idx").on(table.userId),
  check("email_outbox_state_check", sql`${table.state} in ('pending', 'accepted', 'rejected', 'unknown', 'skipped')`),
  check("email_outbox_attempts_check", sql`${table.attempts} between 0 and 10`),
  check("email_outbox_payload_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
]);

export const productMakerMembers = pgTable("product_maker_members", {
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => publicUsers.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 8 }).$type<MakerRole>().notNull(),
  githubUserId: bigint("github_user_id", { mode: "number" }),
  method: varchar("method", { length: 20 }).$type<MakerMethod>().notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  recheckAt: timestamp("recheck_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: varchar("revoked_reason", { length: 40 }),
}, (table) => [
  primaryKey({ columns: [table.productId, table.userId] }),
  index("product_maker_members_user_idx").on(table.userId).where(sql`${table.revokedAt} is null`),
  index("product_maker_members_product_idx").on(table.productId).where(sql`${table.revokedAt} is null`),
  check("product_maker_members_role_check", sql`${table.role} in ('owner', 'editor')`),
  check("product_maker_members_method_check", sql`${table.method} in ('github_repo_owner', 'github_repo_admin', 'repo_file', 'edit_token', 'admin')`),
]);

export const makerReplies = pgTable("maker_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  targetType: varchar("target_type", { length: 12 }).$type<MakerReplyTarget>().notNull(),
  targetId: uuid("target_id").notNull(),
  authorUserId: integer("author_user_id").notNull().references(() => publicUsers.id),
  body: varchar("body", { length: 1000 }).notNull(),
  reviewState: varchar("review_state", { length: 16 }).$type<"accepted" | "held" | "rejected">().notNull().default("accepted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("maker_replies_target_idx").on(table.targetType, table.targetId),
  index("maker_replies_product_idx").on(table.productId, table.createdAt.desc()),
  /** 0109 — 계정 삭제 */
  index("maker_replies_author_idx").on(table.authorUserId),
  check("maker_replies_target_type_check", sql`${table.targetType} in ('reaction', 'feedback')`),
  check("maker_replies_review_check", sql`${table.reviewState} in ('accepted', 'held', 'rejected')`),
  check("maker_replies_body_check", sql`char_length(btrim(${table.body})) between 1 and 1000`),
]);
