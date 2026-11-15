import { index, integer, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * 저장소 커밋 작성자 이메일(0186) — 관리자 전용 비공개 표. ai-level-refresh 잡이 이미 읽는 최근 커밋 30개에서 사람 주소만 남긴다
 * (lib/domain/makers/maintainer-emails.ts 의 거르기). 목적은 나중에 프로젝트 관리자에게 프로젝트 상황을 알려 주는 것이다(2026-11-15 운영자 결정).
 *
 * 공개 화면·공개 API·탐색 캐시·sitemap·피드는 이 표를 읽지 않는다. 읽는 곳은 관리자 화면(lib/domain/makers/maintainer-emails-admin.ts) 하나뿐이고,
 * tests/maintainer-email-boundary.test.ts 가 그 경계를 지킨다.
 * 공용 묶음 lib/db/schema.ts 에서 다시 내보내지 않는다 — 쓰는 곳은 이 파일을 직접 부른다(경계를 좁히고, 묶음을 건드리면 CI 증분 tsc 기록이
 * 통째로 무효가 돼 전체 검사가 4GB 를 넘는다. 2026-11-15 실측: main 전체 검사 5.1GB). select/insert 만 쓰므로 db 의 관계형 schema 에 없어도 된다. 삭제 요청은 저장소 키·주소로 행을 지운다(docs/operations/2026-11-15-maintainer-email-admin.md).
 */
export const repositoryMaintainerEmails = pgTable('repository_maintainer_emails', {
  repositoryKey: varchar('repository_key', { length: 200 }).notNull(),
  email: varchar('email', { length: 254 }).notNull(),
  authorName: varchar('author_name', { length: 200 }),
  authorLogin: varchar('author_login', { length: 100 }),
  /** 마지막으로 본 커밋 창(최근 30개)에서 이 주소가 쓴 커밋 수 */
  commitCount: integer('commit_count').notNull().default(0),
  firstSeenAt: timestamp('first_seen_at').notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.repositoryKey, table.email] }),
  index('repository_maintainer_emails_email_idx').on(table.email)]);
export type RepositoryMaintainerEmail = typeof repositoryMaintainerEmails.$inferSelect;
