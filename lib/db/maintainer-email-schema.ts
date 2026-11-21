import { index, integer, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * 저장소 제작자 커밋 이메일(0194) — 관리자 전용 비공개 표. ai-level-refresh 잡이 이미 읽는 최근 커밋 30개 가운데 저장소 주인(개인 계정)의
 * GitHub 로그인과 같은 사용자가 쓴 커밋의 사람 주소만 남긴다(lib/domain/makers/maintainer-emails.ts 의 고르기·거르기). 조직 저장소는 모으지 않는다.
 * 목적은 나중에 프로젝트 제작자에게 프로젝트 상황을 알려 주는 것이다(2026-11-15 요청, 2026-11-21 소유자 결정 「프로젝트 제작자만 모아」).
 * 마지막 확인 뒤 1년이 지나면 보관 정리(lib/operations/db-retention.ts)가 지운다.
 *
 * 공개 화면·공개 API·탐색 캐시·sitemap·피드는 이 표를 읽지 않는다. 주소를 읽는 곳은 관리자 화면(lib/domain/makers/maintainer-emails-admin.ts)뿐이고,
 * tests/maintainer-email-boundary.test.ts 가 그 경계를 지킨다.
 * 공용 묶음 lib/db/schema.ts 에서 다시 내보내지 않는다 — 쓰는 곳은 이 파일을 직접 부른다(경계를 좁히고, 묶음을 건드리면 CI 증분 tsc 기록이
 * 통째로 무효가 돼 전체 검사가 4GB 를 넘는다. 2026-11-15 실측: main 전체 검사 5.1GB). select/insert/delete 만 쓰므로 db 의 관계형 schema 에 없어도 된다.
 */
export const repositoryMaintainerEmails = pgTable('repository_maintainer_emails', {
  repositoryKey: varchar('repository_key', { length: 200 }).notNull(),
  email: varchar('email', { length: 254 }).notNull(),
  authorName: varchar('author_name', { length: 200 }),
  authorLogin: varchar('author_login', { length: 100 }),
  /** 마지막으로 본 커밋 창(최근 30개)에서 제작자가 이 주소로 쓴 커밋 수 */
  commitCount: integer('commit_count').notNull().default(0),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.repositoryKey, table.email] }),
  index('repository_maintainer_emails_email_idx').on(table.email),
  index('repository_maintainer_emails_last_seen_idx').on(table.lastSeenAt)]);
export type RepositoryMaintainerEmail = typeof repositoryMaintainerEmails.$inferSelect;

/**
 * 다시 모으지 않을 주소(0194) — 관리자가 「지우고 다시 모으지 않기」를 누른 주소. 주소는 남기지 않고 maintainerEmailDenyHash 의 값만 둔다.
 * 수집(ai-level-refresh record)은 쓰기 전에 이 목록을 보고, 관리자 거부와 겹치지 않게 같은 advisory 잠금을 나눠 잡는다.
 */
export const maintainerEmailDenials = pgTable('maintainer_email_denials', {
  emailHash: varchar('email_hash', { length: 64 }).primaryKey(),
  deniedAt: timestamp('denied_at', { withTimezone: true }).notNull().defaultNow(),
});
