import { pgTable, serial, varchar, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * AI 소식 — 공식 출처에서 모은 글.
 *
 * 우리가 글을 다시 쓰지 않는다. 제목·요약·원문 주소만 담고, 누르면 원문으로 간다.
 *
 * - approved: 공개 (자동 승인이 켜져 있으면 들어오자마자 여기)
 * - pending:  관리자 승인 대기 (자동 승인을 끄면 새 글이 여기로)
 * - hidden:   관리자가 내린 것. 다시 수집돼도 되살아나지 않는다 (url 이 유일하다)
 */
export type NewsState = "approved" | "pending" | "hidden";

export const newsItems = pgTable(
  "news_items",
  {
    id: serial("id").primaryKey(),
    /** lib/news/sources.ts 의 key — 출처를 빼도 모은 글은 남는다 */
    sourceKey: varchar("source_key", { length: 60 }).notNull(),
    url: varchar("url", { length: 1000 }).notNull().unique(),
    title: varchar("title", { length: 300 }).notNull(),
    summary: text("summary"),
    /** 출처가 밝힌 게시 시각. 밝히지 않으면 처음 본 시각 */
    publishedAt: timestamp("published_at").notNull(),
    state: varchar("state", { length: 20 }).$type<NewsState>().notNull(),
    /** auto: 자동 승인·대기, 그 밖에는 결정한 관리자 로그인 */
    decidedBy: varchar("decided_by", { length: 120 }).notNull(),
    decidedAt: timestamp("decided_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("news_items_state_published_idx").on(table.state, table.publishedAt.desc()),
    index("news_items_source_published_idx").on(table.sourceKey, table.publishedAt.desc()),
  ],
);

export type NewsItem = typeof newsItems.$inferSelect;
