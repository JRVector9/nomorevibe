import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/**
 * SNS에서 이야기된 글 — 화제 화면(/talk·홈·상세)의 재료.
 *
 * 글의 주소·제목·점수·시각만 담는다. 본문·댓글·작성자는 담지 않는다(SNS 화제·홍보 설계 2026-10-18, 운영·법무).
 * 출처가 같은 글을 다시 보여 주면 점수·댓글만 덮어쓰고, 시각별 값은 social_post_observations 에 쌓는다.
 *
 * - source: hn(Hacker News) · geeknews · x — 지금 수집하는 것은 hn 뿐이다
 * - kind: show 는 만든 사람이 직접 올린 글(Show HN·Show GN), link 는 남이 소개한 글
 * - link_target: 글 주소가 저장소 자체(repo)인지, 그 저장소의 이슈·PR·다른 경로인지, 제품 사이트(site)인지
 * - repository_key: 소문자 owner/repo. 제품 사이트를 가리키는 글(site)은 비운다
 * - state: visible 보임 · hidden 관리자가 숨김 · gone 원문이 지워짐(다시 보이면 되살린다)
 */
export type SocialSource = "hn" | "geeknews" | "x";
export type SocialPostKind = "link" | "show";
export type SocialLinkTarget = "repo" | "issue" | "pull" | "path" | "site";
export type SocialPostState = "visible" | "hidden" | "gone";

export const socialPosts = pgTable("social_posts", {
  id: serial("id").primaryKey(),
  source: varchar("source", { length: 16 }).$type<SocialSource>().notNull(),
  externalId: varchar("external_id", { length: 64 }).notNull(),
  kind: varchar("kind", { length: 12 }).$type<SocialPostKind>().notNull(),
  title: varchar("title", { length: 300 }).notNull(),
  linkUrl: text("link_url").notNull(),
  linkTarget: varchar("link_target", { length: 12 }).$type<SocialLinkTarget>().notNull(),
  repositoryKey: varchar("repository_key", { length: 200 }),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
  /** 마지막으로 본 값. 시각별 값은 social_post_observations */
  points: integer("points").notNull().default(0),
  comments: integer("comments").notNull().default(0),
  /** HN 첫 화면에 오른 적이 있다(알골리아 front_page 태그) */
  frontPage: boolean("front_page").notNull().default(false),
  state: varchar("state", { length: 12 }).$type<SocialPostState>().notNull().default("visible"),
  stateReason: varchar("state_reason", { length: 64 }),
  stateChangedAt: timestamp("state_changed_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** 출처가 이 글을 마지막으로 돌려준 시각 */
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("social_posts_source_external_idx").on(table.source, table.externalId),
  index("social_posts_repository_idx").on(table.repositoryKey, table.postedAt.desc()).where(sql`${table.repositoryKey} is not null`),
  index("social_posts_posted_idx").on(table.postedAt.desc()),
  check("social_posts_source_check", sql`${table.source} in ('hn','geeknews','x')`),
  check("social_posts_kind_check", sql`${table.kind} in ('link','show')`),
  check("social_posts_link_target_check", sql`${table.linkTarget} in ('repo','issue','pull','path','site')`),
  check("social_posts_repository_check", sql`(${table.linkTarget} = 'site' and ${table.repositoryKey} is null)
    or (${table.linkTarget} <> 'site' and ${table.repositoryKey} ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$')`),
  check("social_posts_counts_check", sql`${table.points} >= 0 and ${table.comments} >= 0`),
  check("social_posts_state_check", sql`${table.state} in ('visible','hidden','gone')`),
  check("social_posts_seen_check", sql`${table.lastSeenAt} >= ${table.firstSeenAt}`),
]);

/** 시각별 점수·댓글. 값이 바뀌었을 때(또는 오래 안 바뀌었을 때)만 한 줄 */
export const socialPostObservations = pgTable("social_post_observations", {
  postId: integer("post_id").notNull().references(() => socialPosts.id, { onDelete: "cascade" }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  points: integer("points").notNull(),
  comments: integer("comments").notNull(),
}, table => [
  primaryKey({ columns: [table.postId, table.observedAt] }),
  check("social_post_observations_counts_check", sql`${table.points} >= 0 and ${table.comments} >= 0`),
]);

/**
 * 저장소마다 관리자가 정한 것 — 화제에서 빼기(excluded), 홈 첫 화면 1위 자리 허용(home_decision).
 * C안은 첫 화면 1위만 사람이 한 번 본다: approved 면 1위에 오르고, talk_only 면 /talk 에만 둔다. 정하지 않았으면 1위를 건너뛴다.
 */
export type TalkHomeDecision = "approved" | "talk_only";
export const socialTalkDecisions = pgTable("social_talk_decisions", {
  repositoryKey: varchar("repository_key", { length: 200 }).primaryKey(),
  excluded: boolean("excluded").notNull().default(false),
  homeDecision: varchar("home_decision", { length: 12 }).$type<TalkHomeDecision>(),
  reason: varchar("reason", { length: 200 }),
  decidedBy: varchar("decided_by", { length: 120 }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("social_talk_decisions_repository_check", sql`${table.repositoryKey} ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'`),
  check("social_talk_decisions_home_check", sql`${table.homeDecision} is null or ${table.homeDecision} in ('approved','talk_only')`),
]);

export type SocialPost = typeof socialPosts.$inferSelect;
